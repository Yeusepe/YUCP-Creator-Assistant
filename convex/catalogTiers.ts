import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { ProviderV } from './lib/providers';

function parsePurchaseSourceReference(sourceReference: string): {
  provider: string;
  externalOrderId: string;
  externalLineItemId?: string;
} | null {
  const [provider, externalOrderId, externalLineItemId] = sourceReference.split(':');
  if (!provider || !externalOrderId) {
    return null;
  }
  return {
    provider,
    externalOrderId,
    externalLineItemId: externalLineItemId || undefined,
  };
}

export const upsertCatalogTier = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: ProviderV,
    productId: v.string(),
    catalogProductId: v.optional(v.id('product_catalog')),
    providerProductRef: v.string(),
    providerTierRef: v.string(),
    displayName: v.string(),
    description: v.optional(v.string()),
    amountCents: v.optional(v.number()),
    currency: v.optional(v.string()),
    status: v.optional(v.union(v.literal('active'), v.literal('archived'))),
    metadata: v.optional(v.any()),
  },
  returns: v.id('catalog_tiers'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const existing = await ctx.db
      .query('catalog_tiers')
      .withIndex('by_provider_tier_ref', (q) =>
        q
          .eq('authUserId', args.authUserId)
          .eq('provider', args.provider)
          .eq('providerTierRef', args.providerTierRef)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        productId: args.productId,
        catalogProductId: args.catalogProductId ?? existing.catalogProductId,
        providerProductRef: args.providerProductRef,
        displayName: args.displayName,
        description: args.description ?? existing.description,
        amountCents: args.amountCents ?? existing.amountCents,
        currency: args.currency ?? existing.currency,
        status: args.status ?? existing.status,
        metadata: args.metadata ?? existing.metadata,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('catalog_tiers', {
      authUserId: args.authUserId,
      provider: args.provider,
      productId: args.productId,
      catalogProductId: args.catalogProductId,
      providerProductRef: args.providerProductRef,
      providerTierRef: args.providerTierRef,
      displayName: args.displayName,
      description: args.description,
      amountCents: args.amountCents,
      currency: args.currency,
      status: args.status ?? 'active',
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getByCatalogProduct = query({
  args: {
    apiSecret: v.string(),
    catalogProductId: v.id('product_catalog'),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db
      .query('catalog_tiers')
      .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', args.catalogProductId))
      .order('asc')
      .take(200);
  },
});

export const getCatalogTier = query({
  args: {
    apiSecret: v.string(),
    catalogTierId: v.id('catalog_tiers'),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db.get(args.catalogTierId);
  },
});

export const getActiveCatalogTierIdsForEntitlement = query({
  args: {
    apiSecret: v.string(),
    entitlementId: v.id('entitlements'),
  },
  returns: v.array(v.id('catalog_tiers')),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const entitlement = await ctx.db.get(args.entitlementId);
    if (!entitlement || entitlement.status !== 'active') {
      return [];
    }

    const evidenceRows = await ctx.db
      .query('entitlement_evidence')
      .withIndex('by_source_reference', (q) =>
        q
          .eq('providerKey', entitlement.sourceProvider)
          .eq('sourceReference', entitlement.sourceReference)
      )
      .filter((q) => q.eq(q.field('authUserId'), entitlement.authUserId))
      .take(20);

    const providerTierRefs = new Set<string>();
    for (const evidence of evidenceRows) {
      if (evidence.status !== 'active') {
        continue;
      }

      if (evidence.transactionId) {
        const transaction = await ctx.db.get(evidence.transactionId);
        if (transaction?.externalVariantId) {
          providerTierRefs.add(transaction.externalVariantId);
        }
      }
      if (evidence.membershipId) {
        const membership = await ctx.db.get(evidence.membershipId);
        if (membership?.externalVariantId) {
          providerTierRefs.add(membership.externalVariantId);
        }
        const membershipTierRefs = membership?.metadata?.activeTierRefs;
        if (Array.isArray(membershipTierRefs)) {
          for (const providerTierRef of membershipTierRefs) {
            if (typeof providerTierRef === 'string' && providerTierRef.trim()) {
              providerTierRefs.add(providerTierRef.trim());
            }
          }
        }
      }
      if (evidence.licenseId) {
        const license = await ctx.db.get(evidence.licenseId);
        if (license?.externalVariantId) {
          providerTierRefs.add(license.externalVariantId);
        }
      }
    }

    if (providerTierRefs.size === 0) {
      const purchaseRef = parsePurchaseSourceReference(entitlement.sourceReference);
      if (purchaseRef && purchaseRef.provider === entitlement.sourceProvider) {
        const purchaseFact = await ctx.db
          .query('purchase_facts')
          .withIndex('by_auth_user_provider_order', (q) =>
            q
              .eq('authUserId', entitlement.authUserId)
              .eq('provider', purchaseRef.provider as typeof entitlement.sourceProvider)
              .eq('externalOrderId', purchaseRef.externalOrderId)
          )
          .filter((q) =>
            purchaseRef.externalLineItemId
              ? q.eq(q.field('externalLineItemId'), purchaseRef.externalLineItemId)
              : q.eq(q.field('externalLineItemId'), undefined)
          )
          .first();
        if (purchaseFact?.externalVariantId) {
          providerTierRefs.add(purchaseFact.externalVariantId);
        }
        if (purchaseFact?.providerProductVersionId) {
          providerTierRefs.add(purchaseFact.providerProductVersionId);
        }
      }
    }

    if (providerTierRefs.size === 0) {
      return [];
    }

    const tierIds: Array<Id<'catalog_tiers'>> = [];
    for (const providerTierRef of providerTierRefs) {
      const catalogTier = await ctx.db
        .query('catalog_tiers')
        .withIndex('by_provider_tier_ref', (q) =>
          q
            .eq('authUserId', entitlement.authUserId)
            .eq('provider', entitlement.sourceProvider)
            .eq('providerTierRef', providerTierRef)
        )
        .first();
      if (catalogTier?._id && catalogTier.status !== 'archived') {
        tierIds.push(catalogTier._id);
      }
    }

    return tierIds;
  },
});
