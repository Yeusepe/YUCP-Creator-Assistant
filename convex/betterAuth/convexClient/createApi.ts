import {
  mutationGeneric,
  paginationOptsValidator,
  queryGeneric,
} from "convex/server";
import type { FunctionHandle, SchemaDefinition } from "convex/server";
import { v } from "convex/values";
import type { GenericId, Infer } from "convex/values";
import { asyncMap } from "convex-helpers";
import { partial } from "convex-helpers/validators";
import {
  adapterArgsValidator,
  adapterWhereValidator,
  checkUniqueFields,
  filterByWhere,
  hasUniqueFields,
  listOne,
  paginate,
  selectFields,
} from "./adapterUtils.js";
import { getAuthTables } from "better-auth/db";
import type { TableNames } from "../_generated/dataModel.js";
import type { BetterAuthOptions } from "better-auth/minimal";
import { deriveBetterAuthV17AccountIdentity } from "../accountIdentityMigration.js";

type AdapterQueryArgs = Infer<typeof adapterArgsValidator>;

function equalityText(args: AdapterQueryArgs, field: string): string | undefined {
  const clause = args.where?.find(
    (candidate) =>
      candidate.field === field &&
      (!candidate.operator || candidate.operator === "eq") &&
      typeof candidate.value === "string"
  );
  return typeof clause?.value === "string" && clause.value.length > 0
    ? clause.value
    : undefined;
}

function normalizeLegacyAccountForRead(doc: Record<string, any>) {
  if (doc.issuer && doc.providerAccountId) {
    return doc;
  }
  const identity = deriveBetterAuthV17AccountIdentity({
    accountId: doc.accountId,
    providerId: doc.providerId,
    userId: doc.userId,
    password: doc.password,
  });
  return identity ? { ...doc, ...identity } : doc;
}

function normalizeModelForRead(model: string, doc: Record<string, any>) {
  return model === "account" ? normalizeLegacyAccountForRead(doc) : doc;
}

async function findLegacyAccountForIdentity(
  ctx: any,
  args: AdapterQueryArgs
): Promise<Record<string, any> | null> {
  if (args.model !== "account") {
    return null;
  }
  const issuer = equalityText(args, "issuer");
  const providerAccountId = equalityText(args, "providerAccountId");
  if (!issuer || !providerAccountId) {
    return null;
  }
  const candidates = await ctx.db
    .query("account")
    .withIndex("accountId", (q: any) => q.eq("accountId", providerAccountId))
    .take(3);
  const matches = candidates.filter((candidate: Record<string, any>) => {
    if (candidate.issuer || candidate.providerAccountId) {
      return false;
    }
    const identity = deriveBetterAuthV17AccountIdentity({
      accountId: candidate.accountId,
      providerId: candidate.providerId,
      userId: candidate.userId,
      password: candidate.password,
    });
    return identity?.issuer === issuer && identity.providerAccountId === providerAccountId;
  });
  if (matches.length > 1) {
    throw new Error("Legacy Better Auth account identity is ambiguous");
  }
  const match = matches[0] ? normalizeLegacyAccountForRead(matches[0]) : null;
  return filterByWhere(match as any, args.where) ? match : null;
}

async function listOneForAdapter(
  ctx: any,
  schema: SchemaDefinition<any, any>,
  betterAuthSchema: ReturnType<typeof getAuthTables>,
  args: AdapterQueryArgs
) {
  if (args.model !== "account") {
    return await listOne(ctx, schema, betterAuthSchema, args as any);
  }
  const doc = await listOne(ctx, schema, betterAuthSchema, {
    ...args,
    select: undefined,
  } as any);
  const resolved = doc
    ? normalizeLegacyAccountForRead(doc as Record<string, any>)
    : await findLegacyAccountForIdentity(ctx, args);
  return selectFields(resolved as any, args.select);
}

