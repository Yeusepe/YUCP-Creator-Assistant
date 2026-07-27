import { catalogTierPackageEditionId } from '@yucp/shared/packageEdition';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, query } from './_generated/server';
import { activeCatalogTierIdsForEntitlement } from './catalogTiers';
import {
  ApiActorBindingV,
  requireDelegatedAuthUserActor,
  requireServiceActor,
} from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';

const EDITION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_EDITION_NAME_LENGTH = 80;
const MAX_EDITION_PRIORITY = 10_000;
const MAX_EDITION_TARGETS = 128;

function normalizedEditionId(value: string): string {
  const editionId = value.trim();
  if (!EDITION_ID_PATTERN.test(editionId)) {
    throw new ConvexError('Package edition ID must use lowercase letters, numbers, and hyphens');
  }
  return editionId;
}

function normalizedDisplayName(value: string): string {
  const displayName = value.trim();
  if (!displayName || displayName.length > MAX_EDITION_NAME_LENGTH) {
    throw new ConvexError(
      `Package edition name must contain 1 to ${MAX_EDITION_NAME_LENGTH} characters`
    );
  }
  return displayName;
}

function normalizedPackageId(value: string): string {
  const packageId = value.trim();
  if (!packageId || packageId.length > 256) {
    throw new ConvexError('Package ID is invalid');
  }
  return packageId;
}

function uniqueIds<T extends string>(values: T[]): T[] {
  if (values.length > MAX_EDITION_TARGETS) {
    throw new ConvexError(`Package editions support up to ${MAX_EDITION_TARGETS} access targets`);
  }
  return [...new Set(values)];
}

async function requireOwnedEditionTargets(
  ctx: MutationCtx,
  input: {
    authUserId: string;
    catalogProductIds: Array<Id<'product_catalog'>>;
    catalogTierIds: Array<Id<'catalog_tiers'>>;
    packageId: string;
  }
): Promise<void> {
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', input.packageId))
    .first();
  if (!registration || registration.yucpUserId !== input.authUserId) {
    throw new ConvexError('Package ownership required');
  }
  if (input.catalogProductIds.length === 0) {
    throw new ConvexError('Select at least one catalog product');
  }

  const products = await Promise.all(input.catalogProductIds.map((id) => ctx.db.get(id)));
  if (
    products.some(
      (product) =>
        !product || product.authUserId !== input.authUserId || product.status !== 'active'
    )
  ) {
    throw new ConvexError('Catalog product ownership required');
  }
  const productAssociations = await Promise.all(
    input.catalogProductIds.map(async (catalogProductId) => {
      return await ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_catalog_product_status', (q) =>
          q.eq('catalogProductId', catalogProductId).eq('status', 'active')
        )
        .collect();
    })
  );
  if (
    productAssociations.some(
      (bindings) => bindings.length !== 1 || bindings[0]?.packageId !== input.packageId
    )
  ) {
    throw new ConvexError('Catalog product is not associated with this package');
  }

  const allowedProductIds = new Set(input.catalogProductIds.map(String));
  const tiers = await Promise.all(input.catalogTierIds.map((id) => ctx.db.get(id)));
  if (
    tiers.some(
      (tier) =>
        !tier ||
        tier.authUserId !== input.authUserId ||
        tier.status !== 'active' ||
        !tier.catalogProductId ||
        !allowedProductIds.has(String(tier.catalogProductId))
    )
  ) {
    throw new ConvexError('Catalog tier ownership required');
  }
}

export const upsertForCreator = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
    editionId: v.string(),
    displayName: v.string(),
    catalogProductIds: v.array(v.id('product_catalog')),
    catalogTierIds: v.array(v.id('catalog_tiers')),
    priority: v.number(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const packageId = normalizedPackageId(args.packageId);
    const editionId = normalizedEditionId(args.editionId);
    const displayName = normalizedDisplayName(args.displayName);
    if (!Number.isSafeInteger(args.priority) || Math.abs(args.priority) > MAX_EDITION_PRIORITY) {
      throw new ConvexError(
        `Package edition priority must be an integer from -${MAX_EDITION_PRIORITY} to ${MAX_EDITION_PRIORITY}`
      );
    }
    const catalogProductIds = uniqueIds(args.catalogProductIds);
    const catalogTierIds = uniqueIds(args.catalogTierIds);
    await requireOwnedEditionTargets(ctx, {
      authUserId: args.authUserId,
      catalogProductIds,
      catalogTierIds,
      packageId,
    });

    const existing = await ctx.db
      .query('package_editions')
      .withIndex('by_creator_package_edition', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', packageId)
          .eq('editionId', editionId)
      )
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        catalogProductIds,
        catalogTierIds,
        displayName,
        priority: args.priority,
        status: 'active',
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert('package_editions', {
      catalogProductIds,
      catalogTierIds,
      createdAt: now,
      creatorAuthUserId: args.authUserId,
      displayName,
      editionId,
      packageId,
      priority: args.priority,
      status: 'active',
      updatedAt: now,
    });
  },
});

