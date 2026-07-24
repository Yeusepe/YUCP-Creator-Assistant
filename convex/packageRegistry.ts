/**
 * YUCP Package Name Registry, Layer 1 defense.
 *
 * Enforces namespace ownership. The first verified publisher to sign or upload
 * a packageId owns that name permanently. A different yucpUserId cannot claim
 * the package through another account.
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
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { ApiActorBindingV, requireApiActor, requireDelegatedAuthUserActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';
import {
  getCatalogProductDeleteBlockedReason,
  inspectCatalogProductDeletionDependencies,
} from './lib/catalogProductDeletion';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const PACKAGE_NAME_MAX_LENGTH = 120;
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

async function buildCreatorPackageProductSummary(ctx: QueryCtx, product: Doc<'product_catalog'>) {
  const dependencies = await inspectCatalogProductDeletionDependencies(ctx.db, product._id);
  const deleteBlockedReason = getCatalogProductDeleteBlockedReason(dependencies);
  const status = getCatalogProductWorkspaceStatus(product);
  const linkedPackageIds = Array.from(
    new Set(dependencies.packageVersions.map((version) => version.packageId))
  );
  const packageId = linkedPackageIds.length === 1 ? linkedPackageIds[0] : undefined;

  return {
    _id: product._id,
    aliases: product.aliases,
    canonicalSlug: product.canonicalSlug,
    catalogTiers: dependencies.catalogTiers
      .map((tier) => ({
        _id: tier._id,
        catalogProductId: tier.catalogProductId,
        provider: tier.provider,
        providerTierRef: tier.providerTierRef,
        displayName: tier.displayName,
        description: tier.description,
        amountCents: tier.amountCents,
        currency: tier.currency,
        status: tier.status,
        createdAt: tier.createdAt,
        updatedAt: tier.updatedAt,
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    displayName: product.displayName,
    thumbnailUrl: product.thumbnailUrl,
    packageId,
    productId: product.productId,
    provider: product.provider,
    providerProductRef: product.providerProductRef,
    status,
    supportsAutoDiscovery: product.supportsAutoDiscovery,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    canArchive: status === 'active',
    canRestore: status === 'archived',
    canDelete: deleteBlockedReason === undefined,
    deleteBlockedReason,
  };
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

type RegisterPackageForIdentityInput = {
  packageId: string;
  packageName?: string;
  publisherId: string;
  yucpUserId: string;
};

async function registerPackageForIdentity(
  ctx: MutationCtx,
  args: RegisterPackageForIdentityInput
): Promise<RegistrationResult> {
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
}

export const registerPackage = internalMutation({
  args: {
    packageId: v.string(),
    packageName: v.optional(v.string()),
    publisherId: v.string(),
    /** Better Auth user ID of the registering creator */
    yucpUserId: v.string(),
  },
  handler: async (ctx, args): Promise<RegistrationResult> => {
    return await registerPackageForIdentity(ctx, args);
  },
});

export type CreatorUploadRegistrationResult =
  | RegistrationResult
  | {
      registered: false;
      conflict: false;
      archived: false;
      catalogProductRejected: true;
    };

