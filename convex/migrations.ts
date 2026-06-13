/**
 * One-time data migrations.
 * Run with:
 * - npx convex run migrations:purgeLegacyTenantDocuments
 * - npx convex run migrations:purgeGuildLinkVerifyPromptMessages
 * - npx convex run migrations:purgeLegacyOutboxVerifyPromptRefreshJobs
 * - npx convex run migrations:purgeRoleRuleSourceGuildNames
 * - npx convex run migrations:backfillProtectedAssetUnlockModes
 * - npx convex run migrations:migrateLegacyLicenseSubjectLinks
 * Re-run until the relevant migration returns 0 remaining records.
 */

import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import {
  getYucpAliasPackageContract,
  mergeYucpAliasPackageMetadata,
} from '@yucp/shared';
import {
  buildSyntheticAliasMetadataSeed,
  type CatalogProductAliasSource,
} from './lib/backstageAliasMetadata';
import { PII_PURPOSES } from './lib/credentialKeys';
import { upsertLicenseSubjectLink } from './lib/licenseSubjectLink';
import { encryptPii } from './lib/piiCrypto';
import { resolveProtectedAssetUnlockMode } from './lib/protectedAssetUnlockMode';
import {
  detectCanonicalAuthResolutionForSubject,
  ensureCanonicalAuthUserIdForSubject,
  upsertBuyerProviderLinkRecord,
} from './subjects';

type LegacyMigrationDoc = Record<string, unknown>;
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
type BackstageAliasMetadataRemediationCandidate = {
  deliveryPackageReleaseId: Id<'delivery_package_releases'>;
  deliveryPackageId: Id<'delivery_packages'>;
  authUserId: string;
  packageId: string;
  version: string;
  channel: string;
  aliasId?: string;
  catalogProductIds: Array<Id<'product_catalog'>>;
  productRefs: string[];
  repairable: boolean;
  reason: string;
};
type BackstageCdngineDeliveryVariantRemediationCandidate = {
  deliveryArtifactId: Id<'delivery_release_artifacts'>;
  deliveryPackageReleaseId: Id<'delivery_package_releases'>;
  deliveryPackageId: Id<'delivery_packages'>;
  authUserId: string;
  packageId: string;
  version: string;
  channel: string;
  assetId: string;
  versionId: string;
  deliveryScopeId: string;
  currentVariant: string;
  targetVariant: string;
  repairable: boolean;
  reason: string;
};
type BackstageRawUploadSourceFieldRemediationCandidate = {
  deliveryArtifactId: Id<'delivery_release_artifacts'>;
  deliveryPackageReleaseId: Id<'delivery_package_releases'>;
  deliveryPackageId: Id<'delivery_packages'>;
  authUserId: string;
  packageId: string;
  version: string;
  channel: string;
  assetId: string;
  versionId: string;
  currentField: 'cdngineDelivery';
  targetField: 'cdngineSource';
  repairable: boolean;
  reason: string;
};

const DEFAULT_BUYER_ATTRIBUTION_REPORT_LIMIT = 50;
const DEFAULT_SUBJECT_OWNERSHIP_REPORT_LIMIT = 50;
const DEFAULT_BACKSTAGE_ALIAS_METADATA_REPORT_LIMIT = 50;
const DEFAULT_BACKSTAGE_CDNGINE_VARIANT_REPORT_LIMIT = 50;
const DEFAULT_BACKSTAGE_RAW_UPLOAD_SOURCE_FIELD_REPORT_LIMIT = 50;
const LEGACY_BACKSTAGE_CDNGINE_DELIVERY_VARIANT = 'vpm-package';
const LEGACY_BACKSTAGE_RAW_UPLOAD_SOURCE_VARIANT = 'raw-upload';
const GENERIC_BACKSTAGE_CDNGINE_DELIVERY_VARIANT = 'preserve-original';
const REPORTABLE_BINDING_STATUSES = new Set<Doc<'bindings'>['status']>(['active', 'pending']);

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

