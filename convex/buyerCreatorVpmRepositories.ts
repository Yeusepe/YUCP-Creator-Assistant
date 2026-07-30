import {
  compareSemanticVersions,
  isPrereleaseSemanticVersion,
  isStrictSemanticVersion,
} from '@yucp/shared/semanticVersion';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { ApiActorBindingV, requireServiceActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREATOR_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type RepositoryCtx = MutationCtx | QueryCtx;

type ActiveBuyerCreatorRepository = {
  createdAt: number;
  creatorName: string;
  creatorSlug: string;
  linkId: string;
  packages: Array<{
    editionId: string;
    packageId: string;
    releaseRoot: string;
    version: string;
    versionId: string;
  }>;
  packageIds: string[];
  status: 'active';
};

function activeEntitlement(entitlement: Doc<'entitlements'>, now: number): boolean {
  return (
    entitlement.status === 'active' &&
    (entitlement.expiresAt === undefined || entitlement.expiresAt > now)
  );
}

async function requireBuyerActor(
  actorBinding: Parameters<typeof requireServiceActor>[0],
  buyerAuthUserId: string
): Promise<void> {
  const actor = await requireServiceActor(actorBinding, ['downloads:service']);
  if (actor.authUserId !== buyerAuthUserId) {
    throw new ConvexError('Repository service actor is not bound to this buyer');
  }
}

async function requireCreatorProfile(
  ctx: RepositoryCtx,
  creatorAuthUserId: string,
  creatorSlug?: string
): Promise<Doc<'creator_profiles'>> {
  const profile = await ctx.db
    .query('creator_profiles')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', creatorAuthUserId))
    .first();
  if (
    !profile ||
    profile.status !== 'active' ||
    !profile.deliverySlug ||
    (creatorSlug !== undefined && profile.deliverySlug !== creatorSlug)
  ) {
    throw new ConvexError('Creator delivery namespace is not available');
  }
  return profile;
}

async function activeBuyerEntitlements(
  ctx: RepositoryCtx,
  buyerAuthUserId: string,
  creatorAuthUserId: string
): Promise<Doc<'entitlements'>[]> {
  const subjects = (
    await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', buyerAuthUserId))
      .collect()
  ).filter((subject) => subject.status === 'active');
  const entitlements = (
    await Promise.all(
      subjects.map((subject) =>
        ctx.db
          .query('entitlements')
          .withIndex('by_subject', (q) => q.eq('subjectId', subject._id))
          .collect()
      )
    )
  ).flat();
  const now = Date.now();
  return entitlements.filter(
    (entitlement) =>
      entitlement.authUserId === creatorAuthUserId && activeEntitlement(entitlement, now)
  );
}

async function entitledCatalogProductIds(
  ctx: RepositoryCtx,
  creatorAuthUserId: string,
  entitlements: Doc<'entitlements'>[]
): Promise<Set<Id<'product_catalog'>>> {
  const result = new Set<Id<'product_catalog'>>();
  for (const entitlement of entitlements) {
    if (entitlement.catalogProductId) {
      const product = await ctx.db.get(entitlement.catalogProductId);
      if (product?.authUserId === creatorAuthUserId) {
        result.add(product._id);
      }
      continue;
    }
    const legacyProducts = await ctx.db
      .query('product_catalog')
      .withIndex('by_product_id', (q) => q.eq('productId', entitlement.productId))
      .collect();
    for (const product of legacyProducts) {
      if (product.authUserId === creatorAuthUserId) {
        result.add(product._id);
      }
    }
  }
  return result;
}

async function isEnabledReadyPackage(
  ctx: RepositoryCtx,
  creatorAuthUserId: string,
  packageId: string,
  entitledCatalogProductIds: Set<Id<'product_catalog'>>
): Promise<{
  editionId: string;
  packageId: string;
  releaseRoot: string;
  version: string;
  versionId: string;
} | null> {
  const [registration, enablement, editions] = await Promise.all([
    ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', packageId))
      .first(),
    ctx.db
      .query('creator_vpm_links')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', creatorAuthUserId)
          .eq('packageId', packageId)
          .eq('status', 'active')
      )
      .first(),
    ctx.db
      .query('package_editions')
      .withIndex('by_creator_package', (q) =>
        q.eq('creatorAuthUserId', creatorAuthUserId).eq('packageId', packageId)
      )
      .collect(),
  ]);
  const entitledIds = new Set([...entitledCatalogProductIds].map(String));
  const entitledEdition =
    editions
      .filter(
        (edition) =>
          edition.status === 'active' &&
          edition.catalogProductIds.some((id) => entitledIds.has(String(id)))
      )
      .sort(
        (left, right) =>
          right.priority - left.priority || left.editionId.localeCompare(right.editionId)
      )[0]?.editionId ?? 'standard';
  const releases = (
    await Promise.all(
      (['READY', 'SUPERSEDED'] as const).map((state) =>
        ctx.db
          .query('package_versions_ref')
          .withIndex('by_package_edition_channel', (q) =>
            q
              .eq('packageId', packageId)
              .eq('editionId', entitledEdition)
              .eq('channel', 'stable')
              .eq('state', state)
          )
          .collect()
      )
    )
  )
    .flat()
    .filter(
      (candidate) =>
        isStrictSemanticVersion(candidate.version) &&
        !isPrereleaseSemanticVersion(candidate.version)
    )
    .sort(
      (left, right) =>
        compareSemanticVersions(right.version, left.version) || right.createdAt - left.createdAt
    );
  const release = releases[0] ?? null;
  return registration &&
    registration.yucpUserId === creatorAuthUserId &&
    registration.status !== 'archived' &&
    enablement?.creatorSlug &&
    release?.releaseRoot
    ? {
        editionId: entitledEdition,
        packageId,
        releaseRoot: release.releaseRoot,
        version: release.version,
        versionId: release.versionId,
      }
    : null;
}

