/**
 * Background Sync - Historical backfill, retroactive account linking, retroactive rule sync
 *
 * Implements three flows:
 * 1. Historical backfill: When a product is added, fetch past purchases from Gumroad/Jinxxy and ingest into purchase_facts
 * 2. Retroactive account linking: When a user links Gumroad/Jinxxy, find their past purchases and grant entitlements
 * 3. Retroactive product rule: When a new role rule is added, create role_sync jobs for all users with entitlements
 */

import { internalAction, internalMutation, internalQuery, mutation } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/** Normalized purchase record for batch ingestion */
const BackfillPurchaseRecord = v.object({
  tenantId: v.id('tenants'),
  provider: v.union(v.literal('gumroad'), v.literal('jinxxy')),
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
    v.literal('disputed')
  ),
  purchasedAt: v.number(),
});

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
    tenantId: v.id('tenants'),
    productId: v.string(),
    provider: v.union(v.literal('gumroad'), v.literal('jinxxy')),
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
        tenantId: args.tenantId,
        productId: args.productId,
        provider: args.provider,
        providerProductRef: args.providerProductRef,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Backfill API failed: ${res.status} ${text}`);
    }
  },
});

/**
 * Public mutation: Ingest a batch of purchase records into purchase_facts.
 * Called by the backfill API route. Idempotent via by_tenant_provider_order.
 */
export const ingestBackfillPurchaseFactsBatch = mutation({
  args: {
    apiSecret: v.string(),
    tenantId: v.id('tenants'),
    provider: v.union(v.literal('gumroad'), v.literal('jinxxy')),
    purchases: v.array(BackfillPurchaseRecord),
  },
  returns: v.object({
    inserted: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    let inserted = 0;
    let skipped = 0;

    for (const p of args.purchases) {
      const existing = await ctx.db
        .query('purchase_facts')
        .withIndex('by_tenant_provider_order', (q) =>
          q
            .eq('tenantId', args.tenantId)
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
        tenantId: args.tenantId,
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
 * Internal action: Sync past purchases for a subject who just linked Gumroad/Jinxxy.
 * Queries purchase_facts by emailHash, resolves productId, grants entitlements.
 */
export const syncPastPurchasesForSubject = internalAction({
  args: {
    subjectId: v.id('subjects'),
    provider: v.union(v.literal('gumroad'), v.literal('jinxxy')),
    providerUserId: v.string(),
    emailHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.emailHash) return;

    const apiSecret = process.env.CONVEX_API_SECRET;
    if (!apiSecret) {
      throw new Error('CONVEX_API_SECRET required for syncPastPurchasesForSubject');
    }

    const purchases = await ctx.runQuery(
      internal.backgroundSync.getPurchasesByEmailHash,
      { emailHash: args.emailHash }
    );

    for (const p of purchases) {
      if (p.lifecycleStatus !== 'active') continue;

      const catalog = await ctx.runQuery(
        internal.backgroundSync.resolveCatalogProduct,
        {
          tenantId: p.tenantId,
          provider: args.provider,
          providerProductId: p.providerProductId,
        }
      );

      const productId = catalog?.productId ?? p.providerProductId;
      const catalogProductId = catalog?.catalogProductId;
      const sourceRef =
        args.provider === 'gumroad'
          ? `gumroad:${p.externalOrderId}`
          : `jinxxy:${p.externalOrderId}:${p.externalLineItemId ?? p.externalOrderId}`;

      await ctx.runMutation(api.entitlements.grantEntitlement, {
        apiSecret,
        tenantId: p.tenantId,
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
      tenantId: v.id('tenants'),
      provider: v.union(v.literal('gumroad'), v.literal('jinxxy')),
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
      tenantId: f.tenantId,
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
    tenantId: v.id('tenants'),
    provider: v.union(v.literal('gumroad'), v.literal('jinxxy')),
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
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
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
    tenantId: v.id('tenants'),
    productId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    roleSyncJobsCreated: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_product', (q) =>
        q.eq('tenantId', args.tenantId).eq('productId', args.productId)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    let roleSyncJobsCreated = 0;

    for (const ent of entitlements) {
      const subject = await ctx.db.get(ent.subjectId);
      const discordUserId = subject?.primaryDiscordUserId;
      if (
        !discordUserId ||
        discordUserId.startsWith('gumroad:') ||
        discordUserId.startsWith('jinxxy:')
      ) {
        continue;
      }

      const idempotencyKey = `retroactive_role_sync:${args.jobId}:${ent._id}`;
      const existing = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
        .first();

      if (existing) continue;

      await ctx.db.insert('outbox_jobs', {
        tenantId: args.tenantId,
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

    await ctx.db.patch(args.jobId, {
      status: 'completed',
      updatedAt: now,
    });

    return { success: true, roleSyncJobsCreated };
  },
});