async function listRelatedVerificationBindings(
  ctx: Pick<QueryCtx, 'db'>,
  subjectId: Id<'subjects'>,
  authUserId: string
): Promise<SubjectOwnershipRelatedBinding[]> {
  const bindings = (await ctx.db
    .query('bindings')
    .withIndex('by_auth_user_subject', (q) => q.eq('authUserId', authUserId).eq('subjectId', subjectId))
    .collect()) as Doc<'bindings'>[];

  const relatedBindings: SubjectOwnershipRelatedBinding[] = [];
  for (const binding of bindings) {
    if (binding.bindingType !== 'verification' || !REPORTABLE_BINDING_STATUSES.has(binding.status)) {
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
    expectedLightAuthMarker: resolution.kind === 'materialize_light' ? resolution.marker : undefined,
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

async function buildBackstageAliasMetadataCandidate(
  ctx: Pick<QueryCtx, 'db'>,
  release: Doc<'delivery_package_releases'>,
  deliveryPackage: Doc<'delivery_packages'> | null,
  linkedCatalogProducts: ReadonlyArray<CatalogProductAliasSource>
): Promise<BackstageAliasMetadataRemediationCandidate | null> {
  if (
    release.releaseStatus !== 'published' ||
    !deliveryPackage ||
    getYucpAliasPackageContract(release.metadata)
  ) {
    return null;
  }

  const aliasMetadataSeed = buildSyntheticAliasMetadataSeed(linkedCatalogProducts, release.channel);
  const productRefs = linkedCatalogProducts
    .map((product) => product.canonicalSlug ?? product.providerProductRef ?? undefined)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return {
    deliveryPackageReleaseId: release._id,
    deliveryPackageId: release.deliveryPackageId,
    authUserId: release.authUserId,
    packageId: deliveryPackage.packageId,
    version: release.version,
    channel: release.channel,
    aliasId: aliasMetadataSeed?.aliasId,
    catalogProductIds: linkedCatalogProducts.map((product) => product._id as Id<'product_catalog'>),
    productRefs,
    repairable: aliasMetadataSeed !== undefined,
    reason:
      aliasMetadataSeed !== undefined
        ? 'Missing alias metadata on a published release with recoverable catalog product links'
        : productRefs.length > 0
          ? 'Missing alias metadata but linked catalog products resolve to different alias ids'
          : 'Missing alias metadata but no linked catalog product exposes a canonical slug or provider product reference',
  };
}

async function listBackstageAliasMetadataCandidates(
  ctx: Pick<QueryCtx, 'db'>,
  limit: number
) {
  const releases = (await ctx.db.query('delivery_package_releases').collect()) as Doc<
    'delivery_package_releases'
  >[];
  const deliveryPackageIds = Array.from(
    new Set(releases.map((release) => String(release.deliveryPackageId)))
  );
  const deliveryPackages = (
    await Promise.all(
      deliveryPackageIds.map(async (deliveryPackageId) => {
        return await ctx.db.get(deliveryPackageId as Id<'delivery_packages'>);
      })
    )
  ).filter((deliveryPackage): deliveryPackage is Doc<'delivery_packages'> => deliveryPackage !== null);
  const deliveryPackagesById = new Map(
    deliveryPackages.map((deliveryPackage) => [String(deliveryPackage._id), deliveryPackage])
  );

  const activeLinks = ((await ctx.db.query('delivery_package_products').collect()) as Doc<
    'delivery_package_products'
  >[]).filter((link) => link.status === 'active');
  const catalogProductIds = Array.from(new Set(activeLinks.map((link) => String(link.catalogProductId))));
  const catalogProducts = (
    await Promise.all(
      catalogProductIds.map(async (catalogProductId) => {
        return await ctx.db.get(catalogProductId as Id<'product_catalog'>);
      })
    )
  ).filter((product): product is Doc<'product_catalog'> => product !== null);
  const catalogProductsById = new Map(
    catalogProducts.map((product) => [String(product._id), product])
  );
  const catalogProductsByDeliveryPackageId = new Map<string, CatalogProductAliasSource[]>();
  for (const link of activeLinks) {
    const linkedCatalogProduct = catalogProductsById.get(String(link.catalogProductId));
    if (!linkedCatalogProduct) {
      continue;
    }
    const existingProducts = catalogProductsByDeliveryPackageId.get(String(link.deliveryPackageId)) ?? [];
    existingProducts.push(linkedCatalogProduct);
    catalogProductsByDeliveryPackageId.set(String(link.deliveryPackageId), existingProducts);
  }

  const candidates = (
    await Promise.all(
      releases.map(async (release) =>
        await buildBackstageAliasMetadataCandidate(
          ctx,
          release,
          deliveryPackagesById.get(String(release.deliveryPackageId)) ?? null,
          catalogProductsByDeliveryPackageId.get(String(release.deliveryPackageId)) ?? []
        )
      )
    )
  )
    .filter((candidate): candidate is BackstageAliasMetadataRemediationCandidate => candidate !== null)
    .sort(
      (left, right) =>
        left.packageId.localeCompare(right.packageId) ||
        left.version.localeCompare(right.version) ||
        String(left.deliveryPackageReleaseId).localeCompare(String(right.deliveryPackageReleaseId))
    );

  return {
    scannedAt: Date.now(),
    summary: {
      candidateReleases: candidates.length,
      repairableReleases: candidates.filter((candidate) => candidate.repairable).length,
      skippedDueToLimit: Math.max(0, candidates.length - limit),
    },
    candidates: candidates.slice(0, limit),
  };
}

async function buildBackstageCdngineDeliveryVariantCandidate(
  ctx: Pick<QueryCtx, 'db'>,
  artifact: Doc<'delivery_release_artifacts'>
): Promise<BackstageCdngineDeliveryVariantRemediationCandidate | null> {
  const delivery = artifact.cdngineDelivery;
  if (
    artifact.status !== 'active' ||
    artifact.artifactRole !== 'server_deliverable' ||
    !delivery ||
    delivery.variant !== LEGACY_BACKSTAGE_CDNGINE_DELIVERY_VARIANT
  ) {
    return null;
  }

  const release = (await ctx.db.get(
    artifact.deliveryPackageReleaseId
  )) as Doc<'delivery_package_releases'> | null;
  if (!release) {
    return null;
  }
  const deliveryPackage = (await ctx.db.get(
    release.deliveryPackageId
  )) as Doc<'delivery_packages'> | null;
  if (!deliveryPackage) {
    return null;
  }

  const repairable =
    release.releaseStatus === 'published' &&
    artifact.contentType === 'application/zip' &&
    artifact.ownership === 'server_materialized' &&
    artifact.materializationStrategy === 'normalized_repack' &&
    delivery.deliveryScopeId === 'paid-downloads';

  return {
    deliveryArtifactId: artifact._id,
    deliveryPackageReleaseId: release._id,
    deliveryPackageId: release.deliveryPackageId,
    authUserId: release.authUserId,
    packageId: deliveryPackage.packageId,
    version: release.version,
    channel: release.channel,
    assetId: delivery.assetId,
    versionId: delivery.versionId,
    deliveryScopeId: delivery.deliveryScopeId,
    currentVariant: delivery.variant,
    targetVariant: GENERIC_BACKSTAGE_CDNGINE_DELIVERY_VARIANT,
    repairable,
    reason: repairable
      ? 'Generic Backstage CDNgine deliverable stores the legacy unpublished variant'
      : 'Legacy variant exists outside the generic published Backstage deliverable shape',
  };
}

function legacyRawUploadDeliveryToSource(
  delivery: NonNullable<Doc<'delivery_release_artifacts'>['cdngineDelivery']>
): NonNullable<Doc<'delivery_release_artifacts'>['cdngineSource']> {
  return {
    assetId: delivery.assetId,
    assetOwner: delivery.assetOwner,
    byteSize: delivery.byteSize,
    serviceNamespaceId: delivery.serviceNamespaceId,
    sha256: delivery.sha256,
    tenantId: delivery.tenantId,
    uploadedAt: delivery.uploadedAt,
    versionId: delivery.versionId,
  };
}

async function buildBackstageRawUploadSourceFieldCandidate(
  ctx: Pick<QueryCtx, 'db'>,
  artifact: Doc<'delivery_release_artifacts'>
): Promise<BackstageRawUploadSourceFieldRemediationCandidate | null> {
  const delivery = artifact.cdngineDelivery;
  if (
    artifact.status !== 'active' ||
    artifact.artifactRole !== 'raw_upload' ||
    artifact.cdngineSource ||
    !delivery
  ) {
    return null;
  }

  const release = (await ctx.db.get(
    artifact.deliveryPackageReleaseId
  )) as Doc<'delivery_package_releases'> | null;
  if (!release) {
    return null;
  }
  const deliveryPackage = (await ctx.db.get(
    release.deliveryPackageId
  )) as Doc<'delivery_packages'> | null;
  if (!deliveryPackage) {
    return null;
  }

  const variantMatches = delivery.variant === LEGACY_BACKSTAGE_RAW_UPLOAD_SOURCE_VARIANT;
  const shaMatches = delivery.sha256 === artifact.sha256;
  const byteSizeMatches = delivery.byteSize === artifact.byteSize;
  const repairable = variantMatches && shaMatches && byteSizeMatches;
  const mismatchReasons = [
    variantMatches ? null : `variant is ${delivery.variant}`,
    shaMatches ? null : 'CDNgine SHA-256 does not match artifact SHA-256',
    byteSizeMatches ? null : 'CDNgine byte size does not match artifact byte size',
  ].filter((reason): reason is string => reason !== null);

  return {
    deliveryArtifactId: artifact._id,
    deliveryPackageReleaseId: release._id,
    deliveryPackageId: release.deliveryPackageId,
    authUserId: release.authUserId,
    packageId: deliveryPackage.packageId,
    version: release.version,
    channel: release.channel,
    assetId: delivery.assetId,
    versionId: delivery.versionId,
    currentField: 'cdngineDelivery',
    targetField: 'cdngineSource',
    repairable,
    reason: repairable
      ? 'Legacy raw Backstage upload stores CDNgine source coordinates in cdngineDelivery'
      : `Legacy raw upload coordinates require manual review: ${mismatchReasons.join(', ')}`,
  };
}

async function listBackstageCdngineDeliveryVariantCandidates(
  ctx: Pick<QueryCtx, 'db'>,
  limit: number
) {
  const artifacts = (await ctx.db.query('delivery_release_artifacts').collect()) as Doc<
    'delivery_release_artifacts'
  >[];
  const candidates = (
    await Promise.all(
      artifacts.map(async (artifact) => await buildBackstageCdngineDeliveryVariantCandidate(ctx, artifact))
    )
  )
    .filter(
      (candidate): candidate is BackstageCdngineDeliveryVariantRemediationCandidate =>
        candidate !== null
    )
    .sort(
      (left, right) =>
        left.packageId.localeCompare(right.packageId) ||
        left.version.localeCompare(right.version) ||
        String(left.deliveryArtifactId).localeCompare(String(right.deliveryArtifactId))
    );

  return {
    scannedAt: Date.now(),
    summary: {
      candidateArtifacts: candidates.length,
      repairableArtifacts: candidates.filter((candidate) => candidate.repairable).length,
      skippedDueToLimit: Math.max(0, candidates.length - limit),
    },
    candidates: candidates.slice(0, limit),
  };
}

async function listBackstageRawUploadSourceFieldCandidates(
  ctx: Pick<QueryCtx, 'db'>,
  limit: number
) {
  const artifacts = (await ctx.db.query('delivery_release_artifacts').collect()) as Doc<
    'delivery_release_artifacts'
  >[];
  const candidates = (
    await Promise.all(
      artifacts.map(
        async (artifact) => await buildBackstageRawUploadSourceFieldCandidate(ctx, artifact)
      )
    )
  )
    .filter(
      (candidate): candidate is BackstageRawUploadSourceFieldRemediationCandidate =>
        candidate !== null
    )
    .sort(
      (left, right) =>
        left.packageId.localeCompare(right.packageId) ||
        left.version.localeCompare(right.version) ||
        String(left.deliveryArtifactId).localeCompare(String(right.deliveryArtifactId))
    );

  return {
    scannedAt: Date.now(),
    summary: {
      candidateArtifacts: candidates.length,
      repairableArtifacts: candidates.filter((candidate) => candidate.repairable).length,
      skippedDueToLimit: Math.max(0, candidates.length - limit),
    },
    candidates: candidates.slice(0, limit),
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
    initialCandidates.set(bindingId, binding ? await buildBuyerAttributionCandidate(ctx, binding) : null);
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
      if (!relatedLicenseLink.repairable || repairedLicenseLinkIds.has(String(relatedLicenseLink.id))) {
        continue;
      }

      const source = (await ctx.db.get(relatedLicenseLink.id)) as Doc<'license_subject_links'> | null;
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
 * Backfill protected_assets.unlockMode for rows created before the unlock-mode split.
 * Re-run until it returns { updated: 0 }.
 */
export const backfillProtectedAssetUnlockModes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query('protected_assets').collect();

    let updated = 0;
    for (const doc of docs) {
      const unlockMode = resolveProtectedAssetUnlockMode(doc);
      if (doc.unlockMode !== unlockMode) {
        await ctx.db.patch(doc._id, { unlockMode });
        updated++;
      }
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
 * Detection-first remediation report for published Backstage releases that were
 * stored before alias metadata synthesis existed.
 */
export const listBackstageAliasMetadataRemediationCandidates = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? DEFAULT_BACKSTAGE_ALIAS_METADATA_REPORT_LIMIT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.trunc(requestedLimit)))
      : DEFAULT_BACKSTAGE_ALIAS_METADATA_REPORT_LIMIT;
    return await listBackstageAliasMetadataCandidates(ctx, limit);
  },
});

/**
 * Detection-first remediation report for generic Backstage CDNgine deliverables
 * that were stored with the pre-publication local variant name.
 */
export const listBackstageCdngineDeliveryVariantRemediationCandidates = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? DEFAULT_BACKSTAGE_CDNGINE_VARIANT_REPORT_LIMIT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.trunc(requestedLimit)))
      : DEFAULT_BACKSTAGE_CDNGINE_VARIANT_REPORT_LIMIT;
    return await listBackstageCdngineDeliveryVariantCandidates(ctx, limit);
  },
});

