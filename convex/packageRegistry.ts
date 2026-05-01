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

import {
  applyYucpAliasPackageManifestDefaults,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY,
  BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS,
  BACKSTAGE_VPM_SOURCE_KINDS,
  buildRepoTokenVpmDeliveryMetadata,
  getYucpAliasPackageContract,
  inferBackstageVpmDeliverySourceKind,
  mergeYucpAliasPackageMetadata,
  stripBackstageVpmReservedMetadata,
  YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES,
  YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES,
  YUCP_ALIAS_PACKAGE_KIND,
  type YucpAliasPackageContract,
} from '@yucp/shared';
import type { CdngineBackstageDeliveryReference } from '@yucp/shared/cdngineBackstageDelivery';
import { sha256Hex } from '@yucp/shared/crypto';
import { ConvexError, v } from 'convex/values';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { ApiActorBindingV, requireApiActor, requireDelegatedAuthUserActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';
import {
  buildSyntheticAliasMetadataSeed,
  type CatalogProductAliasSource,
  type SyntheticAliasMetadataSeed,
} from './lib/backstageAliasMetadata';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const PACKAGE_NAME_MAX_LENGTH = 120;
const PACKAGE_DELETE_BLOCKED_REASON =
  'Package has signing or license history and cannot be deleted.';
const PRODUCT_DELETE_BLOCKED_REASON =
  'Product has package, role, entitlement, or tier history and cannot be deleted.';
const PACKAGE_ARCHIVED_UPDATE_BLOCKED_REASON =
  'Archived packages cannot be updated. Restore the package before renaming it.';
const PACKAGE_ARCHIVED_SIGNING_BLOCKED_REASON =
  'Archived packages cannot be updated. Restore the package before signing or changing it.';
const CURRENT_RELEASE_ARCHIVE_BLOCKED_REASON =
  'Current uploads cannot be archived. Upload a new version first.';
const DeliveryPackageVisibilityV = v.union(v.literal('hidden'), v.literal('listed'));
const DeliveryRepoTokenStatusV = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('expired')
);
const DeliveryPackageReleaseStatusV = v.union(
  v.literal('draft'),
  v.literal('published'),
  v.literal('revoked'),
  v.literal('superseded')
);
const DeliveryArtifactModeV = v.union(v.literal('legacy_signed'), v.literal('server_materialized'));
const BACKSTAGE_REPO_TOKEN_PREFIX = 'ybt_';
const BACKSTAGE_REPO_TOKEN_BYTES = 24;

type BackstagePackageSummary = {
  deliveryPackageId: Id<'delivery_packages'>;
  packageId: string;
  packageName?: string;
  displayName?: string;
  description?: string;
  status: Doc<'delivery_packages'>['status'];
  repositoryVisibility: Doc<'delivery_packages'>['repositoryVisibility'];
  defaultChannel?: string;
  latestPublishedVersion?: string;
  latestPublishedAt?: number;
  latestRelease: BackstageReleaseSummary | null;
  releases: BackstageReleaseSummary[];
};

type BackstageReleaseSummary = {
  deliveryPackageReleaseId: string;
  version: string;
  channel: string;
  releaseStatus: Doc<'delivery_package_releases'>['releaseStatus'];
  repositoryVisibility: Doc<'delivery_package_releases'>['repositoryVisibility'];
  deliveryArtifactMode?: 'legacy_signed' | 'server_materialized';
  rawArtifactId?: Id<'delivery_release_artifacts'>;
  deliverableArtifactId?: Id<'delivery_release_artifacts'>;
  artifactKey?: string;
  signedArtifactId?: Id<'signed_release_artifacts'>;
  zipSha256?: string;
  metadata?: unknown;
  publishedAt?: number;
  createdAt: number;
  updatedAt: number;
  unityVersion?: string;
  deliveryName?: string;
  contentType?: string;
  aliasContract?: YucpAliasPackageContract;
};

type DeliveryArtifactSummary = Pick<
  Doc<'delivery_release_artifacts'>,
  | '_id'
  | 'artifactRole'
  | 'status'
  | 'storageId'
  | 'contentType'
  | 'deliveryName'
  | 'cdngineDelivery'
>;

type DownloadablePackageReleaseRecord = {
  deliveryPackageReleaseId: Id<'delivery_package_releases'>;
  artifactKey?: string;
  signedArtifactId?: Id<'signed_release_artifacts'>;
  zipSha256?: string;
  version: string;
  channel: string;
};

type BackstagePackageDownloadRecord = {
  deliveryArtifactId?: Id<'delivery_release_artifacts'>;
  deliveryArtifactMode?: 'legacy_signed' | 'server_materialized';
  artifactId?: Id<'signed_release_artifacts'>;
  artifactKey?: string;
  downloadUrl: string;
  contentType: string;
  deliveryName: string;
  zipSha256?: string;
  version: string;
  channel: string;
  cdngineDelivery?: CdngineBackstageDeliveryReference;
};

type AuthorizedAliasInstallPlanPackageRecord = {
  packageId: string;
  displayName?: string;
  version: string;
  channel: string;
  zipSha256?: string;
  aliasContract: YucpAliasPackageContract;
};

type AuthorizedAliasInstallPlanRecord = {
  creatorAuthUserId: string;
  creatorSlug?: string;
  providerProductRef: string;
  canonicalSlug?: string;
  displayName?: string;
  thumbnailUrl?: string;
  packages: AuthorizedAliasInstallPlanPackageRecord[];
};

const CdngineBackstageDeliveryReferenceV = v.object({
  assetId: v.string(),
  assetOwner: v.string(),
  byteSize: v.number(),
  deliveryScopeId: v.string(),
  serviceNamespaceId: v.string(),
  sha256: v.string(),
  tenantId: v.optional(v.string()),
  uploadedAt: v.number(),
  variant: v.string(),
  versionId: v.string(),
});

const DownloadablePackageReleaseRecordV = v.object({
  deliveryPackageReleaseId: v.id('delivery_package_releases'),
  artifactKey: v.optional(v.string()),
  signedArtifactId: v.optional(v.id('signed_release_artifacts')),
  zipSha256: v.optional(v.string()),
  version: v.string(),
  channel: v.string(),
  cdngineDelivery: v.optional(CdngineBackstageDeliveryReferenceV),
});

const BackstagePackageDownloadRecordV = v.object({
  deliveryArtifactId: v.optional(v.id('delivery_release_artifacts')),
  deliveryArtifactMode: v.optional(DeliveryArtifactModeV),
  artifactId: v.optional(v.id('signed_release_artifacts')),
  artifactKey: v.optional(v.string()),
  downloadUrl: v.string(),
  contentType: v.string(),
  deliveryName: v.string(),
  zipSha256: v.optional(v.string()),
  version: v.string(),
  channel: v.string(),
  cdngineDelivery: v.optional(CdngineBackstageDeliveryReferenceV),
});

const YucpAliasPackageContractV = v.object({
  kind: v.literal(YUCP_ALIAS_PACKAGE_KIND),
  aliasId: v.string(),
  installStrategy: v.literal(YUCP_ALIAS_PACKAGE_INSTALL_STRATEGIES.serverAuthorized),
  importerPackage: v.literal(YUCP_ALIAS_PACKAGE_IMPORTER_PACKAGES.importer),
  minImporterVersion: v.optional(v.string()),
  catalogProductIds: v.optional(v.array(v.string())),
  channel: v.optional(v.string()),
});

const AuthorizedAliasInstallPlanPackageRecordV = v.object({
  packageId: v.string(),
  displayName: v.optional(v.string()),
  version: v.string(),
  channel: v.string(),
  zipSha256: v.optional(v.string()),
  aliasContract: YucpAliasPackageContractV,
});

const AuthorizedAliasInstallPlanRecordV = v.object({
  creatorAuthUserId: v.string(),
  creatorSlug: v.optional(v.string()),
  providerProductRef: v.string(),
  canonicalSlug: v.optional(v.string()),
  displayName: v.optional(v.string()),
  thumbnailUrl: v.optional(v.string()),
  packages: v.array(AuthorizedAliasInstallPlanPackageRecordV),
});

const DeliveryAccessSelectorV = v.union(
  v.object({
    kind: v.literal('catalogProduct'),
    catalogProductId: v.id('product_catalog'),
  }),
  v.object({
    kind: v.literal('catalogTier'),
    catalogTierId: v.id('catalog_tiers'),
  })
);

type DeliveryAccessSelector =
  | {
      kind: 'catalogProduct';
      catalogProductId: Id<'product_catalog'>;
    }
  | {
      kind: 'catalogTier';
      catalogTierId: Id<'catalog_tiers'>;
    };

type ResolvedDeliveryAccessSelector =
  | {
      kind: 'catalogProduct';
      catalogProductId: Id<'product_catalog'>;
    }
  | {
      kind: 'catalogTier';
      catalogProductId: Id<'product_catalog'>;
      catalogTierId: Id<'catalog_tiers'>;
    };

type RegistryReaderCtx = QueryCtx | MutationCtx;
type DeliveryPackageMutationResult = {
  deliveryPackageId: Id<'delivery_packages'>;
  packageId: string;
};

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

function compareReleaseRecency(
  left: Doc<'delivery_package_releases'>,
  right: Doc<'delivery_package_releases'>
): number {
  const leftScore = left.publishedAt ?? left.updatedAt;
  const rightScore = right.publishedAt ?? right.updatedAt;
  return rightScore - leftScore;
}

function shouldReplaceLatestRelease(
  candidate: Doc<'delivery_package_releases'>,
  existing: Doc<'delivery_package_releases'> | undefined
): boolean {
  if (!existing) {
    return true;
  }
  if (candidate.releaseStatus === 'published' && existing.releaseStatus !== 'published') {
    return true;
  }
  if (candidate.releaseStatus !== 'published' && existing.releaseStatus === 'published') {
    return false;
  }
  return compareReleaseRecency(candidate, existing) < 0;
}

type ActiveDeliveryArtifactsForRelease = {
  rawArtifact?: DeliveryArtifactSummary;
  deliverableArtifact?: DeliveryArtifactSummary;
};