export const claimPackageForCreatorUpload = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.id('product_catalog'),
    packageId: v.string(),
  },
  handler: async (ctx, args): Promise<CreatorUploadRegistrationResult> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const product = await ctx.db.get(args.catalogProductId);
    if (
      !product ||
      product.authUserId !== args.authUserId ||
      getCatalogProductWorkspaceStatus(product) !== 'active'
    ) {
      return {
        registered: false,
        conflict: false,
        archived: false,
        catalogProductRejected: true,
      };
    }

    const readyVersions = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_catalog_product', (q) =>
        q.eq('catalogProductId', args.catalogProductId).eq('state', 'READY')
      )
      .collect();
    if (readyVersions.some((version) => version.packageId !== args.packageId)) {
      return {
        registered: false,
        conflict: false,
        archived: false,
        catalogProductRejected: true,
      };
    }

    return await registerPackageForIdentity(ctx, {
      packageId: args.packageId,
      packageName: product.displayName,
      publisherId: `creator:${args.authUserId}`,
      yucpUserId: args.authUserId,
    });
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
    configuredOnly: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const limit = Math.min(
      args.limit && Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : 50,
      100
    );
    const requiresFilteredPagination = Boolean(args.configuredOnly || args.provider || args.status);

    if (!requiresFilteredPagination) {
      const page = await ctx.db
        .query('product_catalog')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
        .paginate({ cursor: args.cursor ?? null, numItems: limit });
      const data = await Promise.all(
        page.page.map((product) => buildCreatorPackageProductSummary(ctx, product))
      );

      return {
        data,
        hasMore: !page.isDone,
        nextCursor: page.isDone ? null : page.continueCursor,
      };
    }

    let products = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();
    if (args.provider) {
      products = products.filter((product) => product.provider === args.provider);
    }
    if (args.status) {
      products = products.filter(
        (product) =>
          getCatalogProductWorkspaceStatus(product) === args.status ||
          product.status === args.status
      );
    }
    if (args.configuredOnly) {
      const configuredProducts = await Promise.all(
        products.map(async (product) => {
          const readyVersion = await ctx.db
            .query('package_versions_ref')
            .withIndex('by_catalog_product', (q) =>
              q.eq('catalogProductId', product._id).eq('state', 'READY')
            )
            .first();
          return readyVersion ? product : null;
        })
      );
      products = configuredProducts.filter((product) => product !== null);
    }

    let startIndex = 0;
    if (args.cursor) {
      const cursorIndex = products.findIndex((product) => String(product._id) === args.cursor);
      if (cursorIndex < 0) {
        // A filtered anchor can disappear between requests. End the traversal instead of replaying
        // page one, which would duplicate results and keep the client on a non-advancing cursor.
        return { data: [], hasMore: false, nextCursor: null };
      }
      startIndex = cursorIndex + 1;
    }
    const pageProducts = products.slice(startIndex, startIndex + limit);
    const data = await Promise.all(
      pageProducts.map((product) => buildCreatorPackageProductSummary(ctx, product))
    );
    const hasMore = startIndex + limit < products.length;

    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(pageProducts[pageProducts.length - 1]?._id) : null,
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
    return await buildCreatorPackageProductSummary(ctx, doc);
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

async function resolveCreatorCatalogProduct(ctx: QueryCtx, creatorRef: string, productRef: string) {
  const normalizedCreatorRef = creatorRef.trim();
  const normalizedProductRef = productRef.trim();
  if (!normalizedCreatorRef || !normalizedProductRef) {
    return null;
  }

  const creatorProfiles = await ctx.db
    .query('creator_profiles')
    .withIndex('by_slug', (q) => q.eq('slug', normalizedCreatorRef))
    .filter((q) => q.eq(q.field('status'), 'active'))
    .take(2);
  if (creatorProfiles.length !== 1) {
    return null;
  }
  const creatorAuthUserId = creatorProfiles[0]?.authUserId;
  if (!creatorAuthUserId) {
    return null;
  }

  const legacyId = ctx.db.normalizeId('product_catalog', normalizedProductRef);
  if (legacyId) {
    const product = await ctx.db.get(legacyId);
    return product?.authUserId === creatorAuthUserId ? product : null;
  }

  const bySlug = await ctx.db
    .query('product_catalog')
    .withIndex('by_auth_user_slug', (q) =>
      q.eq('authUserId', creatorAuthUserId).eq('canonicalSlug', normalizedProductRef)
    )
    .take(2);
  const byRef = await ctx.db
    .query('product_catalog')
    .withIndex('by_auth_user_provider_product_ref', (q) =>
      q.eq('authUserId', creatorAuthUserId).eq('providerProductRef', normalizedProductRef)
    )
    .take(2);
  const candidates = new Map<string, (typeof bySlug)[number]>();
  for (const candidate of [...bySlug, ...byRef]) {
    candidates.set(String(candidate._id), candidate);
  }
  return candidates.size === 1 ? (Array.from(candidates.values())[0] ?? null) : null;
}

async function buildBuyerAccessContext(ctx: QueryCtx, product: Doc<'product_catalog'>) {
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

    return await buildBuyerAccessContext(ctx, product);
  },
});

export const getBuyerAccessContextByCreatorAndProductRef = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    creatorRef: v.string(),
    productRef: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireApiActor(args.actor);

    const product = await resolveCreatorCatalogProduct(ctx, args.creatorRef, args.productRef);
    return product ? await buildBuyerAccessContext(ctx, product) : null;
  },
});
