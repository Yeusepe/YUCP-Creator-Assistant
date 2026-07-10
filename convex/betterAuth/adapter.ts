import { createApi } from '@convex-dev/better-auth';
import { anyApi, type FunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { createSchemaAuthOptions } from './options';
import schema from './schema';

const adapterApi = createApi(schema, createSchemaAuthOptions);

type RawCreateReference = FunctionReference<
  'mutation',
  'public',
  {
    input: unknown;
    select?: string[];
    onCreateHandle?: string;
  },
  unknown,
  string | undefined
>;

const rawCreateRef = (anyApi as unknown as { adapter: { rawCreate: RawCreateReference } }).adapter
  .rawCreate;

function normalizeApiKeyCreateInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }

  const inputRecord = input as Record<string, unknown>;
  if (inputRecord.model !== 'apikey') {
    return input;
  }

  const data = inputRecord.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return input;
  }

  const dataRecord = data as Record<string, unknown>;
  if (typeof dataRecord.userId === 'string' && dataRecord.userId.length > 0) {
    return input;
  }

  if (typeof dataRecord.referenceId !== 'string' || dataRecord.referenceId.length === 0) {
    return input;
  }

  // Better Auth API-key create derives the user owner into referenceId and does
  // not include userId in the adapter insert payload.
  return {
    ...inputRecord,
    data: {
      ...dataRecord,
      userId: dataRecord.referenceId,
    },
  };
}

export const rawCreate = adapterApi.create;

export const create = internalMutation({
  args: {
    input: v.any(),
    select: v.optional(v.array(v.string())),
    onCreateHandle: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    return await ctx.runMutation(rawCreateRef, {
      ...args,
      input: normalizeApiKeyCreateInput(args.input),
    });
  },
});

export const findOne = adapterApi.findOne;
export const findMany = adapterApi.findMany;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateOne = adapterApi.updateOne as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateMany = adapterApi.updateMany as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deleteOne = adapterApi.deleteOne as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deleteMany = adapterApi.deleteMany as any;