async function resolveEntitledPackageIds(
  ctx: RepositoryCtx,
  buyerAuthUserId: string,
  creatorAuthUserId: string
): Promise<{
  catalogProductIds: Set<Id<'product_catalog'>>;
  packages: Array<{
    editionId: string;
    packageId: string;
    releaseRoot: string;
    version: string;
    versionId: string;
  }>;
  packageIds: string[];
}> {
  const entitlements = await activeBuyerEntitlements(ctx, buyerAuthUserId, creatorAuthUserId);
  const catalogProductIds = await entitledCatalogProductIds(ctx, creatorAuthUserId, entitlements);
  const candidatePackageIds = new Set<string>();
  for (const catalogProductId of catalogProductIds) {
    const bindings = await ctx.db
      .query('package_catalog_bindings')
      .withIndex('by_catalog_product_status', (q) =>
        q.eq('catalogProductId', catalogProductId).eq('status', 'active')
      )
      .collect();
    for (const binding of bindings) {
      if (binding.creatorAuthUserId === creatorAuthUserId) {
        candidatePackageIds.add(binding.packageId);
      }
    }
  }
  const availability = await Promise.all(
    [...candidatePackageIds].map(async (packageId) => ({
      packageId,
      release: await isEnabledReadyPackage(ctx, creatorAuthUserId, packageId, catalogProductIds),
    }))
  );
  const packages = availability
    .flatMap((candidate) => (candidate.release ? [candidate.release] : []))
    .sort((left, right) => left.packageId.localeCompare(right.packageId));
  return {
    catalogProductIds,
    packages,
    packageIds: packages.map((candidate) => candidate.packageId),
  };
}

async function serializeRepository(
  ctx: RepositoryCtx,
  repository: Doc<'buyer_creator_vpm_repositories'>
): Promise<ActiveBuyerCreatorRepository | null> {
  const profile = await requireCreatorProfile(
    ctx,
    repository.creatorAuthUserId,
    repository.creatorSlug
  );
  const { packageIds, packages } = await resolveEntitledPackageIds(
    ctx,
    repository.buyerAuthUserId,
    repository.creatorAuthUserId
  );
  if (packageIds.length === 0) {
    return null;
  }
  return {
    createdAt: repository.createdAt,
    creatorName: profile.name,
    creatorSlug: repository.creatorSlug,
    linkId: repository.linkId,
    packages,
    packageIds,
    status: 'active',
  };
}

