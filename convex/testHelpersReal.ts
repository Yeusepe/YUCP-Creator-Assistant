import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import schema from './schema';

const CLEAR_ALL_BATCH_LIMIT = 50;

function assertRealBackendTest(): void {
  const isTest = process.env.IS_TEST === 'true' || process.env.IS_TEST === '1';
  const isRealBackendHarness = process.env.YUCP_REAL_BACKEND_TEST_HELPERS === 'true';
  if (!isTest || !isRealBackendHarness) {
    throw new Error(
      'testHelpersReal functions require IS_TEST=true and YUCP_REAL_BACKEND_TEST_HELPERS=true'
    );
  }
}

const appTableNames = Object.keys(schema.tables);

export const insert = internalMutation({
  args: {
    table: v.string(),
    doc: v.any(),
  },
  handler: async (ctx, args): Promise<string> => {
    assertRealBackendTest();
    return await ctx.db.insert(args.table as never, args.doc as never);
  },
});

export const patch = internalMutation({
  args: {
    id: v.string(),
    patch: v.any(),
  },
  handler: async (ctx, args): Promise<void> => {
    assertRealBackendTest();
    await ctx.db.patch(args.id as never, args.patch as never);
  },
});

export const deleteById = internalMutation({
  args: {
    id: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    assertRealBackendTest();
    await ctx.db.delete(args.id as never);
  },
});

export const get = internalQuery({
  args: {
    id: v.string(),
  },
  handler: async (ctx, args): Promise<unknown> => {
    assertRealBackendTest();
    return await ctx.db.get(args.id as never);
  },
});

export const collect = internalQuery({
  args: {
    table: v.string(),
  },
  handler: async (ctx, args): Promise<unknown[]> => {
    assertRealBackendTest();
    return await ctx.db.query(args.table as never).collect();
  },
});

export const clearAll = internalMutation({
  args: {
    includeScheduled: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ deleted: number }> => {
    assertRealBackendTest();

    let deleted = 0;
    const remaining = () => CLEAR_ALL_BATCH_LIMIT - deleted;

    if (args.includeScheduled !== false) {
      // ponytail: Scheduled cleanup is capped at CLEAR_ALL_BATCH_LIMIT per cleanup run
      // because Convex/system component jobs can remain present after cancellation. If
      // test-created scheduled jobs approach that ceiling, split this into an ID-cursor
      // cleanup phase that verifies progress across calls.
      const scheduled = await ctx.db.system.query('_scheduled_functions').take(remaining());
      for (const job of scheduled) {
        await ctx.scheduler.cancel(job._id);
        deleted++;
      }
    }
    if (remaining() <= 0) return { deleted };

    const storedFiles = await ctx.db.system.query('_storage').take(remaining());
    for (const file of storedFiles) {
      await ctx.storage.delete(file._id);
      deleted++;
    }
    if (remaining() <= 0) return { deleted };

    for (const table of appTableNames) {
      const docs = await ctx.db.query(table as never).take(remaining());
      for (const doc of docs) {
        await ctx.db.delete((doc as { _id: string })._id as never);
        deleted++;
      }
      if (remaining() <= 0) return { deleted };
    }

    return { deleted };
  },
});
