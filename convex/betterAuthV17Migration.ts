import { v } from 'convex/values';
import { components } from './_generated/api';
import { internalMutation, internalQuery } from './_generated/server';

const migrationTable = v.union(v.literal('account'), v.literal('apikey'));
const migrationPhase = v.union(v.literal('backfill'), v.literal('cleanup'));

export const auditPage = internalQuery({
  args: {
    table: migrationTable,
    cursor: v.union(v.null(), v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.runQuery(components.betterAuth.v17Migration.auditPage, args);
  },
});

export const migratePage = internalMutation({
  args: {
    table: migrationTable,
    phase: migrationPhase,
    cursor: v.union(v.null(), v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.betterAuth.v17Migration.migratePage, args);
  },
});
