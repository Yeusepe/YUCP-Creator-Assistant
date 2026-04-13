/**
 * Product Resolution - Resolve catalog products by URL
 *
 * Used for cross-server verification: creator pastes a product link,
 * we normalize it, hash it, and look up in catalog_product_links.
 */

import { sha256Hex } from '@yucp/shared/crypto';
import { v } from 'convex/values';
import { internalQuery, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { ProviderV } from './lib/providers';

/**
 * Normalize a product URL for consistent hashing.
 * Lowercase, trim, remove trailing slash, strip common query params that don't affect product identity.
 */
function normalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url.trim().toLowerCase());
    // Remove trailing slash from pathname
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    // Rebuild with just origin + path (ignore query/hash for product identity)
    return `${parsed.origin}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Resolve a catalog product by URL.
 * Returns the catalog product and link if found; null otherwise.
 * Internal only, exposes authUserId to unauthenticated callers if public.
 */
export const resolveProductByUrl = internalQuery({
  args: {
    url: v.string(),
  },
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
 * Get all active products registered for a tenant.
 * Used by the Discord bot product picker for license key verification.
 * Returns Gumroad and Jinxxy products with their provider refs.
 */
export const getProductsForTenant = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.array(
    v.object({
      _id: v.id('product_catalog'),
      productId: v.string(),
      provider: ProviderV,
      providerProductRef: v.string(),
      canonicalSlug: v.optional(v.string()),
      displayName: v.optional(v.string()),
      lastSyncedAt: v.optional(v.number()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const products = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    const freshestByCatalogId = new Map<string, number>();
    await Promise.all(
      products.map(async (product) => {
        const mappings = await ctx.db
          .query('provider_catalog_mappings')
          .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', product._id))
          .collect();
        const freshest = mappings.reduce<number | undefined>((current, mapping) => {
          const candidate = mapping.lastSyncedAt ?? mapping.updatedAt;
          if (candidate === undefined) return current;
          return current === undefined ? candidate : Math.max(current, candidate);
        }, undefined);
        if (freshest !== undefined) {
          freshestByCatalogId.set(String(product._id), freshest);
        }
      })
    );

    return products.map((p) => ({
      _id: p._id,
      productId: p.productId,
      provider: p.provider,
      providerProductRef: p.providerProductRef,
      canonicalSlug: p.canonicalSlug,
      displayName: p.displayName,
      lastSyncedAt: freshestByCatalogId.get(String(p._id)) ?? p.updatedAt,
    }));
  },
});
