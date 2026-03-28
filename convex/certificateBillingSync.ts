import { Polar } from '@polar-sh/sdk';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action, internalAction, internalMutation, internalQuery } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import {
  type CertificateBillingCatalogBenefit,
  normalizeCertificateBillingCatalogBenefit,
  normalizeCertificateBillingCatalogProduct,
  POLAR_CERTIFICATE_BILLING_DOMAIN,
  POLAR_CERTIFICATE_DOMAIN_METADATA_KEY,
  type CertificateBillingCatalogProduct,
} from './lib/certificateBillingCatalog';
import { getCertificateBillingConfig } from './lib/certificateBillingConfig';
import {
  toCertificateBillingProjectionBenefitGrant,
  toCertificateBillingProjectionMeter,
  toCertificateBillingProjectionSubscription,
} from './lib/certificateBillingProjection';

const CATALOG_STALE_MS = 5 * 60 * 1000;
const MAX_RECONCILIATIONS_PER_RUN = 25;

function getPolarClient() {
  const config = getCertificateBillingConfig();
  if (!config.polarAccessToken) {
    throw new Error('POLAR_ACCESS_TOKEN is required for certificate billing sync');
  }

  return new Polar({
    accessToken: config.polarAccessToken,
    ...(config.polarServer ? { server: config.polarServer } : {}),
  });
}

async function collectPageItems<T>(iterator: AsyncIterable<{ result: { items: T[] } }>) {
  const items: T[] = [];
  for await (const page of iterator) {
    items.push(...page.result.items);
  }
  return items;
}

export const getCatalogSyncState = internalQuery({
  args: {},
  returns: v.object({
    lastAttemptedAt: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    productCount: v.number(),
    benefitCount: v.number(),
  }),
  handler: async (ctx) => {
    const row = await ctx.db
      .query('creator_billing_catalog_sync_state')
      .withIndex('by_domain', (q) => q.eq('domain', POLAR_CERTIFICATE_BILLING_DOMAIN))
      .first();

    return {
      lastAttemptedAt: row?.lastAttemptedAt,
      lastSyncedAt: row?.lastSyncedAt,
      lastError: row?.lastError,
      productCount: row?.productCount ?? 0,
      benefitCount: row?.benefitCount ?? 0,
    };
  },
});

