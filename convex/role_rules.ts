/**
 * Role Rules - Maps products to Discord roles
 *
 * Role rules define which Discord role should be assigned when a user
 * has an active entitlement for a specific product.
 *
 * Key features:
 * - Multiple rules per product (for multi-guild setups)
 * - Priority ordering for conflicting rules
 * - Enable/disable toggle
 * - Optional removal on entitlement revoke
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { addCatalogProductImpl } from './lib/roleRules/catalog';
import { addProductFromDiscordRoleImpl, buildDiscordRoleKey } from './lib/roleRules/discord';
import { normalizeProductUrl, requireApiSecret, sha256Hex } from './lib/roleRules/queries';

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get all role rules for a tenant.
 */
export const getByTenant = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const rules = await ctx.db
      .query('role_rules')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .order('asc')
      .take(1000);

    return rules;
  },
});

/**
 * Get enabled verification providers based on products added to a guild.
 * Used by the Discord bot to show only relevant verify buttons and smart messaging.
 * Returns which verification methods are available based on role rules (products) for this guild.
 */
export const getEnabledVerificationProvidersFromProducts = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
  },
  returns: v.object({
    providers: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    const rules = await ctx.db
      .query('role_rules')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', args.authUserId).eq('guildId', args.guildId)
      )
      .filter((q) => q.eq(q.field('enabled'), true))
      .take(1000);

    const providerSet = new Set<string>();
    let hasDiscordRole = false;

    for (const rule of rules) {
      if (rule.productId.startsWith('discord_role:')) {
        hasDiscordRole = true;
        continue;
      }
      if (rule.catalogProductId) {
        const catalog = await ctx.db.get(rule.catalogProductId);
        if (catalog?.provider) {
          providerSet.add(catalog.provider);
        }
      }
    }

    // Discord "Use Another Server" also requires tenant policy
    if (hasDiscordRole && profile?.policy?.enableDiscordRoleFromOtherServers === true) {
      providerSet.add('discord');
    }

    return { providers: [...providerSet] };
  },
});

/**
 * Get VRChat product_catalog entries for a tenant where providerProductRef is in ownedAvatarIds.
 * Used by complete-vrchat API to build productsToGrant for retroactive verification.
 */
export const getVrchatCatalogProductsMatchingAvatars = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    ownedAvatarIds: v.array(v.string()),
  },
  returns: v.array(
    v.object({
      productId: v.string(),
      catalogProductId: v.id('product_catalog'),
      providerProductRef: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const ownedSet = new Set(args.ownedAvatarIds.map((id) => id.toLowerCase()));
    const catalogs = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.and(q.eq(q.field('provider'), 'vrchat'), q.eq(q.field('status'), 'active')))
      .take(1000);
    const matches: Array<{
      productId: string;
      catalogProductId: Id<'product_catalog'>;
      providerProductRef: string;
    }> = [];
    for (const c of catalogs) {
      if (ownedSet.has(c.providerProductRef.toLowerCase())) {
        matches.push({
          productId: c.productId,
          catalogProductId: c._id,
          providerProductRef: c.providerProductRef,
        });
      }
    }
    return matches;
  },
});

/**
 * Get role rules for a specific guild.
 */
export const getByGuild = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const rules = await ctx.db
      .query('role_rules')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', args.authUserId).eq('guildId', args.guildId)
      )
      .order('asc')
      .take(1000);

    return rules;
  },
});

/**
 * Get unique products for a guild with display names for autocomplete.
 * For catalog products: uses canonicalSlug or providerProductRef from product_catalog.
 * For Discord role products: uses displayName stored at add-time; null for legacy entries (bot enriches at display-time).
 */