async function loadActiveDeliveryArtifactsByReleaseId(
  ctx: RegistryReaderCtx,
  releases: Array<Pick<Doc<'delivery_package_releases'>, '_id'>>
): Promise<Map<string, ActiveDeliveryArtifactsForRelease>> {
  const artifactsByReleaseId = new Map<string, ActiveDeliveryArtifactsForRelease>();
  const artifactRows = (
    await Promise.all(
      releases.map(async (release) => {
        return await ctx.db
          .query('delivery_release_artifacts')
          .withIndex('by_release', (q) => q.eq('deliveryPackageReleaseId', release._id))
          .collect();
      })
    )
  ).flat();

  for (const artifact of artifactRows) {
    if (artifact.status !== 'active') {
      continue;
    }
    const releaseId = String(artifact.deliveryPackageReleaseId);
    const existing = artifactsByReleaseId.get(releaseId) ?? {};
    if (artifact.artifactRole === 'raw_upload') {
      existing.rawArtifact = artifact;
    } else if (artifact.artifactRole === 'server_deliverable') {
      existing.deliverableArtifact = artifact;
    }
    artifactsByReleaseId.set(releaseId, existing);
  }

  return artifactsByReleaseId;
}

function toBackstageReleaseSummary(
  release: Doc<'delivery_package_releases'>,
  signedArtifactsById: Map<string, Doc<'signed_release_artifacts'>>,
  activeDeliveryArtifactsByReleaseId: Map<string, ActiveDeliveryArtifactsForRelease>,
  aliasMetadataSeed?: SyntheticAliasMetadataSeed
): BackstageReleaseSummary {
  const signedArtifact = release.signedArtifactId
    ? signedArtifactsById.get(String(release.signedArtifactId))
    : undefined;
  const releaseArtifacts = activeDeliveryArtifactsByReleaseId.get(String(release._id));
  const rawArtifact = releaseArtifacts?.rawArtifact;
  const deliveryArtifact = releaseArtifacts?.deliverableArtifact;
  const resolvedMetadata = resolveBackstageReleaseMetadata(release.metadata, aliasMetadataSeed);

  return {
    deliveryPackageReleaseId: String(release._id),
    version: release.version,
    channel: release.channel,
    releaseStatus: release.releaseStatus,
    repositoryVisibility: release.repositoryVisibility,
    deliveryArtifactMode: deliveryArtifact ? 'server_materialized' : undefined,
    rawArtifactId: rawArtifact?._id,
    deliverableArtifactId: deliveryArtifact?._id,
    artifactKey: release.artifactKey,
    signedArtifactId: release.signedArtifactId,
    zipSha256: release.zipSha256,
    metadata: resolvedMetadata,
    publishedAt: release.publishedAt,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
    unityVersion: release.unityVersion,
    deliveryName: deliveryArtifact?.deliveryName ?? signedArtifact?.deliveryName,
    contentType: deliveryArtifact?.contentType ?? signedArtifact?.contentType,
    aliasContract: getYucpAliasPackageContract(resolvedMetadata),
  };
}

async function resolveDownloadableArtifactForReleaseRecord(
  ctx: QueryCtx,
  release: DownloadablePackageReleaseRecord | null
): Promise<BackstagePackageDownloadRecord | null> {
  if (!release) {
    return null;
  }

  const deliverable = await ctx.db
    .query('delivery_release_artifacts')
    .withIndex('by_release_role_status', (q) =>
      q
        .eq('deliveryPackageReleaseId', release.deliveryPackageReleaseId)
        .eq('artifactRole', 'server_deliverable')
        .eq('status', 'active')
    )
    .first();
  if (deliverable) {
    const downloadUrl = deliverable.storageId
      ? await ctx.storage.getUrl(deliverable.storageId)
      : null;
    if (!downloadUrl && !deliverable.cdngineDelivery) {
      return null;
    }

    return {
      deliveryArtifactId: deliverable._id,
      deliveryArtifactMode: 'server_materialized',
      downloadUrl: downloadUrl ?? '',
      contentType: deliverable.contentType,
      deliveryName: deliverable.deliveryName,
      zipSha256: release.zipSha256,
      version: release.version,
      channel: release.channel,
      cdngineDelivery: deliverable.cdngineDelivery,
    };
  }

  const artifact = (
    release.signedArtifactId
      ? await ctx.runQuery(internal.releaseArtifacts.getArtifactById, {
          artifactId: release.signedArtifactId,
        })
      : release.artifactKey
        ? await ctx.runQuery(internal.releaseArtifacts.getLatestActiveArtifactByKey, {
            artifactKey: release.artifactKey,
          })
        : null
  ) as {
    artifactKey: string;
    storageId: Id<'_storage'>;
    contentType: string;
    deliveryName: string;
  } | null;
  if (!artifact) {
    return null;
  }

  const downloadUrl = await ctx.storage.getUrl(artifact.storageId);
  if (!downloadUrl) {
    return null;
  }

  return {
    deliveryArtifactMode: 'legacy_signed',
    artifactId: release.signedArtifactId,
    artifactKey: artifact.artifactKey,
    downloadUrl,
    contentType: artifact.contentType,
    deliveryName: artifact.deliveryName,
    zipSha256: release.zipSha256,
    version: release.version,
    channel: release.channel,
  };
}

