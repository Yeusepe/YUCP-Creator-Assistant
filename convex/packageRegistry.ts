/**
 * YUCP Package Name Registry, Layer 1 defense.
 *
 * Enforces namespace ownership: the first verified publisher to sign a
 * packageId owns that name permanently. Subsequent signers with a different
 * yucpUserId are rejected, making it impossible to impersonate an existing
 * package by creating a new account.
 *
 * Identity is anchored to the Better Auth user ID (yucpUserId), not to any
 * specific storefront account, so creators with multiple stores all bind to
 * the same stable identity.
 *
 * References:
 *   npm registry ownership model  https://docs.npmjs.com/about-package-naming
 *   Sigstore policy engine         https://docs.sigstore.dev/policy-controller/overview/
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { internalMutation, internalQuery, query } from './_generated/server';
import { ApiActorBindingV, requireApiActor, requireDelegatedAuthUserActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const PACKAGE_NAME_MAX_LENGTH = 120;
const PRODUCT_DELETE_BLOCKED_REASON =
  'Product has package, role, entitlement, or tier history and cannot be deleted.';
const PACKAGE_ARCHIVED_SIGNING_BLOCKED_REASON =
  'Archived packages cannot be updated. Restore the package before signing or changing it.';

function getPackageStatus(
  registration: Pick<Doc<'package_registry'>, 'status'>
): 'active' | 'archived' {
  return registration.status === 'archived' ? 'archived' : 'active';
}

function isArchivedRegistration(registration: Pick<Doc<'package_registry'>, 'status'>): boolean {
  return getPackageStatus(registration) === 'archived';
}

function getCatalogProductWorkspaceStatus(
  product: Pick<Doc<'product_catalog'>, 'status'>
): 'active' | 'archived' {
  return product.status === 'hidden' ? 'archived' : 'active';
}

function normalizePackageName(packageName: string | undefined): string | undefined {
  if (typeof packageName !== 'string') {
    return undefined;
  }
  const normalized = packageName.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > PACKAGE_NAME_MAX_LENGTH) {
    throw new ConvexError(`Package name must be ${PACKAGE_NAME_MAX_LENGTH} characters or fewer`);
  }
  return normalized;
}

async function getProductDeleteBlockedReason(
  ctx: QueryCtx,
  catalogProductId: Id<'product_catalog'>
): Promise<string | undefined> {
  const roleRule = await ctx.db
    .query('role_rules')
    .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', catalogProductId))
    .first();
  if (roleRule) return PRODUCT_DELETE_BLOCKED_REASON;

  const entitlement = await ctx.db
    .query('entitlements')
    .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', catalogProductId))
    .first();
  if (entitlement) return PRODUCT_DELETE_BLOCKED_REASON;

  const tier = await ctx.db
    .query('catalog_tiers')
    .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', catalogProductId))
    .first();
  if (tier) return PRODUCT_DELETE_BLOCKED_REASON;

  return undefined;
}

export const getRegistration = internalQuery({
  args: { packageId: v.string() },
  handler: async (ctx, args): Promise<Doc<'package_registry'> | null> => {
    return await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
  },
});

export const getRegistrationsByYucpUser = internalQuery({
  args: { yucpUserId: v.string() },
  handler: async (ctx, args): Promise<Doc<'package_registry'>[]> => {
    return await ctx.db
      .query('package_registry')
      .withIndex('by_yucp_user_id', (q) => q.eq('yucpUserId', args.yucpUserId))
      .collect();
  },
});

type PackageRegistrationLookupResult = {
  packageId: string;
  yucpUserId: string;
  status: 'active' | 'archived';
} | null;

export const lookupRegistration = query({
  args: { apiSecret: v.string(), actor: ApiActorBindingV, packageId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      packageId: v.string(),
      yucpUserId: v.string(),
      status: v.union(v.literal('active'), v.literal('archived')),
    })
  ),
  handler: async (ctx, args): Promise<PackageRegistrationLookupResult> => {
    requireApiSecret(args.apiSecret);
    await requireApiActor(args.actor);
    const registration = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId: args.packageId,
    });
    if (!registration) {
      return null;
    }
    return {
      packageId: registration.packageId,
      yucpUserId: registration.yucpUserId,
      status: getPackageStatus(registration),
    };
  },
});

export type RegistrationResult =
  | { registered: true; conflict: false; archived: false }
  | { registered: false; conflict: true; archived: false }
  | { registered: false; conflict: false; archived: true; reason: string };

export const registerPackage = internalMutation({
  args: {
    packageId: v.string(),
    packageName: v.optional(v.string()),
    publisherId: v.string(),
    /** Better Auth user ID of the registering creator */
    yucpUserId: v.string(),
  },
  handler: async (ctx, args): Promise<RegistrationResult> => {
    if (!PACKAGE_ID_RE.test(args.packageId)) {
      throw new ConvexError(`Invalid packageId format: ${args.packageId}`);
    }

    const normalizedPackageName = normalizePackageName(args.packageName);
    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();

    if (existing) {
      if (existing.yucpUserId !== args.yucpUserId) {
        return { registered: false, conflict: true, archived: false };
      }
      if (isArchivedRegistration(existing)) {
        return {
          registered: false,
          conflict: false,
          archived: true,
          reason: PACKAGE_ARCHIVED_SIGNING_BLOCKED_REASON,
        };
      }
      await ctx.db.patch(existing._id, {
        publisherId: args.publisherId,
        packageName: normalizedPackageName ?? existing.packageName,
        status: 'active',
        updatedAt: Date.now(),
      });
      return { registered: true, conflict: false, archived: false };
    }

    const now = Date.now();
    await ctx.db.insert('package_registry', {
      packageId: args.packageId,
      packageName: normalizedPackageName,
      publisherId: args.publisherId,
      yucpUserId: args.yucpUserId,
      status: 'active',
      registeredAt: now,
      updatedAt: now,
    });
    return { registered: true, conflict: false, archived: false };
  },
});