export const getByGuildWithProductNames = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
  },
  returns: v.array(
    v.object({
      productId: v.string(),
      displayName: v.union(v.string(), v.null()),
      provider: v.optional(v.string()),
      sourceGuildId: v.optional(v.string()),
      requiredRoleId: v.optional(v.string()),
      requiredRoleIds: v.optional(v.array(v.string())),
      requiredRoleMatchMode: v.optional(v.union(v.literal('any'), v.literal('all'))),
      verifiedRoleId: v.optional(v.string()),
      verifiedRoleIds: v.optional(v.array(v.string())),
      enabled: v.optional(v.boolean()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const rules = await ctx.db
      .query('role_rules')
      .withIndex('by_auth_user_guild', (q) =>
        q.eq('authUserId', args.authUserId).eq('guildId', args.guildId)
      )
      .order('asc')
      .take(1000);

    const seen = new Set<string>();
    const result: Array<{
      productId: string;
      displayName: string | null;
      provider?: string;
      sourceGuildId?: string;
      requiredRoleId?: string;
      requiredRoleIds?: string[];
      requiredRoleMatchMode?: 'any' | 'all';
      verifiedRoleId?: string;
      verifiedRoleIds?: string[];
      enabled?: boolean;
    }> = [];

    for (const r of rules) {
      if (seen.has(r.productId)) continue;
      seen.add(r.productId);

      let displayName: string | null = null;
      let provider: string | undefined;
      if (r.catalogProductId) {
        const catalog = await ctx.db.get(r.catalogProductId);
        if (catalog) {
          displayName =
            catalog.displayName ??
            catalog.canonicalSlug ??
            catalog.providerProductRef ??
            r.productId;
          provider = catalog.provider;
        }
      }
      // For discord_role products: fall back to the name stored at add time
      if (!displayName) {
        displayName = r.displayName ?? null;
      }
      if (!provider) {
        provider = r.productId.startsWith('discord_role:') ? 'discord' : 'manual';
      }

      result.push({
        productId: r.productId,
        displayName,
        provider,
        sourceGuildId: r.sourceGuildId,
        requiredRoleId: r.requiredRoleId,
        requiredRoleIds: r.requiredRoleIds,
        requiredRoleMatchMode: r.requiredRoleMatchMode,
        verifiedRoleId: r.verifiedRoleId,
        verifiedRoleIds: r.verifiedRoleIds,
        enabled: r.enabled,
      });
    }

    return result;
  },
});

/**
 * Get role rules for a specific product.
 * Used by the role sync service to determine which roles to add.
 */
export const getByProduct = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    productId: v.string(),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const rules = await ctx.db
      .query('role_rules')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('productId'), args.productId))
      .filter((q) => q.eq(q.field('enabled'), true))
      .order('asc')
      .take(1000);

    return rules;
  },
});

/**
 * Get role rules by guild link.
 */
export const getByGuildLink = query({
  args: {
    apiSecret: v.string(),
    guildLinkId: v.id('guild_links'),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const rules = await ctx.db
      .query('role_rules')
      .withIndex('by_guild_link', (q) => q.eq('guildLinkId', args.guildLinkId))
      .order('asc')
      .take(1000);

    return rules;
  },
});

/**
 * Get role rules by catalog product.
 */
export const getByCatalogProduct = query({
  args: {
    apiSecret: v.string(),
    catalogProductId: v.id('product_catalog'),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const rules = await ctx.db
      .query('role_rules')
      .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', args.catalogProductId))
      .take(1000);

    return rules;
  },
});

/**
 * Get Discord cross-server role rules for a tenant.
 * Returns rules with sourceGuildId and requiredRoleId set.
 * Optionally filter by sourceGuildIds (e.g. allowedSourceGuildIds from policy).
 */
export const getDiscordRoleRulesByTenant = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    sourceGuildIds: v.optional(v.array(v.string())),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    let rules = await ctx.db
      .query('role_rules')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('enabled'), true))
      .take(1000);

    rules = rules.filter(
      (r) =>
        r.sourceGuildId != null &&
        (r.requiredRoleId != null || (r.requiredRoleIds != null && r.requiredRoleIds.length > 0))
    );

    if (args.sourceGuildIds && args.sourceGuildIds.length > 0) {
      const allowed = new Set(args.sourceGuildIds);
      rules = rules.filter((r) => r.sourceGuildId && allowed.has(r.sourceGuildId));
    }

    return rules;
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new role rule.
 */