/**
 * Detection-first remediation report for raw Backstage upload artifacts that
 * were stored with source CDNgine coordinates in the delivery field.
 */
export const listBackstageRawUploadSourceFieldRemediationCandidates = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit =
      args.limit ?? DEFAULT_BACKSTAGE_RAW_UPLOAD_SOURCE_FIELD_REPORT_LIMIT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.trunc(requestedLimit)))
      : DEFAULT_BACKSTAGE_RAW_UPLOAD_SOURCE_FIELD_REPORT_LIMIT;
    return await listBackstageRawUploadSourceFieldCandidates(ctx, limit);
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
 * Explicit, opt-in repair for selected published Backstage releases that are
 * missing the synthesized alias metadata contract.
 */
export const repairBackstageAliasMetadataCandidates = internalMutation({
  args: {
    releaseIds: v.array(v.id('delivery_package_releases')),
  },
  handler: async (ctx, args) => {
    const uniqueReleaseIds = Array.from(new Set(args.releaseIds));
    const skippedReleases: Array<{
      deliveryPackageReleaseId: Id<'delivery_package_releases'>;
      reason: string;
    }> = [];
    let repairedReleases = 0;

    for (const releaseId of uniqueReleaseIds) {
      const release = (await ctx.db.get(releaseId)) as Doc<'delivery_package_releases'> | null;
      if (!release) {
        skippedReleases.push({
          deliveryPackageReleaseId: releaseId,
          reason: 'Release no longer exists',
        });
        continue;
      }
      if (release.releaseStatus !== 'published') {
        skippedReleases.push({
          deliveryPackageReleaseId: releaseId,
          reason: `Release status ${release.releaseStatus} is not repairable`,
        });
        continue;
      }
      if (getYucpAliasPackageContract(release.metadata)) {
        skippedReleases.push({
          deliveryPackageReleaseId: releaseId,
          reason: 'Release already has alias metadata',
        });
        continue;
      }

      const activeLinks = ((await ctx.db
        .query('delivery_package_products')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', release.authUserId))
        .collect()) as Doc<'delivery_package_products'>[]).filter(
        (link) =>
          link.status === 'active' && String(link.deliveryPackageId) === String(release.deliveryPackageId)
      );
      const linkedCatalogProducts = (
        await Promise.all(activeLinks.map(async (link) => await ctx.db.get(link.catalogProductId)))
      ).filter((product): product is Doc<'product_catalog'> => product !== null);
      const aliasMetadataSeed = buildSyntheticAliasMetadataSeed(linkedCatalogProducts, release.channel);
      if (!aliasMetadataSeed) {
        skippedReleases.push({
          deliveryPackageReleaseId: releaseId,
          reason:
            linkedCatalogProducts.some(
              (product) => (product.canonicalSlug ?? product.providerProductRef)?.trim()
            )
              ? 'Linked catalog products resolve to different alias ids'
              : 'No linked catalog product exposes a canonical slug or provider product reference',
        });
        continue;
      }

      await ctx.db.patch(releaseId, {
        metadata: mergeYucpAliasPackageMetadata({
          metadata: release.metadata,
          aliasId: aliasMetadataSeed.aliasId,
          catalogProductIds: aliasMetadataSeed.catalogProductIds,
          channel: aliasMetadataSeed.channel,
        }),
        updatedAt: Date.now(),
      });
      repairedReleases += 1;
    }

    return {
      repairedReleases,
      skippedReleases,
    };
  },
});