function compareBackstagePackages(
  left: BackstagePackageSummary,
  right: BackstagePackageSummary
): number {
  const leftLabel = (left.displayName ?? left.packageName ?? left.packageId).toLowerCase();
  const rightLabel = (right.displayName ?? right.packageName ?? right.packageId).toLowerCase();
  return leftLabel.localeCompare(rightLabel) || left.packageId.localeCompare(right.packageId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveBackstageReleaseMetadata(
  metadata: unknown,
  aliasMetadataSeed?: SyntheticAliasMetadataSeed
): Record<string, unknown> {
  const baseMetadata = isRecord(metadata) ? metadata : {};
  if (!aliasMetadataSeed || getYucpAliasPackageContract(baseMetadata)) {
    return baseMetadata;
  }

  return mergeYucpAliasPackageMetadata({
    metadata: baseMetadata,
    aliasId: aliasMetadataSeed.aliasId,
    catalogProductIds: aliasMetadataSeed.catalogProductIds,
    channel: aliasMetadataSeed.channel,
  });
}

function toBackstageReleaseManifestMetadata(
  release: Pick<BackstageReleaseSummary, 'metadata' | 'deliveryName' | 'contentType'>
): Record<string, unknown> {
  const releaseMetadata = isRecord(release.metadata) ? release.metadata : {};
  const normalizedMetadata = stripBackstageVpmReservedMetadata(releaseMetadata);
  const manifestMetadata = applyYucpAliasPackageManifestDefaults(normalizedMetadata);
  const trustedPersistedSourceKind =
    releaseMetadata[BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY] ===
    BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS.serverDerived;
  const reservedSourceKind =
    trustedPersistedSourceKind &&
    (releaseMetadata[BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY] ===
      BACKSTAGE_VPM_SOURCE_KINDS.unitypackage ||
      releaseMetadata[BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY] === BACKSTAGE_VPM_SOURCE_KINDS.zip)
      ? releaseMetadata[BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY]
      : undefined;
  const sourceKind =
    reservedSourceKind ??
    inferBackstageVpmDeliverySourceKind({
      deliveryName: release.deliveryName,
      contentType: release.contentType,
    });
  return {
    ...manifestMetadata,
    ...buildRepoTokenVpmDeliveryMetadata(sourceKind),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function createBackstageRepoToken(): string {
  const randomBytes = new Uint8Array(BACKSTAGE_REPO_TOKEN_BYTES);
  crypto.getRandomValues(randomBytes);
  return `${BACKSTAGE_REPO_TOKEN_PREFIX}${bytesToHex(randomBytes)}`;
}

function buildBackstageDownloadUrl(
  packageBaseUrl: string,
  packageId: string,
  version: string,
  channel: string,
  zipSha256?: string
): string {
  const url = new URL(packageBaseUrl);
  url.searchParams.set('packageId', packageId);
  url.searchParams.set('version', version);
  url.searchParams.set('channel', channel);
  if (zipSha256) {
    url.searchParams.set('zipSHA256', zipSha256);
  }
  return url.toString();
}

function toVpmVersionManifest(
  packageSummary: BackstagePackageSummary,
  packageBaseUrl: string,
  packageHeaders?: Record<string, string>
): Record<string, unknown> | null {
  if (!packageSummary.latestRelease || packageSummary.latestRelease.releaseStatus !== 'published') {
    return null;
  }

  const metadata = toBackstageReleaseManifestMetadata(packageSummary.latestRelease);

  return {
    ...metadata,
    name: packageSummary.packageId,
    version: packageSummary.latestRelease.version,
    displayName:
      packageSummary.displayName ?? packageSummary.packageName ?? packageSummary.packageId,
    url: buildBackstageDownloadUrl(
      packageBaseUrl,
      packageSummary.packageId,
      packageSummary.latestRelease.version,
      packageSummary.latestRelease.channel,
      packageSummary.latestRelease.zipSha256
    ),
    ...(packageHeaders && Object.keys(packageHeaders).length > 0
      ? { headers: packageHeaders }
      : {}),
    ...(packageSummary.latestRelease.zipSha256
      ? { zipSHA256: packageSummary.latestRelease.zipSha256 }
      : {}),
    ...(packageSummary.latestRelease.artifactKey
      ? { yucpArtifactKey: packageSummary.latestRelease.artifactKey }
      : {}),
  };
}

async function requireOwnedCatalogProduct(
  ctx: RegistryReaderCtx,
  authUserId: string,
  catalogProductId: Id<'product_catalog'>
): Promise<Doc<'product_catalog'>> {
  const product = await ctx.db.get(catalogProductId);
  if (!product || product.authUserId !== authUserId) {
    throw new ConvexError('Catalog product not found.');
  }
  return product;
}

async function requireOwnedCatalogTier(
  ctx: RegistryReaderCtx,
  authUserId: string,
  catalogTierId: Id<'catalog_tiers'>
): Promise<Doc<'catalog_tiers'>> {
  const tier = await ctx.db.get(catalogTierId);
  if (!tier || tier.authUserId !== authUserId) {
    throw new ConvexError('Catalog tier not found.');
  }
  return tier;
}

function getResolvedDeliveryAccessSelectorKey(selector: ResolvedDeliveryAccessSelector): string {
  return selector.kind === 'catalogTier'
    ? `tier:${String(selector.catalogTierId)}`
    : `product:${String(selector.catalogProductId)}`;
}

function getDeliveryPackageLinkSelectorKey(
  link: Pick<Doc<'delivery_package_products'>, 'catalogProductId' | 'catalogTierId'>
): string {
  return link.catalogTierId
    ? `tier:${String(link.catalogTierId)}`
    : `product:${String(link.catalogProductId)}`;
}

async function resolveDeliveryAccessSelector(
  ctx: RegistryReaderCtx,
  authUserId: string,
  selector: DeliveryAccessSelector
): Promise<ResolvedDeliveryAccessSelector> {
  if (selector.kind === 'catalogProduct') {
    await requireOwnedCatalogProduct(ctx, authUserId, selector.catalogProductId);
    return selector;
  }

  const catalogTier = await requireOwnedCatalogTier(ctx, authUserId, selector.catalogTierId);
  if (!catalogTier.catalogProductId) {
    throw new ConvexError('Catalog tier is missing its catalog product link.');
  }
  await requireOwnedCatalogProduct(ctx, authUserId, catalogTier.catalogProductId);
  return {
    kind: 'catalogTier',
    catalogProductId: catalogTier.catalogProductId,
    catalogTierId: selector.catalogTierId,
  };
}

async function getProductDeleteBlockedReason(
  ctx: RegistryReaderCtx,
  authUserId: string,
  catalogProductId: Id<'product_catalog'>
): Promise<string | undefined> {
  const deliveryLink = await ctx.db
    .query('delivery_package_products')
    .withIndex('by_auth_user_catalog_product', (q) =>
      q.eq('authUserId', authUserId).eq('catalogProductId', catalogProductId)
    )
    .first();
  if (deliveryLink) return PRODUCT_DELETE_BLOCKED_REASON;

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

async function assertPackageNamespaceOwnership(
  ctx: RegistryReaderCtx,
  authUserId: string,
  packageId: string
): Promise<void> {
  const registration = await ctx.db
    .query('package_registry')
    .withIndex('by_package_id', (q) => q.eq('packageId', packageId))
    .first();

  if (registration && registration.yucpUserId !== authUserId) {
    throw new ConvexError('Package namespace is owned by another creator.');
  }
}

async function getOwnedDeliveryPackageByPackageId(
  ctx: RegistryReaderCtx,
  authUserId: string,
  packageId: string
): Promise<Doc<'delivery_packages'> | null> {
  const deliveryPackage = await ctx.db
    .query('delivery_packages')
    .withIndex('by_package_id', (q) => q.eq('packageId', packageId))
    .first();

  if (!deliveryPackage) {
    return null;
  }
  if (deliveryPackage.authUserId !== authUserId) {
    throw new ConvexError('Delivery package is owned by another creator.');
  }
  return deliveryPackage;
}

async function getOwnedDeliveryPackageRelease(
  ctx: MutationCtx,
  args: {
    authUserId: string;
    packageId: string;
    deliveryPackageReleaseId: Id<'delivery_package_releases'>;
  }
): Promise<{
  deliveryPackage: Doc<'delivery_packages'>;
  release: Doc<'delivery_package_releases'>;
  siblingReleases: Doc<'delivery_package_releases'>[];
}> {
  const deliveryPackage = await getOwnedDeliveryPackageByPackageId(
    ctx,
    args.authUserId,
    args.packageId
  );
  if (!deliveryPackage) {
    throw new ConvexError('Delivery package not found.');
  }

  const release = await ctx.db.get(args.deliveryPackageReleaseId);
  if (
    !release ||
    release.authUserId !== args.authUserId ||
    String(release.deliveryPackageId) !== String(deliveryPackage._id)
  ) {
    throw new ConvexError('Delivery package release not found.');
  }

  const siblingReleases = await ctx.db
    .query('delivery_package_releases')
    .withIndex('by_delivery_package', (q) => q.eq('deliveryPackageId', deliveryPackage._id))
    .collect();

  return { deliveryPackage, release, siblingReleases };
}

function getLatestOwnedDeliveryPackageRelease(
  siblingReleases: Doc<'delivery_package_releases'>[]
): Doc<'delivery_package_releases'> | undefined {
  return siblingReleases.reduce<Doc<'delivery_package_releases'> | undefined>(
    (current, candidate) => (shouldReplaceLatestRelease(candidate, current) ? candidate : current),
    undefined
  );
}

function buildDeliveryPackagePublicationPatch(
  siblingReleases: Doc<'delivery_package_releases'>[]
): Pick<
  Doc<'delivery_packages'>,
  'repositoryVisibility' | 'latestPublishedAt' | 'latestPublishedVersion'
> {
  const latestPublishedRelease = getLatestOwnedDeliveryPackageRelease(
    siblingReleases.filter((candidate) => candidate.releaseStatus === 'published')
  );

  if (!latestPublishedRelease) {
    return {
      repositoryVisibility: 'hidden',
      latestPublishedAt: undefined,
      latestPublishedVersion: undefined,
    };
  }

  return {
    repositoryVisibility: latestPublishedRelease.repositoryVisibility,
    latestPublishedAt: latestPublishedRelease.publishedAt ?? latestPublishedRelease.updatedAt,
    latestPublishedVersion: latestPublishedRelease.version,
  };
}

async function deleteOwnedDeliveryPackageRelease(
  ctx: MutationCtx,
  args: {
    release: Doc<'delivery_package_releases'>;
    siblingReleases: Doc<'delivery_package_releases'>[];
  }
): Promise<void> {
  const deliveryArtifacts = await ctx.db
    .query('delivery_release_artifacts')
    .withIndex('by_release', (q) => q.eq('deliveryPackageReleaseId', args.release._id))
    .collect();
  const signedArtifact =
    args.release.signedArtifactId &&
    !args.siblingReleases.some(
      (candidate) =>
        candidate._id !== args.release._id &&
        candidate.signedArtifactId === args.release.signedArtifactId
    )
      ? await ctx.db.get(args.release.signedArtifactId)
      : null;

  const storageIdsToDelete = new Set<string>();
  for (const artifact of deliveryArtifacts) {
    if (artifact.storageId) {
      storageIdsToDelete.add(String(artifact.storageId));
    }
  }
  if (signedArtifact) {
    storageIdsToDelete.add(String(signedArtifact.storageId));
  }

  for (const artifact of deliveryArtifacts) {
    await ctx.db.delete(artifact._id);
  }
  if (signedArtifact) {
    await ctx.db.delete(signedArtifact._id);
  }
  await ctx.db.delete(args.release._id);

  for (const storageId of storageIdsToDelete) {
    await ctx.storage.delete(storageId as Id<'_storage'>);
  }
}

async function upsertOwnedDeliveryPackage(
  ctx: MutationCtx,
  args: {
    authUserId: string;
    packageId: string;
    packageName?: string;
    displayName?: string;
    description?: string;
    repositoryVisibility?: Doc<'delivery_packages'>['repositoryVisibility'];
    defaultChannel?: string;
  }
): Promise<Id<'delivery_packages'>> {
  await assertPackageNamespaceOwnership(ctx, args.authUserId, args.packageId);

  const now = Date.now();
  const existing = await getOwnedDeliveryPackageByPackageId(ctx, args.authUserId, args.packageId);
  const normalizedPackageName = normalizePackageName(args.packageName);
  const normalizedDisplayName = normalizePackageName(args.displayName);

  if (existing) {
    await ctx.db.patch(existing._id, {
      packageName: normalizedPackageName ?? existing.packageName,
      displayName: normalizedDisplayName ?? existing.displayName,
      description: args.description ?? existing.description,
      repositoryVisibility: args.repositoryVisibility ?? existing.repositoryVisibility,
      defaultChannel: args.defaultChannel ?? existing.defaultChannel,
      status: existing.status === 'archived' ? 'active' : existing.status,
      updatedAt: now,
    });
    return existing._id;
  }

  return await ctx.db.insert('delivery_packages', {
    authUserId: args.authUserId,
    packageId: args.packageId,
    packageName: normalizedPackageName,
    displayName: normalizedDisplayName,
    description: args.description,
    status: 'active',
    repositoryVisibility: args.repositoryVisibility ?? 'hidden',
    defaultChannel: args.defaultChannel,
    createdAt: now,
    updatedAt: now,
  });
}

async function ensureActiveDeliveryPackageLinks(
  ctx: MutationCtx,
  args: {
    authUserId: string;
    accessSelectors: ReadonlyArray<DeliveryAccessSelector>;
    deliveryPackageId: Id<'delivery_packages'>;
  }
): Promise<void> {
  const now = Date.now();
  const resolvedSelectors = Array.from(
    new Map(
      (
        await Promise.all(
          args.accessSelectors.map(async (selector) =>
            resolveDeliveryAccessSelector(ctx, args.authUserId, selector)
          )
        )
      ).map((selector) => [getResolvedDeliveryAccessSelectorKey(selector), selector])
    ).values()
  );

  const existingLinks = (
    await ctx.db
      .query('delivery_package_products')
      .withIndex('by_delivery_package', (q) => q.eq('deliveryPackageId', args.deliveryPackageId))
      .collect()
  ).filter((link) => link.authUserId === args.authUserId);

  const nextSelectorKeys = new Set(
    resolvedSelectors.map((selector) => getResolvedDeliveryAccessSelectorKey(selector))
  );

  await Promise.all(
    existingLinks.map(async (link) => {
      const selectorKey = getDeliveryPackageLinkSelectorKey(link);
      const nextStatus = nextSelectorKeys.has(selectorKey) ? 'active' : 'archived';
      if (link.status === nextStatus) {
        return;
      }
      await ctx.db.patch(link._id, {
        status: nextStatus,
        updatedAt: now,
      });
    })
  );

  const existingLinkKeys = new Set(
    existingLinks.map((link) => getDeliveryPackageLinkSelectorKey(link))
  );
  await Promise.all(
    resolvedSelectors.map(async (selector) => {
      const selectorKey = getResolvedDeliveryAccessSelectorKey(selector);
      if (existingLinkKeys.has(selectorKey)) {
        return;
      }

      await ctx.db.insert('delivery_package_products', {
        authUserId: args.authUserId,
        deliveryPackageId: args.deliveryPackageId,
        catalogProductId: selector.catalogProductId,
        ...(selector.kind === 'catalogTier' ? { catalogTierId: selector.catalogTierId } : {}),
        status: 'active',
        accessMode: 'entitlement',
        createdAt: now,
        updatedAt: now,
      });
    })
  );
}

async function upsertDeliveryPackageWithSelectors(
  ctx: MutationCtx,
  args: {
    authUserId: string;
    accessSelectors: ReadonlyArray<DeliveryAccessSelector>;
    packageId: string;
    packageName?: string;
    displayName?: string;
    description?: string;
    repositoryVisibility?: Doc<'delivery_packages'>['repositoryVisibility'];
    defaultChannel?: string;
  }
): Promise<DeliveryPackageMutationResult> {
  if (args.accessSelectors.length === 0) {
    throw new ConvexError('At least one package access selector is required.');
  }

  const deliveryPackageId = await upsertOwnedDeliveryPackage(ctx, {
    authUserId: args.authUserId,
    packageId: args.packageId,
    packageName: args.packageName,
    displayName: args.displayName,
    description: args.description,
    repositoryVisibility: args.repositoryVisibility,
    defaultChannel: args.defaultChannel,
  });
  await ensureActiveDeliveryPackageLinks(ctx, {
    authUserId: args.authUserId,
    accessSelectors: args.accessSelectors,
    deliveryPackageId,
  });

  return {
    deliveryPackageId,
    packageId: args.packageId,
  };
}

async function summarizeBackstagePackagesFromLinks(
  ctx: RegistryReaderCtx,
  authUserId: string,
  links: ReadonlyArray<Doc<'delivery_package_products'>>
): Promise<Map<string, BackstagePackageSummary[]>> {
  if (links.length === 0) {
    return new Map();
  }

  const uniqueDeliveryPackageIds = Array.from(
    new Set(links.map((link) => String(link.deliveryPackageId)))
  ) as Array<string>;
  const deliveryPackages = (
    await Promise.all(
      uniqueDeliveryPackageIds.map(async (deliveryPackageId) => {
        return await ctx.db.get(deliveryPackageId as Id<'delivery_packages'>);
      })
    )
  ).filter(
    (deliveryPackage): deliveryPackage is Doc<'delivery_packages'> => deliveryPackage !== null
  );

  const deliveryPackagesById = new Map(
    deliveryPackages.map((deliveryPackage) => [String(deliveryPackage._id), deliveryPackage])
  );
  const relevantDeliveryPackageIdSet = new Set(
    deliveryPackages.map((deliveryPackage) => String(deliveryPackage._id))
  );
  const activeLinksForRelevantPackages = (
    (await ctx.db
      .query('delivery_package_products')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
      .collect()) as Doc<'delivery_package_products'>[]
  ).filter(
    (link) =>
      link.status === 'active' && relevantDeliveryPackageIdSet.has(String(link.deliveryPackageId))
  );
  const uniqueCatalogProductIds = Array.from(
    new Set(activeLinksForRelevantPackages.map((link) => String(link.catalogProductId)))
  );
  const catalogProducts = (
    await Promise.all(
      uniqueCatalogProductIds.map(async (catalogProductId) => {
        return await ctx.db.get(catalogProductId as Id<'product_catalog'>);
      })
    )
  ).filter((product): product is Doc<'product_catalog'> => product !== null);
  const catalogProductsById = new Map(
    catalogProducts.map((product) => [String(product._id), product])
  );
  const catalogProductsByDeliveryPackageId = new Map<string, CatalogProductAliasSource[]>();
  for (const link of activeLinksForRelevantPackages) {
    const linkedCatalogProduct = catalogProductsById.get(String(link.catalogProductId));
    if (!linkedCatalogProduct) {
      continue;
    }
    const existingProducts =
      catalogProductsByDeliveryPackageId.get(String(link.deliveryPackageId)) ?? [];
    existingProducts.push(linkedCatalogProduct);
    catalogProductsByDeliveryPackageId.set(String(link.deliveryPackageId), existingProducts);
  }

  const releases = await ctx.db
    .query('delivery_package_releases')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
    .collect();
  const relevantReleases = releases.filter((release) =>
    deliveryPackagesById.has(String(release.deliveryPackageId))
  );
  const signedArtifactIds = Array.from(
    new Set(
      relevantReleases
        .map((release) => (release.signedArtifactId ? String(release.signedArtifactId) : null))
        .filter((artifactId): artifactId is string => Boolean(artifactId))
    )
  );
  const signedArtifacts = (
    await Promise.all(
      signedArtifactIds.map(async (artifactId) => {
        return await ctx.db.get(artifactId as Id<'signed_release_artifacts'>);
      })
    )
  ).filter((artifact): artifact is Doc<'signed_release_artifacts'> => artifact !== null);
  const signedArtifactsById = new Map(
    signedArtifacts.map((artifact) => [String(artifact._id), artifact])
  );
  const activeDeliveryArtifactsByReleaseId = await loadActiveDeliveryArtifactsByReleaseId(
    ctx,
    relevantReleases
  );

  const latestReleaseByPackageId = new Map<string, Doc<'delivery_package_releases'>>();
  const releasesByPackageId = new Map<string, Doc<'delivery_package_releases'>[]>();
  for (const release of relevantReleases) {
    const releaseKey = String(release.deliveryPackageId);
    const existingReleases = releasesByPackageId.get(releaseKey) ?? [];
    existingReleases.push(release);
    releasesByPackageId.set(releaseKey, existingReleases);

    const existing = latestReleaseByPackageId.get(String(release.deliveryPackageId));
    if (shouldReplaceLatestRelease(release, existing)) {
      latestReleaseByPackageId.set(String(release.deliveryPackageId), release);
    }
  }

  const summariesByCatalogProduct = new Map<string, Map<string, BackstagePackageSummary>>();
  for (const link of links) {
    const deliveryPackage = deliveryPackagesById.get(String(link.deliveryPackageId));
    if (!deliveryPackage) {
      continue;
    }
    const catalogProductKey = String(link.catalogProductId);
    const deliveryPackageKey = String(link.deliveryPackageId);
    const summariesForProduct = summariesByCatalogProduct.get(catalogProductKey) ?? new Map();
    if (summariesForProduct.has(deliveryPackageKey)) {
      summariesByCatalogProduct.set(catalogProductKey, summariesForProduct);
      continue;
    }

    const linkedCatalogProducts =
      catalogProductsByDeliveryPackageId.get(String(link.deliveryPackageId)) ?? [];
    const packageReleaseHistory = (releasesByPackageId.get(String(link.deliveryPackageId)) ?? [])
      .slice()
      .sort(compareReleaseRecency)
      .map((release) =>
        toBackstageReleaseSummary(
          release,
          signedArtifactsById,
          activeDeliveryArtifactsByReleaseId,
          buildSyntheticAliasMetadataSeed(linkedCatalogProducts, release.channel)
        )
      );
    const latestRelease = latestReleaseByPackageId.get(String(link.deliveryPackageId)) ?? null;
    const summary: BackstagePackageSummary = {
      deliveryPackageId: deliveryPackage._id,
      packageId: deliveryPackage.packageId,
      packageName: deliveryPackage.packageName,
      displayName: deliveryPackage.displayName,
      description: deliveryPackage.description,
      status: deliveryPackage.status,
      repositoryVisibility: deliveryPackage.repositoryVisibility,
      defaultChannel: deliveryPackage.defaultChannel,
      latestPublishedVersion: deliveryPackage.latestPublishedVersion,
      latestPublishedAt: deliveryPackage.latestPublishedAt,
      latestRelease: latestRelease
        ? toBackstageReleaseSummary(
            latestRelease,
            signedArtifactsById,
            activeDeliveryArtifactsByReleaseId,
            buildSyntheticAliasMetadataSeed(linkedCatalogProducts, latestRelease.channel)
          )
        : null,
      releases: packageReleaseHistory,
    };
    summariesForProduct.set(deliveryPackageKey, summary);
    summariesByCatalogProduct.set(catalogProductKey, summariesForProduct);
  }

  const summaries = new Map<string, BackstagePackageSummary[]>();
  for (const [catalogProductKey, packageMap] of summariesByCatalogProduct) {
    summaries.set(
      catalogProductKey,
      Array.from(packageMap.values()).sort(compareBackstagePackages)
    );
  }

  return summaries;
}

async function buildBackstagePackageMap(
  ctx: RegistryReaderCtx,
  authUserId: string,
  catalogProductIds: ReadonlyArray<Id<'product_catalog'>>
): Promise<Map<string, BackstagePackageSummary[]>> {
  if (catalogProductIds.length === 0) {
    return new Map();
  }

  const catalogProductIdSet = new Set(catalogProductIds.map(String));
  const links = (
    await ctx.db
      .query('delivery_package_products')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
      .collect()
  ).filter(
    (link) => link.status === 'active' && catalogProductIdSet.has(String(link.catalogProductId))
  );

  return await summarizeBackstagePackagesFromLinks(ctx, authUserId, links);
}

async function listEntitledBackstagePackages(
  ctx: QueryCtx,
  authUserId: string,
  subjectId: Id<'subjects'>
): Promise<
  Array<
    BackstagePackageSummary & {
      catalogProductIds: Array<Id<'product_catalog'>>;
    }
  >
> {
  const subject = await ctx.db.get(subjectId);
  if (!subject || subject.status !== 'active') {
    return [];
  }

  const activeEntitlements = await ctx.db
    .query('entitlements')
    .withIndex('by_auth_user_subject', (q) =>
      q.eq('authUserId', authUserId).eq('subjectId', subjectId)
    )
    .filter((q) => q.eq(q.field('status'), 'active'))
    .collect();

  const directCatalogProductIds = activeEntitlements
    .map((entitlement) => entitlement.catalogProductId)
    .filter((catalogProductId): catalogProductId is Id<'product_catalog'> => !!catalogProductId);

  const unresolvedProductIds = activeEntitlements
    .filter((entitlement) => entitlement.catalogProductId === undefined)
    .map((entitlement) => entitlement.productId);

  let catalogProductIds = [...directCatalogProductIds];
  if (unresolvedProductIds.length > 0) {
    const unresolvedProductIdSet = new Set(unresolvedProductIds);
    const ownedProducts = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
      .collect();
    catalogProductIds = catalogProductIds.concat(
      ownedProducts
        .filter((product) => unresolvedProductIdSet.has(product.productId))
        .map((product) => product._id)
    );
  }

  const uniqueCatalogProductIds = Array.from(
    new Map(
      catalogProductIds.map((catalogProductId) => [String(catalogProductId), catalogProductId])
    ).values()
  );
  const apiSecret = process.env.CONVEX_API_SECRET;
  if (!apiSecret) {
    throw new ConvexError('CONVEX_API_SECRET is required for tier entitlement resolution.');
  }
  const activeCatalogTierIds = Array.from(
    new Map(
      (
        await Promise.all(
          activeEntitlements.map(async (entitlement) =>
            ctx.runQuery(api.catalogTiers.getActiveCatalogTierIdsForEntitlement, {
              apiSecret,
              entitlementId: entitlement._id,
            })
          )
        )
      )
        .flat()
        .map((catalogTierId: Id<'catalog_tiers'>) => [String(catalogTierId), catalogTierId])
    ).values()
  );
  const directCatalogProductIdSet = new Set(uniqueCatalogProductIds.map(String));
  const activeCatalogTierIdSet = new Set(activeCatalogTierIds.map(String));
  const matchedLinks = (
    await ctx.db
      .query('delivery_package_products')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', authUserId))
      .collect()
  ).filter(
    (link) =>
      link.status === 'active' &&
      (link.catalogTierId
        ? activeCatalogTierIdSet.has(String(link.catalogTierId))
        : directCatalogProductIdSet.has(String(link.catalogProductId)))
  );
  const backstagePackagesByCatalogProduct = await summarizeBackstagePackagesFromLinks(
    ctx,
    authUserId,
    matchedLinks
  );
  const matchedCatalogProductIds = Array.from(
    new Map(
      matchedLinks.map((link) => [String(link.catalogProductId), link.catalogProductId])
    ).values()
  );

  const entitledPackages = matchedCatalogProductIds.flatMap((catalogProductId) => {
    const summaries = backstagePackagesByCatalogProduct.get(String(catalogProductId)) ?? [];
    return summaries.map((summary) => ({
      catalogProductIds: [catalogProductId],
      ...summary,
    }));
  });

  const mergedByPackageId = new Map<string, (typeof entitledPackages)[number]>();
  for (const entitledPackage of entitledPackages) {
    const existing = mergedByPackageId.get(entitledPackage.packageId);
    if (!existing) {
      mergedByPackageId.set(entitledPackage.packageId, entitledPackage);
      continue;
    }
    existing.catalogProductIds = Array.from(
      new Set([...existing.catalogProductIds, ...entitledPackage.catalogProductIds])
    ) as Array<Id<'product_catalog'>>;
  }

  return Array.from(mergedByPackageId.values()).sort(compareBackstagePackages);
}

async function resolveBackstageProductByRef(
  ctx: RegistryReaderCtx,
  creatorRef: string,
  productRef: string
): Promise<{
  creatorAuthUserId: string;
  creatorProfile: Doc<'creator_profiles'> | null;
  product: Doc<'product_catalog'>;
} | null> {
  const normalizedCreatorRef = creatorRef.trim().toLowerCase();
  const normalizedProductRef = productRef.trim().toLowerCase();
  if (!normalizedCreatorRef || !normalizedProductRef) {
    return null;
  }

  const creatorProfileBySlug = await ctx.db
    .query('creator_profiles')
    .withIndex('by_slug', (q) => q.eq('slug', normalizedCreatorRef))
    .first();
  const creatorAuthUserId = creatorProfileBySlug?.authUserId ?? creatorRef.trim();
  const creatorProfile =
    creatorProfileBySlug ??
    (await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', creatorAuthUserId))
      .first());

  const catalogProducts = await ctx.db
    .query('product_catalog')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', creatorAuthUserId))
    .filter((q) => q.eq(q.field('status'), 'active'))
    .collect();

  const product =
    catalogProducts.find(
      (entry) => entry.canonicalSlug?.trim().toLowerCase() === normalizedProductRef
    ) ??
    catalogProducts.find(
      (entry) => entry.providerProductRef.trim().toLowerCase() === normalizedProductRef
    );
  if (!product) {
    return null;
  }

  return {
    creatorAuthUserId,
    creatorProfile,
    product,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

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

export const issueBackstageRepoToken = internalMutation({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    label: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({
    token: v.string(),
    tokenId: v.id('delivery_repo_tokens'),
    expiresAt: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const subject = await ctx.db.get(args.subjectId);
    if (!subject || subject.status !== 'active' || subject.authUserId !== args.authUserId) {
      throw new ConvexError('Subject not found.');
    }

    const token = createBackstageRepoToken();
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const tokenId = await ctx.db.insert('delivery_repo_tokens', {
      authUserId: args.authUserId,
      subjectId: args.subjectId,
      tokenHash,
      label: args.label,
      status: 'active',
      expiresAt: args.expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    return {
      token,
      tokenId,
      expiresAt: args.expiresAt,
    };
  },
});

export const getBackstageRepoAccessByToken = internalQuery({
  args: {
    tokenHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      tokenId: v.id('delivery_repo_tokens'),
      authUserId: v.string(),
      subjectId: v.id('subjects'),
      status: DeliveryRepoTokenStatusV,
      expiresAt: v.optional(v.number()),
    })
  ),
  handler: async (ctx, args) => {
    const tokenRecord = await ctx.db
      .query('delivery_repo_tokens')
      .withIndex('by_token_hash', (q) => q.eq('tokenHash', args.tokenHash))
      .first();
    if (!tokenRecord) {
      return null;
    }

    const now = Date.now();
    const isExpired = tokenRecord.expiresAt !== undefined && tokenRecord.expiresAt <= now;
    const effectiveStatus = isExpired ? 'expired' : tokenRecord.status;
    if (effectiveStatus !== 'active') {
      return null;
    }

    const subject = await ctx.db.get(tokenRecord.subjectId);
    if (!subject || subject.status !== 'active') {
      return null;
    }

    return {
      tokenId: tokenRecord._id,
      authUserId: tokenRecord.authUserId,
      subjectId: tokenRecord.subjectId,
      status: effectiveStatus,
      expiresAt: tokenRecord.expiresAt,
    };
  },
});

export const touchBackstageRepoToken = internalMutation({
  args: {
    tokenId: v.id('delivery_repo_tokens'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.tokenId, {
      lastUsedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const upsertDeliveryPackageForProduct = internalMutation({
  args: {
    authUserId: v.string(),
    catalogProductId: v.id('product_catalog'),
    packageId: v.string(),
    packageName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    description: v.optional(v.string()),
    repositoryVisibility: v.optional(DeliveryPackageVisibilityV),
    defaultChannel: v.optional(v.string()),
  },
  returns: v.object({
    deliveryPackageId: v.id('delivery_packages'),
    packageId: v.string(),
  }),
  handler: async (ctx, args) => {
    const deliveryPackageId = await upsertOwnedDeliveryPackage(ctx, {
      authUserId: args.authUserId,
      packageId: args.packageId,
      packageName: args.packageName,
      displayName: args.displayName,
      description: args.description,
      repositoryVisibility: args.repositoryVisibility,
      defaultChannel: args.defaultChannel,
    });
    await ensureActiveDeliveryPackageLinks(ctx, {
      authUserId: args.authUserId,
      accessSelectors: [{ kind: 'catalogProduct', catalogProductId: args.catalogProductId }],
      deliveryPackageId,
    });

    return {
      deliveryPackageId,
      packageId: args.packageId,
    };
  },
});

export const upsertDeliveryPackageForAccessSelectors = internalMutation({
  args: {
    authUserId: v.string(),
    accessSelectors: v.array(DeliveryAccessSelectorV),
    packageId: v.string(),
    packageName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    description: v.optional(v.string()),
    repositoryVisibility: v.optional(DeliveryPackageVisibilityV),
    defaultChannel: v.optional(v.string()),
  },
  returns: v.object({
    deliveryPackageId: v.id('delivery_packages'),
    packageId: v.string(),
  }),
  handler: async (ctx, args) => {
    return await upsertDeliveryPackageWithSelectors(ctx, {
      authUserId: args.authUserId,
      accessSelectors: args.accessSelectors,
      packageId: args.packageId,
      packageName: args.packageName,
      displayName: args.displayName,
      description: args.description,
      repositoryVisibility: args.repositoryVisibility,
      defaultChannel: args.defaultChannel,
    });
  },
});

export const upsertDeliveryPackageForProducts = internalMutation({
  args: {
    authUserId: v.string(),
    catalogProductIds: v.array(v.id('product_catalog')),
    packageId: v.string(),
    packageName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    description: v.optional(v.string()),
    repositoryVisibility: v.optional(DeliveryPackageVisibilityV),
    defaultChannel: v.optional(v.string()),
  },
  returns: v.object({
    deliveryPackageId: v.id('delivery_packages'),
    packageId: v.string(),
  }),
  handler: async (ctx, args) => {
    if (args.catalogProductIds.length === 0) {
      throw new ConvexError('At least one catalog product is required.');
    }
    return await upsertDeliveryPackageWithSelectors(ctx, {
      authUserId: args.authUserId,
      accessSelectors: args.catalogProductIds.map((catalogProductId) => ({
        kind: 'catalogProduct' as const,
        catalogProductId,
      })),
      packageId: args.packageId,
      packageName: args.packageName,
      displayName: args.displayName,
      description: args.description,
      repositoryVisibility: args.repositoryVisibility,
      defaultChannel: args.defaultChannel,
    });
  },
});

export const recordDeliveryPackageRelease = internalMutation({
  args: {
    authUserId: v.string(),
    packageId: v.string(),
    version: v.string(),
    channel: v.string(),
    releaseStatus: v.optional(DeliveryPackageReleaseStatusV),
    repositoryVisibility: v.optional(DeliveryPackageVisibilityV),
    signedArtifactId: v.optional(v.id('signed_release_artifacts')),
    artifactKey: v.optional(v.string()),
    unityVersion: v.optional(v.string()),
    zipSha256: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  returns: v.object({
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
  }),
  handler: async (ctx, args) => {
    const deliveryPackage = await getOwnedDeliveryPackageByPackageId(
      ctx,
      args.authUserId,
      args.packageId
    );
    if (!deliveryPackage) {
      throw new ConvexError('Delivery package not found.');
    }

    const now = Date.now();
    const releaseStatus = args.releaseStatus ?? 'published';
    const repositoryVisibility = args.repositoryVisibility ?? deliveryPackage.repositoryVisibility;
    const existingReleases = await ctx.db
      .query('delivery_package_releases')
      .withIndex('by_delivery_package', (q) => q.eq('deliveryPackageId', deliveryPackage._id))
      .collect();
    const existingRelease = existingReleases.find(
      (release) => release.version === args.version && release.channel === args.channel
    );

    if (releaseStatus === 'published') {
      await Promise.all(
        existingReleases
          .filter(
            (release) =>
              release.channel === args.channel &&
              release.releaseStatus === 'published' &&
              (!existingRelease || String(release._id) !== String(existingRelease._id))
          )
          .map(async (release) => {
            await ctx.db.patch(release._id, {
              releaseStatus: 'superseded',
              updatedAt: now,
            });
          })
      );
    }

    const patch = {
      releaseStatus,
      repositoryVisibility,
      signedArtifactId: args.signedArtifactId,
      artifactKey: args.artifactKey,
      unityVersion: args.unityVersion,
      zipSha256: args.zipSha256,
      metadata: args.metadata,
      publishedAt: releaseStatus === 'published' ? now : undefined,
      updatedAt: now,
    };

    let deliveryPackageReleaseId: Id<'delivery_package_releases'>;
    if (existingRelease) {
      await ctx.db.patch(existingRelease._id, patch);
      deliveryPackageReleaseId = existingRelease._id;
    } else {
      deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
        authUserId: args.authUserId,
        deliveryPackageId: deliveryPackage._id,
        packageId: args.packageId,
        version: args.version,
        channel: args.channel,
        releaseStatus,
        repositoryVisibility,
        signedArtifactId: args.signedArtifactId,
        artifactKey: args.artifactKey,
        unityVersion: args.unityVersion,
        zipSha256: args.zipSha256,
        metadata: args.metadata,
        publishedAt: releaseStatus === 'published' ? now : undefined,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (releaseStatus === 'published') {
      await ctx.db.patch(deliveryPackage._id, {
        status: 'active',
        repositoryVisibility,
        defaultChannel: deliveryPackage.defaultChannel ?? args.channel,
        latestPublishedVersion: args.version,
        latestPublishedAt: now,
        updatedAt: now,
      });
    }

    return {
      deliveryPackageReleaseId,
    };
  },
});

export const updateMaterializedReleaseDigest = internalMutation({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    zipSha256: v.string(),
    sourceKind: v.optional(
      v.union(
        v.literal(BACKSTAGE_VPM_SOURCE_KINDS.unitypackage),
        v.literal(BACKSTAGE_VPM_SOURCE_KINDS.zip)
      )
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!SHA256_HEX_RE.test(args.zipSha256)) {
      throw new ConvexError('zipSha256 must be a lowercase 64-character SHA-256 hex digest.');
    }
    const release = await ctx.db.get(args.deliveryPackageReleaseId);
    if (!release) {
      throw new ConvexError('Delivery package release not found.');
    }
    const releaseMetadata =
      release.metadata && typeof release.metadata === 'object' && !Array.isArray(release.metadata)
        ? { ...(release.metadata as Record<string, unknown>) }
        : {};
    if (args.sourceKind) {
      releaseMetadata[BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_KEY] = args.sourceKind;
      releaseMetadata[BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_KEY] =
        BACKSTAGE_VPM_DELIVERY_SOURCE_KIND_TRUST_MARKERS.serverDerived;
    }
    await ctx.db.patch(args.deliveryPackageReleaseId, {
      zipSha256: args.zipSha256,
      ...(args.sourceKind ? { metadata: releaseMetadata } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const getDeliveryPackageReleaseById = internalQuery({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('delivery_package_releases'),
      authUserId: v.string(),
      deliveryPackageId: v.id('delivery_packages'),
      packageId: v.string(),
      version: v.string(),
      channel: v.string(),
      zipSha256: v.optional(v.string()),
      signedArtifactId: v.optional(v.id('signed_release_artifacts')),
      artifactKey: v.optional(v.string()),
      metadata: v.optional(v.any()),
    })
  ),
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.deliveryPackageReleaseId);
    if (!release) {
      return null;
    }
    return {
      _id: release._id,
      authUserId: release.authUserId,
      deliveryPackageId: release.deliveryPackageId,
      packageId: release.packageId,
      version: release.version,
      channel: release.channel,
      zipSha256: release.zipSha256,
      signedArtifactId: release.signedArtifactId,
      artifactKey: release.artifactKey,
      metadata: release.metadata,
    };
  },
});

export const listDeliveryPackageReleasesByPackage = internalQuery({
  args: {
    packageId: v.string(),
    version: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
      version: v.string(),
      channel: v.string(),
      releaseStatus: DeliveryPackageReleaseStatusV,
      zipSha256: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const deliveryPackage = await ctx.db
      .query('delivery_packages')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!deliveryPackage) {
      return [];
    }
    const releases = await ctx.db
      .query('delivery_package_releases')
      .withIndex('by_delivery_package', (q) => q.eq('deliveryPackageId', deliveryPackage._id))
      .collect();

    return releases
      .filter((release) => (args.version ? release.version === args.version : true))
      .filter((release) => (args.channel ? release.channel === args.channel : true))
      .map((release) => ({
        deliveryPackageReleaseId: release._id,
        version: release.version,
        channel: release.channel,
        releaseStatus: release.releaseStatus,
        zipSha256: release.zipSha256,
      }))
      .sort((left, right) => right.version.localeCompare(left.version));
  },
});

export const getDeliveryPackageById = internalQuery({
  args: {
    deliveryPackageId: v.id('delivery_packages'),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('delivery_packages'),
      packageName: v.optional(v.string()),
      displayName: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const deliveryPackage = await ctx.db.get(args.deliveryPackageId);
    if (!deliveryPackage) {
      return null;
    }
    return {
      _id: deliveryPackage._id,
      packageName: deliveryPackage.packageName,
      displayName: deliveryPackage.displayName,
    };
  },
});

export const archiveReleaseForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
  },
  returns: v.union(
    v.object({
      archived: v.literal(true),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
    }),
    v.object({
      archived: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    let ownedRelease: Awaited<ReturnType<typeof getOwnedDeliveryPackageRelease>>;
    try {
      ownedRelease = await getOwnedDeliveryPackageRelease(ctx, args);
    } catch (error) {
      if (
        error instanceof ConvexError &&
        (error.message === 'Delivery package not found.' ||
          error.message === 'Delivery package release not found.')
      ) {
        return { archived: false as const, reason: error.message };
      }
      throw error;
    }

    const { deliveryPackage, release, siblingReleases } = ownedRelease;
    const latestRelease = getLatestOwnedDeliveryPackageRelease(siblingReleases);

    if (latestRelease && String(latestRelease._id) === String(release._id)) {
      return {
        archived: false as const,
        reason: CURRENT_RELEASE_ARCHIVE_BLOCKED_REASON,
      };
    }

    const now = Date.now();
    if (release.releaseStatus !== 'revoked' || release.repositoryVisibility !== 'hidden') {
      await ctx.db.patch(release._id, {
        releaseStatus: 'revoked',
        repositoryVisibility: 'hidden',
        updatedAt: now,
      });
    }

    await ctx.db.patch(deliveryPackage._id, {
      updatedAt: now,
    });

    return {
      archived: true as const,
      deliveryPackageReleaseId: release._id,
    };
  },
});

export const deleteReleaseForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
  },
  returns: v.union(
    v.object({
      deleted: v.literal(true),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
    }),
    v.object({
      deleted: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    let ownedRelease: Awaited<ReturnType<typeof getOwnedDeliveryPackageRelease>>;
    try {
      ownedRelease = await getOwnedDeliveryPackageRelease(ctx, args);
    } catch (error) {
      if (
        error instanceof ConvexError &&
        (error.message === 'Delivery package not found.' ||
          error.message === 'Delivery package release not found.')
      ) {
        return { deleted: false as const, reason: error.message };
      }
      throw error;
    }

    const { deliveryPackage, release, siblingReleases } = ownedRelease;
    const remainingReleases = siblingReleases.filter(
      (candidate) => String(candidate._id) !== String(release._id)
    );
    const now = Date.now();
    await deleteOwnedDeliveryPackageRelease(ctx, { release, siblingReleases });
    await ctx.db.patch(deliveryPackage._id, {
      ...buildDeliveryPackagePublicationPatch(remainingReleases),
      updatedAt: now,
    });

    return {
      deleted: true as const,
      deliveryPackageReleaseId: release._id,
    };
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

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

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
    // c74: Validate packageId format, only safe characters, bounded length.
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
        // Different creator claims this namespace, ownership conflict
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
      // Same owner, potentially different publisherId (key rotation), update
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
 * Admin-only: transfer package ownership after identity verification.
 * Records the previous owner for audit purposes.
 */
export const transferPackage = internalMutation({
  args: {
    packageId: v.string(),
    newPublisherId: v.string(),
    newYucpUserId: v.string(),
    transferReason: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing) return { transferred: false, reason: 'not_found' };

    await ctx.db.patch(existing._id, {
      publisherId: args.newPublisherId,
      yucpUserId: args.newYucpUserId,
      transferredFromYucpUserId: existing.yucpUserId,
      transferReason: args.transferReason,
      updatedAt: Date.now(),
    });
    return { transferred: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Product Catalog Queries (public API)
// ─────────────────────────────────────────────────────────────────────────────

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
      all = all.filter((p) => p.provider === args.provider);
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
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
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
    const backstagePackagesByCatalogProduct = await buildBackstagePackageMap(
      ctx,
      args.authUserId,
      data.map((product) => product._id)
    );
    const hasMore = startIndex + limit < all.length;
    const dataWithCapabilities = await Promise.all(
      data.map(async (product) => {
        const deleteBlockedReason = await getProductDeleteBlockedReason(
          ctx,
          args.authUserId,
          product._id
        );
        const status = getCatalogProductWorkspaceStatus(product);
        return {
          ...product,
          status,
          catalogTiers: (catalogTiersByProduct.get(String(product._id)) ?? []).sort((left, right) =>
            left.displayName.localeCompare(right.displayName)
          ),
          backstagePackages: backstagePackagesByCatalogProduct.get(String(product._id)) ?? [],
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

export const getPublicBackstageProductAccessByRef = query({
  args: {
    apiSecret: v.string(),
    creatorRef: v.string(),
    productRef: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      creatorAuthUserId: v.string(),
      creatorSlug: v.optional(v.string()),
      catalogProductId: v.id('product_catalog'),
      productId: v.string(),
      provider: v.string(),
      providerProductRef: v.string(),
      canonicalSlug: v.optional(v.string()),
      displayName: v.optional(v.string()),
      thumbnailUrl: v.optional(v.string()),
      primaryPackageId: v.optional(v.string()),
      primaryPackageName: v.optional(v.string()),
      packageSummaries: v.array(
        v.object({
          packageId: v.string(),
          displayName: v.optional(v.string()),
          latestPublishedVersion: v.optional(v.string()),
          latestReleaseChannel: v.optional(v.string()),
          aliasContract: v.optional(YucpAliasPackageContractV),
        })
      ),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const resolved = await resolveBackstageProductByRef(ctx, args.creatorRef, args.productRef);
    if (!resolved) {
      return null;
    }

    const backstagePackagesByCatalogProduct = await buildBackstagePackageMap(
      ctx,
      resolved.creatorAuthUserId,
      [resolved.product._id]
    );
    const packageSummaries = (
      backstagePackagesByCatalogProduct.get(String(resolved.product._id)) ?? []
    )
      .filter((pkg) => pkg.status === 'active')
      .map((pkg) => ({
        packageId: pkg.packageId,
        displayName: pkg.displayName ?? pkg.packageName,
        latestPublishedVersion: pkg.latestPublishedVersion,
        latestReleaseChannel: pkg.latestRelease?.channel,
        aliasContract: pkg.latestRelease?.aliasContract,
      }));
    const primaryPackage = packageSummaries[0];

    return {
      creatorAuthUserId: resolved.creatorAuthUserId,
      creatorSlug: resolved.creatorProfile?.slug,
      catalogProductId: resolved.product._id,
      productId: resolved.product.productId,
      provider: resolved.product.provider,
      providerProductRef: resolved.product.providerProductRef,
      canonicalSlug: resolved.product.canonicalSlug,
      displayName: resolved.product.displayName,
      thumbnailUrl: resolved.product.thumbnailUrl,
      primaryPackageId: primaryPackage?.packageId,
      primaryPackageName: primaryPackage?.displayName,
      packageSummaries,
    };
  },
});

export const getAuthorizedAliasInstallPlanByRef = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    creatorRef: v.string(),
    productRef: v.string(),
  },
  returns: v.union(v.null(), AuthorizedAliasInstallPlanRecordV),
  handler: async (ctx, args): Promise<AuthorizedAliasInstallPlanRecord | null> => {
    requireApiSecret(args.apiSecret);
    const resolved = await resolveBackstageProductByRef(ctx, args.creatorRef, args.productRef);
    if (!resolved) {
      return null;
    }

    const targetCatalogProductId = String(resolved.product._id);
    const entitledPackages = await listEntitledBackstagePackages(
      ctx,
      args.authUserId,
      args.subjectId
    );
    const packages = entitledPackages.reduce<AuthorizedAliasInstallPlanPackageRecord[]>(
      (acc, pkg) => {
        const latestRelease = pkg.latestRelease;
        if (
          !pkg.catalogProductIds.some(
            (catalogProductId) => String(catalogProductId) === targetCatalogProductId
          ) ||
          latestRelease?.releaseStatus !== 'published' ||
          !latestRelease.aliasContract ||
          !(latestRelease.aliasContract.catalogProductIds?.includes(targetCatalogProductId) ?? true)
        ) {
          return acc;
        }

        acc.push({
          packageId: pkg.packageId,
          displayName: pkg.displayName ?? pkg.packageName,
          version: latestRelease.version,
          channel: latestRelease.channel,
          zipSha256: latestRelease.zipSha256,
          aliasContract: latestRelease.aliasContract,
        });
        return acc;
      },
      []
    );
    if (packages.length === 0) {
      return null;
    }

    return {
      creatorAuthUserId: resolved.creatorAuthUserId,
      creatorSlug: resolved.creatorProfile?.slug,
      providerProductRef: resolved.product.providerProductRef,
      canonicalSlug: resolved.product.canonicalSlug,
      displayName: resolved.product.displayName,
      thumbnailUrl: resolved.product.thumbnailUrl,
      packages,
    };
  },
});

export const archiveProductForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.id('product_catalog'),
  },
  returns: v.union(
    v.object({
      archived: v.literal(true),
      catalogProductId: v.id('product_catalog'),
    }),
    v.object({
      archived: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const product = await requireOwnedCatalogProduct(ctx, args.authUserId, args.catalogProductId);
    if (product.status !== 'hidden') {
      await ctx.db.patch(product._id, {
        status: 'hidden',
        updatedAt: Date.now(),
      });
    }
    return { archived: true as const, catalogProductId: product._id };
  },
});

export const restoreProductForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.id('product_catalog'),
  },
  returns: v.union(
    v.object({
      restored: v.literal(true),
      catalogProductId: v.id('product_catalog'),
    }),
    v.object({
      restored: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const product = await requireOwnedCatalogProduct(ctx, args.authUserId, args.catalogProductId);
    if (product.status === 'hidden') {
      await ctx.db.patch(product._id, {
        status: 'active',
        updatedAt: Date.now(),
      });
    }
    return { restored: true as const, catalogProductId: product._id };
  },
});

export const deleteProductForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    catalogProductId: v.id('product_catalog'),
  },
  returns: v.union(
    v.object({
      deleted: v.literal(true),
      catalogProductId: v.id('product_catalog'),
    }),
    v.object({
      deleted: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const product = await requireOwnedCatalogProduct(ctx, args.authUserId, args.catalogProductId);
    const deleteBlockedReason = await getProductDeleteBlockedReason(
      ctx,
      args.authUserId,
      product._id
    );
    if (deleteBlockedReason) {
      return { deleted: false as const, reason: deleteBlockedReason };
    }

    const catalogLinks = await ctx.db
      .query('catalog_product_links')
      .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', product._id))
      .collect();
    await Promise.all(catalogLinks.map((link) => ctx.db.delete(link._id)));
    await ctx.db.delete(product._id);
    return { deleted: true as const, catalogProductId: product._id };
  },
});

export const listForAuthUser = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    includeArchived: v.optional(v.boolean()),
  },
  returns: v.object({
    packages: v.array(
      v.object({
        packageId: v.string(),
        packageName: v.optional(v.string()),
        registeredAt: v.number(),
        updatedAt: v.number(),
        status: v.union(v.literal('active'), v.literal('archived')),
        archivedAt: v.optional(v.number()),
        canDelete: v.boolean(),
        deleteBlockedReason: v.optional(v.string()),
        canArchive: v.boolean(),
        canRestore: v.boolean(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const rows = (
      await ctx.db
        .query('package_registry')
        .withIndex('by_yucp_user_id', (q) => q.eq('yucpUserId', args.authUserId))
        .collect()
    ).filter((row) => args.includeArchived || !isArchivedRegistration(row));

    const packages = await Promise.all(
      rows.map(async (row) => {
        const status = getPackageStatus(row);
        const signingLog = await ctx.db
          .query('signing_log')
          .withIndex('by_package_id', (q) => q.eq('packageId', row.packageId))
          .first();
        const protectedAsset = signingLog
          ? null
          : await ctx.db
              .query('protected_assets')
              .withIndex('by_package_id', (q) => q.eq('packageId', row.packageId))
              .first();
        const couplingTrace =
          signingLog || protectedAsset
            ? null
            : await ctx.db
                .query('coupling_trace_records')
                .withIndex('by_package_token', (q) => q.eq('packageId', row.packageId))
                .first();
        const protectedUnlock =
          signingLog || protectedAsset || couplingTrace
            ? null
            : await ctx.db
                .query('protected_asset_unlocks')
                .withIndex('by_package_asset_machine_project', (q) =>
                  q.eq('packageId', row.packageId)
                )
                .first();
        const deleteBlockedReason =
          signingLog || protectedAsset || couplingTrace || protectedUnlock
            ? PACKAGE_DELETE_BLOCKED_REASON
            : undefined;
        return {
          packageId: row.packageId,
          packageName: row.packageName,
          registeredAt: row.registeredAt,
          updatedAt: row.updatedAt,
          status,
          archivedAt: row.archivedAt,
          canDelete: deleteBlockedReason === undefined,
          deleteBlockedReason,
          canArchive: status === 'active',
          canRestore: status === 'archived',
        };
      })
    );

    return {
      packages: packages.sort((left, right) => {
        const leftLabel = (left.packageName ?? left.packageId).toLowerCase();
        const rightLabel = (right.packageName ?? right.packageId).toLowerCase();
        return leftLabel.localeCompare(rightLabel) || left.packageId.localeCompare(right.packageId);
      }),
    };
  },
});

export const renameForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
    packageName: v.string(),
  },
  returns: v.union(
    v.object({
      updated: v.literal(true),
      packageId: v.string(),
      packageName: v.string(),
    }),
    v.object({
      updated: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);
    const normalizedPackageName = normalizePackageName(args.packageName);
    if (!normalizedPackageName) {
      return { updated: false as const, reason: 'Package name is required.' };
    }

    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing || existing.yucpUserId !== args.authUserId) {
      return { updated: false as const, reason: 'Package not found.' };
    }
    if (isArchivedRegistration(existing)) {
      return {
        updated: false as const,
        reason: PACKAGE_ARCHIVED_UPDATE_BLOCKED_REASON,
      };
    }

    await ctx.db.patch(existing._id, {
      packageName: normalizedPackageName,
      updatedAt: Date.now(),
    });

    return {
      updated: true as const,
      packageId: args.packageId,
      packageName: normalizedPackageName,
    };
  },
});

export const archiveForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.union(
    v.object({
      archived: v.literal(true),
      packageId: v.string(),
    }),
    v.object({
      archived: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing || existing.yucpUserId !== args.authUserId) {
      return { archived: false as const, reason: 'Package not found.' };
    }

    if (!isArchivedRegistration(existing)) {
      await ctx.db.patch(existing._id, {
        status: 'archived',
        archivedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return { archived: true as const, packageId: args.packageId };
  },
});

export const restoreForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.union(
    v.object({
      restored: v.literal(true),
      packageId: v.string(),
    }),
    v.object({
      restored: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing || existing.yucpUserId !== args.authUserId) {
      return { restored: false as const, reason: 'Package not found.' };
    }

    if (isArchivedRegistration(existing)) {
      await ctx.db.patch(existing._id, {
        status: 'active',
        archivedAt: undefined,
        updatedAt: Date.now(),
      });
    }

    return { restored: true as const, packageId: args.packageId };
  },
});

export const deleteForAuthUser = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.union(
    v.object({
      deleted: v.literal(true),
      packageId: v.string(),
    }),
    v.object({
      deleted: v.literal(false),
      reason: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.authUserId);

    const existing = await ctx.db
      .query('package_registry')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (!existing || existing.yucpUserId !== args.authUserId) {
      return { deleted: false as const, reason: 'Package not found.' };
    }

    const signingLog = await ctx.db
      .query('signing_log')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (signingLog) {
      return { deleted: false as const, reason: PACKAGE_DELETE_BLOCKED_REASON };
    }

    const protectedAsset = await ctx.db
      .query('protected_assets')
      .withIndex('by_package_id', (q) => q.eq('packageId', args.packageId))
      .first();
    if (protectedAsset) {
      return { deleted: false as const, reason: PACKAGE_DELETE_BLOCKED_REASON };
    }

    const couplingTrace = await ctx.db
      .query('coupling_trace_records')
      .withIndex('by_package_token', (q) => q.eq('packageId', args.packageId))
      .first();
    if (couplingTrace) {
      return { deleted: false as const, reason: PACKAGE_DELETE_BLOCKED_REASON };
    }

    const protectedUnlock = await ctx.db
      .query('protected_asset_unlocks')
      .withIndex('by_package_asset_machine_project', (q) => q.eq('packageId', args.packageId))
      .first();
    if (protectedUnlock) {
      return { deleted: false as const, reason: PACKAGE_DELETE_BLOCKED_REASON };
    }

    await ctx.db.delete(existing._id);
    return { deleted: true as const, packageId: args.packageId };
  },
});

/**
 * Get a single product_catalog entry by ID, scoped to authUserId.
 */
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
    const backstagePackagesByCatalogProduct = await buildBackstagePackageMap(ctx, args.authUserId, [
      args.catalogProductId,
    ]);
    const catalogTiers = await ctx.db
      .query('catalog_tiers')
      .withIndex('by_catalog_product', (q) => q.eq('catalogProductId', args.catalogProductId))
      .collect();
    return {
      ...doc,
      catalogTiers,
      backstagePackages: backstagePackagesByCatalogProduct.get(String(doc._id)) ?? [],
    };
  },
});

export const getBuyerAccessContextByCatalogProductId = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    catalogProductId: v.id('product_catalog'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireApiActor(args.actor);

    const product = await ctx.db.get(args.catalogProductId);
    if (!product) {
      return null;
    }

    const status = getCatalogProductWorkspaceStatus(product);
    if (status !== 'active') {
      return null;
    }

    const backstagePackagesByCatalogProduct = await buildBackstagePackageMap(
      ctx,
      product.authUserId,
      [args.catalogProductId]
    );
    const backstagePackages =
      backstagePackagesByCatalogProduct
        .get(String(product._id))
        ?.sort(compareBackstagePackages)
        .map((packageLink) => ({
          packageId: packageLink.packageId,
          packageName: packageLink.packageName,
          displayName: packageLink.displayName,
          defaultChannel: packageLink.defaultChannel,
          latestPublishedVersion: packageLink.latestPublishedVersion,
          latestPublishedAt: packageLink.latestPublishedAt,
          repositoryVisibility: packageLink.repositoryVisibility,
        })) ?? [];

    return {
      catalogProductId: product._id,
      creatorAuthUserId: product.authUserId,
      productId: product.productId,
      provider: product.provider,
      providerProductRef: product.providerProductRef,
      displayName: product.displayName,
      canonicalSlug: product.canonicalSlug,
      thumbnailUrl: product.thumbnailUrl,
      status,
      backstagePackages,
    };
  },
});

export const listEntitledPackagesForSubject = internalQuery({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
  },
  handler: async (ctx, args) => {
    return await listEntitledBackstagePackages(ctx, args.authUserId, args.subjectId);
  },
});

export const buildBackstageRepositoryForSubject = internalQuery({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    repositoryUrl: v.string(),
    packageBaseUrl: v.string(),
    packageHeaders: v.optional(v.record(v.string(), v.string())),
    repositoryName: v.optional(v.string()),
    repositoryId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const entitledPackages = await listEntitledBackstagePackages(
      ctx,
      args.authUserId,
      args.subjectId
    );
    const packages = entitledPackages.reduce<Record<string, { versions: Record<string, unknown> }>>(
      (acc, packageSummary) => {
        const manifest = toVpmVersionManifest(
          packageSummary,
          args.packageBaseUrl,
          args.packageHeaders
        );
        if (!manifest || !packageSummary.latestRelease) {
          return acc;
        }
        acc[packageSummary.packageId] = {
          versions: {
            [packageSummary.latestRelease.version]: manifest,
          },
        };
        return acc;
      },
      {}
    );

    return {
      name: args.repositoryName ?? 'Backstage Repos',
      author: 'YUCP',
      id: args.repositoryId ?? `club.yucp.backstage.${args.authUserId}`,
      url: args.repositoryUrl,
      packages,
    };
  },
});

export const getEntitledPackageReleaseForSubject = internalQuery({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    packageId: v.string(),
    version: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
      deliveryPackageId: v.id('delivery_packages'),
      packageId: v.string(),
      version: v.string(),
      channel: v.string(),
      artifactKey: v.optional(v.string()),
      signedArtifactId: v.optional(v.id('signed_release_artifacts')),
      zipSha256: v.optional(v.string()),
      repositoryVisibility: DeliveryPackageVisibilityV,
    })
  ),
  handler: async (ctx, args) => {
    const entitledPackages = await listEntitledBackstagePackages(
      ctx,
      args.authUserId,
      args.subjectId
    );
    const entitledPackage = entitledPackages.find((entry) => entry.packageId === args.packageId);
    if (!entitledPackage) {
      return null;
    }

    const releases = await ctx.db
      .query('delivery_package_releases')
      .withIndex('by_delivery_package', (q) =>
        q.eq('deliveryPackageId', entitledPackage.deliveryPackageId)
      )
      .collect();
    const matchingRelease = releases
      .filter((release) => release.releaseStatus === 'published')
      .filter((release) => (args.version ? release.version === args.version : true))
      .filter((release) => (args.channel ? release.channel === args.channel : true))
      .sort(compareReleaseRecency)[0];

    if (!matchingRelease) {
      return null;
    }

    return {
      deliveryPackageReleaseId: matchingRelease._id,
      deliveryPackageId: entitledPackage.deliveryPackageId,
      packageId: matchingRelease.packageId,
      version: matchingRelease.version,
      channel: matchingRelease.channel,
      artifactKey: matchingRelease.artifactKey,
      signedArtifactId: matchingRelease.signedArtifactId,
      zipSha256: matchingRelease.zipSha256,
      repositoryVisibility: matchingRelease.repositoryVisibility,
    };
  },
});

export const resolveDownloadableArtifactForRelease = internalQuery({
  args: DownloadablePackageReleaseRecordV,
  returns: v.union(v.null(), BackstagePackageDownloadRecordV),
  handler: async (ctx, args): Promise<BackstagePackageDownloadRecord | null> => {
    return await resolveDownloadableArtifactForReleaseRecord(ctx, args);
  },
});

export const getResolvedEntitledPackageDownloadForSubject = internalQuery({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    packageId: v.string(),
    version: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  returns: v.union(v.null(), BackstagePackageDownloadRecordV),
  handler: async (ctx, args): Promise<BackstagePackageDownloadRecord | null> => {
    const release = await ctx.runQuery(
      internal.packageRegistry.getEntitledPackageReleaseForSubject,
      {
        authUserId: args.authUserId,
        subjectId: args.subjectId,
        packageId: args.packageId,
        version: args.version,
        channel: args.channel,
      }
    );

    return await resolveDownloadableArtifactForReleaseRecord(
      ctx,
      release as DownloadablePackageReleaseRecord | null
    );
  },
});
