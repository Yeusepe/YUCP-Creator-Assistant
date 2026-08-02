/**
 * One-time data migrations.
 * Run with:
 * - npx convex run migrations:purgeLegacyTenantDocuments
 * - npx convex run migrations:purgeGuildLinkVerifyPromptMessages
 * - npx convex run migrations:purgeLegacyOutboxVerifyPromptRefreshJobs
 * - npx convex run migrations:purgeRoleRuleSourceGuildNames
 * - npx convex run migrations:migrateLegacyLicenseSubjectLinks
 * - npx convex run migrations:repairEntitlementCatalogProductIds
 * - npx convex run migrations:resetIncompleteProviderLicenseIntents
 * - npx convex run migrations:listPackageVersionReleaseBackfillCandidates
 * - npx convex run migrations:backfillPackageVersionReleasePublication
 * - npx convex run migrations:backfillPackageVersionVpmMetadata
 * - npx convex run migrations:purgeCreatorVpmLinkCatalogProductIds
 * - npx convex run migrations:repairCreatorVpmLinkPackageBindings
 * - npx convex run migrations:repairPackageVersionEditionIds
 * - npx convex run migrations:repairCatalogProductCanonicalUrls
 * Re-run until the relevant migration returns 0 remaining records.
 */

import { v } from 'convex/values';
import {
  getProviderDescriptor,
  resolveCatalogProductUrl,
} from '@yucp/providers/providerMetadata';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { PII_PURPOSES } from './lib/credentialKeys';
import { upsertLicenseSubjectLink } from './lib/licenseSubjectLink';
import { encryptPii } from './lib/piiCrypto';
import { sha256Hex } from './lib/roleRules/queries';
import { enqueueRoleSync } from './lib/roleSyncEnqueue';
import { enqueueExistingRoleOutboxJobInWorkpool } from './lib/roleSyncWorkpoolDispatch';
import { decryptForPurpose } from './lib/vrchat/crypto';
import {
  detectCanonicalAuthResolutionForSubject,
  ensureCanonicalAuthUserIdForSubject,
  upsertBuyerProviderLinkRecord,
} from './subjects';

type LegacyMigrationDoc = Record<string, unknown>;
type TieredProductEvidenceRefreshProduct = {
  catalogProductId: Id<'product_catalog'>;
  authUserId: string;
  productId: string;
  provider: Doc<'product_catalog'>['provider'];
  providerProductRef: string;
};
type TieredProductEvidenceRefreshBatch = {
  products: TieredProductEvidenceRefreshProduct[];
  continueCursor: string;
  isDone: boolean;
};
type TieredProductEvidenceRefreshResult = {
  selected: number;
  refreshed: number;
  failures: Array<{ catalogProductId: string; error: string }>;
  continueCursor: string;
  isDone: boolean;
};
type TierEvidenceLicenseReverificationCandidate = {
  entitlementId: Id<'entitlements'>;
  authUserId: string;
  subjectId: Id<'subjects'>;
  provider: Doc<'entitlements'>['sourceProvider'];
  providerProductRef: string;
  licenseKeyEncrypted: string;
};
type TierEvidenceLicenseReverificationBatch = {
  candidates: TierEvidenceLicenseReverificationCandidate[];
  continueCursor: string;
  isDone: boolean;
};
type BuyerAttributionCandidateConfidence = 'high' | 'medium';
type BuyerAttributionRelatedBuyerProviderLink = {
  id: Id<'buyer_provider_links'>;
  subjectId: Id<'subjects'>;
  status: Doc<'buyer_provider_links'>['status'];
  verificationMethod?: Doc<'buyer_provider_links'>['verificationMethod'];
  linkedAt: number;
  createdAt: number;
  updatedAt: number;
};
type BuyerAttributionRelatedLicenseSubjectLink = {
  id: Id<'license_subject_links'>;
  licenseSubject: string;
  authUserId: string;
  providerUserId?: string;
  providerProductId?: string;
  externalOrderId?: string;
  createdAt: number;
  confidence: BuyerAttributionCandidateConfidence;
  reason: string;
  proposedAuthUserId: string;
  repairable: boolean;
};
type BuyerAttributionCandidate = {
  bindingId: Id<'bindings'>;
  bindingStatus: Doc<'bindings'>['status'];
  bindingCreatedAt: number;
  currentAuthUserId: string;
  expectedBuyerAuthUserId: string;
  subjectId: Id<'subjects'>;
  subjectDisplayName?: string;
  provider: Doc<'external_accounts'>['provider'];
  externalAccountId: Id<'external_accounts'>;
  providerUserId: string;
  providerUsername?: string;
  relatedBuyerProviderLinks: BuyerAttributionRelatedBuyerProviderLink[];
  relatedLicenseSubjectLinks: BuyerAttributionRelatedLicenseSubjectLink[];
  repairable: boolean;
};
type SubjectOwnershipResolution = 'better_auth' | 'existing_light' | 'new_light' | 'ambiguous';
type SubjectOwnershipRelatedBinding = {
  id: Id<'bindings'>;
  authUserId: string;
  status: Doc<'bindings'>['status'];
  createdAt: number;
  updatedAt: number;
  externalAccountId: Id<'external_accounts'>;
  provider?: Doc<'external_accounts'>['provider'];
  providerUserId?: string;
  providerUsername?: string;
};
type SubjectOwnershipCandidate = {
  subjectId: Id<'subjects'>;
  currentAuthUserId: string;
  discordUserId: string;
  subjectDisplayName?: string;
  expectedAuthUserId?: string;
  expectedLightAuthMarker?: string;
  ambiguousAuthUserIds?: string[];
  resolution: SubjectOwnershipResolution;
  relatedBuyerProviderLinks: BuyerAttributionRelatedBuyerProviderLink[];
  relatedVerificationBindings: SubjectOwnershipRelatedBinding[];
  repairable: boolean;
};
const DEFAULT_BUYER_ATTRIBUTION_REPORT_LIMIT = 50;
const DEFAULT_SUBJECT_OWNERSHIP_REPORT_LIMIT = 50;
const MAX_PACKAGE_EDITION_MIGRATION_READS = 64;
const MAX_PACKAGE_VERSION_MIGRATION_READS = 64;
const MAX_STORAGE_MIGRATION_BATCH = 5;
const REPORTABLE_BINDING_STATUSES = new Set<Doc<'bindings'>['status']>(['active', 'pending']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_VERSION_RELEASE_FIELDS = [
  'activeContentDigest',
  'activePolicyVersion',
  'bindingRoot',
  'commonRoot',
  'logicalBytes',
  'logicalFiles',
  'manifestSha256',
  'protectedFiles',
  'protectedSourceRoot',
  'protectionPolicyDigest',
  'protectionPolicyId',
  'releaseRoot',
  'vpmDependencies',
  'vpmRepositories',
] as const;

const ProtectedPackageFileV = v.object({
  materializerType: v.string(),
  normalizedPath: v.string(),
  required: v.boolean(),
  sourceSha256: v.string(),
});

function packageVersionReleaseNeedsBackfill(version: LegacyMigrationDoc): boolean {
  return (
    PACKAGE_VERSION_RELEASE_FIELDS.some((field) => !Object.hasOwn(version, field)) ||
    Object.hasOwn(version, 'contentType') ||
    Object.hasOwn(version, 'totalSize')
  );
}

export const listPackageVersionReleaseBackfillCandidates = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    candidates: v.array(
      v.object({
        packageId: v.string(),
        version: v.string(),
        versionId: v.string(),
      })
    ),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    scanned: v.number(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(
      1,
      Math.min(args.limit ?? MAX_STORAGE_MIGRATION_BATCH, MAX_STORAGE_MIGRATION_BATCH)
    );
    const page = await ctx.db
      .query('package_versions_ref')
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    return {
      candidates: page.page
        .filter((version) =>
          packageVersionReleaseNeedsBackfill(version as unknown as LegacyMigrationDoc)
        )
        .map((version) => ({
          packageId: version.packageId,
          version: version.version,
          versionId: version.versionId,
        })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
    };
  },
});

export const backfillPackageVersionReleasePublication = internalMutation({
  args: {
    activeContentDigest: v.string(),
    activePolicyVersion: v.string(),
    bindingRoot: v.string(),
    commonRoot: v.string(),
    logicalBytes: v.number(),
    logicalFiles: v.number(),
    manifestSha256: v.string(),
    protectedFiles: v.array(ProtectedPackageFileV),
    protectedSourceRoot: v.string(),
    protectionPolicyDigest: v.string(),
    protectionPolicyId: v.string(),
    releaseRoot: v.string(),
    versionId: v.string(),
    vpmDependencies: v.record(v.string(), v.string()),
    vpmRepositories: v.record(v.string(), v.string()),
  },
  returns: v.object({
    status: v.union(v.literal('already_complete'), v.literal('not_found'), v.literal('updated')),
  }),
  handler: async (ctx, args) => {
    const versions = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_version_id', (q) => q.eq('versionId', args.versionId))
      .take(2);
    if (versions.length === 0) {
      return { status: 'not_found' as const };
    }
    if (versions.length !== 1 || !versions[0]) {
      throw new Error('Package version durable identity is not unique');
    }
    for (const digest of [
      args.activeContentDigest,
      args.bindingRoot,
      args.commonRoot,
      args.manifestSha256,
      args.protectedSourceRoot,
      args.protectionPolicyDigest,
      args.releaseRoot,
      ...args.protectedFiles.map((file) => file.sourceSha256),
    ]) {
      if (!SHA256_PATTERN.test(digest)) {
        throw new Error('Package version release publication contains an invalid SHA-256 digest');
      }
    }
    if (
      !Number.isSafeInteger(args.logicalBytes) ||
      args.logicalBytes < 0 ||
      !Number.isSafeInteger(args.logicalFiles) ||
      args.logicalFiles < 1
    ) {
      throw new Error('Package version release publication contains invalid logical counts');
    }

    const version = versions[0];
    const legacy = version as unknown as LegacyMigrationDoc;
    const publication = {
      activeContentDigest: args.activeContentDigest,
      activePolicyVersion: args.activePolicyVersion,
      bindingRoot: args.bindingRoot,
      commonRoot: args.commonRoot,
      logicalBytes: args.logicalBytes,
      logicalFiles: args.logicalFiles,
      manifestSha256: args.manifestSha256,
      protectedFiles: args.protectedFiles,
      protectedSourceRoot: args.protectedSourceRoot,
      protectionPolicyDigest: args.protectionPolicyDigest,
      protectionPolicyId: args.protectionPolicyId,
      releaseRoot: args.releaseRoot,
      vpmDependencies: args.vpmDependencies,
      vpmRepositories: args.vpmRepositories,
    };
    for (const field of PACKAGE_VERSION_RELEASE_FIELDS) {
      if (
        Object.hasOwn(legacy, field) &&
        JSON.stringify(legacy[field]) !== JSON.stringify(publication[field])
      ) {
        throw new Error(`Package version release publication conflicts at ${field}`);
      }
    }
    if (!packageVersionReleaseNeedsBackfill(legacy)) {
      return { status: 'already_complete' as const };
    }
    await ctx.db.patch(version._id, {
      ...publication,
      contentType: undefined,
      totalSize: undefined,
    });
    return { status: 'updated' as const };
  },
});