/**
 * Explicit, opt-in repair for active Backstage server deliverables that point at
 * CDNgine's generic preserve-original publication but kept the legacy variant.
 */
export const repairBackstageCdngineDeliveryVariantCandidates = internalMutation({
  args: {
    artifactIds: v.array(v.id('delivery_release_artifacts')),
  },
  handler: async (ctx, args) => {
    const uniqueArtifactIds = Array.from(new Set(args.artifactIds));
    const skippedArtifacts: Array<{
      deliveryArtifactId: Id<'delivery_release_artifacts'>;
      reason: string;
    }> = [];
    let repairedArtifacts = 0;

    for (const artifactId of uniqueArtifactIds) {
      const artifact = (await ctx.db.get(artifactId)) as Doc<'delivery_release_artifacts'> | null;
      if (!artifact) {
        skippedArtifacts.push({
          deliveryArtifactId: artifactId,
          reason: 'Artifact no longer exists',
        });
        continue;
      }

      const candidate = await buildBackstageCdngineDeliveryVariantCandidate(ctx, artifact);
      if (!candidate) {
        skippedArtifacts.push({
          deliveryArtifactId: artifactId,
          reason: 'Artifact is not an active legacy Backstage CDNgine deliverable',
        });
        continue;
      }
      if (!candidate.repairable || !artifact.cdngineDelivery) {
        skippedArtifacts.push({
          deliveryArtifactId: artifactId,
          reason: candidate.reason,
        });
        continue;
      }

      await ctx.db.patch(artifactId, {
        cdngineDelivery: {
          ...artifact.cdngineDelivery,
          variant: GENERIC_BACKSTAGE_CDNGINE_DELIVERY_VARIANT,
        },
        updatedAt: Date.now(),
      });
      repairedArtifacts += 1;
    }

    return {
      repairedArtifacts,
      skippedArtifacts,
    };
  },
});

