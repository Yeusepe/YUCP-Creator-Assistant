/**
 * Creator Provider Config - Per-creator Jinxxy API key storage
 *
 * Gumroad uses global env vars. Jinxxy keys are per-creator.
 * Caller encrypts the API key before storing; decrypts when fetching.
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
 * Get Jinxxy API key for verification (API-only, requires apiSecret).
 * Returns per-creator key; falls back to null if creator has none configured.
 */
export const getJinxxyApiKeyForVerification = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const config = await ctx.db
      .query('creator_provider_config')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!config?.jinxxyApiKeyEncrypted) return null;
    return config.jinxxyApiKeyEncrypted;
  },
});

/**
 * Get creator provider config (for API/bot to fetch Jinxxy key).
 */
export const getCreatorProviderConfig = query({
  args: {
    authUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      jinxxyApiKeyEncrypted: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query('creator_provider_config')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (!config) return null;
    return {
      jinxxyApiKeyEncrypted: config.jinxxyApiKeyEncrypted,
    };
  },
});

/**
 * Upsert Jinxxy API key for a creator.
 * Caller must encrypt the key before passing; we store as-is.
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

    const existing = await ctx.db
      .query('creator_provider_config')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('creator_provider_config', {
        authUserId: args.authUserId,
        jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted,
        createdAt: now,
        updatedAt: now,
      });
    }
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

    const existing = await ctx.db
      .query('creator_provider_config')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        jinxxyApiKeyEncrypted: undefined,
        updatedAt: now,
      });
    }
  },
});
