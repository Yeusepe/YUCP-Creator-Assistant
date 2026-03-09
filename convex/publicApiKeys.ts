import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { type MutationCtx, mutation, query } from './_generated/server';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

const PublicApiKeyStatus = v.union(v.literal('active'), v.literal('revoked'));

async function createAuditEvent(
  ctx: MutationCtx,
  params: {
    tenantId: Id<'tenants'>;
    actorId: string;
    eventType: 'public.api_key.created' | 'public.api_key.revoked';
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await ctx.db.insert('audit_events', {
    tenantId: params.tenantId,
    eventType: params.eventType,
    actorType: 'admin',
    actorId: params.actorId,
    metadata: params.metadata,
    createdAt: Date.now(),
  });
}

export const listPublicApiKeys = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.array(
    v.object({
      _id: v.id('public_api_keys'),
      _creationTime: v.number(),
      tenantId: v.id('tenants'),
      name: v.string(),
      prefix: v.string(),
      status: PublicApiKeyStatus,
      scopes: v.array(v.string()),
      createdByAuthUserId: v.string(),
      revokedByAuthUserId: v.optional(v.string()),
      lastUsedAt: v.optional(v.number()),
      expiresAt: v.optional(v.number()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const keys = await ctx.db
      .query('public_api_keys')
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
      .order('desc')
      .collect();
    return keys.map(({ keyHash: _, ...rest }) => rest);
  },
});

export const getActivePublicApiKeyByHash = query({
  args: {
    apiSecret: v.string(),
    keyHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('public_api_keys'),
      _creationTime: v.number(),
      tenantId: v.id('tenants'),
      name: v.string(),
      prefix: v.string(),
      keyHash: v.string(),
      status: PublicApiKeyStatus,
      scopes: v.array(v.string()),
      createdByAuthUserId: v.string(),
      revokedByAuthUserId: v.optional(v.string()),
      lastUsedAt: v.optional(v.number()),
      expiresAt: v.optional(v.number()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const key = await ctx.db
      .query('public_api_keys')
      .withIndex('by_key_hash', (q) => q.eq('keyHash', args.keyHash))
      .first();

    if (!key || key.status !== 'active') {
      return null;
    }

    return key;
  },
});

export const createPublicApiKeyRecord = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    name: v.string(),
    prefix: v.string(),
    keyHash: v.string(),
    scopes: v.array(v.string()),
    createdByAuthUserId: v.string(),
    expiresAt: v.optional(v.number()),
  },
  returns: v.id('public_api_keys'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const keyId = await ctx.db.insert('public_api_keys', {
      tenantId: args.tenantId,
      name: args.name,
      prefix: args.prefix,
      keyHash: args.keyHash,
      status: 'active',
      scopes: args.scopes,
      createdByAuthUserId: args.createdByAuthUserId,
      expiresAt: args.expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    await createAuditEvent(ctx, {
      tenantId: args.tenantId,
      actorId: args.createdByAuthUserId,
      eventType: 'public.api_key.created',
      metadata: {
        keyId,
        name: args.name,
        prefix: args.prefix,
        scopes: args.scopes,
        expiresAt: args.expiresAt,
      },
    });

    return keyId;
  },
});

export const revokePublicApiKey = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    keyId: v.id('public_api_keys'),
    revokedByAuthUserId: v.string(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const key = await ctx.db.get(args.keyId);
    if (!key || key.tenantId !== args.tenantId) {
      throw new Error('Public API key not found');
    }

    await ctx.db.patch(args.keyId, {
      status: 'revoked',
      revokedByAuthUserId: args.revokedByAuthUserId,
      updatedAt: Date.now(),
    });

    await createAuditEvent(ctx, {
      tenantId: args.tenantId,
      actorId: args.revokedByAuthUserId,
      eventType: 'public.api_key.revoked',
      metadata: {
        keyId: args.keyId,
        name: key.name,
        prefix: key.prefix,
      },
    });

    return { success: true };
  },
});

export const touchPublicApiKeyLastUsed = mutation({
  args: {
    apiSecret: v.string(),
    keyId: v.id('public_api_keys'),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await ctx.db.patch(args.keyId, {
      lastUsedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});
