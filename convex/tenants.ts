/**
 * Tenants - Creator organizations
 *
 * Tenants are created when a creator completes onboarding (e.g. Discord bot install).
 * All tenant-scoped data (verification sessions, guild links, entitlements) references a tenant.
 *
 * Requires CONVEX_API_SECRET for API-to-Convex calls.
 */

import { v } from 'convex/values';
import { components } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalQuery, mutation, query } from './_generated/server';

const SubjectStatus = v.union(
  v.literal('active'),
  v.literal('suspended'),
  v.literal('quarantined'),
  v.literal('deleted')
);

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
 * Create a new tenant. Called by API after creator onboarding (e.g. bot install).
 * Returns the tenant ID for use in verification sessions, guild links, etc.
 */
export const createTenant = mutation({
  args: {
    apiSecret: v.string(),
    name: v.string(),
    ownerDiscordUserId: v.string(),
    ownerAuthUserId: v.string(),
    slug: v.optional(v.string()),
    policy: PolicyInput,
  },
  returns: v.id('tenants'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    // Check for existing tenant by owner
    const existing = await ctx.db
      .query('tenants')
      .withIndex('by_owner_auth', (q) => q.eq('ownerAuthUserId', args.ownerAuthUserId))
      .first();

    if (existing) {
      return existing._id;
    }

    return await ctx.db.insert('tenants', {
      name: args.name,
      ownerDiscordUserId: args.ownerDiscordUserId,
      ownerAuthUserId: args.ownerAuthUserId,
      slug: args.slug,
      status: 'active',
      policy: args.policy,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Get tenant by slug. Used for human-friendly URL resolution (e.g. /tenants/my-creator).
 */
export const getTenantBySlug = query({
  args: {
    apiSecret: v.string(),
    slug: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('tenants'),
      _creationTime: v.number(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      ownerAuthUserId: v.string(),
      slug: v.optional(v.string()),
      status: v.string(),
      policy: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const tenant = await ctx.db
      .query('tenants')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug))
      .first();
    return tenant ?? null;
  },
});

/**
 * Get tenant by ID. Used by API to validate tenant exists before verification.
 */
export const getTenant = query({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('tenants'),
      _creationTime: v.number(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      ownerAuthUserId: v.string(),
      slug: v.optional(v.string()),
      status: v.string(),
      policy: v.optional(v.any()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db.get(args.tenantId);
  },
});

/**
 * Update tenant policy (partial). Used by bot during onboarding.
 */
export const updateTenantPolicy = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    policy: PolicyInput,
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) throw new Error('Tenant not found');
    const now = Date.now();
    const merged = {
      ...tenant.policy,
      ...args.policy,
    };
    await ctx.db.patch(args.tenantId, {
      policy: merged,
      updatedAt: now,
    });
  },
});

/**
 * Upsert Jinxxy API key for a tenant (delegates to tenant_provider_config).
 * Used by bot during setup. Caller stores key as-is; encryption TODO.
 */
export const upsertJinxxyApiKey = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    jinxxyApiKeyEncrypted: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('tenant_provider_config')
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('tenant_provider_config', {
        tenantId: args.tenantId,
        jinxxyApiKeyEncrypted: args.jinxxyApiKeyEncrypted,
        createdAt: now,
        updatedAt: now,
      });
    }
  },
});

/**
 * Get tenant by owner auth user ID. Used when creator logs in to find their tenant.
 */
export const getTenantByOwnerAuth = query({
  args: {
    apiSecret: v.string(),
    ownerAuthUserId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('tenants'),
      _creationTime: v.number(),
      name: v.string(),
      ownerDiscordUserId: v.string(),
      ownerAuthUserId: v.string(),
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
      .query('tenants')
      .withIndex('by_owner_auth', (q) => q.eq('ownerAuthUserId', args.ownerAuthUserId))
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
    // Query the Better Auth component's account model via its adapter
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

    // Fallback: try looking in subjects table
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