export const createRoleRule = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
    guildLinkId: v.id('guild_links'),
    productId: v.string(),
    catalogProductId: v.optional(v.id('product_catalog')),
    verifiedRoleId: v.optional(v.string()),
    verifiedRoleIds: v.optional(v.array(v.string())),
    removeOnRevoke: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    enabled: v.optional(v.boolean()),
  },
  returns: v.object({
    ruleId: v.id('role_rules'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const link = await ctx.db.get(args.guildLinkId);
    if (!link || link.authUserId !== args.authUserId) {
      throw new ConvexError('Unauthorized: caller does not own this guild link');
    }
    const now = Date.now();
    const roleIds = args.verifiedRoleIds ?? (args.verifiedRoleId ? [args.verifiedRoleId] : []);
    if (roleIds.length === 0) {
      throw new Error('At least one verified role is required');
    }
    const verifiedRoleId = roleIds[0];

    const ruleId = await ctx.db.insert('role_rules', {
      authUserId: args.authUserId,
      guildId: args.guildId,
      guildLinkId: args.guildLinkId,
      productId: args.productId,
      catalogProductId: args.catalogProductId,
      verifiedRoleId,
      verifiedRoleIds: roleIds.length > 1 ? roleIds : undefined,
      removeOnRevoke: args.removeOnRevoke ?? true,
      priority: args.priority ?? 0,
      enabled: args.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });

    const idempotencyKey = `retroactive_rule_sync:${args.authUserId}:${args.productId}`;
    const existingJob = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
      .first();
    if (!existingJob) {
      await ctx.db.insert('outbox_jobs', {
        authUserId: args.authUserId,
        jobType: 'retroactive_rule_sync',
        payload: { authUserId: args.authUserId, productId: args.productId },
        status: 'pending',
        idempotencyKey,
        retryCount: 0,
        maxRetries: 5,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { ruleId };
  },
});

/**
 * Update an existing role rule.
 */
export const updateRoleRule = mutation({
  args: {
    apiSecret: v.string(),
    ruleId: v.id('role_rules'),
    verifiedRoleId: v.optional(v.string()),
    verifiedRoleIds: v.optional(v.array(v.string())),
    removeOnRevoke: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    enabled: v.optional(v.boolean()),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const rule = await ctx.db.get(args.ruleId);
    if (!rule) {
      throw new Error(`Role rule not found: ${args.ruleId}`);
    }

    const update: Record<string, unknown> = {
      updatedAt: Date.now(),
    };

    if (args.verifiedRoleIds !== undefined) {
      if (args.verifiedRoleIds.length === 0) {
        throw new Error('At least one verified role is required');
      }
      update.verifiedRoleId = args.verifiedRoleIds[0];
      update.verifiedRoleIds = args.verifiedRoleIds.length > 1 ? args.verifiedRoleIds : undefined;
    } else if (args.verifiedRoleId !== undefined) {
      update.verifiedRoleId = args.verifiedRoleId;
      update.verifiedRoleIds = undefined;
    }
    if (args.removeOnRevoke !== undefined) {
      update.removeOnRevoke = args.removeOnRevoke;
    }
    if (args.priority !== undefined) {
      update.priority = args.priority;
    }
    if (args.enabled !== undefined) {
      update.enabled = args.enabled;
    }

    await ctx.db.patch(args.ruleId, update);

    return { success: true };
  },
});

/**
 * Delete a role rule and clean up orphaned catalog entries.
 */
export const deleteRoleRule = mutation({
  args: {
    apiSecret: v.string(),
    ruleId: v.id('role_rules'),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const rule = await ctx.db.get(args.ruleId);
    if (!rule) {
      throw new Error(`Role rule not found: ${args.ruleId}`);
    }

    await ctx.db.delete(args.ruleId);

    // If this rule had a catalogProductId, check if any other rules still reference it
    if (rule.catalogProductId) {
      const remainingRefs = await ctx.db
        .query('role_rules')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', rule.catalogProductId!))
        .first();

      // If no other rules reference this catalog product, purge it to keep the picker clean
      if (!remainingRefs) {
        // Find and delete associated links first
        const links = await ctx.db
          .query('catalog_product_links')
          .filter((q) => q.eq(q.field('catalogProductId'), rule.catalogProductId!))
          .take(1000);

        for (const link of links) {
          await ctx.db.delete(link._id);
        }

        // Then delete the catalog entry itself
        await ctx.db.delete(rule.catalogProductId);
      }
    }

    return { success: true };
  },
});

/**
 * Get or create product catalog entry for Gumroad product. Returns productId and catalogProductId.
 */
export const addProductFromGumroad = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    productId: v.string(),
    providerProductRef: v.string(),
    canonicalSlug: v.optional(v.string()),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    productId: v.string(),
    catalogProductId: v.id('product_catalog'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q.eq('provider', 'gumroad').eq('providerProductRef', args.providerProductRef)
      )
      .first();

    if (existing) {
      // Update displayName if we now have one and it was previously missing
      if (args.displayName && !existing.displayName) {
        await ctx.db.patch(existing._id, { displayName: args.displayName, updatedAt: now });
      }
      await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
        authUserId: args.authUserId,
        productId: args.productId,
        provider: 'gumroad',
        providerProductRef: args.providerProductRef,
      });
      return { productId: existing.productId, catalogProductId: existing._id };
    }

    const catalogId = await ctx.db.insert('product_catalog', {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: 'gumroad',
      providerProductRef: args.providerProductRef,
      canonicalSlug: args.canonicalSlug,
      displayName: args.displayName,
      status: 'active',
      supportsAutoDiscovery: true,
      createdAt: now,
      updatedAt: now,
    });

    const url = `https://gumroad.com/l/${args.providerProductRef}`;
    const normalized = url.toLowerCase().trim();
    const urlHash = await sha256Hex(normalized);

    await ctx.db.insert('catalog_product_links', {
      catalogProductId: catalogId,
      provider: 'gumroad',
      originalUrl: url,
      normalizedUrl: normalized,
      urlHash,
      linkKind: 'direct_product',
      status: 'active',
      submittedByAuthUserId: args.authUserId,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: 'gumroad',
      providerProductRef: args.providerProductRef,
    });

    return { productId: args.productId, catalogProductId: catalogId };
  },
});