export const backfillPackageVersionVpmMetadata = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    packageId: v.string(),
    vpmDependencies: v.record(v.string(), v.string()),
    vpmRepositories: v.record(v.string(), v.string()),
  },
  returns: v.object({
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    scanned: v.number(),
    updated: v.number(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const page = await ctx.db
      .query('package_versions_ref')
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    let updated = 0;
    for (const version of page.page) {
      if (version.packageId !== args.packageId) {
        continue;
      }
      await ctx.db.patch(version._id, {
        vpmDependencies: args.vpmDependencies,
        vpmRepositories: args.vpmRepositories,
      });
      updated++;
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      updated,
    };
  },
});

export const purgeCreatorVpmLinkCatalogProductIds = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    scanned: v.number(),
    unresolved: v.number(),
    updated: v.number(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(
      1,
      Math.min(args.limit ?? MAX_STORAGE_MIGRATION_BATCH, MAX_STORAGE_MIGRATION_BATCH)
    );
    const page = await ctx.db
      .query('creator_vpm_links')
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    let unresolved = 0;
    let updated = 0;
    for (const link of page.page) {
      const legacy = link as unknown as LegacyMigrationDoc;
      if (!Object.hasOwn(legacy, 'catalogProductId')) {
        continue;
      }
      const activeBindings = await ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_creator_package_status', (q) =>
          q
            .eq('creatorAuthUserId', link.creatorAuthUserId)
            .eq('packageId', link.packageId)
            .eq('status', 'active')
        )
        .take(1);
      if (activeBindings.length === 0) {
        const catalogProductId =
          typeof legacy.catalogProductId === 'string'
            ? ctx.db.normalizeId('product_catalog', legacy.catalogProductId)
            : null;
        const product = catalogProductId ? await ctx.db.get(catalogProductId) : null;
        const registration = await ctx.db
          .query('package_registry')
          .withIndex('by_package_id', (q) => q.eq('packageId', link.packageId))
          .unique();
        const priorBindings = catalogProductId
          ? await ctx.db
              .query('package_catalog_bindings')
              .withIndex('by_catalog_product_status', (q) =>
                q.eq('catalogProductId', catalogProductId)
              )
              .take(1)
          : [];
        if (
          !registration ||
          registration.status === 'archived' ||
          registration.yucpUserId !== link.creatorAuthUserId ||
          !product ||
          product.status === 'hidden' ||
          product.authUserId !== link.creatorAuthUserId ||
          priorBindings.length > 0
        ) {
          unresolved++;
          continue;
        }
        const now = Date.now();
        await ctx.db.insert('package_catalog_bindings', {
          creatorAuthUserId: link.creatorAuthUserId,
          packageId: link.packageId,
          catalogProductId: product._id,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }
      await ctx.db.patch(link._id, {
        catalogProductId: undefined,
      } as never);
      updated++;
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      unresolved,
      updated,
    };
  },
});

async function repairCreatorVpmLinkPackageBinding(
  ctx: MutationCtx,
  link: Doc<'creator_vpm_links'>
): Promise<'repaired' | 'resolved' | 'unresolved'> {
  if (link.status !== 'active') {
    return 'resolved';
  }
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', link.packageId))
    .unique();
  if (
    !registration ||
    registration.status === 'archived' ||
    registration.yucpUserId !== link.creatorAuthUserId
  ) {
    return 'unresolved';
  }
  const activeBinding = await ctx.db
    .query('package_catalog_bindings')
    .withIndex('by_creator_package_status', (q) =>
      q
        .eq('creatorAuthUserId', link.creatorAuthUserId)
        .eq('packageId', link.packageId)
        .eq('status', 'active')
    )
    .first();
  if (activeBinding) {
    return 'resolved';
  }

  const versions = await ctx.db
    .query('package_versions_ref')
    .withIndex('by_package_channel', (q) => q.eq('packageId', link.packageId))
    .take(MAX_PACKAGE_VERSION_MIGRATION_READS + 1);
  if (versions.length > MAX_PACKAGE_VERSION_MIGRATION_READS) {
    return 'unresolved';
  }
  const candidateIds = [
    ...new Set(
      versions.flatMap((version) =>
        version.catalogProductId ? [String(version.catalogProductId)] : []
      )
    ),
  ];
  const candidates = await Promise.all(
    candidateIds.map(async (candidateId) => {
      const id = ctx.db.normalizeId('product_catalog', candidateId);
      return id ? await ctx.db.get(id) : null;
    })
  );
  const activeOwnedCandidates = candidates.filter(
    (candidate): candidate is Doc<'product_catalog'> =>
      candidate !== null &&
      candidate.authUserId === link.creatorAuthUserId &&
      candidate.status !== 'hidden'
  );
  if (activeOwnedCandidates.length !== 1) {
    return 'unresolved';
  }
  const candidate = activeOwnedCandidates[0];
  if (
    !candidate ||
    (
      await ctx.db
        .query('package_catalog_bindings')
        .withIndex('by_catalog_product_status', (q) => q.eq('catalogProductId', candidate._id))
        .take(1)
    ).length > 0
  ) {
    return 'unresolved';
  }
  const now = Date.now();
  await ctx.db.insert('package_catalog_bindings', {
    creatorAuthUserId: link.creatorAuthUserId,
    packageId: link.packageId,
    catalogProductId: candidate._id,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return 'repaired';
}

export const repairCreatorVpmLinkPackageBindings = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    repaired: v.number(),
    scanned: v.number(),
    unresolved: v.number(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(
      1,
      Math.min(args.limit ?? MAX_STORAGE_MIGRATION_BATCH, MAX_STORAGE_MIGRATION_BATCH)
    );
    const page = await ctx.db
      .query('creator_vpm_links')
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    let repaired = 0;
    let unresolved = 0;
    for (const link of page.page) {
      const result = await repairCreatorVpmLinkPackageBinding(ctx, link);
      if (result === 'repaired') {
        repaired++;
      } else if (result === 'unresolved') {
        unresolved++;
      }
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      repaired,
      scanned: page.page.length,
      unresolved,
    };
  },
});

async function repairPackageVersionEditionId(
  ctx: MutationCtx,
  version: Doc<'package_versions_ref'>
): Promise<'repaired' | 'resolved' | 'unresolved'> {
  if (!version.catalogProductId) {
    return 'resolved';
  }
  const catalogProductId = version.catalogProductId;
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', version.packageId))
    .unique();
  const product = await ctx.db.get(catalogProductId);
  if (
    !registration ||
    registration.status === 'archived' ||
    !product ||
    product.status === 'hidden' ||
    product.authUserId !== registration.yucpUserId
  ) {
    return 'unresolved';
  }
  const editionPage = await ctx.db
    .query('package_editions')
    .withIndex('by_creator_package', (q) =>
      q.eq('creatorAuthUserId', registration.yucpUserId).eq('packageId', version.packageId)
    )
    .take(MAX_PACKAGE_EDITION_MIGRATION_READS + 1);
  if (editionPage.length > MAX_PACKAGE_EDITION_MIGRATION_READS) {
    return 'unresolved';
  }
  const editions = editionPage.filter(
    (edition) => edition.status === 'active' && edition.catalogProductIds.includes(catalogProductId)
  );
  const currentEditionId = version.editionId ?? 'standard';
  if (editions.length !== 1) {
    return 'unresolved';
  }
  if (editions[0]?.editionId === currentEditionId) {
    return 'resolved';
  }
  const targetEditionId = editions[0]?.editionId;
  if (!targetEditionId) {
    return 'unresolved';
  }
  const logicalConflict = (
    await ctx.db
      .query('package_versions_ref')
      .withIndex('by_package_edition_version', (q) =>
        q
          .eq('packageId', version.packageId)
          .eq('editionId', targetEditionId)
          .eq('version', version.version)
      )
      .take(2)
  ).some((candidate) => candidate._id !== version._id);
  const readyConflict =
    version.state === 'READY' &&
    (
      await ctx.db
        .query('package_versions_ref')
        .withIndex('by_package_edition_channel', (q) =>
          q
            .eq('packageId', version.packageId)
            .eq('editionId', targetEditionId)
            .eq('channel', version.channel)
            .eq('state', 'READY')
        )
        .take(1)
    ).some((candidate) => candidate._id !== version._id);
  if (logicalConflict || readyConflict) {
    return 'unresolved';
  }
  await ctx.db.patch(version._id, { editionId: targetEditionId });
  return 'repaired';
}

export const repairPackageVersionEditionIds = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    packageId: v.string(),
  },
  returns: v.object({
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    repaired: v.number(),
    scanned: v.number(),
    unresolved: v.number(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 5, 5));
    const page = await ctx.db
      .query('package_versions_ref')
      .withIndex('by_package_channel', (q) => q.eq('packageId', args.packageId))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    let repaired = 0;
    let unresolved = 0;
    for (const version of page.page) {
      const result = await repairPackageVersionEditionId(ctx, version);
      if (result === 'repaired') {
        repaired++;
      } else if (result === 'unresolved') {
        unresolved++;
      }
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      repaired,
      scanned: page.page.length,
      unresolved,
    };
  },
});

type CatalogProductResolution =
  | { status: 'resolved'; catalogProduct: Doc<'product_catalog'> }
  | { status: 'ambiguous' }
  | { status: 'unresolved' };