export const listForCreator = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    return (
      await ctx.db
        .query('package_editions')
        .withIndex('by_creator_package', (q) =>
          q
            .eq('creatorAuthUserId', args.authUserId)
            .eq('packageId', normalizedPackageId(args.packageId))
        )
        .collect()
    ).sort(
      (left, right) =>
        right.priority - left.priority ||
        left.displayName.localeCompare(right.displayName) ||
        String(left._id).localeCompare(String(right._id))
    );
  },
});

export const getManagementScopeForCreator = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
    editionId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const packageId = normalizedPackageId(args.packageId);
    const editionId = normalizedEditionId(args.editionId);
    const registration = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', packageId))
      .unique();
    if (!registration || registration.yucpUserId !== args.authUserId) {
      return null;
    }
    const edition = await ctx.db
      .query('package_editions')
      .withIndex('by_creator_package_edition', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', packageId)
          .eq('editionId', editionId)
      )
      .unique();
    if (!edition) {
      return editionId === 'standard'
        ? {
            displayName: 'Standard',
            editionId,
            packageId,
            status: 'active' as const,
          }
        : null;
    }
    return {
      displayName: edition.displayName,
      editionId: edition.editionId,
      packageId: edition.packageId,
      status: edition.status,
    };
  },
});

export const ensureStandardForCreatorUpload = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductIds: v.array(v.id('product_catalog')),
    packageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const packageId = normalizedPackageId(args.packageId);
    const existing = await ctx.db
      .query('package_editions')
      .withIndex('by_creator_package_edition', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', packageId)
          .eq('editionId', 'standard')
      )
      .first();
    const catalogProductIds = uniqueIds([
      ...(existing?.catalogProductIds ?? []),
      ...args.catalogProductIds,
    ]);
    if (args.catalogProductIds.length === 0 || catalogProductIds.length > MAX_EDITION_TARGETS) {
      throw new ConvexError(
        `The standard package edition requires from 1 to ${MAX_EDITION_TARGETS} catalog products`
      );
    }
    await requireOwnedEditionTargets(ctx, {
      authUserId: args.authUserId,
      catalogProductIds,
      catalogTierIds: [],
      packageId,
    });
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        catalogProductIds,
        catalogTierIds: [],
        displayName: 'Standard',
        priority: 0,
        status: 'active',
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert('package_editions', {
      catalogProductIds,
      catalogTierIds: [],
      createdAt: now,
      creatorAuthUserId: args.authUserId,
      displayName: 'Standard',
      editionId: 'standard',
      packageId,
      priority: 0,
      status: 'active',
      updatedAt: now,
    });
  },
});

export const ensureCatalogTierForCreatorUpload = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductIds: v.array(v.id('product_catalog')),
    catalogTierId: v.id('catalog_tiers'),
    editionId: v.string(),
    packageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const packageId = normalizedPackageId(args.packageId);
    const editionId = normalizedEditionId(args.editionId);
    if (editionId !== catalogTierPackageEditionId(String(args.catalogTierId))) {
      throw new ConvexError('Catalog tier does not match the package edition');
    }
    const selectedCatalogProductIds = uniqueIds(args.catalogProductIds);
    const tier = await ctx.db.get(args.catalogTierId);
    if (
      !tier ||
      !tier.catalogProductId ||
      tier.authUserId !== args.authUserId ||
      tier.status !== 'active' ||
      !selectedCatalogProductIds.includes(tier.catalogProductId)
    ) {
      throw new ConvexError('Catalog tier ownership required');
    }
    const catalogProductIds = [tier.catalogProductId];
    await requireOwnedEditionTargets(ctx, {
      authUserId: args.authUserId,
      catalogProductIds,
      catalogTierIds: [args.catalogTierId],
      packageId,
    });

    const existing = await ctx.db
      .query('package_editions')
      .withIndex('by_creator_package_edition', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', packageId)
          .eq('editionId', editionId)
      )
      .first();
    const now = Date.now();
    const priority = Number.isSafeInteger(tier.amountCents)
      ? Math.max(100, Math.min(MAX_EDITION_PRIORITY, tier.amountCents ?? 100))
      : 100;
    if (existing) {
      if (
        existing.catalogTierIds.length !== 1 ||
        existing.catalogTierIds[0] !== args.catalogTierId
      ) {
        throw new ConvexError('Package edition ID is already assigned');
      }
      if (existing.status !== 'active') {
        throw new ConvexError('Active package edition required');
      }
      await ctx.db.patch(existing._id, {
        catalogProductIds,
        displayName: normalizedDisplayName(tier.displayName),
        priority,
        updatedAt: now,
      });
      return {
        catalogProductId: tier.catalogProductId,
        editionRecordId: existing._id,
      };
    }
    const editionRecordId = await ctx.db.insert('package_editions', {
      catalogProductIds,
      catalogTierIds: [args.catalogTierId],
      createdAt: now,
      creatorAuthUserId: args.authUserId,
      displayName: normalizedDisplayName(tier.displayName),
      editionId,
      packageId,
      priority,
      status: 'active',
      updatedAt: now,
    });
    return { catalogProductId: tier.catalogProductId, editionRecordId };
  },
});

