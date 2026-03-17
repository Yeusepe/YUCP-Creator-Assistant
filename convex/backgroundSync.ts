/**
 * Background Sync - Historical backfill, retroactive account linking, retroactive rule sync
 *
 * Implements three flows:
 * 1. Historical backfill: When a product is added, fetch past purchases from Gumroad/Jinxxy and ingest into purchase_facts
 * 2. Retroactive account linking: When a user links Gumroad/Jinxxy, find their past purchases and grant entitlements
 * 3. Retroactive product rule: When a new role rule is added, create role_sync jobs for all users with entitlements
 */

import { ConvexError, v } from 'convex/values';
import { PROVIDER_KEYS } from '../packages/shared/src/providers';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
} from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';

/** Normalized purchase record for batch ingestion */
const BackfillPurchaseRecord = v.object({
  authUserId: v.string(),
  provider: v.string(),
  externalOrderId: v.string(),
  externalLineItemId: v.optional(v.string()),
  buyerEmailNormalized: v.optional(v.string()),
  buyerEmailHash: v.optional(v.string()),
  providerUserId: v.optional(v.string()),
  providerProductId: v.string(),
  paymentStatus: v.string(),
  lifecycleStatus: v.union(
    v.literal('active'),
    v.literal('refunded'),
    v.literal('cancelled'),
    v.literal('disputed')
  ),
  purchasedAt: v.number(),
});

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build a provider-agnostic source reference string for entitlement evidence.
 * Gumroad uses a simple format; all other providers use provider:orderId[:lineItemId].
 */
function buildSourceRef(provider: string, orderId: string, lineItemId?: string): string {
  if (provider === 'gumroad') return `gumroad:${orderId}`;
  return lineItemId ? `${provider}:${orderId}:${lineItemId}` : `${provider}:${orderId}`;
}

// ============================================================================
// 1. HISTORICAL BACKFILL
// ============================================================================

/**
 * Internal action: Backfill purchase_facts from Gumroad/Jinxxy API.
 * Calls BACKFILL_API_URL to perform the actual fetch (API has decryption keys).
 * If BACKFILL_API_URL is not set, no-ops.
 */