async function resolveEntitlementCatalogProduct(
  ctx: Pick<MutationCtx, 'db'>,
  entitlement: Doc<'entitlements'>
): Promise<CatalogProductResolution> {
  const evidenceRows = await ctx.db
    .query('entitlement_evidence')
    .withIndex('by_source_reference', (q) =>
      q
        .eq('providerKey', entitlement.sourceProvider)
        .eq('sourceReference', entitlement.sourceReference)
    )
    .filter((q) => q.eq(q.field('authUserId'), entitlement.authUserId))
    .filter((q) => q.eq(q.field('subjectId'), entitlement.subjectId))
    .filter((q) => q.eq(q.field('productId'), entitlement.productId))
    .collect();
  const evidenceCatalogIds = Array.from(
    new Set(
      evidenceRows.flatMap((evidence) =>
        evidence.catalogProductId ? [String(evidence.catalogProductId)] : []
      )
    )
  );
  if (evidenceCatalogIds.length > 1) {
    return { status: 'ambiguous' };
  }
  if (evidenceCatalogIds.length === 1) {
    const evidenceCatalogProduct = await ctx.db.get(evidenceCatalogIds[0] as Id<'product_catalog'>);
    if (
      evidenceCatalogProduct &&
      evidenceCatalogProduct.authUserId === entitlement.authUserId &&
      evidenceCatalogProduct.provider === entitlement.sourceProvider &&
      evidenceCatalogProduct.status === 'active'
    ) {
      return { status: 'resolved', catalogProduct: evidenceCatalogProduct };
    }
  }

  const providerReferenceMatches = await ctx.db
    .query('product_catalog')
    .withIndex('by_auth_user_provider_product_ref', (q) =>
      q.eq('authUserId', entitlement.authUserId).eq('providerProductRef', entitlement.productId)
    )
    .filter((q) => q.eq(q.field('provider'), entitlement.sourceProvider))
    .filter((q) => q.eq(q.field('status'), 'active'))
    .collect();
  if (providerReferenceMatches.length === 1) {
    return { status: 'resolved', catalogProduct: providerReferenceMatches[0] };
  }
  if (providerReferenceMatches.length > 1) {
    return { status: 'ambiguous' };
  }

  const localProductMatches = await ctx.db
    .query('product_catalog')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', entitlement.authUserId))
    .filter((q) => q.eq(q.field('provider'), entitlement.sourceProvider))
    .filter((q) => q.eq(q.field('productId'), entitlement.productId))
    .filter((q) => q.eq(q.field('status'), 'active'))
    .collect();
  if (localProductMatches.length === 1) {
    return { status: 'resolved', catalogProduct: localProductMatches[0] };
  }
  return { status: localProductMatches.length > 1 ? 'ambiguous' : 'unresolved' };
}

export const repairEntitlementCatalogProductIds = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    repaired: v.number(),
    evidenceRepaired: v.number(),
    ambiguous: v.number(),
    unresolved: v.number(),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const page = await ctx.db
      .query('entitlements')
      .withIndex('by_status', (q) => q.eq('status', 'active'))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const now = Date.now();
    let repaired = 0;
    let evidenceRepaired = 0;
    let ambiguous = 0;
    let unresolved = 0;

    for (const entitlement of page.page) {
      if (entitlement.catalogProductId) {
        continue;
      }
      const resolution = await resolveEntitlementCatalogProduct(ctx, entitlement);
      if (resolution.status === 'ambiguous') {
        ambiguous++;
        continue;
      }
      if (resolution.status === 'unresolved') {
        unresolved++;
        continue;
      }

      await ctx.db.patch(entitlement._id, {
        catalogProductId: resolution.catalogProduct._id,
        updatedAt: now,
      });
      repaired++;

      const evidenceRows = await ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q
            .eq('providerKey', entitlement.sourceProvider)
            .eq('sourceReference', entitlement.sourceReference)
        )
        .filter((q) => q.eq(q.field('authUserId'), entitlement.authUserId))
        .filter((q) => q.eq(q.field('subjectId'), entitlement.subjectId))
        .filter((q) => q.eq(q.field('productId'), entitlement.productId))
        .collect();
      for (const evidence of evidenceRows) {
        if (evidence.catalogProductId) {
          continue;
        }
        await ctx.db.patch(evidence._id, {
          catalogProductId: resolution.catalogProduct._id,
          updatedAt: now,
        });
        evidenceRepaired++;
      }
    }

    return {
      scanned: page.page.length,
      repaired,
      evidenceRepaired,
      ambiguous,
      unresolved,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

async function resolveProviderLicenseIntentCatalogProduct(
  ctx: Pick<MutationCtx, 'db'>,
  intent: Doc<'verification_intents'>,
  requirement: Doc<'verification_intents'>['requirements'][number]
): Promise<Doc<'product_catalog'> | null> {
  if (!requirement.providerProductRef) {
    return null;
  }

  const packageRegistration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', intent.packageId))
    .first();
  const creatorAuthUserId = requirement.creatorAuthUserId ?? packageRegistration?.yucpUserId;
  if (!creatorAuthUserId) {
    return null;
  }
  if (packageRegistration && packageRegistration.yucpUserId !== creatorAuthUserId) {
    return null;
  }

  const candidates = await ctx.db
    .query('product_catalog')
    .withIndex('by_auth_user_provider_product_ref', (q) =>
      q
        .eq('authUserId', creatorAuthUserId)
        .eq('providerProductRef', requirement.providerProductRef as string)
    )
    .collect();
  return (
    candidates.find(
      (candidate) =>
        candidate.provider === requirement.providerKey &&
        candidate.status === 'active' &&
        (!requirement.productId || candidate.productId === requirement.productId)
    ) ?? null
  );
}

export const resetIncompleteProviderLicenseIntents = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    reset: v.number(),
    preserved: v.number(),
    expired: v.number(),
    skipped: v.number(),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const page = await ctx.db
      .query('verification_intents')
      .withIndex('by_status_expires', (q) => q.eq('status', 'verified'))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const now = Date.now();
    let reset = 0;
    let preserved = 0;
    let expired = 0;
    let skipped = 0;

    for (const intent of page.page) {
      const requirement = intent.requirements.find(
        (entry) =>
          entry.methodKey === intent.verifiedMethodKey &&
          entry.kind === 'manual_license' &&
          entry.providerKey !== 'manual'
      );
      if (!requirement) {
        skipped++;
        continue;
      }

      if (intent.expiresAt <= now) {
        await ctx.db.patch(intent._id, {
          status: 'expired',
          verifiedMethodKey: undefined,
          verificationGrantJti: undefined,
          verificationGrantExpiresAt: undefined,
          errorCode: 'expired',
          errorMessage: 'Verification intent has expired',
          updatedAt: now,
        });
        expired++;
        continue;
      }

      const catalogProduct = await resolveProviderLicenseIntentCatalogProduct(
        ctx,
        intent,
        requirement
      );
      const entitlement =
        intent.subjectId && catalogProduct
          ? await ctx.db
              .query('entitlements')
              .withIndex('by_auth_user_subject', (q) =>
                q
                  .eq('authUserId', catalogProduct.authUserId)
                  .eq('subjectId', intent.subjectId as Id<'subjects'>)
              )
              .filter((q) =>
                q.and(
                  q.eq(q.field('catalogProductId'), catalogProduct._id),
                  q.eq(q.field('status'), 'active')
                )
              )
              .first()
          : null;
      if (entitlement) {
        preserved++;
        continue;
      }

      await ctx.db.patch(intent._id, {
        status: 'pending',
        verifiedMethodKey: undefined,
        verificationGrantJti: undefined,
        verificationGrantExpiresAt: undefined,
        verificationGrantUsedAt: undefined,
        errorCode: 'provider_license_reverification_required',
        errorMessage: 'Enter the license again to create canonical package access.',
        updatedAt: now,
      });
      reset++;
    }

    return {
      scanned: page.page.length,
      reset,
      preserved,
      expired,
      skipped,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

const LEGACY_TABLES = [
  'bindings',
  'verification_sessions',
  'entitlements',
  'guild_links',
  'role_rules',
  'download_routes',
  'download_artifacts',
  'unity_installations',
  'runtime_assertions',
  'outbox_jobs',
  'audit_events',
  'product_catalog',
  'purchase_facts',
  'provider_connections',
  'provider_credentials',
  'provider_connection_capabilities',
  'provider_catalog_mappings',
  'provider_transactions',
  'provider_memberships',
  'provider_licenses',
  'entitlement_evidence',
  'creator_oauth_apps',
  'manual_licenses',
  'webhook_events',
  'collaborator_invites',
  'collaborator_connections',
  'creator_profiles',
] as const;

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function isProviderScopedSubjectIdentity(primaryDiscordUserId: string): boolean {
  return primaryDiscordUserId.includes(':');
}

function normalizeProviderTierRefs(providerTierRefs: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      providerTierRefs
        .map((providerTierRef) => providerTierRef?.trim())
        .filter((providerTierRef): providerTierRef is string => Boolean(providerTierRef))
    )
  );
}

function parseEntitlementPurchaseReference(
  provider: Doc<'entitlements'>['sourceProvider'],
  sourceReference: string
): { externalOrderId: string } | null {
  const trimmed = sourceReference.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(':');
  if (parts.length >= 2 && parts[0] === provider && parts[1]) {
    return {
      externalOrderId: parts[1],
    };
  }

  return { externalOrderId: trimmed };
}

async function activeCatalogTierRefsForEntitlement(
  ctx: Pick<QueryCtx, 'db'>,
  entitlement: Doc<'entitlements'>
): Promise<Set<string>> {
  const catalogTiers = await ctx.db
    .query('catalog_tiers')
    .withIndex('by_product', (q) =>
      q.eq('authUserId', entitlement.authUserId).eq('productId', entitlement.productId)
    )
    .filter((q) => q.eq(q.field('status'), 'active'))
    .collect();

  return new Set(catalogTiers.map((tier) => tier.providerTierRef.trim()).filter(Boolean));
}

