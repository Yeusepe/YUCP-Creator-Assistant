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
const PUBLIC_PACKAGE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

function normalizePublicPackageSlug(publicSlug: string): string {
  const normalized = publicSlug.trim().toLowerCase();
  if (
    publicSlug !== normalized ||
    normalized.length > 64 ||
    !PUBLIC_PACKAGE_SLUG_RE.test(normalized)
  ) {
    throw new ConvexError('Public product path must use lowercase letters, numbers, and hyphens');
  }
  return normalized;
}

type LogicalCatalogProductGroup = {
  aliasId: string;
  associationUpdatedAt: number;
  packageId?: string;
  products: Doc<'product_catalog'>[];
};

async function buildCreatorPackageProductSummary(
  ctx: QueryCtx,
  product: Doc<'product_catalog'>,
  resolvedLogicalGroup?: LogicalCatalogProductGroup
) {
  const dependencies = await inspectCatalogProductDeletionDependencies(ctx.db, product._id);
  const deleteBlockedReason = getCatalogProductDeleteBlockedReason(dependencies);
  const status = getCatalogProductWorkspaceStatus(product);
  const logicalGroup = resolvedLogicalGroup ?? {
    aliasId: String(product._id),
    associationUpdatedAt: product.updatedAt,
    products: [product],
  };
  const registration = logicalGroup.packageId
    ? await ctx.db
        .query('package_registry')
        .withIndex('by_package_id', (q) => q.eq('packageId', logicalGroup.packageId as string))
        .unique()
    : null;
  const publicNamespace = logicalGroup.packageId
    ? await ctx.db
        .query('package_public_namespaces')
        .withIndex('by_creator_package_status', (q) =>
          q
            .eq('creatorAuthUserId', product.authUserId)
            .eq('packageId', logicalGroup.packageId as string)
            .eq('status', 'active')
        )
        .first()
    : null;
  const creatorProfile = await ctx.db
    .query('creator_profiles')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', product.authUserId))
    .first();
  const packageEditions = logicalGroup.packageId
    ? (
        await ctx.db
          .query('package_editions')
          .withIndex('by_creator_package', (q) =>
            q
              .eq('creatorAuthUserId', product.authUserId)
              .eq('packageId', logicalGroup.packageId as string)
          )
          .collect()
      )
        .sort(
          (left, right) =>
            right.priority - left.priority || left.displayName.localeCompare(right.displayName)
        )
        .map((edition) => ({
          catalogProductIds: edition.catalogProductIds,
          catalogTierIds: edition.catalogTierIds,
          createdAt: edition.createdAt,
          displayName: edition.displayName,
          editionId: edition.editionId,
          priority: edition.priority,
          status: edition.status,
          updatedAt: edition.updatedAt,
        }))
    : [];
  const logicalCatalogTiers = (
    await Promise.all(
      logicalGroup.products.map(async (candidate) => {
        return await ctx.db
          .query('catalog_tiers')
          .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', candidate._id))
          .collect();
      })
    )
  ).flat();

  return {
    _id: product._id,
    aliases: product.aliases,
    canonicalSlug: product.canonicalSlug,
    catalogTiers: logicalCatalogTiers
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
    aliasId: logicalGroup.aliasId,
    packageAssociationUpdatedAt: logicalGroup.associationUpdatedAt,
    catalogProductIds: logicalGroup.products.map((candidate) => candidate._id),
    storefronts: logicalGroup.products.map(buildCatalogStorefront),
    packageId: logicalGroup.packageId,
    packageName:
      registration?.yucpUserId === product.authUserId ? registration.packageName : undefined,
    publicCreatorSlug: creatorProfile?.slug,
    publicSlug: publicNamespace?.slug,
    packageEditions,
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

function compareCatalogProducts(
  left: Doc<'product_catalog'>,
  right: Doc<'product_catalog'>
): number {
  return (
    left.provider.localeCompare(right.provider) ||
    left.providerProductRef.localeCompare(right.providerProductRef) ||
    String(left._id).localeCompare(String(right._id))
  );
}

function buildCatalogStorefront(product: Doc<'product_catalog'>) {
  return {
    catalogProductId: product._id,
    productId: product.productId,
    provider: product.provider,
    providerProductRef: product.providerProductRef,
    displayName: product.displayName,
    canonicalSlug: product.canonicalSlug,
    thumbnailUrl: product.thumbnailUrl,
  };
}

async function resolveLogicalCatalogProductGroup(
  ctx: QueryCtx,
  product: Doc<'product_catalog'>
): Promise<LogicalCatalogProductGroup> {
  const creatorProducts = await ctx.db
    .query('product_catalog')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', product.authUserId))
    .collect();
  const groupsByProductId = await resolveLogicalCatalogProductGroups(ctx, creatorProducts);
  return (
    groupsByProductId.get(String(product._id)) ?? {
      aliasId: String(product._id),
      associationUpdatedAt: product.updatedAt,
      products: [product],
    }
  );
}

async function resolveLogicalCatalogProductGroups(
  ctx: QueryCtx,
  creatorProducts: ReadonlyArray<Doc<'product_catalog'>>
): Promise<Map<string, LogicalCatalogProductGroup>> {
  const ownedProducts = [...creatorProducts].sort(compareCatalogProducts);
  const activeProducts = ownedProducts
    .filter((product) => getCatalogProductWorkspaceStatus(product) === 'active')
    .sort(compareCatalogProducts);

  const packageIdByProductId = new Map<string, string>();
  const associationUpdatedAtByPackageId = new Map<string, number>();
  await Promise.all(
    ownedProducts.map(async (product) => {
      const bindings = await ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_catalog_product_status', (q) =>
          q.eq('catalogProductId', product._id).eq('status', 'active')
        )
        .take(2);
      if (bindings.length === 1) {
        packageIdByProductId.set(String(product._id), bindings[0]?.packageId as string);
      }
    })
  );

  const productsByPackageId = new Map<string, Doc<'product_catalog'>[]>();
  for (const product of activeProducts) {
    const packageId = packageIdByProductId.get(String(product._id));
    if (!packageId) {
      continue;
    }
    const products = productsByPackageId.get(packageId) ?? [];
    products.push(product);
    productsByPackageId.set(packageId, products);
  }
  await Promise.all(
    Array.from(productsByPackageId.keys()).map(async (packageId) => {
      const bindings = await ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_creator_package_status', (q) =>
          q
            .eq('creatorAuthUserId', ownedProducts[0]?.authUserId as string)
            .eq('packageId', packageId)
        )
        .collect();
      associationUpdatedAtByPackageId.set(
        packageId,
        Math.max(0, ...bindings.map((binding) => binding.updatedAt))
      );
    })
  );

  const resolvedGroupsByProductId = new Map<string, LogicalCatalogProductGroup>();
  for (const product of activeProducts) {
    const packageId = packageIdByProductId.get(String(product._id));
    const products = packageId ? (productsByPackageId.get(packageId) ?? [product]) : [product];
    resolvedGroupsByProductId.set(String(product._id), {
      aliasId: packageId ?? String(product._id),
      associationUpdatedAt: packageId
        ? (associationUpdatedAtByPackageId.get(packageId) ?? product.updatedAt)
        : product.updatedAt,
      ...(packageId ? { packageId } : {}),
      products,
    });
  }
  return resolvedGroupsByProductId;
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

async function requireOwnedActivePackageAndProduct(
  ctx: MutationCtx,
  input: {
    authUserId: string;
    catalogProductId: Doc<'product_catalog'>['_id'];
    packageId: string;
  }
): Promise<Doc<'product_catalog'>> {
  const packageId = input.packageId.trim();
  if (!PACKAGE_ID_RE.test(packageId)) {
    throw new ConvexError(`Invalid packageId format: ${input.packageId}`);
  }
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', packageId))
    .unique();
  if (
    !registration ||
    registration.yucpUserId !== input.authUserId ||
    isArchivedRegistration(registration)
  ) {
    throw new ConvexError('Active package ownership required');
  }
  const product = await ctx.db.get(input.catalogProductId);
  if (
    !product ||
    product.authUserId !== input.authUserId ||
    getCatalogProductWorkspaceStatus(product) !== 'active'
  ) {
    throw new ConvexError('Catalog product ownership required');
  }
  return product;
}

async function bindOwnedCatalogProduct(
  ctx: MutationCtx,
  input: {
    authUserId: string;
    catalogProductId: Doc<'product_catalog'>['_id'];
    packageId: string;
  }
) {
  await requireOwnedActivePackageAndProduct(ctx, input);
  const activeBindings = await ctx.db
    .query('package_catalog_bindings')
    .withIndex('by_catalog_product_status', (q) =>
      q.eq('catalogProductId', input.catalogProductId).eq('status', 'active')
    )
    .take(2);
  if (activeBindings.length > 1) {
    throw new ConvexError('Catalog product has conflicting package links');
  }
  const existing = activeBindings[0];
  if (existing) {
    if (existing.creatorAuthUserId !== input.authUserId || existing.packageId !== input.packageId) {
      throw new ConvexError('Catalog product is already linked to another package');
    }
    return {
      bound: true as const,
      catalogProductId: input.catalogProductId,
      created: false,
      packageId: input.packageId,
    };
  }
  const now = Date.now();
  await ctx.db.insert('package_catalog_bindings', {
    catalogProductId: input.catalogProductId,
    creatorAuthUserId: input.authUserId,
    packageId: input.packageId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return {
    bound: true as const,
    catalogProductId: input.catalogProductId,
    created: true,
    packageId: input.packageId,
  };
}

export const bindCatalogProductForCreator = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.id('product_catalog'),
    packageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    return await bindOwnedCatalogProduct(ctx, args);
  },
});