/**
 * List product_catalog entries for a creator with optional provider/status filters and pagination.
 */
export const listByAuthUser = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    provider: v.optional(v.string()),
    status: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    let all = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.provider) {
      all = all.filter((product) => product.provider === args.provider);
    }
    if (args.status) {
      all = all.filter(
        (product) =>
          getCatalogProductWorkspaceStatus(product) === args.status ||
          product.status === args.status
      );
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const index = all.findIndex((item) => String(item._id) === args.cursor);
      if (index !== -1) startIndex = index + 1;
    }
    const data = all.slice(startIndex, startIndex + limit);
    const catalogTiers = await ctx.db
      .query('catalog_tiers')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();
    const catalogTiersByProduct = new Map<string, Doc<'catalog_tiers'>[]>();
    for (const tier of catalogTiers) {
      if (!tier.catalogProductId) {
        continue;
      }
      const productKey = String(tier.catalogProductId);
      const existing = catalogTiersByProduct.get(productKey) ?? [];
      existing.push(tier);
      catalogTiersByProduct.set(productKey, existing);
    }
    const hasMore = startIndex + limit < all.length;
    const dataWithCapabilities = await Promise.all(
      data.map(async (product) => {
        const deleteBlockedReason = await getProductDeleteBlockedReason(ctx, product._id);
        const status = getCatalogProductWorkspaceStatus(product);
        return {
          ...product,
          status,
          catalogTiers: (catalogTiersByProduct.get(String(product._id)) ?? []).sort((left, right) =>
            left.displayName.localeCompare(right.displayName)
          ),
          canArchive: status === 'active',
          canRestore: status === 'archived',
          canDelete: deleteBlockedReason === undefined,
          deleteBlockedReason,
        };
      })
    );

    return {
      data: dataWithCapabilities,
      hasMore,
      nextCursor: hasMore ? String(data[data.length - 1]._id) : null,
    };
  },
});

/** Get a single product_catalog entry by ID, scoped to authUserId. */
export const getByIdForAuthUser = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.id('product_catalog'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const doc = await ctx.db.get(args.catalogProductId);
    if (!doc || doc.authUserId !== args.authUserId) return null;
    const catalogTiers = await ctx.db
      .query('catalog_tiers')
      .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', args.catalogProductId))
      .collect();
    return {
      ...doc,
      catalogTiers,
    };
  },
});

async function resolveCatalogProduct(ctx: QueryCtx, ref: string) {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }

  const legacyId = ctx.db.normalizeId('product_catalog', trimmed);
  if (legacyId) {
    return await ctx.db.get(legacyId);
  }

  const bySlug = await ctx.db
    .query('product_catalog')
    .withIndex('by_slug', (q) => q.eq('canonicalSlug', trimmed))
    .take(2);
  const byRef = await ctx.db
    .query('product_catalog')
    .withIndex('by_provider_product_ref', (q) => q.eq('providerProductRef', trimmed))
    .take(2);
  const candidates = new Map<string, (typeof bySlug)[number]>();
  for (const candidate of [...bySlug, ...byRef]) {
    candidates.set(String(candidate._id), candidate);
  }
  return candidates.size === 1 ? (Array.from(candidates.values())[0] ?? null) : null;
}

export const getBuyerAccessContextByCatalogProductId = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    catalogProductId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireApiActor(args.actor);

    const product = await resolveCatalogProduct(ctx, args.catalogProductId);
    if (!product) {
      return null;
    }

    const status = getCatalogProductWorkspaceStatus(product);
    if (status !== 'active') {
      return null;
    }

    const packageVersions = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_catalog_product', (q) =>
        q.eq('catalogProductId', product._id).eq('state', 'READY')
      )
      .collect();
    const packageIds = new Set(packageVersions.map((version) => version.packageId));
    const packageId = packageIds.size === 1 ? packageIds.values().next().value : undefined;

    return {
      catalogProductId: product._id,
      creatorAuthUserId: product.authUserId,
      ...(packageId ? { packageId } : {}),
      productId: product.productId,
      provider: product.provider,
      providerProductRef: product.providerProductRef,
      displayName: product.displayName,
      canonicalSlug: product.canonicalSlug,
      thumbnailUrl: product.thumbnailUrl,
      status,
    };
  },
});