async function activeEntitlementTierEvidenceRefs(
  ctx: Pick<QueryCtx, 'db'>,
  entitlement: Doc<'entitlements'>
): Promise<Set<string>> {
  const evidenceRows = await ctx.db
    .query('entitlement_evidence')
    .withIndex('by_source_reference', (q) =>
      q
        .eq('providerKey', entitlement.sourceProvider)
        .eq('sourceReference', entitlement.sourceReference)
    )
    .filter((q) => q.eq(q.field('authUserId'), entitlement.authUserId))
    .filter((q) => q.eq(q.field('subjectId'), entitlement.subjectId))
    .filter((q) => q.eq(q.field('productId'), entitlement.productId))
    .collect();

  const providerTierRefs = new Set<string>();
  for (const evidence of evidenceRows) {
    if (evidence.status !== 'active' || !Array.isArray(evidence.providerTierRefs)) {
      continue;
    }
    for (const providerTierRef of evidence.providerTierRefs) {
      const normalized = providerTierRef.trim();
      if (normalized) {
        providerTierRefs.add(normalized);
      }
    }
  }
  return providerTierRefs;
}

function purchaseFactMatchesEntitlementProduct(args: {
  purchaseFact: Doc<'purchase_facts'>;
  entitlement: Doc<'entitlements'>;
  catalogProduct: Doc<'product_catalog'> | null;
}): boolean {
  const allowedProviderProductRefs = new Set<string>();
  allowedProviderProductRefs.add(args.entitlement.productId);
  if (args.catalogProduct?.providerProductRef) {
    allowedProviderProductRefs.add(args.catalogProduct.providerProductRef);
  }
  if (args.catalogProduct?.productId) {
    allowedProviderProductRefs.add(args.catalogProduct.productId);
  }
  return allowedProviderProductRefs.has(args.purchaseFact.providerProductId);
}

async function findRepairPurchaseFactForEntitlement(
  ctx: Pick<QueryCtx, 'db'>,
  entitlement: Doc<'entitlements'>
): Promise<Doc<'purchase_facts'> | null> {
  const purchaseRef = parseEntitlementPurchaseReference(
    entitlement.sourceProvider,
    entitlement.sourceReference
  );
  if (!purchaseRef) {
    return null;
  }

  const catalogProduct = entitlement.catalogProductId
    ? await ctx.db.get(entitlement.catalogProductId)
    : null;
  const purchaseFacts = await ctx.db
    .query('purchase_facts')
    .withIndex('by_auth_user_provider_order', (q) =>
      q
        .eq('authUserId', entitlement.authUserId)
        .eq('provider', entitlement.sourceProvider)
        .eq('externalOrderId', purchaseRef.externalOrderId)
    )
    .collect();

  const matchingPurchaseFacts = purchaseFacts.filter((purchaseFact) => {
    if (purchaseFact.lifecycleStatus !== 'active') {
      return false;
    }
    if (
      entitlement.subjectId &&
      purchaseFact.subjectId &&
      purchaseFact.subjectId !== entitlement.subjectId
    ) {
      return false;
    }
    return purchaseFactMatchesEntitlementProduct({
      purchaseFact,
      entitlement,
      catalogProduct,
    });
  });

  return matchingPurchaseFacts.length === 1 ? matchingPurchaseFacts[0] : null;
}

async function listRelatedBuyerProviderLinks(
  ctx: Pick<QueryCtx, 'db'>,
  subjectId: Id<'subjects'>,
  externalAccountId?: Id<'external_accounts'>
): Promise<BuyerAttributionRelatedBuyerProviderLink[]> {
  const links = externalAccountId
    ? ((await ctx.db
        .query('buyer_provider_links')
        .withIndex('by_subject_external', (q) =>
          q.eq('subjectId', subjectId).eq('externalAccountId', externalAccountId)
        )
        .collect()) as Doc<'buyer_provider_links'>[])
    : ((await ctx.db
        .query('buyer_provider_links')
        .withIndex('by_subject', (q) => q.eq('subjectId', subjectId))
        .collect()) as Doc<'buyer_provider_links'>[]);

  return links.map((link) => ({
    id: link._id,
    subjectId: link.subjectId,
    status: link.status,
    verificationMethod: link.verificationMethod,
    linkedAt: link.linkedAt,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  }));
}

async function listAllRelatedVerificationBindings(
  ctx: Pick<QueryCtx, 'db'>,
  subjectId: Id<'subjects'>
): Promise<SubjectOwnershipRelatedBinding[]> {
  const bindings = (await ctx.db.query('bindings').collect()) as Doc<'bindings'>[];

  const relatedBindings: SubjectOwnershipRelatedBinding[] = [];
  for (const binding of bindings) {
    if (
      binding.subjectId !== subjectId ||
      binding.bindingType !== 'verification' ||
      !REPORTABLE_BINDING_STATUSES.has(binding.status)
    ) {
      continue;
    }

    const externalAccount = await ctx.db.get(binding.externalAccountId);
    relatedBindings.push({
      id: binding._id,
      authUserId: binding.authUserId,
      status: binding.status,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
      externalAccountId: binding.externalAccountId,
      provider: externalAccount?.provider,
      providerUserId: externalAccount?.providerUserId,
      providerUsername: externalAccount?.providerUsername,
    });
  }

  return relatedBindings;
}

async function buildBuyerAttributionCandidate(
  ctx: Pick<QueryCtx, 'db'>,
  binding: Doc<'bindings'>
): Promise<BuyerAttributionCandidate | null> {
  if (binding.bindingType !== 'verification' || !REPORTABLE_BINDING_STATUSES.has(binding.status)) {
    return null;
  }

  const subject = await ctx.db.get(binding.subjectId);
  if (!subject?.authUserId || subject.authUserId === binding.authUserId) {
    return null;
  }

  const externalAccount = await ctx.db.get(binding.externalAccountId);
  if (!externalAccount?.provider || !externalAccount.providerUserId) {
    return null;
  }

  const providerUserCollision = await hasProviderUserCollision(ctx, binding, externalAccount);

  const relatedBuyerProviderLinks = await listRelatedBuyerProviderLinks(
    ctx,
    binding.subjectId,
    binding.externalAccountId
  );

  const highConfidenceMatches: BuyerAttributionRelatedLicenseSubjectLink[] = [];
  const mediumConfidenceMatches: BuyerAttributionRelatedLicenseSubjectLink[] = [];
  const licenseLinks = (await ctx.db
    .query('license_subject_links')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', binding.authUserId))
    .collect()) as Doc<'license_subject_links'>[];

  for (const licenseLink of licenseLinks) {
    if (licenseLink.provider !== externalAccount.provider) {
      continue;
    }

    if (
      licenseLink.providerUserId &&
      licenseLink.providerUserId === externalAccount.providerUserId
    ) {
      highConfidenceMatches.push({
        id: licenseLink._id,
        licenseSubject: licenseLink.licenseSubject,
        authUserId: licenseLink.authUserId,
        providerUserId: licenseLink.providerUserId,
        providerProductId: licenseLink.providerProductId,
        externalOrderId: licenseLink.externalOrderId,
        createdAt: licenseLink.createdAt,
        confidence: 'high',
        reason: providerUserCollision
          ? 'providerUserId matches more than one suspect buyer subject; manual review required'
          : 'providerUserId matches the external account linked by the suspect binding',
        proposedAuthUserId: subject.authUserId,
        repairable: !providerUserCollision,
      });
      continue;
    }

    if (licenseLink.createdAt === binding.createdAt) {
      mediumConfidenceMatches.push({
        id: licenseLink._id,
        licenseSubject: licenseLink.licenseSubject,
        authUserId: licenseLink.authUserId,
        providerUserId: licenseLink.providerUserId,
        providerProductId: licenseLink.providerProductId,
        externalOrderId: licenseLink.externalOrderId,
        createdAt: licenseLink.createdAt,
        confidence: 'medium',
        reason: 'same provider and createdAt as the suspect verification binding',
        proposedAuthUserId: subject.authUserId,
        repairable: false,
      });
    }
  }

  return {
    bindingId: binding._id,
    bindingStatus: binding.status,
    bindingCreatedAt: binding.createdAt,
    currentAuthUserId: binding.authUserId,
    expectedBuyerAuthUserId: subject.authUserId,
    subjectId: binding.subjectId,
    subjectDisplayName: subject.displayName,
    provider: externalAccount.provider,
    externalAccountId: binding.externalAccountId,
    providerUserId: externalAccount.providerUserId,
    providerUsername: externalAccount.providerUsername,
    relatedBuyerProviderLinks,
    relatedLicenseSubjectLinks: uniqueById([...highConfidenceMatches, ...mediumConfidenceMatches]),
    repairable: true,
  };
}

async function hasProviderUserCollision(
  ctx: Pick<QueryCtx, 'db'>,
  binding: Doc<'bindings'>,
  externalAccount: Doc<'external_accounts'>
): Promise<boolean> {
  const suspectBindings = (await ctx.db
    .query('bindings')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', binding.authUserId))
    .collect()) as Doc<'bindings'>[];
  const candidateBuyerAuthUserIds = new Set<string>();

  for (const suspectBinding of suspectBindings) {
    if (
      suspectBinding.bindingType !== 'verification' ||
      !REPORTABLE_BINDING_STATUSES.has(suspectBinding.status)
    ) {
      continue;
    }

    const suspectSubject = await ctx.db.get(suspectBinding.subjectId);
    if (!suspectSubject?.authUserId || suspectSubject.authUserId === suspectBinding.authUserId) {
      continue;
    }

    const suspectExternalAccount =
      suspectBinding.externalAccountId === binding.externalAccountId
        ? externalAccount
        : ((await ctx.db.get(suspectBinding.externalAccountId)) as Doc<'external_accounts'> | null);
    if (
      !suspectExternalAccount?.providerUserId ||
      suspectExternalAccount.provider !== externalAccount.provider ||
      suspectExternalAccount.providerUserId !== externalAccount.providerUserId
    ) {
      continue;
    }

    candidateBuyerAuthUserIds.add(suspectSubject.authUserId);
    if (candidateBuyerAuthUserIds.size > 1) {
      return true;
    }
  }

  return false;
}