async function paginateForAdapter(
  ctx: any,
  schema: SchemaDefinition<any, any>,
  betterAuthSchema: ReturnType<typeof getAuthTables>,
  args: AdapterQueryArgs & {
    paginationOpts: { cursor: string | null; numItems: number };
  }
) {
  if (args.model !== "account") {
    return await paginate(ctx, schema, betterAuthSchema, args as any);
  }
  const result = await paginate(ctx, schema, betterAuthSchema, {
    ...args,
    select: undefined,
  } as any);
  if (result.page.length > 0) {
    return {
      ...result,
      page: result.page.map((doc) =>
        selectFields(normalizeLegacyAccountForRead(doc as Record<string, any>) as any, args.select)
      ),
    };
  }
  if (args.paginationOpts.cursor) {
    return result;
  }
  const fallback = await findLegacyAccountForIdentity(ctx, args);
  return fallback
    ? {
        page: [selectFields(fallback as any, args.select)],
        isDone: true,
        continueCursor: "",
      }
    : result;
}

const whereValidator = (
  schema: SchemaDefinition<any, any>,
  tableName: TableNames
) =>
  v.object({
    field: v.union(
      ...Object.keys(schema.tables[tableName].validator.fields).map((field) =>
        v.literal(field)
      ),
      v.literal("_id")
    ),
    operator: v.optional(
      v.union(
        v.literal("lt"),
        v.literal("lte"),
        v.literal("gt"),
        v.literal("gte"),
        v.literal("eq"),
        v.literal("in"),
        v.literal("not_in"),
        v.literal("ne"),
        v.literal("contains"),
        v.literal("starts_with"),
        v.literal("ends_with")
      )
    ),
    value: v.union(
      v.string(),
      v.number(),
      v.boolean(),
      v.array(v.string()),
      v.array(v.number()),
      v.null()
    ),
    connector: v.optional(v.union(v.literal("AND"), v.literal("OR"))),
    mode: v.optional(v.union(v.literal("sensitive"), v.literal("insensitive"))),
  });