/**
 * Get or create product catalog entry for Jinxxy product.
 */
export const addProductFromJinxxy = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    productId: v.string(),
    providerProductRef: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    productId: v.string(),
    catalogProductId: v.id('product_catalog'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q.eq('provider', 'jinxxy').eq('providerProductRef', args.providerProductRef)
      )
      .first();

    if (existing) {
      if (args.displayName && existing.displayName !== args.displayName) {
        await ctx.db.patch(existing._id, { displayName: args.displayName, updatedAt: now });
      }
      await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
        authUserId: args.authUserId,
        productId: args.productId,
        provider: 'jinxxy',
        providerProductRef: args.providerProductRef,
      });
      return { productId: existing.productId, catalogProductId: existing._id };
    }

    const catalogId = await ctx.db.insert('product_catalog', {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: 'jinxxy',
      providerProductRef: args.providerProductRef,
      displayName: args.displayName,
      status: 'active',
      supportsAutoDiscovery: false,
      createdAt: now,
      updatedAt: now,
    });

    const url = `https://jinxxy.app/products/${args.providerProductRef}`;
    const normalized = url.toLowerCase().trim();
    const urlHash = await sha256Hex(normalized);

    await ctx.db.insert('catalog_product_links', {
      catalogProductId: catalogId,
      provider: 'jinxxy',
      originalUrl: url,
      normalizedUrl: normalized,
      urlHash,
      linkKind: 'direct_product',
      status: 'active',
      submittedByAuthUserId: args.authUserId,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: 'jinxxy',
      providerProductRef: args.providerProductRef,
    });

    return { productId: args.productId, catalogProductId: catalogId };
  },
});