/**
 * Explicit, opt-in repair for active raw Backstage uploads that stored source
 * CDNgine coordinates in cdngineDelivery instead of cdngineSource.
 */
export const repairBackstageRawUploadSourceFieldCandidates = internalMutation({
  args: {
    artifactIds: v.array(v.id('delivery_release_artifacts')),
  },
  handler: async (ctx, args) => {
    const uniqueArtifactIds = Array.from(new Set(args.artifactIds));
    const skippedArtifacts: Array<{
      deliveryArtifactId: Id<'delivery_release_artifacts'>;
      reason: string;
    }> = [];
    let repairedArtifacts = 0;

    for (const artifactId of uniqueArtifactIds) {
      const artifact = (await ctx.db.get(artifactId)) as Doc<'delivery_release_artifacts'> | null;
      if (!artifact) {
        skippedArtifacts.push({
          deliveryArtifactId: artifactId,
          reason: 'Artifact no longer exists',
        });
        continue;
      }

      const candidate = await buildBackstageRawUploadSourceFieldCandidate(ctx, artifact);
      if (!candidate) {
        skippedArtifacts.push({
          deliveryArtifactId: artifactId,
          reason: 'Artifact is not an active legacy raw Backstage upload',
        });
        continue;
      }
      if (!candidate.repairable || !artifact.cdngineDelivery) {
        skippedArtifacts.push({
          deliveryArtifactId: artifactId,
          reason: candidate.reason,
        });
        continue;
      }

      await ctx.db.patch(artifactId, {
        cdngineSource: legacyRawUploadDeliveryToSource(artifact.cdngineDelivery),
        cdngineDelivery: undefined,
        updatedAt: Date.now(),
      });
      repairedArtifacts += 1;
    }

    return {
      repairedArtifacts,
      skippedArtifacts,
    };
  },
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
        if (binding.bindingType !== 'verification' || !REPORTABLE_BINDING_STATUSES.has(binding.status)) {
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
