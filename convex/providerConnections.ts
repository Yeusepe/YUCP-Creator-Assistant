/**
 * Provider Connections - Creator credentials and webhook config
 *
 * Gumroad: OAuth tokens, resource subscriptions.
 * Jinxxy: API key, webhook secret.
 */

import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/**
 * Get Jinxxy webhook secret for a tenant.
 * Used by webhook handler for signature verification.
 */
export const getJinxxyWebhookSecret = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'jinxxy')
      )
      .first();
    if (!conn?.webhookSecretRef) return null;
    return conn.webhookSecretRef;
  },
});

/**
 * Get Gumroad webhook secret for a tenant.
 * Used by webhook handler for signature verification.
 */
export const getGumroadWebhookSecret = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'gumroad')
      )
      .first();
    if (!conn?.gumroadWebhookSecretRef) return null;
    return conn.gumroadWebhookSecretRef;
  },
});

/**
 * Get connection status for a tenant (gumroad, jinxxy).
 */
export const getConnectionStatus = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.object({
    gumroad: v.boolean(),
    jinxxy: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const [gumroad, jinxxy] = await Promise.all([
      ctx.db
        .query('provider_connections')
        .withIndex('by_tenant_provider', (q) =>
          q.eq('tenantId', args.tenantId).eq('provider', 'gumroad')
        )
        .first(),
      ctx.db
        .query('provider_connections')
        .withIndex('by_tenant_provider', (q) =>
          q.eq('tenantId', args.tenantId).eq('provider', 'jinxxy')
        )
        .first(),
    ]);
    return {
      gumroad: !!(gumroad?.gumroadAccessTokenEncrypted && gumroad?.status !== 'disconnected'),
      jinxxy: !!(jinxxy?.jinxxyApiKeyEncrypted && jinxxy?.status !== 'disconnected'),
    };
  },
});

/**
 * List all connections for a tenant with full status info.
 */
export const listConnections = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const tenant = await ctx.db.get(args.tenantId);
    const allowMismatchedEmails = tenant?.policy?.allowMismatchedEmails ?? false;

    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
      .collect();

    return {
      allowMismatchedEmails,
      connections: connections.map((c) => ({
        id: c._id,
        provider: c.provider,
        label: c.label ?? (c.provider === 'gumroad' ? 'Gumroad Store' : 'Jinxxy Store'),
        connectionType: c.connectionType ?? 'setup',
        status: c.status ?? (c.gumroadAccessTokenEncrypted || c.jinxxyApiKeyEncrypted ? 'active' : 'disconnected'),
        webhookConfigured: c.webhookConfigured,
        hasApiKey: !!(c.jinxxyApiKeyEncrypted),
        hasAccessToken: !!(c.gumroadAccessTokenEncrypted),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }))
    };
  },
});

/**
 * Get connection with encrypted tokens for backfill (internal use by API).
 * Returns encrypted token for decryption by API which has BETTER_AUTH_SECRET.
 */
export const getConnectionForBackfill = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    provider: v.union(v.literal('gumroad'), v.literal('jinxxy')),
  },
  returns: v.union(
    v.object({
      gumroadAccessTokenEncrypted: v.optional(v.string()),
      jinxxyApiKeyEncrypted: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', args.provider)
      )
      .first();

    if (!conn) return null;

    return {
      gumroadAccessTokenEncrypted: conn.gumroadAccessTokenEncrypted,
      jinxxyApiKeyEncrypted: conn.jinxxyApiKeyEncrypted,
    };
  },
});

/**
 * Disconnect a provider connection (soft delete — sets status to 'disconnected').
 */
export const disconnectConnection = mutation({
  args: {
    apiSecret: v.string(),
    connectionId: v.id('provider_connections'),
    tenantId: v.id('tenants'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db.get(args.connectionId);
    if (!conn || conn.tenantId !== args.tenantId) {
      throw new Error('Connection not found or access denied');
    }
    await ctx.db.patch(args.connectionId, {
      status: 'disconnected',
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

/**
 * Update a specific tenant setting from the onboarding flow.
 */
export const updateTenantSetting = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    key: v.string(),
    value: v.any(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) throw new Error('Tenant not found');

    const policy = tenant.policy ?? {};
    const updatedPolicy = { ...policy, [args.key]: args.value };

    await ctx.db.patch(args.tenantId, {
      policy: updatedPolicy,
      updatedAt: Date.now(),
    });
    return { success: true };
  }
});

/**
 * Upsert Gumroad provider connection (OAuth tokens).
 */
export const upsertGumroadConnection = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    gumroadAccessTokenEncrypted: v.string(),
    gumroadRefreshTokenEncrypted: v.optional(v.string()),
    gumroadUserId: v.optional(v.string()),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'gumroad')
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: 'active',
        gumroadAccessTokenEncrypted: args.gumroadAccessTokenEncrypted,
        gumroadRefreshTokenEncrypted: args.gumroadRefreshTokenEncrypted ?? existing.gumroadRefreshTokenEncrypted,
        gumroadUserId: args.gumroadUserId ?? existing.gumroadUserId,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('provider_connections', {
      tenantId: args.tenantId,
      provider: 'gumroad',
      label: 'Gumroad Store',
      connectionType: 'setup',
      status: 'active',
      gumroadAccessTokenEncrypted: args.gumroadAccessTokenEncrypted,
      gumroadRefreshTokenEncrypted: args.gumroadRefreshTokenEncrypted,
      gumroadUserId: args.gumroadUserId,
      webhookConfigured: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Upsert Jinxxy provider connection (API key, webhook secret).
 * Called from Discord setup when creator configures Jinxxy.
 */
export const upsertJinxxyConnection = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    jinxxyApiKeyEncrypted: v.optional(v.string()),
    webhookSecretRef: v.optional(v.string()),
    webhookEndpoint: v.optional(v.string()),
  },
  returns: v.id('provider_connections'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'jinxxy')
      )
      .first();

    const webhookConfigured = !!(args.webhookSecretRef && args.webhookEndpoint);

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: 'active',
        jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted ?? existing.jinxxyApiKeyEncrypted,
        webhookSecretRef: args.webhookSecretRef ?? existing.webhookSecretRef,
        webhookEndpoint: args.webhookEndpoint ?? existing.webhookEndpoint,
        webhookConfigured: webhookConfigured || existing.webhookConfigured,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('provider_connections', {
      tenantId: args.tenantId,
      provider: 'jinxxy',
      label: 'Jinxxy Store',
      connectionType: 'setup',
      status: 'active',
      jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted,
      webhookSecretRef: args.webhookSecretRef,
      webhookEndpoint: args.webhookEndpoint,
      webhookConfigured,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const removeAccountForSubject = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    subjectId: v.id('subjects'),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    // Find the binding for this subject and tenant
    const bindings = await ctx.db
      .query('bindings')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', args.tenantId).eq('subjectId', args.subjectId)
      )
      .collect();

    let accountToDelete = null;
    let bindingToDelete = null;

    // Find the specific provider account
    for (const binding of bindings) {
      const account = await ctx.db.get(binding.externalAccountId);
      if (account && account.provider === args.provider) {
        accountToDelete = account;
        bindingToDelete = binding;
        break;
      }
    }

    if (!accountToDelete || !bindingToDelete) return false;

    // Delete both the binding and the external account
    await ctx.db.delete(bindingToDelete._id);
    await ctx.db.delete(accountToDelete._id);
    return true;
  },
});