export const addProductFromLemonSqueezy = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    productId: v.string(),
    providerProductRef: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    productId: v.string(),
    catalogProductId: v.id('product_catalog'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q.eq('provider', 'lemonsqueezy').eq('providerProductRef', args.providerProductRef)
      )
      .filter((q) => q.eq(q.field('authUserId'), args.authUserId))
      .first();

    if (existing) {
      if (args.displayName && existing.displayName !== args.displayName) {
        await ctx.db.patch(existing._id, { displayName: args.displayName, updatedAt: now });
      }
      await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
        authUserId: args.authUserId,
        productId: args.productId,
        provider: 'lemonsqueezy',
        providerProductRef: args.providerProductRef,
      });
      return { productId: existing.productId, catalogProductId: existing._id };
    }

    const catalogId = await ctx.db.insert('product_catalog', {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: 'lemonsqueezy',
      providerProductRef: args.providerProductRef,
      displayName: args.displayName,
      status: 'active',
      supportsAutoDiscovery: false,
      createdAt: now,
      updatedAt: now,
    });

    const url = `https://app.lemonsqueezy.com/products/${args.providerProductRef}`;
    const normalized = url.toLowerCase().trim();
    const urlHash = await sha256Hex(normalized);

    await ctx.db.insert('catalog_product_links', {
      catalogProductId: catalogId,
      provider: 'lemonsqueezy',
      originalUrl: url,
      normalizedUrl: normalized,
      urlHash,
      linkKind: 'direct_product',
      status: 'active',
      submittedByAuthUserId: args.authUserId,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: 'lemonsqueezy',
      providerProductRef: args.providerProductRef,
    });

    return { productId: args.productId, catalogProductId: catalogId };
  },
});

/**
 * Generic: get or create a product catalog entry for any catalog-sync provider.
 * Prefer this over provider-specific mutations when the provider key is dynamic.
 * @deprecated Use `addCatalogProduct` instead — it accepts a pre-computed canonicalUrl
 * from the caller (derived from PROVIDER_REGISTRY.catalogProductUrlTemplate).
 */
export const addProductForProvider = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    productId: v.string(),
    providerProductRef: v.string(),
    provider: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    productId: v.string(),
    catalogProductId: v.id('product_catalog'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q.eq('provider', args.provider).eq('providerProductRef', args.providerProductRef)
      )
      .filter((q) => q.eq(q.field('authUserId'), args.authUserId))
      .first();

    if (existing) {
      if (args.displayName && existing.displayName !== args.displayName) {
        await ctx.db.patch(existing._id, { displayName: args.displayName, updatedAt: now });
      }
      await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
        authUserId: args.authUserId,
        productId: args.productId,
        provider: args.provider,
        providerProductRef: args.providerProductRef,
      });
      return { productId: existing.productId, catalogProductId: existing._id };
    }

    const urlBuilders: Record<string, (ref: string) => string> = {
      gumroad: (ref) => `https://gumroad.com/l/${ref}`,
      jinxxy: (ref) => `https://jinxxy.app/products/${ref}`,
      lemonsqueezy: (ref) => `https://app.lemonsqueezy.com/products/${ref}`,
    };
    const buildUrl = urlBuilders[args.provider];
    const url = buildUrl
      ? buildUrl(args.providerProductRef)
      : `https://example.invalid/${args.provider}/${args.providerProductRef}`;
    const normalized = url.toLowerCase().trim();
    const urlHash = await sha256Hex(normalized);

    const catalogId = await ctx.db.insert('product_catalog', {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: args.provider,
      providerProductRef: args.providerProductRef,
      displayName: args.displayName,
      status: 'active',
      supportsAutoDiscovery: args.provider === 'gumroad',
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert('catalog_product_links', {
      catalogProductId: catalogId,
      provider: args.provider,
      originalUrl: url,
      normalizedUrl: normalized,
      urlHash,
      linkKind: 'direct_product',
      status: 'active',
      submittedByAuthUserId: args.authUserId,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: args.provider,
      providerProductRef: args.providerProductRef,
    });

    return { productId: args.productId, catalogProductId: catalogId };
  },
});

/**
 * Generic: upsert a product catalog entry for any catalog-sync provider.
 *
 * The caller (bot/product.ts) is responsible for computing `canonicalUrl` from
 * PROVIDER_REGISTRY.catalogProductUrlTemplate and `supportsAutoDiscovery` from
 * PROVIDER_REGISTRY.supportsAutoDiscovery. This keeps the Convex mutation free
 * from baked provider metadata.
 *
 * Replaces the per-provider mutations (addProductFromGumroad, addProductFromJinxxy,
 * addProductFromLemonSqueezy, addProductFromVrchatCatalog) for the catalog-sync flow.
 * The URL-based flows (addProductFromGumroadUrl, addProductFromVrchat) remain separate
 * because they have distinct logic (slug parsing, avatar ID extraction).
 */
