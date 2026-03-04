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
    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
      .collect();
    return connections.map((c) => ({
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
    }));
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
 * Get or create Jinxxy webhook config (callback URL, signing secret).
 * Generates a new signing secret if none exists.
 */
export const getOrCreateJinxxyWebhookConfig = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    baseUrl: v.string(),
  },
  returns: v.object({
    callbackUrl: v.string(),
    signingSecret: v.string(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', 'jinxxy')
      )
      .first();

    const callbackUrl = `${args.baseUrl.replace(/\/$/, '')}/webhooks/jinxxy/${args.tenantId}`;

    if (existing?.webhookSecretRef && existing.webhookSecretRef.length <= 40) {
      return {
        callbackUrl,
        signingSecret: existing.webhookSecretRef,
      };
    }

    // 14 random bytes = 28 hex chars + "whsec_yucp_" (11 chars) = 39 chars total (under 40 limit)
    const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(14)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const signingSecret = `whsec_yucp_${randomPart}`;

    if (existing) {
      await ctx.db.patch(existing._id, {
        webhookSecretRef: signingSecret,
        webhookEndpoint: callbackUrl,
        webhookConfigured: false,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('provider_connections', {
        tenantId: args.tenantId,
        provider: 'jinxxy',
        label: 'Jinxxy Store',
        connectionType: 'setup',
        status: 'active',
        webhookSecretRef: signingSecret,
        webhookEndpoint: callbackUrl,
        webhookConfigured: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { callbackUrl, signingSecret };
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
