/**
 * Creator Provider Config - Legacy credential retrieval
 *
 * All new credentials are stored in provider_connections + provider_credentials.
 * These functions query the generic credential system.
 */

import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/**
 * Get Jinxxy API key for verification — reads from provider_credentials.
 * Returns the encrypted api_key credential for the jinxxy provider connection.
 */
export const getJinxxyApiKeyForVerification = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'jinxxy')
      )
      .filter((q) => q.neq(q.field('status'), 'disconnected'))
      .first();
    if (!conn) return null;
    const cred = await ctx.db
      .query('provider_credentials')
      .withIndex('by_connection_key', (q) =>
        q.eq('providerConnectionId', conn._id).eq('credentialKey', 'api_key')
      )
      .first();
    return cred?.encryptedValue ?? null;
  },
});

/**
 * Get creator provider config (for API/bot to fetch Jinxxy key).
 * @deprecated Use getJinxxyApiKeyForVerification instead.
 */
export const getCreatorProviderConfig = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      jinxxyApiKeyEncrypted: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'jinxxy')
      )
      .filter((q) => q.neq(q.field('status'), 'disconnected'))
      .first();
    if (!conn) return null;
    const cred = await ctx.db
      .query('provider_credentials')
      .withIndex('by_connection_key', (q) =>
        q.eq('providerConnectionId', conn._id).eq('credentialKey', 'api_key')
      )
      .first();
    return { jinxxyApiKeyEncrypted: cred?.encryptedValue };
  },
});

/**
 * Upsert Jinxxy API key for a creator.
 * @deprecated Use upsertProviderConnection or putProviderCredential instead.
 * Kept for backward compat with bot flows that call this directly.
 */
export const upsertJinxxyApiKey = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    jinxxyApiKeyEncrypted: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    let conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'jinxxy')
      )
      .first();

    if (!conn) {
      const id = await ctx.db.insert('provider_connections', {
        authUserId: args.authUserId,
        provider: 'jinxxy' as any,
        providerKey: 'jinxxy' as any,
        label: 'Jinxxy Store',
        connectionType: 'setup',
        status: 'active',
        authMode: 'api_key',
        webhookConfigured: false,
        createdAt: now,
        updatedAt: now,
      });
      conn = await ctx.db.get(id);
    }

    if (!conn) throw new Error('Failed to resolve Jinxxy connection');

    const existing = await ctx.db
      .query('provider_credentials')
      .withIndex('by_connection_key', (q) =>
        q.eq('providerConnectionId', conn!._id).eq('credentialKey', 'api_key')
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        encryptedValue: args.jinxxyApiKeyEncrypted,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('provider_credentials', {
        providerConnectionId: conn._id,
        providerKey: 'jinxxy' as any,
        credentialKey: 'api_key',
        kind: 'api_key',
        status: 'active',
        encryptedValue: args.jinxxyApiKeyEncrypted,
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(conn._id, { updatedAt: now });
  },
});

/**
 * Clear Jinxxy API key for a creator.
 */
export const clearJinxxyApiKey = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', 'jinxxy')
      )
      .first();
    if (!conn) return;
    const cred = await ctx.db
      .query('provider_credentials')
      .withIndex('by_connection_key', (q) =>
        q.eq('providerConnectionId', conn._id).eq('credentialKey', 'api_key')
      )
      .first();
    if (cred) {
      await ctx.db.patch(cred._id, { encryptedValue: undefined, updatedAt: now });
    }
  },
});