export const addCatalogProduct = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    /** The provider-internal product ID (used as productId in role_rules). */
    productId: v.string(),
    /** The provider-internal product reference (used as providerProductRef in product_catalog). */
    providerProductRef: v.string(),
    provider: v.string(),
    /** Canonical URL for the product page, pre-computed by the caller from PROVIDER_REGISTRY. */
    canonicalUrl: v.string(),
    /** Whether this provider supports auto-discovery via backfill. Pre-computed by caller. */
    supportsAutoDiscovery: v.boolean(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    productId: v.string(),
    catalogProductId: v.id('product_catalog'),
  }),
  handler: (ctx, args) => addCatalogProductImpl(ctx, args),
});

/**
 * Extract VRChat avatar ID from URL or raw ID.
 * Matches avtr_[a-f0-9-]{36} or extracts from vrchat.com/home/avatar/avtr_xxx
 * @see https://vrchat.com/home/avatar/avtr_xxx
 */
function extractVrchatAvatarId(urlOrId: string): string | null {
  const trimmed = urlOrId?.trim() ?? '';
  const directMatch = trimmed.match(/avtr_[a-f0-9-]{36}/i);
  if (directMatch) return directMatch[0];
  const urlMatch = trimmed.match(/vrchat\.com\/home\/avatar\/(avtr_[a-f0-9-]{36})/i);
  return urlMatch ? urlMatch[1] : null;
}

/**
 * Get or create product catalog entry for VRChat avatar.
 * No webhooks/backfill - VRChat has no webhooks.
 */
export const addProductFromVrchat = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    productId: v.string(),
    providerProductRef: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    productId: v.string(),
    catalogProductId: v.id('product_catalog'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const avatarId = extractVrchatAvatarId(args.providerProductRef);
    if (!avatarId) {
      throw new Error(
        'Invalid VRChat avatar URL or ID. Expected avtr_xxx or https://vrchat.com/home/avatar/avtr_xxx'
      );
    }
    const now = Date.now();
    const existing = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q.eq('provider', 'vrchat').eq('providerProductRef', avatarId)
      )
      .first();

    if (existing) {
      if (args.displayName && existing.displayName !== args.displayName) {
        await ctx.db.patch(existing._id, { displayName: args.displayName, updatedAt: now });
      }
      return { productId: existing.productId, catalogProductId: existing._id };
    }

    const catalogId = await ctx.db.insert('product_catalog', {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: 'vrchat',
      providerProductRef: avatarId,
      displayName: args.displayName,
      status: 'active',
      supportsAutoDiscovery: false,
      createdAt: now,
      updatedAt: now,
    });

    const url = `https://vrchat.com/home/avatar/${avatarId}`;
    const normalized = url.toLowerCase().trim();
    const urlHash = await sha256Hex(normalized);

    await ctx.db.insert('catalog_product_links', {
      catalogProductId: catalogId,
      provider: 'vrchat',
      originalUrl: url,
      normalizedUrl: normalized,
      urlHash,
      linkKind: 'direct_product',
      status: 'active',
      submittedByAuthUserId: args.authUserId,
      createdAt: now,
      updatedAt: now,
    });

    return { productId: args.productId, catalogProductId: catalogId };
  },
});

/**
 * Get or create a product catalog entry for a VRChat store listing (catalog flow).
 *
 * The `productId` and `providerProductRef` are VRChat listing IDs (`prod_xxx`).
 * This is distinct from `addProductFromVrchat` which handles avatar IDs (`avtr_xxx`)
 * entered manually by URL.
 *
 * Buyer verification works because `getOwnershipFromSession` collects both `avatar.id`
 * (avtr_xxx) and `avatar.productId` (prod_xxx) from `getLicensedAvatars`.
 * Source: packages/providers/src/vrchat/client.ts — getOwnershipFromSession
 */