export const unbindCatalogProductForCreator = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.id('product_catalog'),
    packageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    await requireOwnedActivePackageAndProduct(ctx, args);
    const bindings = await ctx.db
      .query('package_catalog_bindings')
      .withIndex('by_catalog_product_status', (q) =>
        q.eq('catalogProductId', args.catalogProductId).eq('status', 'active')
      )
      .take(2);
    if (
      bindings.length !== 1 ||
      bindings[0]?.creatorAuthUserId !== args.authUserId ||
      bindings[0]?.packageId !== args.packageId
    ) {
      throw new ConvexError('Catalog product is not linked to this package');
    }
    const packageBindings = await ctx.db
      .query('package_catalog_bindings')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', args.packageId)
          .eq('status', 'active')
      )
      .take(2);
    if (packageBindings.length < 2) {
      throw new ConvexError('Package must keep at least one linked storefront');
    }
    const now = Date.now();
    const targetTiers = await ctx.db
      .query('catalog_tiers')
      .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', args.catalogProductId))
      .collect();
    const targetTierIds = new Set(targetTiers.map((tier) => String(tier._id)));
    const editions = await ctx.db
      .query('package_editions')
      .withIndex('by_creator_package', (q) =>
        q.eq('creatorAuthUserId', args.authUserId).eq('packageId', args.packageId)
      )
      .collect();
    for (const edition of editions) {
      const catalogProductIds = edition.catalogProductIds.filter(
        (catalogProductId) => catalogProductId !== args.catalogProductId
      );
      const catalogTierIds = edition.catalogTierIds.filter(
        (catalogTierId) => !targetTierIds.has(String(catalogTierId))
      );
      const losesEveryTierConstraint =
        edition.catalogTierIds.length > 0 && catalogTierIds.length === 0;
      await ctx.db.patch(edition._id, {
        catalogProductIds,
        catalogTierIds,
        ...(edition.status === 'active' &&
        (catalogProductIds.length === 0 || losesEveryTierConstraint)
          ? { status: 'archived' as const }
          : {}),
        updatedAt: now,
      });
    }
    await ctx.db.patch(bindings[0]._id, {
      removedAt: now,
      status: 'removed',
      updatedAt: now,
    });
    return { unbound: true as const };
  },
});

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
    catalogProductIds: v.array(v.id('product_catalog')),
    packageId: v.string(),
  },
  handler: async (ctx, args): Promise<CreatorUploadRegistrationResult> => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const catalogProductIds = [
      ...new Map(args.catalogProductIds.map((id) => [String(id), id])).values(),
    ];
    if (catalogProductIds.length === 0 || catalogProductIds.length > 32) {
      throw new ConvexError('Creator upload requires from 1 to 32 catalog products');
    }
    const products = await Promise.all(catalogProductIds.map(async (id) => await ctx.db.get(id)));
    if (
      products.some(
        (product) =>
          !product ||
          product.authUserId !== args.authUserId ||
          getCatalogProductWorkspaceStatus(product) !== 'active'
      )
    ) {
      return {
        registered: false,
        conflict: false,
        archived: false,
        catalogProductRejected: true,
      };
    }

    for (const catalogProductId of catalogProductIds) {
      const existingBindings = await ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_catalog_product_status', (q) =>
          q.eq('catalogProductId', catalogProductId).eq('status', 'active')
        )
        .take(2);
      if (
        existingBindings.length > 1 ||
        (existingBindings[0] &&
          (existingBindings[0].creatorAuthUserId !== args.authUserId ||
            existingBindings[0].packageId !== args.packageId))
      ) {
        return {
          registered: false,
          conflict: false,
          archived: false,
          catalogProductRejected: true,
        };
      }
    }

    const primaryProduct = products[0];
    if (!primaryProduct) {
      throw new ConvexError('Creator upload catalog product resolution failed');
    }
    const registration = await registerPackageForIdentity(ctx, {
      packageId: args.packageId,
      packageName: primaryProduct.displayName,
      publisherId: `creator:${args.authUserId}`,
      yucpUserId: args.authUserId,
    });
    if (!registration.registered) {
      return registration;
    }
    for (const catalogProductId of catalogProductIds) {
      await bindOwnedCatalogProduct(ctx, {
        authUserId: args.authUserId,
        catalogProductId,
        packageId: args.packageId,
      });
    }
    return registration;
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
    const logicalGroupsByProductId = await resolveLogicalCatalogProductGroups(ctx, products);
    const seenLogicalGroups = new Set<string>();
    products = products.filter((product) => {
      const group = logicalGroupsByProductId.get(String(product._id));
      if (!group) {
        return args.configuredOnly !== true;
      }
      if (args.configuredOnly && !group.packageId) {
        return false;
      }
      const identity = group.products.map((candidate) => String(candidate._id)).join('\u0000');
      if (seenLogicalGroups.has(identity)) {
        return false;
      }
      seenLogicalGroups.add(identity);
      return true;
    });

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
      pageProducts.map((product) =>
        buildCreatorPackageProductSummary(
          ctx,
          product,
          logicalGroupsByProductId.get(String(product._id))
        )
      )
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
    return await buildCreatorPackageProductSummary(
      ctx,
      doc,
      await resolveLogicalCatalogProductGroup(ctx, doc)
    );
  },
});