export const archiveForCreator = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
    editionId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const packageId = normalizedPackageId(args.packageId);
    const editionId = normalizedEditionId(args.editionId);
    if (editionId === 'standard') {
      throw new ConvexError('The standard edition is always available');
    }
    const existing = await ctx.db
      .query('package_editions')
      .withIndex('by_creator_package_edition', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', packageId)
          .eq('editionId', editionId)
      )
      .first();
    if (!existing) {
      throw new ConvexError('Package edition not found');
    }
    if (existing.status !== 'archived') {
      await ctx.db.patch(existing._id, { status: 'archived', updatedAt: Date.now() });
    }
    return existing._id;
  },
});

type EntitlementMatch = {
  catalogProductId: Id<'product_catalog'>;
  entitlement: Doc<'entitlements'>;
  tierIds: Array<Id<'catalog_tiers'>>;
};

export const resolveBuyerEdition = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    buyerAuthUserId: v.string(),
    packageId: v.string(),
    catalogProductIds: v.array(v.id('product_catalog')),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const actor = await requireServiceActor(args.actor, [
      'downloads:service',
      'entitlements:service',
    ]);
    if (actor.authUserId !== args.buyerAuthUserId) {
      throw new ConvexError('Unauthorized: service actor is not bound to this buyer');
    }
    const packageId = normalizedPackageId(args.packageId);
    const catalogProductIds = uniqueIds(args.catalogProductIds);
    if (catalogProductIds.length === 0) {
      return null;
    }
    const products = (await Promise.all(catalogProductIds.map((id) => ctx.db.get(id)))).filter(
      (product): product is Doc<'product_catalog'> => Boolean(product)
    );
    if (products.length !== catalogProductIds.length) {
      return null;
    }
    if (products.some((product) => product.status !== 'active')) {
      return null;
    }
    const packageBindings = await Promise.all(
      catalogProductIds.map(async (catalogProductId) => {
        return await ctx.db
          .query('package_catalog_bindings')
          .withIndex('by_catalog_product_status', (q) =>
            q.eq('catalogProductId', catalogProductId).eq('status', 'active')
          )
          .take(2);
      })
    );
    if (
      packageBindings.some(
        (bindings) =>
          bindings.length !== 1 ||
          bindings[0]?.packageId !== packageId ||
          bindings[0]?.creatorAuthUserId !== products[0]?.authUserId
      )
    ) {
      return null;
    }
    const creatorAuthUserIds = new Set(products.map((product) => product.authUserId));
    if (creatorAuthUserIds.size !== 1) {
      return null;
    }
    const creatorAuthUserId = products[0]?.authUserId;
    if (!creatorAuthUserId) {
      return null;
    }
    const legacyIdentityToCatalogIds = new Map<string, Array<Id<'product_catalog'>>>();
    for (const product of products) {
      const key = `${product.provider}\u0000${product.productId}`;
      const candidates = legacyIdentityToCatalogIds.get(key) ?? [];
      candidates.push(product._id);
      legacyIdentityToCatalogIds.set(key, candidates);
    }
    const allowedCatalogProductIds = new Set(catalogProductIds.map(String));
    const subjects = (
      await ctx.db
        .query('subjects')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', args.buyerAuthUserId))
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
    )
      .flat()
      .filter(
        (entitlement) =>
          entitlement.authUserId === creatorAuthUserId &&
          entitlement.status === 'active' &&
          (entitlement.expiresAt === undefined || entitlement.expiresAt > Date.now())
      );

    const matches: EntitlementMatch[] = [];
    for (const entitlement of entitlements) {
      const legacyCandidates = entitlement.catalogProductId
        ? []
        : (legacyIdentityToCatalogIds.get(
            `${entitlement.sourceProvider}\u0000${entitlement.productId}`
          ) ?? []);
      const matchedCatalogProductId = entitlement.catalogProductId
        ? allowedCatalogProductIds.has(String(entitlement.catalogProductId))
          ? entitlement.catalogProductId
          : undefined
        : legacyCandidates.length === 1
          ? legacyCandidates[0]
          : undefined;
      if (!matchedCatalogProductId) {
        continue;
      }
      matches.push({
        catalogProductId: matchedCatalogProductId,
        entitlement,
        tierIds: await activeCatalogTierIdsForEntitlement(ctx, entitlement._id),
      });
    }
    if (matches.length === 0) {
      return null;
    }

    const editions = (
      await ctx.db
        .query('package_editions')
        .withIndex('by_creator_package', (q) =>
          q.eq('creatorAuthUserId', creatorAuthUserId).eq('packageId', packageId)
        )
        .collect()
    ).filter((edition) => edition.status === 'active');
    if (editions.length === 0) {
      return {
        editionId: 'standard',
        matchedCatalogProductId: matches[0]?.catalogProductId,
        matchedCatalogTierIds: matches[0]?.tierIds ?? [],
      };
    }

    const configuredTierIds = [
      ...new Map(
        editions.flatMap((edition) =>
          edition.catalogTierIds.map((catalogTierId) => [String(catalogTierId), catalogTierId])
        )
      ).values(),
    ];
    const configuredTiers = await Promise.all(
      configuredTierIds.map(async (catalogTierId) => await ctx.db.get(catalogTierId))
    );
    const configuredTierById = new Map(
      configuredTiers
        .filter(
          (tier): tier is Doc<'catalog_tiers'> =>
            tier !== null && tier.status === 'active' && tier.catalogProductId !== undefined
        )
        .map((tier) => [String(tier._id), tier])
    );

    const ranked = editions
      .map((edition) => {
        const editionProducts = new Set(edition.catalogProductIds.map(String));
        if (
          edition.catalogTierIds.some(
            (catalogTierId) => !configuredTierById.has(String(catalogTierId))
          )
        ) {
          return null;
        }
        const matched = matches
          .map((candidate) => {
            if (!editionProducts.has(String(candidate.catalogProductId))) {
              return null;
            }
            const candidateTierIds = edition.catalogTierIds.filter(
              (catalogTierId) =>
                configuredTierById.get(String(catalogTierId))?.catalogProductId ===
                candidate.catalogProductId
            );
            if (
              candidateTierIds.length > 0 &&
              !candidate.tierIds.some((tierId) => candidateTierIds.includes(tierId))
            ) {
              return null;
            }
            return { candidate, matchedTierCount: candidateTierIds.length };
          })
          .filter(
            (
              candidate
            ): candidate is {
              candidate: EntitlementMatch;
              matchedTierCount: number;
            } => candidate !== null
          )
          .sort(
            (left, right) =>
              right.matchedTierCount - left.matchedTierCount ||
              String(left.candidate.catalogProductId).localeCompare(
                String(right.candidate.catalogProductId)
              )
          )[0];
        return matched
          ? {
              edition,
              match: matched.candidate,
              matchedTierCount: matched.matchedTierCount,
            }
          : null;
      })
      .filter(
        (
          candidate
        ): candidate is {
          edition: Doc<'package_editions'>;
          match: EntitlementMatch;
          matchedTierCount: number;
        } => Boolean(candidate)
      )
      .sort(
        (left, right) =>
          right.edition.priority - left.edition.priority ||
          right.matchedTierCount - left.matchedTierCount ||
          left.edition.editionId.localeCompare(right.edition.editionId)
      );
    const selected = ranked[0];
    if (selected) {
      return {
        editionId: selected.edition.editionId,
        matchedCatalogProductId: selected.match.catalogProductId,
        matchedCatalogTierIds: selected.match.tierIds,
      };
    }
    return {
      editionId: 'standard',
      matchedCatalogProductId: matches[0]?.catalogProductId,
      matchedCatalogTierIds: matches[0]?.tierIds ?? [],
    };
  },
});