export const backfillProductPurchases = internalAction({
  args: {
    authUserId: v.string(),
    productId: v.string(),
    provider: v.string(),
    providerProductRef: v.string(),
  },
  handler: async (ctx, args) => {
    const apiUrl = process.env.BACKFILL_API_URL;
    if (!apiUrl) {
      return; // No-op when API URL not configured
    }

    const apiSecret = process.env.CONVEX_API_SECRET;
    if (!apiSecret) {
      throw new Error('CONVEX_API_SECRET required for backfill');
    }

    const url = `${apiUrl.replace(/\/$/, '')}/api/internal/backfill-product`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiSecret,
        authUserId: args.authUserId,
        productId: args.productId,
        provider: args.provider,
        providerProductRef: args.providerProductRef,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Backfill API failed: ${res.status} ${text}`);
    }

    await ctx.runMutation(internal.backgroundSync.projectBackfilledPurchasesForProduct, {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: args.provider,
      providerProductRef: args.providerProductRef,
    });
  },
});

/**
 * Public mutation: Ingest a batch of purchase records into purchase_facts.
 * Called by the backfill API route. Idempotent via by_auth_user_provider_order.
 */
export const ingestBackfillPurchaseFactsBatch = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: v.string(),
    purchases: v.array(BackfillPurchaseRecord),
  },
  returns: v.object({
    inserted: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    if (!(PROVIDER_KEYS as readonly string[]).includes(args.provider)) {
      throw new ConvexError('Invalid provider');
    }
    const now = Date.now();
    const MAX_FUTURE_MS = 5 * 60 * 1000;
    let inserted = 0;
    let skipped = 0;

    for (const p of args.purchases) {
      if (p.purchasedAt > now + MAX_FUTURE_MS) {
        throw new ConvexError('purchasedAt cannot be more than 5 minutes in the future');
      }
      // No lower-bound check here: backfill is explicitly for historical purchases of any age.
      const existing = await ctx.db
        .query('purchase_facts')
        .withIndex('by_auth_user_provider_order', (q) =>
          q
            .eq('authUserId', args.authUserId)
            .eq('provider', args.provider)
            .eq('externalOrderId', p.externalOrderId)
        )
        .filter((q) =>
          p.externalLineItemId
            ? q.eq(q.field('externalLineItemId'), p.externalLineItemId)
            : q.eq(q.field('externalLineItemId'), undefined)
        )
        .first();

      if (existing) {
        skipped++;
        continue;
      }

      await ctx.db.insert('purchase_facts', {
        authUserId: args.authUserId,
        provider: args.provider,
        externalOrderId: p.externalOrderId,
        externalLineItemId: p.externalLineItemId,
        buyerEmailNormalized: p.buyerEmailNormalized,
        buyerEmailHash: p.buyerEmailHash,
        providerUserId: p.providerUserId,
        providerProductId: p.providerProductId,
        paymentStatus: p.paymentStatus,
        lifecycleStatus: p.lifecycleStatus,
        purchasedAt: p.purchasedAt,
        createdAt: now,
        updatedAt: now,
      });
      inserted++;
    }

    return { inserted, skipped };
  },
});

// ============================================================================
// 2. RETROACTIVE ACCOUNT LINKING
// ============================================================================

/**
 * Internal action: Trigger backfill for tenant's Gumroad products, then sync past purchases.
 * Used when a Gumroad buyer connects and purchase_facts may be empty (backfill not yet run).
 * Ensures purchase_facts is populated before syncPastPurchasesForSubject runs.
 */
export const triggerBackfillThenSyncForGumroadBuyer = internalAction({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    providerUserId: v.string(),
    emailHash: v.string(),
  },
  handler: async (ctx, args) => {
    const products = await ctx.runQuery(internal.backgroundSync.getGumroadProductsForTenant, {
      authUserId: args.authUserId,
    });

    for (const p of products) {
      await ctx.runAction(internal.backgroundSync.backfillProductPurchases, {
        authUserId: args.authUserId,
        productId: p.productId,
        provider: 'gumroad',
        providerProductRef: p.providerProductRef,
      });
    }

    await ctx.runAction(internal.backgroundSync.syncPastPurchasesForSubject, {
      subjectId: args.subjectId,
      provider: 'gumroad',
      providerUserId: args.providerUserId,
      emailHash: args.emailHash,
    });
  },
});

/**
 * Public mutation: Schedule backfill + sync when a Gumroad buyer connects.
 * Call from API verification callback to ensure purchase_facts is populated before sync.
 */
export const scheduleBackfillThenSyncForGumroadBuyer = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    providerUserId: v.string(),
    emailHash: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await ctx.scheduler.runAfter(
      0,
      internal.backgroundSync.triggerBackfillThenSyncForGumroadBuyer,
      {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        providerUserId: args.providerUserId,
        emailHash: args.emailHash,
      }
    );
  },
});

/** Internal query: Get Gumroad products for a tenant */
export const getGumroadProductsForTenant = internalQuery({
  args: { authUserId: v.string() },
  returns: v.array(
    v.object({
      productId: v.string(),
      providerProductRef: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const catalog = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('provider'), 'gumroad'))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    return catalog.map((c) => ({
      productId: c.productId,
      providerProductRef: c.providerProductRef,
    }));
  },
});

/** Internal query: Get Jinxxy products for a creator */
export const getJinxxyProductsForTenant = internalQuery({
  args: { authUserId: v.string() },
  returns: v.array(
    v.object({
      productId: v.string(),
      providerProductRef: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const catalog = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('provider'), 'jinxxy'))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    return catalog.map((c) => ({
      productId: c.productId,
      providerProductRef: c.providerProductRef,
    }));
  },
});

/** Internal query: Get LemonSqueezy products for a creator */
export const getLSProductsForTenant = internalQuery({
  args: { authUserId: v.string() },
  returns: v.array(
    v.object({
      productId: v.string(),
      providerProductRef: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const catalog = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('provider'), 'lemonsqueezy'))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    return catalog.map((c) => ({
      productId: c.productId,
      providerProductRef: c.providerProductRef,
    }));
  },
});

/**
 * Internal action: Trigger backfill for tenant's Jinxxy products, then sync past purchases.
 * Mirrors triggerBackfillThenSyncForGumroadBuyer for Jinxxy.
 */
export const triggerBackfillThenSyncForJinxxyBuyer = internalAction({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    providerUserId: v.string(),
    emailHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const products = await ctx.runQuery(internal.backgroundSync.getJinxxyProductsForTenant, {
      authUserId: args.authUserId,
    });

    for (const p of products) {
      await ctx.runAction(internal.backgroundSync.backfillProductPurchases, {
        authUserId: args.authUserId,
        productId: p.productId,
        provider: 'jinxxy',
        providerProductRef: p.providerProductRef,
      });
    }

    await ctx.runAction(internal.backgroundSync.syncPastPurchasesForSubject, {
      subjectId: args.subjectId,
      provider: 'jinxxy',
      providerUserId: args.providerUserId,
      emailHash: args.emailHash,
    });
  },
});

/**
 * Internal action: Trigger backfill for tenant's LemonSqueezy products, then sync past purchases.
 * Mirrors triggerBackfillThenSyncForGumroadBuyer for LemonSqueezy.
 */
export const triggerBackfillThenSyncForLSBuyer = internalAction({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    providerUserId: v.string(),
    emailHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const products = await ctx.runQuery(internal.backgroundSync.getLSProductsForTenant, {
      authUserId: args.authUserId,
    });

    for (const p of products) {
      await ctx.runAction(internal.backgroundSync.backfillProductPurchases, {
        authUserId: args.authUserId,
        productId: p.productId,
        provider: 'lemonsqueezy',
        providerProductRef: p.providerProductRef,
      });
    }

    await ctx.runAction(internal.backgroundSync.syncPastPurchasesForSubject, {
      subjectId: args.subjectId,
      provider: 'lemonsqueezy',
      providerUserId: args.providerUserId,
      emailHash: args.emailHash,
    });
  },
});

/**
 * Public mutation: Generic schedule for buyer backfill+sync after license key verification.
 * Dispatches to the correct provider-specific internal action.
 * Both Jinxxy and LemonSqueezy license handlers call this after successful verification.
 * Adding a new provider = add one internalAction above + one dispatch case here.
 */
export const scheduleBackfillThenSyncForBuyer = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    provider: v.string(),
    providerUserId: v.string(),
    emailHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    if (args.provider === 'jinxxy') {
      await ctx.scheduler.runAfter(
        0,
        internal.backgroundSync.triggerBackfillThenSyncForJinxxyBuyer,
        {
          authUserId: args.authUserId,
          subjectId: args.subjectId,
          providerUserId: args.providerUserId,
          emailHash: args.emailHash,
        }
      );
    } else if (args.provider === 'lemonsqueezy') {
      await ctx.scheduler.runAfter(0, internal.backgroundSync.triggerBackfillThenSyncForLSBuyer, {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        providerUserId: args.providerUserId,
        emailHash: args.emailHash,
      });
    }
    // Other providers: no-op (Gumroad has its own scheduleBackfillThenSyncForGumroadBuyer)
  },
});

/**
 * Internal action: Sync past purchases for a subject who just linked Gumroad/Jinxxy.
 * Queries purchase_facts by emailHash, resolves productId, grants entitlements.
 */
export const syncPastPurchasesForSubject = internalAction({
  args: {
    subjectId: v.id('subjects'),
    provider: v.string(),
    providerUserId: v.string(),
    emailHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const apiSecret = process.env.CONVEX_API_SECRET;
    if (!apiSecret) {
      throw new Error('CONVEX_API_SECRET required for syncPastPurchasesForSubject');
    }

    // Fetch purchase facts: by emailHash if available, otherwise by providerUserId
    type PurchaseFact = {
      authUserId: string;
      provider: string;
      externalOrderId: string;
      externalLineItemId?: string;
      providerProductId: string;
      lifecycleStatus: string;
      purchasedAt: number;
    };
    let purchases: PurchaseFact[];
    if (args.emailHash) {
      purchases = await ctx.runQuery(internal.backgroundSync.getPurchasesByEmailHash, {
        emailHash: args.emailHash,
      });
    } else {
      purchases = await ctx.runQuery(internal.backgroundSync.getPurchasesByProviderUserId, {
        provider: args.provider,
        providerUserId: args.providerUserId,
      });
    }

    for (const p of purchases) {
      if (p.lifecycleStatus !== 'active') continue;
      if (p.provider !== args.provider) continue;

      const catalog = await ctx.runQuery(internal.backgroundSync.resolveCatalogProduct, {
        authUserId: p.authUserId,
        provider: args.provider,
        providerProductId: p.providerProductId,
      });

      const productId = catalog?.productId ?? p.providerProductId;
      const catalogProductId = catalog?.catalogProductId;
      const sourceRef = buildSourceRef(args.provider, p.externalOrderId, p.externalLineItemId);

      await ctx.runMutation(api.entitlements.grantEntitlement, {
        apiSecret,
        authUserId: p.authUserId,
        subjectId: args.subjectId,
        productId,
        catalogProductId,
        evidence: {
          provider: args.provider,
          sourceReference: sourceRef,
          purchasedAt: p.purchasedAt,
        },
      });
    }
  },
});

/** Internal query: Get purchases by email hash */
export const getPurchasesByEmailHash = internalQuery({
  args: { emailHash: v.string() },
  returns: v.array(
    v.object({
      authUserId: v.string(),
      provider: v.string(),
      externalOrderId: v.string(),
      externalLineItemId: v.optional(v.string()),
      providerProductId: v.string(),
      lifecycleStatus: v.string(),
      purchasedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const facts = await ctx.db
      .query('purchase_facts')
      .withIndex('by_email_hash', (q) => q.eq('buyerEmailHash', args.emailHash))
      .collect();

    return facts.map((f) => ({
      authUserId: f.authUserId,
      provider: f.provider,
      externalOrderId: f.externalOrderId,
      externalLineItemId: f.externalLineItemId,
      providerProductId: f.providerProductId,
      lifecycleStatus: f.lifecycleStatus,
      purchasedAt: f.purchasedAt,
    }));
  },
});

/** Internal query: Get purchases by providerUserId (for providers without email, e.g. Jinxxy) */
export const getPurchasesByProviderUserId = internalQuery({
  args: { provider: v.string(), providerUserId: v.string() },
  returns: v.array(
    v.object({
      authUserId: v.string(),
      provider: v.string(),
      externalOrderId: v.string(),
      externalLineItemId: v.optional(v.string()),
      providerProductId: v.string(),
      lifecycleStatus: v.string(),
      purchasedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const facts = await ctx.db
      .query('purchase_facts')
      .withIndex('by_provider_user', (q) =>
        q.eq('provider', args.provider).eq('providerUserId', args.providerUserId)
      )
      .collect();

    return facts.map((f) => ({
      authUserId: f.authUserId,
      provider: f.provider,
      externalOrderId: f.externalOrderId,
      externalLineItemId: f.externalLineItemId,
      providerProductId: f.providerProductId,
      lifecycleStatus: f.lifecycleStatus,
      purchasedAt: f.purchasedAt,
    }));
  },
});

/** Internal query: Resolve catalog product by tenant + provider ref */
export const resolveCatalogProduct = internalQuery({
  args: {
    authUserId: v.string(),
    provider: v.string(),
    providerProductId: v.string(),
  },
  returns: v.union(
    v.object({
      productId: v.string(),
      catalogProductId: v.id('product_catalog'),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const catalog = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('provider'), args.provider))
      .filter((q) => q.eq(q.field('providerProductRef'), args.providerProductId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (!catalog) return null;
    return {
      productId: catalog.productId,
      catalogProductId: catalog._id,
    };
  },
});

/**
 * Internal mutation: project entitlements from backfilled purchases for a specific product.
 * This closes the gap where product-add backfill populated purchase_facts but never
 * translated them into entitlements for users who had already linked their accounts.
 */
export const projectBackfilledPurchasesForProduct = internalMutation({
  args: {
    authUserId: v.string(),
    productId: v.string(),
    provider: v.string(),
    providerProductRef: v.string(),
  },
  returns: v.object({
    purchaseFactsFound: v.number(),
    linkedToSubject: v.number(),
    entitlementsGranted: v.number(),
    skippedInactive: v.number(),
    unresolved: v.number(),
  }),
  handler: async (ctx, args) => {
    const apiSecret = process.env.CONVEX_API_SECRET;
    if (!apiSecret) {
      throw new Error('CONVEX_API_SECRET required for projectBackfilledPurchasesForProduct');
    }

    const purchaseFacts = await ctx.db
      .query('purchase_facts')
      .withIndex('by_auth_user_product', (q) =>
        q.eq('authUserId', args.authUserId).eq('providerProductId', args.providerProductRef)
      )
      .filter((q) => q.eq(q.field('provider'), args.provider))
      .collect();

    const catalog = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('provider'), args.provider))
      .filter((q) => q.eq(q.field('providerProductRef'), args.providerProductRef))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    const productId = catalog?.productId ?? args.productId;
    const catalogProductId = catalog?._id;

    let linkedToSubject = 0;
    let entitlementsGranted = 0;
    let skippedInactive = 0;
    let unresolved = 0;

    for (const purchaseFact of purchaseFacts) {
      if (purchaseFact.lifecycleStatus !== 'active') {
        skippedInactive++;
        continue;
      }

      let subjectId = purchaseFact.subjectId;
      if (!subjectId) {
        subjectId = await findSubjectByEmailHash(ctx, args.authUserId, purchaseFact.buyerEmailHash);
      }

      if (!subjectId && purchaseFact.providerUserId) {
        subjectId = await findSubjectByProviderUserId(
          ctx,
          args.authUserId,
          args.provider,
          purchaseFact.providerUserId
        );
      }

      if (!subjectId) {
        unresolved++;
        continue;
      }

      if (purchaseFact.subjectId !== subjectId) {
        await ctx.db.patch(purchaseFact._id, {
          subjectId,
          updatedAt: Date.now(),
        });
        linkedToSubject++;
      }

      const sourceReference = buildSourceRef(
        args.provider,
        purchaseFact.externalOrderId,
        purchaseFact.externalLineItemId
      );

      const grantResult = await ctx.runMutation(api.entitlements.grantEntitlement, {
        apiSecret,
        authUserId: args.authUserId,
        subjectId,
        productId,
        catalogProductId,
        evidence: {
          provider: args.provider,
          sourceReference,
          purchasedAt: purchaseFact.purchasedAt,
        },
      });

      if (grantResult.isNew || grantResult.previousStatus) {
        entitlementsGranted++;
      }
    }

    return {
      purchaseFactsFound: purchaseFacts.length,
      linkedToSubject,
      entitlementsGranted,
      skippedInactive,
      unresolved,
    };
  },
});

async function findSubjectByEmailHash(
  ctx: MutationCtx,
  authUserId: string,
  emailHash: string | undefined
): Promise<Id<'subjects'> | undefined> {
  if (!emailHash) return undefined;

  const externalAccounts = await ctx.db
    .query('external_accounts')
    .withIndex('by_email_hash', (q) => q.eq('emailHash', emailHash))
    .filter((q) => q.eq(q.field('status'), 'active'))
    .collect();

  for (const externalAccount of externalAccounts) {
    const binding = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_external', (q) =>
        q.eq('authUserId', authUserId).eq('externalAccountId', externalAccount._id)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (binding) {
      return binding.subjectId;
    }
  }

  return undefined;
}

async function findSubjectByProviderUserId(
  ctx: MutationCtx,
  authUserId: string,
  provider: string,
  providerUserId: string
): Promise<Id<'subjects'> | undefined> {
  const externalAccount = await ctx.db
    .query('external_accounts')
    .withIndex('by_provider_user', (q) =>
      q.eq('provider', provider).eq('providerUserId', providerUserId)
    )
    .filter((q) => q.eq(q.field('status'), 'active'))
    .first();

  if (!externalAccount) {
    return undefined;
  }

  const binding = await ctx.db
    .query('bindings')
    .withIndex('by_auth_user_external', (q) =>
      q.eq('authUserId', authUserId).eq('externalAccountId', externalAccount._id)
    )
    .filter((q) => q.eq(q.field('status'), 'active'))
    .first();

  return binding?.subjectId;
}

// ============================================================================
// 3. RETROACTIVE PRODUCT RULE
// ============================================================================

/**
 * Public mutation: Process retroactive_rule_sync job.
 * Queries entitlements for the product, creates role_sync jobs for each.
 * Called by the bot when it sees a retroactive_rule_sync job.
 */
export const processRetroactiveRuleSyncJob = mutation({
  args: {
    apiSecret: v.string(),
    jobId: v.id('outbox_jobs'),
    authUserId: v.string(),
    productId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    roleSyncJobsCreated: v.number(),
    entitlementsFound: v.number(),
    skippedNoDiscordId: v.number(),
    skippedDuplicate: v.number(),
    // For discord_role products: accounts with stored tokens for proactive checking
    discordTokenAccounts: v.optional(
      v.array(
        v.object({
          externalAccountId: v.id('external_accounts'),
          providerUserId: v.string(),
          discordAccessTokenEncrypted: v.string(),
          discordTokenExpiresAt: v.optional(v.number()),
          discordRefreshTokenEncrypted: v.optional(v.string()),
        })
      )
    ),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_product', (q) =>
        q.eq('authUserId', args.authUserId).eq('productId', args.productId)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    let roleSyncJobsCreated = 0;
    let skippedNoDiscordId = 0;
    let skippedDuplicate = 0;

    for (const ent of entitlements) {
      const subject = await ctx.db.get(ent.subjectId);
      const discordUserId = subject?.primaryDiscordUserId;
      if (
        !discordUserId ||
        discordUserId.startsWith('gumroad:') ||
        discordUserId.startsWith('jinxxy:')
      ) {
        skippedNoDiscordId++;
        continue;
      }

      const idempotencyKey = `retroactive_role_sync:${args.jobId}:${ent._id}`;
      const existing = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
        .first();

      if (existing) {
        skippedDuplicate++;
        continue;
      }

      await ctx.db.insert('outbox_jobs', {
        authUserId: args.authUserId,
        jobType: 'role_sync',
        payload: {
          subjectId: ent.subjectId,
          entitlementId: ent._id,
          discordUserId,
        },
        status: 'pending',
        idempotencyKey,
        retryCount: 0,
        maxRetries: 5,
        createdAt: now,
        updatedAt: now,
      });
      roleSyncJobsCreated++;
    }

    // For discord_role products: find Discord accounts with stored OAuth tokens
    // so the bot can proactively check guild membership without re-authorization.
    let discordTokenAccounts:
      | Array<{
          externalAccountId: Id<'external_accounts'>;
          providerUserId: string;
          discordAccessTokenEncrypted: string;
          discordTokenExpiresAt?: number;
          discordRefreshTokenEncrypted?: string;
        }>
      | undefined;

    if (args.productId.startsWith('discord_role:')) {
      const allDiscordAccounts = await ctx.db
        .query('external_accounts')
        .withIndex('by_provider', (q) => q.eq('provider', 'discord'))
        .filter((q) => q.eq(q.field('status'), 'active'))
        .collect();

      discordTokenAccounts = allDiscordAccounts
        .filter((a) => a.discordAccessTokenEncrypted)
        .map((a) => ({
          externalAccountId: a._id,
          providerUserId: a.providerUserId,
          discordAccessTokenEncrypted: a.discordAccessTokenEncrypted as string,
          discordTokenExpiresAt: a.discordTokenExpiresAt,
          discordRefreshTokenEncrypted: a.discordRefreshTokenEncrypted,
        }));
    }

    await ctx.db.patch(args.jobId, {
      status: 'completed',
      updatedAt: now,
    });

    return {
      success: true,
      roleSyncJobsCreated,
      entitlementsFound: entitlements.length,
      skippedNoDiscordId,
      skippedDuplicate,
      discordTokenAccounts,
    };
  },
});