export const replaceCatalogSnapshot = internalMutation({
  args: {
    products: v.array(
      v.object({
        productId: v.string(),
        slug: v.string(),
        displayName: v.string(),
        description: v.optional(v.string()),
        status: v.union(v.literal('active'), v.literal('archived')),
        sortOrder: v.number(),
        displayBadge: v.optional(v.string()),
        recurringInterval: v.optional(v.string()),
        recurringPriceIds: v.array(v.string()),
        meteredPrices: v.array(
          v.object({
            priceId: v.string(),
            meterId: v.string(),
            meterName: v.string(),
          })
        ),
        benefitIds: v.array(v.string()),
        highlights: v.array(v.string()),
        metadata: v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
      })
    ),
    benefits: v.array(
      v.object({
        benefitId: v.string(),
        type: v.string(),
        description: v.optional(v.string()),
        metadata: v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
        featureFlags: v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
        capabilityKeys: v.array(v.string()),
        capabilityKey: v.optional(v.string()),
        deviceCap: v.optional(v.number()),
        signQuotaPerPeriod: v.optional(v.number()),
        auditRetentionDays: v.optional(v.number()),
        supportTier: v.optional(v.string()),
        tierRank: v.optional(v.number()),
      })
    ),
    attemptedAt: v.number(),
    syncedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existingProducts = await ctx.db.query('creator_billing_catalog_products').collect();
    const existingBenefits = await ctx.db.query('creator_billing_catalog_benefits').collect();
    const existingState = await ctx.db
      .query('creator_billing_catalog_sync_state')
      .withIndex('by_domain', (q) => q.eq('domain', POLAR_CERTIFICATE_BILLING_DOMAIN))
      .first();

    await Promise.all(existingProducts.map((row) => ctx.db.delete(row._id)));
    await Promise.all(existingBenefits.map((row) => ctx.db.delete(row._id)));

    for (const product of args.products) {
      await ctx.db.insert('creator_billing_catalog_products', {
        ...product,
        syncedAt: args.syncedAt ?? now,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const benefit of args.benefits) {
      await ctx.db.insert('creator_billing_catalog_benefits', {
        ...benefit,
        syncedAt: args.syncedAt ?? now,
        createdAt: now,
        updatedAt: now,
      });
    }

    const statePatch = {
      domain: POLAR_CERTIFICATE_BILLING_DOMAIN,
      lastAttemptedAt: args.attemptedAt,
      lastSyncedAt: args.syncedAt,
      lastError: args.lastError,
      productCount: args.products.length,
      benefitCount: args.benefits.length,
      updatedAt: now,
    };

    if (existingState) {
      await ctx.db.patch(existingState._id, statePatch);
    } else {
      await ctx.db.insert('creator_billing_catalog_sync_state', {
        ...statePatch,
        createdAt: now,
      });
    }
  },
});

export const recordCatalogSyncFailure = internalMutation({
  args: {
    attemptedAt: v.number(),
    lastError: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existingState = await ctx.db
      .query('creator_billing_catalog_sync_state')
      .withIndex('by_domain', (q) => q.eq('domain', POLAR_CERTIFICATE_BILLING_DOMAIN))
      .first();

    const existingProductCount = await ctx.db.query('creator_billing_catalog_products').collect();
    const existingBenefitCount = await ctx.db.query('creator_billing_catalog_benefits').collect();

    const statePatch = {
      domain: POLAR_CERTIFICATE_BILLING_DOMAIN,
      lastAttemptedAt: args.attemptedAt,
      lastError: args.lastError,
      productCount: existingProductCount.length,
      benefitCount: existingBenefitCount.length,
      updatedAt: now,
    };

    if (existingState) {
      await ctx.db.patch(existingState._id, statePatch);
      return;
    }

    await ctx.db.insert('creator_billing_catalog_sync_state', {
      ...statePatch,
      createdAt: now,
    });
  },
});

export const syncCatalog = internalAction({
  args: {
    reason: v.optional(v.string()),
  },
  returns: v.object({
    synced: v.boolean(),
    productCount: v.number(),
    benefitCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const attemptedAt = Date.now();

    try {
      const polar = getPolarClient();
      const rawProducts = await collectPageItems(
        await polar.products.list({
          limit: 100,
          metadata: {
            [POLAR_CERTIFICATE_DOMAIN_METADATA_KEY]: POLAR_CERTIFICATE_BILLING_DOMAIN,
          },
        })
      );

      const products = rawProducts
        .map((product) => normalizeCertificateBillingCatalogProduct(product))
        .filter((product): product is CertificateBillingCatalogProduct => product !== null);
      const benefitById = new Map<string, CertificateBillingCatalogBenefit>();
      for (const product of rawProducts) {
        for (const benefit of product.benefits ?? []) {
          const normalized = normalizeCertificateBillingCatalogBenefit(benefit);
          benefitById.set(normalized.benefitId, normalized);
        }
      }

      const syncedAt = Date.now();
      await ctx.runMutation(internal.certificateBillingSync.replaceCatalogSnapshot, {
        products,
        benefits: [...benefitById.values()],
        attemptedAt,
        syncedAt,
      });

      return {
        synced: true,
        productCount: products.length,
        benefitCount: benefitById.size,
      };
    } catch (error) {
      await ctx.runMutation(internal.certificateBillingSync.recordCatalogSyncFailure, {
        attemptedAt,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

export const ensureCatalogFresh = action({
  args: {
    apiSecret: v.string(),
    maxAgeMs: v.optional(v.number()),
  },
  returns: v.object({
    synced: v.boolean(),
    productCount: v.number(),
    benefitCount: v.number(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ synced: boolean; productCount: number; benefitCount: number }> => {
    requireApiSecret(args.apiSecret);
    const state = await ctx.runQuery(internal.certificateBillingSync.getCatalogSyncState, {});
    const maxAgeMs = args.maxAgeMs ?? CATALOG_STALE_MS;
    const now = Date.now();
    const needsSync =
      state.productCount === 0 || !state.lastSyncedAt || now - state.lastSyncedAt > maxAgeMs;

    if (!needsSync) {
      return {
        synced: false,
        productCount: state.productCount,
        benefitCount: state.benefitCount,
      };
    }

    return await ctx.runAction(internal.certificateBillingSync.syncCatalog, {
      reason: 'stale_read',
    });
  },
});

export const scheduleCatalogSync = internalMutation({
  args: {
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.certificateBillingSync.syncCatalog, {
      reason: args.reason,
    });
  },
});

export const scheduleReconciliationTarget = internalMutation({
  args: {
    authUserId: v.string(),
    polarCustomerId: v.optional(v.string()),
    delayMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const nextRunAt = now + Math.max(args.delayMs ?? 0, 0);
    const existing = await ctx.db
      .query('creator_billing_reconciliation_targets')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        polarCustomerId: args.polarCustomerId ?? existing.polarCustomerId,
        nextRunAt: Math.min(existing.nextRunAt, nextRunAt),
        lastRequestedAt: now,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.insert('creator_billing_reconciliation_targets', {
      authUserId: args.authUserId,
      polarCustomerId: args.polarCustomerId,
      nextRunAt,
      lastRequestedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listDueReconciliationTargets = internalQuery({
  args: {
    now: v.number(),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      id: v.id('creator_billing_reconciliation_targets'),
      authUserId: v.string(),
      polarCustomerId: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('creator_billing_reconciliation_targets')
      .withIndex('by_next_run_at', (q) => q.lte('nextRunAt', args.now))
      .take(args.limit);

    return rows.map((row) => ({
      id: row._id,
      authUserId: row.authUserId,
      polarCustomerId: row.polarCustomerId,
    }));
  },
});

export const markReconciliationResult = internalMutation({
  args: {
    id: v.id('creator_billing_reconciliation_targets'),
    success: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) {
      return;
    }

    const now = Date.now();
    if (args.success) {
      await ctx.db.patch(row._id, {
        lastSucceededAt: now,
        lastError: undefined,
        nextRunAt: now + 60 * 60 * 1000,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.patch(row._id, {
      lastError: args.error,
      nextRunAt: now + 15 * 60 * 1000,
      updatedAt: now,
    });
  },
});

export const reconcileCustomerState = internalAction({
  args: {
    authUserId: v.string(),
    polarCustomerId: v.optional(v.string()),
  },
  returns: v.object({
    reconciled: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const polar = getPolarClient();
    const state = await polar.customers.getStateExternal({
      externalId: args.authUserId,
    });

    await ctx.runMutation(internal.certificateBilling.projectCustomerStateChanged, {
      authUserId: args.authUserId,
      polarCustomerId: state.id,
      customerEmail: state.email,
      activeSubscriptions: state.activeSubscriptions.map(
        toCertificateBillingProjectionSubscription
      ),
      grantedBenefits: state.grantedBenefits.map(toCertificateBillingProjectionBenefitGrant),
      activeMeters: state.activeMeters.map(toCertificateBillingProjectionMeter),
    });

    return { reconciled: true };
  },
});

export const reconcileDueCustomers = internalAction({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? MAX_RECONCILIATIONS_PER_RUN, 100));
    const due = await ctx.runQuery(internal.certificateBillingSync.listDueReconciliationTargets, {
      now: Date.now(),
      limit,
    });

    let processed = 0;
    for (const target of due) {
      try {
        await ctx.runAction(internal.certificateBillingSync.reconcileCustomerState, {
          authUserId: target.authUserId,
          polarCustomerId: target.polarCustomerId,
        });
        await ctx.runMutation(internal.certificateBillingSync.markReconciliationResult, {
          id: target.id,
          success: true,
        });
        processed += 1;
      } catch (error) {
        await ctx.runMutation(internal.certificateBillingSync.markReconciliationResult, {
          id: target.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { processed };
  },
});

export const ingestUsageEvent = internalAction({
  args: {
    authUserId: v.string(),
    workspaceKey: v.string(),
    certNonce: v.string(),
  },
  returns: v.object({ ingested: v.boolean() }),
  handler: async (_ctx, args) => {
    const polar = getPolarClient();
    await polar.events.ingest({
      events: [
        {
          name: 'signature.recorded',
          externalCustomerId: args.authUserId,
          externalId: `signature.recorded:${args.certNonce}:${crypto.randomUUID()}`,
          metadata: {
            quantity: 1,
            workspace_key: args.workspaceKey,
            cert_nonce: args.certNonce,
          },
        },
      ],
    });
    return { ingested: true };
  },
});