async function listBuyerAttributionCandidates(ctx: Pick<QueryCtx, 'db'>, limit: number) {
  const candidates: BuyerAttributionCandidate[] = [];
  const bindings = ((await ctx.db.query('bindings').collect()) as Doc<'bindings'>[]).reverse();

  for (const binding of bindings) {
    const candidate = await buildBuyerAttributionCandidate(ctx, binding);
    if (!candidate) {
      continue;
    }
    candidates.push(candidate);
    if (candidates.length >= limit) {
      break;
    }
  }

  return {
    scannedAt: Date.now(),
    summary: {
      candidateBindings: candidates.length,
      repairableBindings: candidates.filter((candidate) => candidate.repairable).length,
      buyerProviderLinksForReview: candidates.reduce(
        (total, candidate) => total + candidate.relatedBuyerProviderLinks.length,
        0
      ),
      repairableLicenseSubjectLinks: candidates.reduce(
        (total, candidate) =>
          total + candidate.relatedLicenseSubjectLinks.filter((link) => link.repairable).length,
        0
      ),
      reviewOnlyLicenseSubjectLinks: candidates.reduce(
        (total, candidate) =>
          total + candidate.relatedLicenseSubjectLinks.filter((link) => !link.repairable).length,
        0
      ),
    },
    candidates,
  };
}

async function buildSubjectOwnershipCandidate(
  ctx: Pick<QueryCtx, 'db' | 'runQuery'>,
  subject: Doc<'subjects'>
): Promise<SubjectOwnershipCandidate | null> {
  if (!subject.authUserId || subject.status !== 'active') {
    return null;
  }

  const relatedBuyerProviderLinks = await listRelatedBuyerProviderLinks(ctx, subject._id);
  const relatedVerificationBindings = await listAllRelatedVerificationBindings(ctx, subject._id);

  if (isProviderScopedSubjectIdentity(subject.primaryDiscordUserId)) {
    const conflictingAuthUserIds = Array.from(
      new Set(
        relatedVerificationBindings
          .map((binding) => binding.authUserId)
          .filter((authUserId) => authUserId !== subject.authUserId)
      )
    );

    if (conflictingAuthUserIds.length === 0) {
      return null;
    }

    return {
      subjectId: subject._id,
      currentAuthUserId: subject.authUserId,
      discordUserId: subject.primaryDiscordUserId,
      subjectDisplayName: subject.displayName,
      ambiguousAuthUserIds: [subject.authUserId, ...conflictingAuthUserIds].sort(),
      resolution: 'ambiguous',
      relatedBuyerProviderLinks,
      relatedVerificationBindings,
      repairable: false,
    };
  }

  const resolution = await detectCanonicalAuthResolutionForSubject(ctx, subject);
  if (resolution.kind === 'resolved' && resolution.authUserId === subject.authUserId) {
    return null;
  }
  if (resolution.kind === 'ambiguous' && resolution.authUserIds.includes(subject.authUserId)) {
    return null;
  }

  return {
    subjectId: subject._id,
    currentAuthUserId: subject.authUserId,
    discordUserId: subject.primaryDiscordUserId,
    subjectDisplayName: subject.displayName,
    expectedAuthUserId: resolution.kind === 'resolved' ? resolution.authUserId : undefined,
    expectedLightAuthMarker:
      resolution.kind === 'materialize_light' ? resolution.marker : undefined,
    ambiguousAuthUserIds: resolution.kind === 'ambiguous' ? resolution.authUserIds : undefined,
    resolution:
      resolution.kind === 'resolved'
        ? resolution.source
        : resolution.kind === 'materialize_light'
          ? 'new_light'
          : 'ambiguous',
    relatedBuyerProviderLinks,
    relatedVerificationBindings,
    repairable: resolution.kind !== 'ambiguous',
  };
}

async function listSubjectOwnershipCandidates(
  ctx: Pick<QueryCtx, 'db' | 'runQuery'>,
  limit: number
) {
  const candidates: SubjectOwnershipCandidate[] = [];
  const subjects = ((await ctx.db.query('subjects').collect()) as Doc<'subjects'>[]).reverse();

  for (const subject of subjects) {
    const candidate = await buildSubjectOwnershipCandidate(ctx, subject);
    if (!candidate) {
      continue;
    }
    candidates.push(candidate);
    if (candidates.length >= limit) {
      break;
    }
  }

  return {
    scannedAt: Date.now(),
    summary: {
      candidateSubjects: candidates.length,
      repairableSubjects: candidates.filter((candidate) => candidate.repairable).length,
      reviewOnlySubjects: candidates.filter((candidate) => !candidate.repairable).length,
      buyerProviderLinksForReview: candidates.reduce(
        (total, candidate) => total + candidate.relatedBuyerProviderLinks.length,
        0
      ),
      followUpVerificationBindings: candidates.reduce(
        (total, candidate) => total + candidate.relatedVerificationBindings.length,
        0
      ),
    },
    candidates,
  };
}

async function repairBuyerAttributionBindingIds(
  ctx: Pick<MutationCtx, 'db'>,
  bindingIds: readonly Id<'bindings'>[]
) {
  const uniqueBindingIds = Array.from(new Set(bindingIds));
  const skippedBindings: Array<{ bindingId: Id<'bindings'>; reason: string }> = [];
  const repairedLicenseLinkIds = new Set<string>();
  const initialCandidates = new Map<Id<'bindings'>, BuyerAttributionCandidate | null>();
  let repairedBindings = 0;
  let repairedLicenseSubjectLinks = 0;
  let createdBuyerProviderLinks = 0;

  for (const bindingId of uniqueBindingIds) {
    const binding = (await ctx.db.get(bindingId)) as Doc<'bindings'> | null;
    initialCandidates.set(
      bindingId,
      binding ? await buildBuyerAttributionCandidate(ctx, binding) : null
    );
  }

  for (const bindingId of uniqueBindingIds) {
    const binding = (await ctx.db.get(bindingId)) as Doc<'bindings'> | null;
    if (!binding) {
      skippedBindings.push({ bindingId, reason: 'Binding no longer exists' });
      continue;
    }

    const candidate = initialCandidates.get(bindingId) ?? null;
    if (!candidate) {
      skippedBindings.push({
        bindingId,
        reason: 'Binding is no longer a repairable buyer-attribution candidate',
      });
      continue;
    }

    const existingBuyerBinding = (await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', candidate.expectedBuyerAuthUserId).eq('subjectId', candidate.subjectId)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field('externalAccountId'), candidate.externalAccountId),
          q.or(q.eq(q.field('status'), 'active'), q.eq(q.field('status'), 'pending'))
        )
      )
      .first()) as Doc<'bindings'> | null;

    if (existingBuyerBinding && existingBuyerBinding._id !== binding._id) {
      await ctx.db.patch(binding._id, {
        status: 'revoked',
        reason: 'Merged into buyer-scoped verification binding during remediation',
        version: binding.version + 1,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.patch(binding._id, {
        authUserId: candidate.expectedBuyerAuthUserId,
        version: binding.version + 1,
        updatedAt: Date.now(),
      });
    }
    repairedBindings += 1;

    const hasActiveBuyerProviderLink = candidate.relatedBuyerProviderLinks.some(
      (link) => link.status === 'active'
    );
    if (!hasActiveBuyerProviderLink) {
      await upsertBuyerProviderLinkRecord(ctx, {
        subjectId: candidate.subjectId,
        provider: candidate.provider,
        externalAccountId: candidate.externalAccountId,
        verificationMethod: 'account_link',
      });
      if (candidate.relatedBuyerProviderLinks.length === 0) {
        createdBuyerProviderLinks += 1;
      }
    }

    for (const relatedLicenseLink of candidate.relatedLicenseSubjectLinks) {
      if (
        !relatedLicenseLink.repairable ||
        repairedLicenseLinkIds.has(String(relatedLicenseLink.id))
      ) {
        continue;
      }

      const source = (await ctx.db.get(
        relatedLicenseLink.id
      )) as Doc<'license_subject_links'> | null;
      if (!source) {
        continue;
      }

      const targetId = await upsertLicenseSubjectLink(ctx, {
        authUserId: candidate.expectedBuyerAuthUserId,
        licenseSubject: source.licenseSubject,
        packageId: source.packageId,
        provider: source.provider,
        licenseKeyEncrypted: source.licenseKeyEncrypted,
        providerUserId: source.providerUserId,
        externalOrderId: source.externalOrderId,
        providerProductId: source.providerProductId,
      });

      if (targetId !== source._id) {
        await ctx.db.delete(source._id);
      }

      repairedLicenseLinkIds.add(String(source._id));
      repairedLicenseSubjectLinks += 1;
    }
  }

  return {
    repairedBindings,
    repairedLicenseSubjectLinks,
    createdBuyerProviderLinks,
    skippedBindings,
  };
}

/**
 * Delete up to 200 legacy tenant documents per table (plus up to 200
 * catalog_product_links) per call. Re-run until it returns { deleted: 0 }.
 */
export const purgeLegacyTenantDocuments = internalMutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    const PER_TABLE = 200;

    for (const table of LEGACY_TABLES) {
      // Filter to only fetch docs that still have a legacy tenantId field,
      // so .take() selects from the right pool regardless of insertion order.
      const docs = await ctx.db
        .query(table)
        .filter((q) => q.neq(q.field('tenantId'), null))
        .take(PER_TABLE);
      for (const doc of docs) {
        const fields = doc as LegacyMigrationDoc;
        const hasAuthUserId =
          ('authUserId' in fields && fields.authUserId != null) ||
          ('ownerAuthUserId' in fields && fields.ownerAuthUserId != null) ||
          ('submittedByAuthUserId' in fields && fields.submittedByAuthUserId != null);
        const hasLegacyTenantId =
          ('tenantId' in fields && fields.tenantId != null) ||
          ('ownerTenantId' in fields && fields.ownerTenantId != null) ||
          ('submittedByTenantId' in fields && fields.submittedByTenantId != null);
        if (hasLegacyTenantId && !hasAuthUserId) {
          await ctx.db.delete(doc._id);
          deleted++;
        }
      }
    }

    // Also purge catalog_product_links with submittedByTenantId
    const catalogLinks = await ctx.db
      .query('catalog_product_links')
      .filter((q) => q.neq(q.field('submittedByTenantId'), null))
      .take(PER_TABLE);
    for (const doc of catalogLinks) {
      const fields = doc as LegacyMigrationDoc;
      if (fields.submittedByTenantId != null && fields.submittedByAuthUserId == null) {
        await ctx.db.delete(doc._id);
        deleted++;
      }
    }

    return { deleted };
  },
});

/**
 * Remove legacy guild_links.verifyPromptMessage fields in batches.
 * Re-run until it returns { updated: 0 }.
 */
