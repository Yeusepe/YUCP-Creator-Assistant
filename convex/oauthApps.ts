/**
 * Tenant-scoped metadata for OAuth clients stored by Better Auth.
 * Better Auth owns the actual OAuth client + secret records; this table maps them to tenants.
 */

import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

const OAuthAppRecord = v.object({
  _id: v.id('creator_oauth_apps'),
  _creationTime: v.number(),
  tenantId: v.id('tenants'),
  name: v.string(),
  clientId: v.string(),
  clientSecretHash: v.optional(v.string()),
  redirectUris: v.array(v.string()),
  scopes: v.array(v.string()),
  createdByAuthUserId: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const listOAuthApps = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.array(OAuthAppRecord),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return ctx.db
      .query('creator_oauth_apps')
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
      .order('desc')
      .collect();
  },
});

export const getOAuthApp = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    appId: v.id('creator_oauth_apps'),
  },
  returns: v.union(v.null(), OAuthAppRecord),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const app = await ctx.db.get(args.appId);
    if (!app || app.tenantId !== args.tenantId) {
      return null;
    }
    return app;
  },
});

export const createOAuthAppMapping = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    name: v.string(),
    clientId: v.string(),
    redirectUris: v.array(v.string()),
    scopes: v.array(v.string()),
    createdByAuthUserId: v.string(),
  },
  returns: OAuthAppRecord,
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const appId = await ctx.db.insert('creator_oauth_apps', {
      tenantId: args.tenantId,
      name: args.name.trim(),
      clientId: args.clientId,
      redirectUris: args.redirectUris,
      scopes: args.scopes,
      createdByAuthUserId: args.createdByAuthUserId,
      createdAt: now,
      updatedAt: now,
    });

    const created = await ctx.db.get(appId);
    if (!created) {
      throw new Error('Failed to create OAuth app mapping');
    }

    return created;
  },
});

export const updateOAuthAppMapping = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    appId: v.id('creator_oauth_apps'),
    name: v.optional(v.string()),
    redirectUris: v.optional(v.array(v.string())),
    scopes: v.optional(v.array(v.string())),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const app = await ctx.db.get(args.appId);
    if (!app || app.tenantId !== args.tenantId) {
      throw new Error('OAuth app not found');
    }

    const patch: Partial<{
      name: string;
      redirectUris: string[];
      scopes: string[];
      updatedAt: number;
    }> = { updatedAt: Date.now() };

    if (args.name !== undefined) {
      const nextName = args.name.trim();
      if (!nextName) {
        throw new Error('name cannot be empty');
      }
      patch.name = nextName;
    }

    if (args.redirectUris !== undefined) {
      patch.redirectUris = args.redirectUris;
    }

    if (args.scopes !== undefined) {
      patch.scopes = args.scopes;
    }

    await ctx.db.patch(args.appId, patch);
    return { success: true };
  },
});

export const deleteOAuthAppMapping = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    appId: v.id('creator_oauth_apps'),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const app = await ctx.db.get(args.appId);
    if (!app || app.tenantId !== args.tenantId) {
      throw new Error('OAuth app not found');
    }

    await ctx.db.delete(args.appId);
    return { success: true };
  },
});
