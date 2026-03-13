/**
 * Creator Profiles - Creator organizations (user-first architecture)
 *
 * Creator profiles are created when a creator completes onboarding (e.g. Discord bot install).
 * All creator-scoped data (verification sessions, guild links, entitlements) references a creator
 * profile via authUserId (Better Auth user ID).
 *
 * Requires CONVEX_API_SECRET for API-to-Convex calls.
 */

import { v } from 'convex/values';
import { components } from './_generated/api';
import { internalQuery, mutation, query } from './_generated/server';

const PolicyInput = v.optional(
  v.object({
    maxBindingsPerProduct: v.optional(v.number()),
    allowTransfer: v.optional(v.boolean()),
    transferCooldownHours: v.optional(v.number()),
    allowSharedUse: v.optional(v.boolean()),
    maxUnityInstallations: v.optional(v.number()),
    autoVerifyOnJoin: v.optional(v.boolean()),
    revocationBehavior: v.optional(v.string()),
    gracePeriodHours: v.optional(v.number()),
    requireFullProductLinkSetOnSetup: v.optional(v.boolean()),
    allowCatalogLinkResolution: v.optional(v.boolean()),
    manualReviewRequired: v.optional(v.boolean()),
    discordRoleFreshnessMinutes: v.optional(v.number()),
    allowCatalogBackedVerification: v.optional(v.boolean()),
    autoDiscoverSupportedProductsForRememberedPurchaser: v.optional(v.boolean()),
    // Discord onboarding config
    logChannelId: v.optional(v.string()),
    verificationScope: v.optional(v.union(v.literal('account'), v.literal('license'))),
    shareVerificationWithServers: v.optional(v.boolean()),
    shareVerificationScope: v.optional(v.string()),
    duplicateVerificationBehavior: v.optional(
      v.union(v.literal('block'), v.literal('notify'), v.literal('allow'))
    ),
    duplicateVerificationNotifyChannelId: v.optional(v.string()),
    suspiciousAccountBehavior: v.optional(
      v.union(v.literal('quarantine'), v.literal('notify'), v.literal('revoke'))
    ),
    suspiciousNotifyChannelId: v.optional(v.string()),
    enableDiscordRoleFromOtherServers: v.optional(v.boolean()),
    allowedSourceGuildIds: v.optional(v.array(v.string())),
    allowMismatchedEmails: v.optional(v.boolean()),
  })
);

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/**
 * Create (or return existing) creator profile. Called by API after creator onboarding.
 * Returns the Convex _id of the creator_profiles document.
 */
export const createCreatorProfile = mutation({
  args: {
    apiSecret: v.string(),
    name: v.string(),
    ownerDiscordUserId: v.string(),
    authUserId: v.string(),
    slug: v.optional(v.string()),
    policy: PolicyInput,
  },
  returns: v.id('creator_profiles'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (existing) {
      return existing._id;
    }

    return await ctx.db.insert('creator_profiles', {
      authUserId: args.authUserId,
      name: args.name,
      ownerDiscordUserId: args.ownerDiscordUserId,
      slug: args.slug,
      status: 'active',
      policy: args.policy,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Get creator profile by slug. Used for human-friendly URL resolution.
 */
export const getCreatorBySlug = query({
  args: {
    apiSecret: v.string(),
    slug: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('creator_profiles'),
      _creationTime: v.number(),
      authUserId: v.string(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      slug: v.optional(v.string()),
      status: v.string(),
      policy: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .first();
    return profile ?? null;
  },
});

/**
 * Get creator profile by authUserId.
 */
export const getCreatorProfile = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('creator_profiles'),
      _creationTime: v.number(),
      authUserId: v.string(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      slug: v.optional(v.string()),
      status: v.string(),
      policy: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
  },
});

/**
 * Update creator policy (partial). Used by bot during onboarding.
 */
export const updateCreatorPolicy = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    policy: PolicyInput,
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!profile) throw new Error('Creator profile not found');
    const now = Date.now();
    const merged = {
      ...profile.policy,
      ...args.policy,
    };
    await ctx.db.patch(profile._id, {
      policy: merged,
      updatedAt: now,
    });
  },
});

/**
 * Upsert Jinxxy API key for a creator (delegates to creator_provider_config).
 * Used by bot during setup.
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
 * Get creator profile by authUserId. Used when creator logs in.
 */
export const getCreatorByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('creator_profiles'),
      _creationTime: v.number(),
      authUserId: v.string(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      slug: v.optional(v.string()),
      status: v.string(),
      policy: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
  },
});

/**
 * Get Discord user ID from Better Auth user ID.
 * Finds the linked Discord OAuth account via the Better Auth component adapter.
 * Must be internalQuery since it calls an internal component function.
 */
export const getDiscordUserIdFromAuthUser = internalQuery({
  args: {
    authUserId: v.string(),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'account',
      where: [
        { field: 'userId', operator: 'eq', value: args.authUserId },
        { field: 'providerId', operator: 'eq', value: 'discord', connector: 'AND' },
      ],
      paginationOpts: { cursor: null, numItems: 1 },
    });

    if (result?.page?.length > 0) {
      return result.page[0].accountId as string;
    }

    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (subject) {
      return subject.primaryDiscordUserId;
    }

    return null;
  },
});