export const createApi = <Schema extends SchemaDefinition<any, any>>(
  schema: Schema,
  createAuthOptions: (ctx: any) => BetterAuthOptions
) => {
  const betterAuthSchema = getAuthTables(createAuthOptions({} as any));
  return {
    create: mutationGeneric({
      args: {
        input: v.union(
          ...Object.entries(schema.tables).map(([model, table]) =>
            v.object({
              model: v.literal(model),
              data: v.object((table as any).validator.fields),
            })
          )
        ),
        select: v.optional(v.array(v.string())),
        onCreateHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        await checkUniqueFields(
          ctx,
          schema,
          betterAuthSchema,
          args.input.model,
          args.input.data
        );
        const id = await ctx.db.insert(
          args.input.model as any,
          args.input.data
        );
        const doc = await ctx.db.get(args.input.model, id);
        if (!doc) {
          throw new Error(`Failed to create ${args.input.model}`);
        }
        const result = selectFields(doc, args.select);
        if (args.onCreateHandle) {
          await ctx.runMutation(
            args.onCreateHandle as FunctionHandle<"mutation">,
            {
              model: args.input.model,
              doc,
            }
          );
          const updatedDoc = await ctx.db.get(args.input.model, id);
          if (!updatedDoc) {
            throw new Error(
              `Failed to create ${args.input.model} (deleted by onCreate trigger?)`
            );
          }
          return selectFields(updatedDoc, args.select);
        }
        return result;
      },
    }),
    findOne: queryGeneric({
      args: {
        model: v.union(
          ...Object.keys(schema.tables).map((model) => v.literal(model))
        ),
        where: v.optional(v.array(adapterWhereValidator)),
        select: v.optional(v.array(v.string())),
        join: v.optional(v.any()),
      },
      handler: async (ctx, args) => {
        return await listOneForAdapter(ctx, schema, betterAuthSchema, args);
      },
    }),
    findMany: queryGeneric({
      args: {
        model: v.union(
          ...Object.keys(schema.tables).map((model) => v.literal(model))
        ),
        where: v.optional(v.array(adapterWhereValidator)),
        select: v.optional(v.array(v.string())),
        limit: v.optional(v.number()),
        sortBy: v.optional(
          v.object({
            direction: v.union(v.literal("asc"), v.literal("desc")),
            field: v.string(),
          })
        ),
        offset: v.optional(v.number()),
        join: v.optional(v.any()),
        paginationOpts: paginationOptsValidator,
      },
      handler: async (ctx, args) => {
        return await paginateForAdapter(ctx, schema, betterAuthSchema, args);
      },
    }),
    updateOne: mutationGeneric({
      args: {
        input: v.union(
          ...Object.entries(schema.tables).map(
            ([name, table]: [string, Schema["tables"][string]]) => {
              const tableName = name as TableNames;
              const fields = partial(table.validator.fields);
              return v.object({
                model: v.literal(tableName),
                update: v.object(fields),
                where: v.optional(v.array(whereValidator(schema, tableName))),
              });
            }
          )
        ),
        onUpdateHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const doc = await listOneForAdapter(ctx, schema, betterAuthSchema, args.input);
        if (!doc) {
          throw new Error(`Failed to update ${args.input.model}`);
        }
        await checkUniqueFields(
          ctx,
          schema,
          betterAuthSchema,
          args.input.model,
          args.input.update,
          doc
        );
        await ctx.db.patch(
          args.input.model,
          doc._id as GenericId<TableNames>,
          args.input.update as any
        );
        const updatedDoc = await ctx.db.get(
          args.input.model,
          doc._id as GenericId<TableNames>
        );
        if (!updatedDoc) {
          throw new Error(`Failed to update ${args.input.model}`);
        }
        if (args.onUpdateHandle) {
          await ctx.runMutation(
            args.onUpdateHandle as FunctionHandle<"mutation">,
            {
              model: args.input.model,
              newDoc: updatedDoc,
              oldDoc: doc,
            }
          );
          const innerUpdatedDoc = await ctx.db.get(
            args.input.model,
            doc._id as GenericId<TableNames>
          );
          if (!innerUpdatedDoc) {
            throw new Error(
              `Failed to update ${args.input.model} (deleted by onUpdate trigger?)`
            );
          }
          return normalizeModelForRead(args.input.model, innerUpdatedDoc);
        }
        return normalizeModelForRead(args.input.model, updatedDoc);
      },
    }),
    updateMany: mutationGeneric({
      args: {
        input: v.union(
          ...Object.entries(schema.tables).map(
            ([name, table]: [string, Schema["tables"][string]]) => {
              const tableName = name as TableNames;
              const fields = partial(table.validator.fields);
              return v.object({
                model: v.literal(tableName),
                update: v.object(fields),
                where: v.optional(v.array(whereValidator(schema, tableName))),
              });
            }
          )
        ),
        paginationOpts: paginationOptsValidator,
        onUpdateHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const { page, ...result } = await paginateForAdapter(
          ctx,
          schema,
          betterAuthSchema,
          {
            ...args.input,
            paginationOpts: args.paginationOpts,
          }
        );
        if (args.input.update) {
          if (
            hasUniqueFields(
              betterAuthSchema,
              args.input.model,
              args.input.update ?? {}
            ) &&
            page.length > 1
          ) {
            throw new Error(
              `Attempted to set unique fields in multiple documents in ${args.input.model} with the same value. Fields: ${Object.keys(args.input.update ?? {}).join(", ")}`
            );
          }
          await asyncMap(page, async (doc) => {
            await checkUniqueFields(
              ctx,
              schema,
              betterAuthSchema,
              args.input.model,
              args.input.update ?? {},
              doc
            );
            await ctx.db.patch(
              args.input.model,
              doc._id as GenericId<TableNames>,
              args.input.update as any
            );

            if (args.onUpdateHandle) {
              await ctx.runMutation(
                args.onUpdateHandle as FunctionHandle<"mutation">,
                {
                  model: args.input.model,
                  newDoc: await ctx.db.get(
                    args.input.model,
                    doc._id as GenericId<TableNames>
                  ),
                  oldDoc: doc,
                }
              );
            }
          });
        }
        return {
          ...result,
          count: page.length,
          ids: page.map((doc) => doc._id),
        };
      },
    }),
    // Better Auth atomic adapter contract:
    // https://github.com/better-auth/better-auth/blob/v1.7.0-rc.2/packages/core/src/db/adapter/index.ts
    consumeOne: mutationGeneric({
      args: {
        input: v.union(
          ...Object.keys(schema.tables).map((name: string) => {
            const tableName = name as TableNames;
            return v.object({
              model: v.literal(tableName),
              where: v.optional(v.array(whereValidator(schema, tableName))),
            });
          })
        ),
        onDeleteHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const doc = await listOneForAdapter(ctx, schema, betterAuthSchema, args.input);
        if (!doc) {
          return null;
        }
        await ctx.db.delete(args.input.model, doc._id as GenericId<TableNames>);
        if (args.onDeleteHandle) {
          await ctx.runMutation(
            args.onDeleteHandle as FunctionHandle<"mutation">,
            { model: args.input.model, doc }
          );
        }
        return doc;
      },
    }),
    incrementOne: mutationGeneric({
      args: {
        input: v.union(
          ...Object.keys(schema.tables).map((name: string) => {
            const tableName = name as TableNames;
            return v.object({
              increment: v.record(v.string(), v.number()),
              model: v.literal(tableName),
              set: v.optional(v.record(v.string(), v.any())),
              where: v.optional(v.array(whereValidator(schema, tableName))),
            });
          })
        ),
        onUpdateHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const doc = await listOneForAdapter(ctx, schema, betterAuthSchema, args.input);
        if (!doc) {
          return null;
        }

        const update: Record<string, unknown> = { ...args.input.set };
        for (const [field, delta] of Object.entries(args.input.increment)) {
          const current = doc[field];
          if (typeof current !== "number") {
            throw new Error(`Cannot increment nonnumeric field ${args.input.model}.${field}`);
          }
          if (!Number.isFinite(delta)) {
            throw new Error(`Increment delta must be finite for ${args.input.model}.${field}`);
          }
          const next = current + delta;
          if (!Number.isFinite(next)) {
            throw new Error(`Increment result must be finite for ${args.input.model}.${field}`);
          }
          update[field] = next;
        }

        await checkUniqueFields(
          ctx,
          schema,
          betterAuthSchema,
          args.input.model,
          update,
          doc
        );
        await ctx.db.patch(
          args.input.model,
          doc._id as GenericId<TableNames>,
          update as never
        );
        const updatedDoc = await ctx.db.get(
          args.input.model,
          doc._id as GenericId<TableNames>
        );
        if (!updatedDoc) {
          throw new Error(`Failed to increment ${args.input.model}`);
        }
        if (args.onUpdateHandle) {
          await ctx.runMutation(
            args.onUpdateHandle as FunctionHandle<"mutation">,
            {
              model: args.input.model,
              newDoc: updatedDoc,
              oldDoc: doc,
            }
          );
          const innerUpdatedDoc = await ctx.db.get(
            args.input.model,
            doc._id as GenericId<TableNames>
          );
          if (!innerUpdatedDoc) {
            throw new Error(
              `Failed to increment ${args.input.model} after the update trigger`
            );
          }
          return normalizeModelForRead(args.input.model, innerUpdatedDoc);
        }
        return normalizeModelForRead(args.input.model, updatedDoc);
      },
    }),
    deleteOne: mutationGeneric({
      args: {
        input: v.union(
          ...Object.keys(schema.tables).map((name: string) => {
            const tableName = name as TableNames;
            return v.object({
              model: v.literal(tableName),
              where: v.optional(v.array(whereValidator(schema, tableName))),
            });
          })
        ),
        onDeleteHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const doc = await listOneForAdapter(ctx, schema, betterAuthSchema, args.input);
        if (!doc) {
          return;
        }
        await ctx.db.delete(args.input.model, doc._id as GenericId<TableNames>);
        if (args.onDeleteHandle) {
          await ctx.runMutation(
            args.onDeleteHandle as FunctionHandle<"mutation">,
            { model: args.input.model, doc }
          );
        }
        return doc;
      },
    }),
    deleteMany: mutationGeneric({
      args: {
        input: v.union(
          ...Object.keys(schema.tables).map((name: string) => {
            const tableName = name as TableNames;
            return v.object({
              model: v.literal(tableName),
              where: v.optional(v.array(whereValidator(schema, tableName))),
            });
          })
        ),
        paginationOpts: paginationOptsValidator,
        onDeleteHandle: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const { page, ...result } = await paginateForAdapter(
          ctx,
          schema,
          betterAuthSchema,
          {
            ...args.input,
            paginationOpts: args.paginationOpts,
          }
        );
        await asyncMap(page, async (doc) => {
          if (args.onDeleteHandle) {
            await ctx.runMutation(
              args.onDeleteHandle as FunctionHandle<"mutation">,
              {
                model: args.input.model,
                doc,
              }
            );
          }
          await ctx.db.delete(
            args.input.model,
            doc._id as GenericId<TableNames>
          );
        });
        return {
          ...result,
          count: page.length,
          ids: page.map((doc) => doc._id),
        };
      },
    }),
  };
};
