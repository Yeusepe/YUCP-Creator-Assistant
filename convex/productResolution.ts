/**
 * Product Resolution - Resolve catalog products by URL
 *
 * Used for cross-server verification: creator pastes a product link,
 * we normalize it, hash it, and look up in catalog_product_links.
 */

import { query } from './_generated/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';

/**
 * Normalize a product URL for consistent hashing.
 * Lowercase, trim, remove trailing slash, strip common query params that don't affect product identity.
 */
function normalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url.trim().toLowerCase());
    // Remove trailing slash from pathname
    let path = parsed.pathname.replace(/\/+$/, '') || '/';
    // Rebuild with just origin + path (ignore query/hash for product identity)
    return `${parsed.origin}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Compute SHA-256 hash of a string (for urlHash).
 * Uses Web Crypto API (available in Convex runtime).
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve a catalog product by URL.
 * Returns the catalog product and link if found; null otherwise.
 */
export const resolveProductByUrl = query({
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
      tenantId: v.id('tenants'),
      status: v.string(),
    }),
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
      tenantId: catalogProduct.tenantId,
      status: catalogProduct.status,
    };
  },
});