export const ensureActive = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    buyerAuthUserId: v.string(),
    creatorAuthUserId: v.string(),
    creatorSlug: v.string(),
    requiredCatalogProductIds: v.array(v.id('product_catalog')),
    proposedLinkId: v.string(),
  },
  returns: v.object({
    created: v.boolean(),
    createdAt: v.number(),
    creatorSlug: v.string(),
    linkId: v.string(),
    status: v.literal('active'),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireBuyerActor(args.actor, args.buyerAuthUserId);
    if (!LINK_ID_PATTERN.test(args.proposedLinkId)) {
      throw new ConvexError('VPM repository link ID is invalid');
    }
    if (!CREATOR_SLUG_PATTERN.test(args.creatorSlug)) {
      throw new ConvexError('Creator delivery slug is invalid');
    }
    await requireCreatorProfile(ctx, args.creatorAuthUserId, args.creatorSlug);
    const { catalogProductIds, packageIds } = await resolveEntitledPackageIds(
      ctx,
      args.buyerAuthUserId,
      args.creatorAuthUserId
    );
    const requiredPackageIds = new Set<string>();
    for (const catalogProductId of args.requiredCatalogProductIds) {
      if (!catalogProductIds.has(catalogProductId)) {
        continue;
      }
      const bindings = await ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_catalog_product_status', (q) =>
          q.eq('catalogProductId', catalogProductId).eq('status', 'active')
        )
        .collect();
      for (const binding of bindings) {
        if (binding.creatorAuthUserId === args.creatorAuthUserId) {
          requiredPackageIds.add(binding.packageId);
        }
      }
    }
    if (
      args.requiredCatalogProductIds.length === 0 ||
      packageIds.length === 0 ||
      !packageIds.some((packageId) => requiredPackageIds.has(packageId))
    ) {
      throw new ConvexError('Buyer has no enabled package for this product');
    }

    const existing = await ctx.db
      .query('buyer_creator_vpm_repositories')
      .withIndex('by_buyer_creator_status', (q) =>
        q
          .eq('buyerAuthUserId', args.buyerAuthUserId)
          .eq('creatorAuthUserId', args.creatorAuthUserId)
          .eq('status', 'active')
      )
      .first();
    if (existing) {
      if (existing.creatorSlug !== args.creatorSlug) {
        await ctx.db.patch(existing._id, {
          creatorSlug: args.creatorSlug,
          updatedAt: Date.now(),
        });
      }
      return {
        created: false,
        createdAt: existing.createdAt,
        creatorSlug: args.creatorSlug,
        linkId: existing.linkId,
        status: 'active' as const,
      };
    }

    const duplicate = await ctx.db
      .query('buyer_creator_vpm_repositories')
      .withIndex('by_link_id', (q) => q.eq('linkId', args.proposedLinkId))
      .first();
    if (duplicate) {
      throw new ConvexError('VPM repository link ID is already in use');
    }
    const now = Date.now();
    await ctx.db.insert('buyer_creator_vpm_repositories', {
      buyerAuthUserId: args.buyerAuthUserId,
      creatorAuthUserId: args.creatorAuthUserId,
      creatorSlug: args.creatorSlug,
      linkId: args.proposedLinkId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    return {
      created: true,
      createdAt: now,
      creatorSlug: args.creatorSlug,
      linkId: args.proposedLinkId,
      status: 'active' as const,
    };
  },
});

export const getActiveByLinkId = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    linkId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      createdAt: v.number(),
      creatorName: v.string(),
      creatorSlug: v.string(),
      linkId: v.string(),
      packages: v.array(
        v.object({
          editionId: v.string(),
          packageId: v.string(),
          releaseRoot: v.string(),
          version: v.string(),
          versionId: v.string(),
        })
      ),
      packageIds: v.array(v.string()),
      status: v.literal('active'),
    })
  ),
  handler: async (ctx, args): Promise<ActiveBuyerCreatorRepository | null> => {
    requireApiSecret(args.apiSecret);
    await requireServiceActor(args.actor, ['downloads:service']);
    if (!LINK_ID_PATTERN.test(args.linkId)) {
      return null;
    }
    const repository = await ctx.db
      .query('buyer_creator_vpm_repositories')
      .withIndex('by_link_id', (q) => q.eq('linkId', args.linkId))
      .first();
    if (!repository || repository.status !== 'active') {
      return null;
    }
    return await serializeRepository(ctx, repository);
  },
});