export const addProductFromVrchatCatalog = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    productId: v.string(),
    providerProductRef: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    productId: v.string(),
    catalogProductId: v.id('product_catalog'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    if (!args.providerProductRef.startsWith('prod_')) {
      throw new Error(
        `Invalid VRChat catalog product ID. Expected prod_xxx, got: ${args.providerProductRef}`
      );
    }

    const now = Date.now();
    const existing = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q.eq('provider', 'vrchat').eq('providerProductRef', args.providerProductRef)
      )
      .first();

    if (existing) {
      if (args.displayName && existing.displayName !== args.displayName) {
        await ctx.db.patch(existing._id, { displayName: args.displayName, updatedAt: now });
      }
      return { productId: existing.productId, catalogProductId: existing._id };
    }

    const catalogId = await ctx.db.insert('product_catalog', {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: 'vrchat',
      providerProductRef: args.providerProductRef,
      displayName: args.displayName,
      status: 'active',
      supportsAutoDiscovery: false,
      createdAt: now,
      updatedAt: now,
    });

    // Use the VRChat store listing URL as the canonical link
    const url = `https://vrchat.com/store/listing/${args.providerProductRef}`;
    const normalized = url.toLowerCase().trim();
    const urlHash = await sha256Hex(normalized);

    await ctx.db.insert('catalog_product_links', {
      catalogProductId: catalogId,
      provider: 'vrchat',
      originalUrl: url,
      normalizedUrl: normalized,
      urlHash,
      linkKind: 'direct_product',
      status: 'active',
      submittedByAuthUserId: args.authUserId,
      createdAt: now,
      updatedAt: now,
    });

    return { productId: args.productId, catalogProductId: catalogId };
  },
});


/**
 * Get or create a product catalog entry for a Payhip product.
 * The permalink (e.g., "RGsF") is the canonical Payhip product identifier.
 * Does not trigger backfill — Payhip has no purchases API; events arrive via webhooks.
 */
export const addProductFromPayhip = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    /** Payhip product permalink (e.g., "RGsF") */
    permalink: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    productId: v.string(),
    catalogProductId: v.id('product_catalog'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const existing = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q.eq('provider', 'payhip').eq('providerProductRef', args.permalink)
      )
      .first();

    if (existing) {
      if (args.displayName && existing.displayName !== args.displayName) {
        await ctx.db.patch(existing._id, { displayName: args.displayName, updatedAt: now });
      }
      await ctx.scheduler.runAfter(
        0,
        internal.backgroundSync.projectBackfilledPurchasesForProduct,
        {
          authUserId: args.authUserId,
          productId: args.permalink,
          provider: 'payhip',
          providerProductRef: args.permalink,
        }
      );
      return { productId: existing.productId, catalogProductId: existing._id };
    }

    const catalogId = await ctx.db.insert('product_catalog', {
      authUserId: args.authUserId,
      productId: args.permalink,
      provider: 'payhip',
      providerProductRef: args.permalink,
      displayName: args.displayName,
      status: 'active',
      supportsAutoDiscovery: false,
      createdAt: now,
      updatedAt: now,
    });

    const url = `https://payhip.com/b/${args.permalink}`;
    const normalized = url.toLowerCase().trim();
    const urlHash = await sha256Hex(normalized);

    await ctx.db.insert('catalog_product_links', {
      catalogProductId: catalogId,
      provider: 'payhip',
      originalUrl: url,
      normalizedUrl: normalized,
      urlHash,
      linkKind: 'direct_product',
      status: 'active',
      submittedByAuthUserId: args.authUserId,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.backgroundSync.projectBackfilledPurchasesForProduct, {
      authUserId: args.authUserId,
      productId: args.permalink,
      provider: 'payhip',
      providerProductRef: args.permalink,
    });

    return { productId: args.permalink, catalogProductId: catalogId };
  },
});

/**
 * Add a Discord cross-server role rule.
 * Creates a role rule that grants verifiedRoleId(s) when the user has requiredRoleId(s)
 * in the source guild. No product_catalog entry; uses synthetic productId.
 */