export const purgeGuildLinkVerifyPromptMessages = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('guild_links')
      .filter((q) => q.neq(q.field('verifyPromptMessage'), null))
      .take(200);

    let updated = 0;
    for (const doc of docs) {
      await ctx.db.patch(doc._id, {
        verifyPromptMessage: undefined,
      });
      updated++;
    }

    return { updated };
  },
});

/**
 * Remove legacy outbox_jobs rows for the retired verify_prompt_refresh workflow.
 * Re-run until it returns { deleted: 0 }.
 */
export const purgeLegacyOutboxVerifyPromptRefreshJobs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('outbox_jobs')
      .filter((q) => q.eq(q.field('jobType'), 'verify_prompt_refresh'))
      .take(200);

    let deleted = 0;
    for (const doc of docs) {
      await ctx.db.delete(doc._id);
      deleted++;
    }

    return { deleted };
  },
});

/**
 * Remove legacy role_rules.sourceGuildName fields in batches.
 * Re-run until it returns { updated: 0 }.
 */
export const purgeRoleRuleSourceGuildNames = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('role_rules')
      .filter((q) => q.neq(q.field('sourceGuildName'), null))
      .take(200);

    let updated = 0;
    for (const doc of docs) {
      await ctx.db.patch(doc._id, {
        sourceGuildName: undefined,
      });
      updated++;
    }

    return { updated };
  },
});

/**
 * Encrypt legacy plaintext license keys and drop redundant purchaser emails.
 * Re-run until it returns { updated: 0 }.
 */
export const migrateLegacyLicenseSubjectLinks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('license_subject_links')
      .filter((q) =>
        q.or(q.neq(q.field('licenseKey'), null), q.neq(q.field('purchaserEmail'), null))
      )
      .take(200);

    let updated = 0;
    for (const doc of docs) {
      const licenseKeyEncrypted =
        doc.licenseKeyEncrypted ??
        (doc.licenseKey
          ? await encryptPii(doc.licenseKey, PII_PURPOSES.forensicsLicenseKey)
          : undefined);
      await ctx.db.patch(doc._id, {
        licenseKey: undefined,
        licenseKeyEncrypted,
        purchaserEmail: undefined,
      });
      updated++;
    }

    return { updated };
  },
});

/**
 * Detection-first remediation report for buyer verification records that were
 * historically attributed to the creator auth user instead of the buyer.
 */
export const listBuyerAttributionRemediationCandidates = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? DEFAULT_BUYER_ATTRIBUTION_REPORT_LIMIT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.trunc(requestedLimit)))
      : DEFAULT_BUYER_ATTRIBUTION_REPORT_LIMIT;
    return await listBuyerAttributionCandidates(ctx, limit);
  },
});

/**
 * Detection-first remediation report for subjects whose auth owner no longer
 * matches the canonical Discord account owner from Better Auth.
 */
export const listSubjectOwnershipRemediationCandidates = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? DEFAULT_SUBJECT_OWNERSHIP_REPORT_LIMIT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.trunc(requestedLimit)))
      : DEFAULT_SUBJECT_OWNERSHIP_REPORT_LIMIT;
    return await listSubjectOwnershipCandidates(ctx, limit);
  },
});

/**
 * Explicit, opt-in repair for selected buyer-attribution candidates. This only
 * moves verification bindings plus high-confidence license subject links. Any
 * ambiguous license links remain in the report for operator review.
 */
export const repairBuyerAttributionCandidates = internalMutation({
  args: {
    bindingIds: v.array(v.id('bindings')),
  },
  handler: async (ctx, args) => await repairBuyerAttributionBindingIds(ctx, args.bindingIds),
});

/**
 * Explicit, opt-in repair for selected subjects with wrong auth ownership.
 * After re-homing each subject, this reuses the existing buyer-attribution
 * repair flow for any verification bindings that become newly suspect.
 */
export const repairSubjectOwnershipCandidates = internalMutation({
  args: {
    subjectIds: v.array(v.id('subjects')),
  },
  handler: async (ctx, args) => {
    const uniqueSubjectIds = Array.from(new Set(args.subjectIds));
    const skippedSubjects: Array<{ subjectId: Id<'subjects'>; reason: string }> = [];
    const followUpBindingIds = new Set<Id<'bindings'>>();
    let repairedSubjects = 0;
    let createdLightAuthUsers = 0;

    for (const subjectId of uniqueSubjectIds) {
      const subject = (await ctx.db.get(subjectId)) as Doc<'subjects'> | null;
      if (!subject) {
        skippedSubjects.push({ subjectId, reason: 'Subject no longer exists' });
        continue;
      }

      const candidate = await buildSubjectOwnershipCandidate(ctx, subject);
      if (!candidate) {
        skippedSubjects.push({
          subjectId,
          reason: 'Subject is no longer a repairable ownership candidate',
        });
        continue;
      }
      if (!candidate.repairable) {
        skippedSubjects.push({
          subjectId,
          reason: 'Subject ownership is ambiguous and requires manual review',
        });
        continue;
      }

      const resolved = await ensureCanonicalAuthUserIdForSubject(ctx, subject);
      if (resolved.source === 'new_light') {
        createdLightAuthUsers += 1;
      }

      await ctx.db.patch(subject._id, {
        authUserId: resolved.authUserId,
        updatedAt: Date.now(),
      });
      repairedSubjects += 1;

      const relatedBindings = (await ctx.db
        .query('bindings')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', candidate.currentAuthUserId).eq('subjectId', subject._id)
        )
        .collect()) as Doc<'bindings'>[];
      for (const binding of relatedBindings) {
        if (
          binding.bindingType !== 'verification' ||
          !REPORTABLE_BINDING_STATUSES.has(binding.status)
        ) {
          continue;
        }
        followUpBindingIds.add(binding._id);
      }
    }

    const bindingRepairResult =
      followUpBindingIds.size > 0
        ? await repairBuyerAttributionBindingIds(ctx, Array.from(followUpBindingIds))
        : {
            repairedBindings: 0,
            repairedLicenseSubjectLinks: 0,
            createdBuyerProviderLinks: 0,
            skippedBindings: [],
          };

    return {
      repairedSubjects,
      createdLightAuthUsers,
      skippedSubjects,
      ...bindingRepairResult,
    };
  },
});

