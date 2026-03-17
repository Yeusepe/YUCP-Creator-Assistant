/**
 * Business logic for addCatalogProduct mutation.
 *
 * Kept in a lib helper so the Convex export in role_rules.ts stays a thin wrapper
 * while this file can be tested and reasoned about independently.
 */

import type { GenericMutationCtx } from 'convex/server';
import type { DataModel } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { requireApiSecret, sha256Hex } from './queries';

type MutationCtx = GenericMutationCtx<DataModel>;

export interface AddCatalogProductArgs {
  apiSecret: string;
  authUserId: string;
  productId: string;
  providerProductRef: string;
  provider: string;
  /** Canonical URL for the product page, pre-computed by the caller from PROVIDER_REGISTRY. */
  canonicalUrl: string;
  /** Whether this provider supports auto-discovery via backfill. Pre-computed by caller. */
  supportsAutoDiscovery: boolean;
  displayName?: string;
}

export async function addCatalogProductImpl(
  ctx: MutationCtx,
  args: AddCatalogProductArgs
): Promise<{ productId: string; catalogProductId: Id<'product_catalog'> }> {
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
    if (args.supportsAutoDiscovery) {
      await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
        authUserId: args.authUserId,
        productId: args.productId,
        provider: args.provider,
        providerProductRef: args.providerProductRef,
      });
    }
    return { productId: existing.productId, catalogProductId: existing._id };
  }

  const normalized = args.canonicalUrl.toLowerCase().trim();
  const urlHash = await sha256Hex(normalized);

  const catalogId = await ctx.db.insert('product_catalog', {
    authUserId: args.authUserId,
    productId: args.productId,
    provider: args.provider,
    providerProductRef: args.providerProductRef,
    displayName: args.displayName,
    status: 'active',
    supportsAutoDiscovery: args.supportsAutoDiscovery,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert('catalog_product_links', {
    catalogProductId: catalogId,
    provider: args.provider,
    originalUrl: args.canonicalUrl,
    normalizedUrl: normalized,
    urlHash,
    linkKind: 'direct_product',
    status: 'active',
    submittedByAuthUserId: args.authUserId,
    createdAt: now,
    updatedAt: now,
  });

  if (args.supportsAutoDiscovery) {
    await ctx.scheduler.runAfter(0, internal.backgroundSync.backfillProductPurchases, {
      authUserId: args.authUserId,
      productId: args.productId,
      provider: args.provider,
      providerProductRef: args.providerProductRef,
    });
  }

  return { productId: args.productId, catalogProductId: catalogId };
}
