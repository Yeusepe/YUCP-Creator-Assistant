import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import schema from './schema';

function assertRealBackendTest(): void {
  if (process.env.IS_TEST !== 'true') {
    throw new Error('testHelpersReal functions require IS_TEST=true');
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
  args: {},
  handler: async (ctx): Promise<void> => {
    assertRealBackendTest();

    const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
    for (const job of scheduled) {
      await ctx.scheduler.cancel(job._id);
    }

    const storedFiles = await ctx.db.system.query('_storage').collect();
    for (const file of storedFiles) {
      await ctx.storage.delete(file._id);
    }

    for (const table of appTableNames) {
      const docs = await ctx.db.query(table as never).collect();
      for (const doc of docs) {
        await ctx.db.delete(doc._id);
      }
    }
  },
});