export const repairEntitlementEvidenceTierRefs = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    repaired: v.number(),
    skipped: v.number(),
    roleSyncJobsCreated: v.number(),
    skippedNoDiscordId: v.number(),
    remaining: v.number(),
    continueCursor: v.optional(v.union(v.string(), v.null())),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const page = await ctx.db
      .query('entitlements')
      .withIndex('by_status', (q) => q.eq('status', 'active'))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const now = Date.now();

    let scanned = 0;
    let repaired = 0;
    let skipped = 0;
    let roleSyncJobsCreated = 0;
    let skippedNoDiscordId = 0;

    for (const entitlement of page.page) {
      const activeCatalogTierRefs = await activeCatalogTierRefsForEntitlement(ctx, entitlement);
      const activeEvidenceTierRefs = await activeEntitlementTierEvidenceRefs(ctx, entitlement);
      if (
        [...activeEvidenceTierRefs].some((providerTierRef) =>
          activeCatalogTierRefs.has(providerTierRef)
        )
      ) {
        continue;
      }
      if (activeCatalogTierRefs.size === 0 && activeEvidenceTierRefs.size > 0) {
        continue;
      }

      scanned++;
      const purchaseFact = await findRepairPurchaseFactForEntitlement(ctx, entitlement);
      if (!purchaseFact) {
        skipped++;
        continue;
      }

      const providerTierRefs = normalizeProviderTierRefs([
        purchaseFact.providerProductVersionId,
        purchaseFact.externalVariantId,
      ]);
      if (providerTierRefs.length === 0) {
        skipped++;
        continue;
      }
      if (
        activeCatalogTierRefs.size > 0 &&
        !providerTierRefs.some((providerTierRef) => activeCatalogTierRefs.has(providerTierRef))
      ) {
        skipped++;
        continue;
      }

      const existing = await ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q
            .eq('providerKey', entitlement.sourceProvider)
            .eq('sourceReference', entitlement.sourceReference)
        )
        .filter((q) => q.eq(q.field('authUserId'), entitlement.authUserId))
        .filter((q) => q.eq(q.field('subjectId'), entitlement.subjectId))
        .filter((q) => q.eq(q.field('productId'), entitlement.productId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          subjectId: entitlement.subjectId,
          status: 'active',
          productId: entitlement.productId,
          catalogProductId: entitlement.catalogProductId ?? existing.catalogProductId,
          providerTierRefs,
          observedAt: now,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('entitlement_evidence', {
          authUserId: entitlement.authUserId,
          subjectId: entitlement.subjectId,
          providerKey: entitlement.sourceProvider,
          sourceReference: entitlement.sourceReference,
          evidenceType: 'purchase_fact_remediation',
          status: 'active',
          productId: entitlement.productId,
          catalogProductId: entitlement.catalogProductId,
          providerTierRefs,
          observedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }

      repaired++;

      const subject = await ctx.db.get(entitlement.subjectId);
      const discordUserId = subject?.primaryDiscordUserId;
      if (!discordUserId || isProviderScopedSubjectIdentity(discordUserId)) {
        skippedNoDiscordId++;
        continue;
      }

      await enqueueRoleSync(ctx, {
        authUserId: entitlement.authUserId,
        subjectId: entitlement.subjectId,
        entitlementId: entitlement._id,
        discordUserId,
        idempotencyKey: `tier_evidence_repair:${entitlement._id}:${providerTierRefs.join('|')}`,
      });
      roleSyncJobsCreated++;
    }

    return {
      scanned,
      repaired,
      skipped,
      roleSyncJobsCreated,
      skippedNoDiscordId,
      remaining: page.isDone ? 0 : 1,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * List the bounded set of active, tiered catalog products whose authoritative
 * purchase facts can be refreshed through the provider backfill capability.
 * This is provider-neutral: product capabilities and catalog tiers decide
 * eligibility, while the provider plugin owns the external API semantics.
 * `supportsAutoDiscovery` describes catalog discovery, not purchase-history
 * backfill, so historical and manually-added tiered products remain eligible.
 */
export const listTieredProductEvidenceRefreshBatch = internalQuery({
  args: {
    authUserId: v.optional(v.string()),
    provider: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TieredProductEvidenceRefreshBatch> => {
    const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
    let query = ctx.db
      .query('product_catalog')
      .withIndex('by_status', (q) => q.eq('status', 'active'));
    if (args.authUserId) {
      query = query.filter((q) => q.eq(q.field('authUserId'), args.authUserId));
    }
    if (args.provider) {
      query = query.filter((q) => q.eq(q.field('provider'), args.provider));
    }

    const page = await query.paginate({ cursor: args.cursor ?? null, numItems: limit });
    const products: TieredProductEvidenceRefreshProduct[] = [];

    for (const product of page.page) {
      const activeTier = await ctx.db
        .query('catalog_tiers')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', product._id))
        .filter((q) => q.eq(q.field('status'), 'active'))
        .first();
      if (!activeTier) {
        continue;
      }
      products.push({
        catalogProductId: product._id,
        authUserId: product.authUserId,
        productId: product.productId,
        provider: product.provider,
        providerProductRef: product.providerProductRef,
      });
    }

    return {
      products,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Refresh authoritative purchase facts for one bounded page of tiered products.
 * Run each page before repairEntitlementEvidenceTierRefs so stale upstream
 * identifiers are corrected at their canonical purchase-fact source first.
 */
export const refreshTieredProductEvidenceSources = internalAction({
  args: {
    authUserId: v.optional(v.string()),
    provider: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TieredProductEvidenceRefreshResult> => {
    const batch: TieredProductEvidenceRefreshBatch = await ctx.runQuery(
      internal.migrations.listTieredProductEvidenceRefreshBatch,
      {
        authUserId: args.authUserId,
        provider: args.provider,
        cursor: args.cursor,
        limit: args.limit,
      }
    );
    const failures: Array<{ catalogProductId: string; error: string }> = [];
    let refreshed = 0;

    for (const product of batch.products) {
      try {
        await ctx.runAction(internal.backgroundSync.backfillProductPurchases, {
          authUserId: product.authUserId,
          productId: product.productId,
          provider: product.provider,
          providerProductRef: product.providerProductRef,
        });
        refreshed++;
      } catch (error) {
        failures.push({
          catalogProductId: product.catalogProductId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.info('[role-sync-recovery] refreshed tier evidence sources', {
      provider: args.provider ?? 'all',
      selected: batch.products.length,
      refreshed,
      failed: failures.length,
      isDone: batch.isDone,
    });

    return {
      selected: batch.products.length,
      refreshed,
      failures,
      continueCursor: batch.continueCursor,
      isDone: batch.isDone,
    };
  },
});

/**
 * Find tier-evidence failures that can be recovered by revalidating the
 * encrypted license captured during the original verification. The provider
 * plugin remains the authority for tier identity; this query never infers a
 * tier from catalog shape alone.
 */
export const listTierEvidenceLicenseReverificationBatch = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TierEvidenceLicenseReverificationBatch> => {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const page = await ctx.db
      .query('entitlements')
      .withIndex('by_status', (q) => q.eq('status', 'active'))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const candidates: TierEvidenceLicenseReverificationCandidate[] = [];

    for (const entitlement of page.page) {
      const activeCatalogTierRefs = await activeCatalogTierRefsForEntitlement(ctx, entitlement);
      if (activeCatalogTierRefs.size === 0) {
        continue;
      }
      const activeEvidenceTierRefs = await activeEntitlementTierEvidenceRefs(ctx, entitlement);
      if (
        [...activeEvidenceTierRefs].some((providerTierRef) =>
          activeCatalogTierRefs.has(providerTierRef)
        )
      ) {
        continue;
      }
      if (!entitlement.licenseSubject) {
        continue;
      }

      const catalogProduct = entitlement.catalogProductId
        ? await ctx.db.get(entitlement.catalogProductId)
        : null;
      if (
        !catalogProduct ||
        catalogProduct.status !== 'active' ||
        catalogProduct.provider !== entitlement.sourceProvider
      ) {
        continue;
      }

      const licenseLink = await ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q
            .eq('authUserId', entitlement.authUserId)
            .eq('licenseSubject', entitlement.licenseSubject as string)
        )
        .filter((q) => q.eq(q.field('provider'), entitlement.sourceProvider))
        .first();
      if (!licenseLink?.licenseKeyEncrypted) {
        continue;
      }

      candidates.push({
        entitlementId: entitlement._id,
        authUserId: entitlement.authUserId,
        subjectId: entitlement.subjectId,
        provider: entitlement.sourceProvider,
        providerProductRef: catalogProduct.providerProductRef,
        licenseKeyEncrypted: licenseLink.licenseKeyEncrypted,
      });
    }

    return {
      candidates,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Confirm that provider verification persisted evidence for an active catalog
 * tier on the entitlement being remediated. An HTTP success alone is not a
 * successful remediation.
 */
export const isTierEvidenceResolvedForEntitlement = internalQuery({
  args: {
    entitlementId: v.id('entitlements'),
  },
  handler: async (ctx, args) => {
    const entitlement = await ctx.db.get(args.entitlementId);
    if (!entitlement || entitlement.status !== 'active') {
      return false;
    }

    const activeCatalogTierRefs = await activeCatalogTierRefsForEntitlement(ctx, entitlement);
    if (activeCatalogTierRefs.size === 0) {
      return false;
    }
    const activeEvidenceTierRefs = await activeEntitlementTierEvidenceRefs(ctx, entitlement);
    return [...activeEvidenceTierRefs].some((providerTierRef) =>
      activeCatalogTierRefs.has(providerTierRef)
    );
  },
});

/**
 * Revalidate one bounded page of recoverable license-backed tier evidence.
 * The existing provider-neutral complete-license endpoint dispatches to the
 * owning provider plugin, updates evidence, and enqueues a fresh role sync.
 */
export const reverifyTierEvidenceLicenses = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batch: TierEvidenceLicenseReverificationBatch = await ctx.runQuery(
      internal.migrations.listTierEvidenceLicenseReverificationBatch,
      args
    );
    const apiUrl = process.env.BACKFILL_API_URL;
    const apiSecret = process.env.CONVEX_API_SECRET;
    const encryptionSecret = process.env.ENCRYPTION_SECRET;
    if (!apiUrl || !apiSecret || !encryptionSecret) {
      throw new Error(
        'BACKFILL_API_URL, CONVEX_API_SECRET, and ENCRYPTION_SECRET are required for license evidence reverification'
      );
    }

    const failures: Array<{ entitlementId: Id<'entitlements'>; error: string }> = [];
    let reverified = 0;

    for (const candidate of batch.candidates) {
      try {
        const licenseKey = await decryptForPurpose(
          candidate.licenseKeyEncrypted,
          encryptionSecret,
          PII_PURPOSES.forensicsLicenseKey
        );
        const response = await fetch(
          `${apiUrl.replace(/\/$/, '')}/api/verification/complete-license`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              apiSecret,
              licenseKey,
              provider: candidate.provider,
              productId: candidate.providerProductRef,
              authUserId: candidate.authUserId,
              subjectId: candidate.subjectId,
            }),
          }
        );
        const result = (await response.json().catch(() => null)) as {
          success?: boolean;
          error?: string;
        } | null;
        if (!response.ok || result?.success !== true) {
          throw new Error(result?.error ?? `License reverification failed with HTTP ${response.status}`);
        }
        const tierEvidenceResolved = await ctx.runQuery(
          internal.migrations.isTierEvidenceResolvedForEntitlement,
          { entitlementId: candidate.entitlementId }
        );
        if (!tierEvidenceResolved) {
          throw new Error(
            'License reverification succeeded but did not persist matching tier evidence'
          );
        }
        reverified++;
      } catch (error) {
        failures.push({
          entitlementId: candidate.entitlementId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.info('[role-sync-recovery] reverified license tier evidence', {
      selected: batch.candidates.length,
      reverified,
      failed: failures.length,
      isDone: batch.isDone,
    });

    return {
      selected: batch.candidates.length,
      reverified,
      failures,
      continueCursor: batch.continueCursor,
      isDone: batch.isDone,
    };
  },
});

/**
 * Destructive helper for reset workflows.
 * Deletes provider connection rows and their provider-scoped dependents for one auth user.
 */
export const dangerouslyResetProviderDataForAuthUser = internalMutation({
  args: {
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    const connectionIds = new Set(connections.map((doc) => doc._id));

    const providerCredentials = [];
    const providerConnectionCapabilities = [];
    const providerCatalogMappings = [];
    const providerTransactions = [];
    const providerMemberships = [];
    const providerLicenses = [];

    for (const connection of connections) {
      providerCredentials.push(
        ...(await ctx.db
          .query('provider_credentials')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerConnectionCapabilities.push(
        ...(await ctx.db
          .query('provider_connection_capabilities')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerCatalogMappings.push(
        ...(await ctx.db
          .query('provider_catalog_mappings')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerTransactions.push(
        ...(await ctx.db
          .query('provider_transactions')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerMemberships.push(
        ...(await ctx.db
          .query('provider_memberships')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerLicenses.push(
        ...(await ctx.db
          .query('provider_licenses')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
    }

    const transactionIds = new Set(providerTransactions.map((doc) => doc._id));
    const membershipIds = new Set(providerMemberships.map((doc) => doc._id));
    const licenseIds = new Set(providerLicenses.map((doc) => doc._id));

    const entitlementEvidence = (await ctx.db.query('entitlement_evidence').collect()).filter(
      (doc) =>
        doc.authUserId === args.authUserId ||
        (doc.providerConnectionId != null && connectionIds.has(doc.providerConnectionId)) ||
        (doc.transactionId != null && transactionIds.has(doc.transactionId)) ||
        (doc.membershipId != null && membershipIds.has(doc.membershipId)) ||
        (doc.licenseId != null && licenseIds.has(doc.licenseId))
    );

    const webhookEvents = await ctx.db
      .query('webhook_events')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    let deletedEntitlementEvidence = 0;
    for (const doc of entitlementEvidence) {
      await ctx.db.delete(doc._id);
      deletedEntitlementEvidence++;
    }

    let deletedWebhookEvents = 0;
    for (const doc of webhookEvents) {
      if (doc.providerConnectionId == null || connectionIds.has(doc.providerConnectionId)) {
        await ctx.db.delete(doc._id);
        deletedWebhookEvents++;
      }
    }

    for (const doc of providerCredentials) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerConnectionCapabilities) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerCatalogMappings) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerTransactions) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerMemberships) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerLicenses) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of connections) {
      await ctx.db.delete(doc._id);
    }

    return {
      providerConnections: connections.length,
      providerCredentials: providerCredentials.length,
      providerConnectionCapabilities: providerConnectionCapabilities.length,
      providerCatalogMappings: providerCatalogMappings.length,
      providerTransactions: providerTransactions.length,
      providerMemberships: providerMemberships.length,
      providerLicenses: providerLicenses.length,
      entitlementEvidence: deletedEntitlementEvidence,
      webhookEvents: deletedWebhookEvents,
    };
  },
});

/**
 * Re-drive dead-lettered role_sync / role_removal jobs through the Workpool.
 *
 * The legacy bot poller burned these into dead_letter in ~22s by ignoring
 * backoff. This resets each row to pending and re-enqueues it so it runs again
 * with proper retry handling. Run with:
 *   npx convex run migrations:redriveDeadLetterRoleSync --prod
 * Re-run until `remaining` reaches 0. Idempotent: only re-picks rows that are
 * still in dead_letter.
 */
export const redriveDeadLetterRoleSync = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
    skipped: v.number(),
    remaining: v.number(),
  }),
  handler: async (ctx, args) => {
    if (process.env.ROLE_SYNC_VIA_WORKPOOL !== 'true') {
      throw new Error('ROLE_SYNC_VIA_WORKPOOL must be enabled to redrive role sync jobs');
    }

    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const pageSize = limit + 1;
    const roleSyncTargets = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_status_job_type', (q) =>
        q.eq('status', 'dead_letter').eq('jobType', 'role_sync')
      )
      .take(pageSize);
    const roleRemovalTargets = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_status_job_type', (q) =>
        q.eq('status', 'dead_letter').eq('jobType', 'role_removal')
      )
      .take(pageSize);
    const targets = [...roleSyncTargets, ...roleRemovalTargets].sort(
      (a, b) => a.createdAt - b.createdAt
    );
    const batch = targets.slice(0, limit);

    let processed = 0;
    let skipped = 0;
    const now = Date.now();

    for (const job of batch) {
      const dispatch = await enqueueExistingRoleOutboxJobInWorkpool(ctx, job);
      if (!dispatch.enqueued) {
        skipped++;
        continue;
      }

      // Reset the projection row only after Workpool accepts the durable work.
      await ctx.db.patch(job._id, {
        status: 'pending',
        retryCount: 0,
        lastError: undefined,
        nextRetryAt: undefined,
        workpoolEnqueuedAt: now,
        updatedAt: now,
      });
      processed++;
    }

    return {
      processed,
      skipped,
      // This is a bounded page signal, not a full backlog count. Keep re-running until it is 0.
      remaining: Math.max(targets.length - processed - skipped, 0),
    };
  },
});

function isDiscordRateLimitDeadLetter(job: Doc<'outbox_jobs'>): boolean {
  return Boolean(job.lastError && /\bRate limited(?:\s|\(|$)/i.test(job.lastError));
}

/**
 * Re-drive only role jobs that exhausted their Workpool attempts on a
 * transient Discord rate limit. Permanent membership, missing-role, and tier
 * evidence failures remain dead-lettered for their owning recovery path.
 */
export const redriveRateLimitedRoleSync = internalMutation({
  args: {
    jobType: v.optional(v.union(v.literal('role_sync'), v.literal('role_removal'))),
    cursor: v.optional(v.union(v.string(), v.null())),
    scanLimit: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    matched: v.number(),
    processed: v.number(),
    skipped: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (process.env.ROLE_SYNC_VIA_WORKPOOL !== 'true') {
      throw new Error('ROLE_SYNC_VIA_WORKPOOL must be enabled to redrive role sync jobs');
    }

    const scanLimit = Math.max(1, Math.min(args.scanLimit ?? 100, 500));
    const jobType = args.jobType ?? 'role_sync';
    const page = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_status_job_type', (q) =>
        q.eq('status', 'dead_letter').eq('jobType', jobType)
      )
      .paginate({ cursor: args.cursor ?? null, numItems: scanLimit });
    const targets = page.page
      .filter(isDiscordRateLimitDeadLetter)
      .sort((a, b) => a.createdAt - b.createdAt);

    let processed = 0;
    let skipped = 0;
    const now = Date.now();
    for (const job of targets) {
      const dispatch = await enqueueExistingRoleOutboxJobInWorkpool(ctx, job);
      if (!dispatch.enqueued) {
        skipped++;
        continue;
      }
      await ctx.db.patch(job._id, {
        status: 'pending',
        retryCount: 0,
        lastError: undefined,
        nextRetryAt: undefined,
        workpoolEnqueuedAt: now,
        updatedAt: now,
      });
      processed++;
    }

    return {
      scanned: page.page.length,
      matched: targets.length,
      processed,
      skipped,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});


const NEEDS_RESYNC_REPORT_LIMIT = 50;

/**
 * Legacy canonical-URL outputs produced by the old template-plus-providerProductRef
 * write paths. These were never valid public product URLs:
 * - example.invalid placeholders from addProductForProvider
 * - jinxxy.app/products/{api-uuid} (wrong domain, wrong identifier kind)
 * - app.lemonsqueezy.com/products/{id} (merchant dashboard, login-gated)
 * - vrchat.com/store/listing/{id} (no such public page)
 * - gumroad.com/l/{api-id} (API ids are not permalinks)
 */
function legacyJunkNormalizedUrls(provider: string, providerProductRef: string): string[] {
  const ref = providerProductRef.toLowerCase();
  return [
    `https://example.invalid/${provider.toLowerCase()}/${ref}`,
    `https://jinxxy.app/products/${ref}`,
    `https://app.lemonsqueezy.com/products/${ref}`,
    `https://vrchat.com/store/listing/${ref}`,
    `https://gumroad.com/l/${ref}`,
  ];
}

/**
 * Repair canonical product URLs stored in catalog_product_links.
 *
 * For every active product_catalog row this migration:
 * - patches legacy junk links to the slug-derived URL when one exists (repaired)
 * - inserts a direct product link when none exists and the URL is slug-derivable (inserted)
 * - deletes legacy junk links with no derivable replacement (junkRemoved)
 * - leaves valid provider-supplied links untouched
 *
 * Rows left without any trustworthy URL are reported in needsResyncProducts so an
 * operator can re-run catalog sync (bot autosetup / product add), which now stores
 * the provider API product URL. Deterministic: no provider API calls are made here.
 *
 * Run with:
 * - bun x convex run migrations:repairCatalogProductCanonicalUrls '{"apply":false}'
 * - bun x convex run migrations:repairCatalogProductCanonicalUrls '{"apply":true,"cursor":"..."}'
 */
export const repairCatalogProductCanonicalUrls = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    apply: v.optional(v.boolean()),
  },
  returns: v.object({
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
    scanned: v.number(),
    repaired: v.number(),
    inserted: v.number(),
    junkRemoved: v.number(),
    untouched: v.number(),
    needsResync: v.number(),
    needsResyncProducts: v.array(
      v.object({
        catalogProductId: v.string(),
        authUserId: v.string(),
        provider: v.string(),
        providerProductRef: v.string(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const apply = args.apply ?? false;
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const page = await ctx.db
      .query('product_catalog')
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    let repaired = 0;
    let inserted = 0;
    let junkRemoved = 0;
    let untouched = 0;
    let needsResync = 0;
    const needsResyncProducts: Array<{
      catalogProductId: string;
      authUserId: string;
      provider: string;
      providerProductRef: string;
    }> = [];
    const now = Date.now();

    const reportNeedsResync = (product: Doc<'product_catalog'>) => {
      if (!getProviderDescriptor(product.provider)?.catalogProductUrlFromProvider) {
        return;
      }
      needsResync++;
      if (needsResyncProducts.length < NEEDS_RESYNC_REPORT_LIMIT) {
        needsResyncProducts.push({
          catalogProductId: String(product._id),
          authUserId: product.authUserId,
          provider: product.provider,
          providerProductRef: product.providerProductRef,
        });
      }
    };

    for (const product of page.page) {
      if (product.status !== 'active') {
        continue;
      }
      const desired = resolveCatalogProductUrl({
        provider: product.provider,
        canonicalSlug: product.canonicalSlug,
      });
      const link = await ctx.db
        .query('catalog_product_links')
        .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', product._id))
        .filter((q) =>
          q.and(q.eq(q.field('linkKind'), 'direct_product'), q.eq(q.field('status'), 'active'))
        )
        .first();

      if (!link) {
        if (!desired) {
          reportNeedsResync(product);
          continue;
        }
        inserted++;
        if (apply) {
          const normalized = desired.toLowerCase();
          await ctx.db.insert('catalog_product_links', {
            catalogProductId: product._id,
            provider: product.provider,
            originalUrl: desired,
            normalizedUrl: normalized,
            urlHash: await sha256Hex(normalized),
            linkKind: 'direct_product',
            status: 'active',
            submittedByAuthUserId: product.authUserId,
            createdAt: now,
            updatedAt: now,
          });
        }
        continue;
      }

      const isJunk = legacyJunkNormalizedUrls(product.provider, product.providerProductRef).includes(
        link.normalizedUrl
      );
      if (!isJunk) {
        untouched++;
        continue;
      }

      if (desired) {
        const normalizedDesired = desired.toLowerCase();
        if (link.normalizedUrl === normalizedDesired) {
          // The legacy template output happens to equal the correct URL
          // (e.g. Gumroad flows where the ref already was the permalink).
          untouched++;
          continue;
        }
        repaired++;
        if (apply) {
          await ctx.db.patch(link._id, {
            originalUrl: desired,
            normalizedUrl: normalizedDesired,
            urlHash: await sha256Hex(normalizedDesired),
            updatedAt: now,
          });
        }
        continue;
      }

      junkRemoved++;
      if (apply) {
        await ctx.db.delete(link._id);
      }
      reportNeedsResync(product);
    }

    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      repaired,
      inserted,
      junkRemoved,
      untouched,
      needsResync,
      needsResyncProducts,
    };
  },
});