export const addProductFromDiscordRole = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    sourceGuildId: v.string(),
    requiredRoleId: v.optional(v.string()),
    requiredRoleIds: v.optional(v.array(v.string())),
    requiredRoleMatchMode: v.optional(v.union(v.literal('any'), v.literal('all'))),
    guildId: v.string(),
    guildLinkId: v.id('guild_links'),
    verifiedRoleId: v.optional(v.string()),
    verifiedRoleIds: v.optional(v.array(v.string())),
    /** Human-readable name (e.g. "Member (My Server)") — resolved by bot at add time */
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    productId: v.string(),
    ruleId: v.id('role_rules'),
  }),
  handler: (ctx, args) => addProductFromDiscordRoleImpl(ctx, args),
});

/**
 * Resolve catalog product by URL (for cross-server verification).
 */
export const resolveProductByUrl = query({
  args: { url: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      catalogProductId: v.id('product_catalog'),
      productId: v.string(),
      provider: v.string(),
      providerProductRef: v.string(),
      authUserId: v.string(),
      status: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const normalized = normalizeProductUrl(args.url);
    const urlHash = await sha256Hex(normalized);
    const link = await ctx.db
      .query('catalog_product_links')
      .withIndex('by_url_hash', (q) => q.eq('urlHash', urlHash))
      .first();
    if (!link || link.status !== 'active') return null;
    const catalogProduct = await ctx.db.get(link.catalogProductId);
    if (!catalogProduct || catalogProduct.status !== 'active') return null;
    return {
      catalogProductId: catalogProduct._id,
      productId: catalogProduct.productId,
      provider: catalogProduct.provider,
      providerProductRef: catalogProduct.providerProductRef,
      authUserId: catalogProduct.authUserId,
      status: catalogProduct.status,
    };
  },
});

/**
 * Bulk create role rules for a guild.
 * Used when setting up role sync for multiple products at once.
 */
export const bulkCreateRoleRules = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
    guildLinkId: v.id('guild_links'),
    rules: v.array(
      v.object({
        productId: v.string(),
        catalogProductId: v.optional(v.id('product_catalog')),
        verifiedRoleId: v.string(),
        removeOnRevoke: v.optional(v.boolean()),
        priority: v.optional(v.number()),
      })
    ),
  },
  returns: v.object({
    createdCount: v.number(),
    ruleIds: v.array(v.id('role_rules')),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const ruleIds: Id<'role_rules'>[] = [];

    const uniqueProductIds = new Set<string>();
    for (const rule of args.rules) {
      const ruleId = await ctx.db.insert('role_rules', {
        authUserId: args.authUserId,
        guildId: args.guildId,
        guildLinkId: args.guildLinkId,
        productId: rule.productId,
        catalogProductId: rule.catalogProductId,
        verifiedRoleId: rule.verifiedRoleId,
        removeOnRevoke: rule.removeOnRevoke ?? true,
        priority: rule.priority ?? 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });

      ruleIds.push(ruleId);
      uniqueProductIds.add(rule.productId);
    }

    for (const productId of uniqueProductIds) {
      const idempotencyKey = `retroactive_rule_sync:${args.authUserId}:${productId}`;
      const existingJob = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
        .first();
      if (!existingJob) {
        await ctx.db.insert('outbox_jobs', {
          authUserId: args.authUserId,
          jobType: 'retroactive_rule_sync',
          payload: { authUserId: args.authUserId, productId },
          status: 'pending',
          idempotencyKey,
          retryCount: 0,
          maxRetries: 5,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return {
      createdCount: ruleIds.length,
      ruleIds,
    };
  },
});

/**
 * List role rules for a creator with optional guildId, productId, and enabled filters.
 */
export const listByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.optional(v.string()),
    productId: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('role_rules')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.guildId !== undefined) {
      all = all.filter((r) => r.guildId === args.guildId);
    }
    if (args.productId !== undefined) {
      all = all.filter((r) => r.productId === args.productId);
    }
    if (args.enabled !== undefined) {
      all = all.filter((r) => r.enabled === args.enabled);
    }
    return all;
  },
});

/**
 * Get a single role rule by ID, scoped to authUserId.
 */
export const getRuleById = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    ruleId: v.id('role_rules'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const doc = await ctx.db.get(args.ruleId);
    if (!doc || doc.authUserId !== args.authUserId) return null;
    return doc;
  },
});
