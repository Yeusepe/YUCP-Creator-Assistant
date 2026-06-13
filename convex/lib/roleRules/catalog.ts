/**
 * Business logic for addCatalogProduct mutation.
 *
 * Kept in a lib helper so the Convex export in role_rules.ts stays a thin wrapper
 * while this file can be tested and reasoned about independently.
 */

import type { GenericMutationCtx } from 'convex/server';
import { internal } from '../../_generated/api';
import type { DataModel, Doc, Id } from '../../_generated/dataModel';
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
  thumbnailUrl?: string;
  canonicalSlug?: string;
  aliases?: readonly string[];
}

function normalizeCatalogIdentityString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeCatalogAliases(aliases?: readonly string[]): string[] | undefined {
  if (!aliases?.length) {
    return undefined;
  }

  const normalizedAliases: string[] = [];
  const seen = new Set<string>();
  for (const alias of aliases) {
    const normalizedAlias = normalizeCatalogIdentityString(alias);
    if (!normalizedAlias || seen.has(normalizedAlias)) {
      continue;
    }
    seen.add(normalizedAlias);
    normalizedAliases.push(normalizedAlias);
  }

  return normalizedAliases.length > 0 ? normalizedAliases : undefined;
}

function areCatalogAliasesEqual(left?: readonly string[], right?: readonly string[]): boolean {
  const normalizedLeft = normalizeCatalogAliases(left);
  const normalizedRight = normalizeCatalogAliases(right);
  if (!normalizedLeft && !normalizedRight) {
    return true;
  }
  if (!normalizedLeft || !normalizedRight || normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export async function addCatalogProductImpl(
  ctx: MutationCtx,
  args: AddCatalogProductArgs
): Promise<{ productId: string; catalogProductId: Id<'product_catalog'> }> {
  requireApiSecret(args.apiSecret);
  const now = Date.now();
  const canonicalSlug = normalizeCatalogIdentityString(args.canonicalSlug);
  const aliases = normalizeCatalogAliases(args.aliases);

  const existing = await ctx.db
    .query('product_catalog')
    .withIndex('by_provider_ref', (q) =>
      q.eq('provider', args.provider).eq('providerProductRef', args.providerProductRef)
    )
    .filter((q) => q.eq(q.field('authUserId'), args.authUserId))
    .first();

  if (existing) {
    const patch: Partial<Doc<'product_catalog'>> = {};
    if (args.displayName && existing.displayName !== args.displayName) {
      patch.displayName = args.displayName;
    }
    if (args.thumbnailUrl && existing.thumbnailUrl !== args.thumbnailUrl) {
      patch.thumbnailUrl = args.thumbnailUrl;
    }
    if (canonicalSlug && existing.canonicalSlug !== canonicalSlug) {
      patch.canonicalSlug = canonicalSlug;
    }
    if (aliases && !areCatalogAliasesEqual(existing.aliases, aliases)) {
      patch.aliases = aliases;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
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
    ...(canonicalSlug ? { canonicalSlug } : {}),
    displayName: args.displayName,
    thumbnailUrl: args.thumbnailUrl,
    ...(aliases ? { aliases } : {}),
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