/** Get one creator-owned package aggregate by its provider-neutral package ID. */
export const getByPackageIdForAuthUser = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const registration = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .unique();
    if (
      !registration ||
      registration.yucpUserId !== args.authUserId ||
      isArchivedRegistration(registration)
    ) {
      return null;
    }
    const bindings = await ctx.db
      .query('package_catalog_bindings')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', args.packageId)
          .eq('status', 'active')
      )
      .collect();
    const products = (
      await Promise.all(bindings.map(async (binding) => await ctx.db.get(binding.catalogProductId)))
    )
      .filter(
        (product): product is Doc<'product_catalog'> =>
          product !== null &&
          product.authUserId === args.authUserId &&
          getCatalogProductWorkspaceStatus(product) === 'active'
      )
      .sort(compareCatalogProducts);
    const product = products[0];
    if (!product) {
      return null;
    }
    return await buildCreatorPackageProductSummary(
      ctx,
      product,
      await resolveLogicalCatalogProductGroup(ctx, product)
    );
  },
});

/**
 * Set the public path for a creator-owned package aggregate.
 *
 * Previous paths remain as aliases so links already shared with buyers keep resolving.
 */
export const updatePublicNamespace = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
    publicSlug: v.string(),
  },
  returns: v.object({
    packageId: v.string(),
    publicSlug: v.string(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const publicSlug = normalizePublicPackageSlug(args.publicSlug);
    const registration = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .unique();
    if (
      !registration ||
      registration.yucpUserId !== args.authUserId ||
      isArchivedRegistration(registration)
    ) {
      throw new ConvexError('Package is not available');
    }

    const claimedNamespaces = await ctx.db
      .query('package_public_namespaces')
      .withIndex('by_creator_slug', (q) =>
        q.eq('creatorAuthUserId', args.authUserId).eq('slug', publicSlug)
      )
      .collect();
    if (claimedNamespaces.some((namespace) => namespace.packageId !== args.packageId)) {
      throw new ConvexError('Public product path is already in use');
    }

    const now = Date.now();
    const activeNamespaces = await ctx.db
      .query('package_public_namespaces')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', args.packageId)
          .eq('status', 'active')
      )
      .collect();
    for (const namespace of activeNamespaces) {
      if (namespace.slug !== publicSlug) {
        await ctx.db.patch(namespace._id, { status: 'alias', updatedAt: now });
      }
    }

    const target = claimedNamespaces.find((namespace) => namespace.packageId === args.packageId);
    if (target) {
      await ctx.db.patch(target._id, { status: 'active', updatedAt: now });
    } else {
      await ctx.db.insert('package_public_namespaces', {
        creatorAuthUserId: args.authUserId,
        packageId: args.packageId,
        slug: publicSlug,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    }

    return { packageId: args.packageId, publicSlug };
  },
});

async function resolveCreatorAuthUserId(ctx: QueryCtx, creatorRef: string) {
  const namespace = await ctx.db
    .query('creator_namespaces')
    .withIndex('by_kind_slug', (q) => q.eq('kind', 'public').eq('slug', creatorRef))
    .first();
  if (namespace) {
    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', namespace.creatorAuthUserId))
      .first();
    return profile?.status === 'active' ? profile.authUserId : null;
  }
  const profiles = await ctx.db
    .query('creator_profiles')
    .withIndex('by_slug', (q) => q.eq('slug', creatorRef))
    .filter((q) => q.eq(q.field('status'), 'active'))
    .take(2);
  return profiles.length === 1 ? (profiles[0]?.authUserId ?? null) : null;
}

async function resolvePackagePublicNamespace(
  ctx: QueryCtx,
  creatorAuthUserId: string,
  productRef: string
) {
  const namespace = await ctx.db
    .query('package_public_namespaces')
    .withIndex('by_creator_slug', (q) =>
      q.eq('creatorAuthUserId', creatorAuthUserId).eq('slug', productRef)
    )
    .first();
  if (!namespace) {
    return null;
  }
  const activeNamespace = await ctx.db
    .query('package_public_namespaces')
    .withIndex('by_creator_package_status', (q) =>
      q
        .eq('creatorAuthUserId', creatorAuthUserId)
        .eq('packageId', namespace.packageId)
        .eq('status', 'active')
    )
    .first();
  return activeNamespace
    ? { packageId: namespace.packageId, publicSlug: activeNamespace.slug }
    : null;
}

async function resolveCatalogProduct(ctx: QueryCtx, ref: string) {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }

  const catalogId = ctx.db.normalizeId('product_catalog', trimmed);
  if (catalogId) {
    return await ctx.db.get(catalogId);
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

  const creatorAuthUserId = await resolveCreatorAuthUserId(ctx, normalizedCreatorRef);
  if (!creatorAuthUserId) {
    return null;
  }

  const packageNamespace = await resolvePackagePublicNamespace(
    ctx,
    creatorAuthUserId,
    normalizedProductRef
  );
  if (packageNamespace) {
    const bindings = await ctx.db
      .query('package_catalog_bindings')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', creatorAuthUserId)
          .eq('packageId', packageNamespace.packageId)
          .eq('status', 'active')
      )
      .collect();
    const products = await Promise.all(
      bindings.map(async (binding) => await ctx.db.get(binding.catalogProductId))
    );
    const product = products
      .filter(
        (candidate): candidate is Doc<'product_catalog'> =>
          candidate !== null &&
          candidate.authUserId === creatorAuthUserId &&
          getCatalogProductWorkspaceStatus(candidate) === 'active'
      )
      .sort(compareCatalogProducts)[0];
    if (product) {
      return product;
    }
  }

  const catalogId = ctx.db.normalizeId('product_catalog', normalizedProductRef);
  if (catalogId) {
    const product = await ctx.db.get(catalogId);
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

  const logicalGroup = await resolveLogicalCatalogProductGroup(ctx, product);

  return {
    catalogProductId: product._id,
    catalogProductIds: logicalGroup.products.map((candidate) => candidate._id),
    creatorAuthUserId: product.authUserId,
    aliasId: logicalGroup.aliasId,
    packageAssociationUpdatedAt: logicalGroup.associationUpdatedAt,
    ...(logicalGroup.packageId ? { packageId: logicalGroup.packageId } : {}),
    storefronts: logicalGroup.products.map(buildCatalogStorefront),
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

export const getBuyerAccessContextByPackageId = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    packageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireApiActor(args.actor);
    const registration = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .unique();
    if (!registration || isArchivedRegistration(registration)) {
      return null;
    }
    const bindings = await ctx.db
      .query('package_catalog_bindings')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', registration.yucpUserId)
          .eq('packageId', args.packageId)
          .eq('status', 'active')
      )
      .collect();
    const products = await Promise.all(
      bindings.map(async (binding) => await ctx.db.get(binding.catalogProductId))
    );
    const product = products.find(
      (candidate): candidate is Doc<'product_catalog'> =>
        candidate !== null && getCatalogProductWorkspaceStatus(candidate) === 'active'
    );
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

/**
 * Resolve a buyer-facing creator/product path, including historical package aliases.
 */
export const resolveBuyerAccessByCreatorProduct = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    creatorRef: v.string(),
    productRef: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireApiActor(args.actor);
    const creatorAuthUserId = await resolveCreatorAuthUserId(ctx, args.creatorRef.trim());
    if (!creatorAuthUserId) {
      return null;
    }
    const packageNamespace = await resolvePackagePublicNamespace(
      ctx,
      creatorAuthUserId,
      args.productRef.trim()
    );
    const product = await resolveCreatorCatalogProduct(ctx, args.creatorRef, args.productRef);
    if (!product) {
      return null;
    }
    const context = await buildBuyerAccessContext(ctx, product);
    if (!context) {
      return null;
    }
    return {
      ...context,
      ...(packageNamespace
        ? {
            packageId: packageNamespace.packageId,
            publicSlug: packageNamespace.publicSlug,
          }
        : {}),
    };
  },
});
