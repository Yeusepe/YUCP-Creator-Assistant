import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  buildCatalogProductUrl,
  CATALOG_SYNC_PROVIDER_KEYS,
  getProviderDescriptor,
} from '@yucp/providers/providerMetadata';
import {
  mergeYucpAliasPackageMetadata,
  type PublicApiScope,
  type YucpAliasPackageContract,
} from '@yucp/shared';
import type { ApiActorBinding } from '@yucp/shared/apiActor';
import {
  BACKSTAGE_PACKAGE_MEDIA_KINDS,
  type BackstagePackageMediaKind,
  type BackstagePackageMediaReference,
} from '@yucp/shared/backstagePackageMedia';
import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import { prepareBackstageArtifactDescriptorForPublish } from '@yucp/shared/backstageVpmPackage';
import {
  type CdngineBackstageDeliveryReference,
  type CdngineBackstageSourceReference,
  isCdngineBackstageSourceReference,
} from '@yucp/shared/cdngineBackstageDelivery';
import { legacyProductIdsToSelectors, normalizeProductSelectorList } from '@yucp/shared/product';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { listProviderProductsViaApi, listProviderTiersViaApi } from '../internalRpc/router';
import { createAuthUserActorBinding } from '../lib/apiActor';
import { buildBackstageImporterDelivery } from '../lib/backstageImporterDelivery';
import { buildBackstageRepositoryUrls, getCreatorRepoIdentity } from '../lib/backstageRepoIdentity';
import {
  authorizeCdngineBackstageSource,
  buildBackstageAddRepoUrl,
  CdngineApiRequestError,
  type CdngineBackstageConfig,
  completeBackstageUploadSessionInCdngine,
  createBackstageUploadSessionInCdngine,
  fetchWithTimeout,
  getAllowedOrigins,
  hasCdngineErrorMessage,
  isRecord,
  jsonResponse,
  requireCdngineBackstageConfig,
  sanitizeCdngineObjectKeySegment,
  sha256ArrayBuffer,
  uploadBackstageBytesToCdngine,
  waitForCdngineBackstageDeliveryPublication,
} from '../lib/cdngineBackstage';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { verifyBetterAuthAccessToken } from '../lib/oauthAccessToken';
import { readBoundedArrayBuffer, readContentLength } from '../lib/readBoundedArrayBuffer';
import { MAX_BACKSTAGE_PACKAGE_BYTES } from '../lib/requestBodyLimits';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const BACKSTAGE_UPLOAD_COMPLETION_TOKEN_HEADER = 'X-YUCP-Upload-Completion-Token';
const BACKSTAGE_REPO_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_BACKSTAGE_LIVE_SYNC_TIMEOUT_MS = 1_500;
const MAX_BACKSTAGE_PACKAGE_MEDIA_BYTES = 5 * 1024 * 1024;
const MAX_BACKSTAGE_IN_PROCESS_MATERIALIZATION_BYTES = 256 * 1024 * 1024;
const BACKSTAGE_PACKAGE_MEDIA_CONTENT_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export type PackagesConfig = {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexSiteUrl: string;
  convexUrl: string;
  cdngine?: CdngineBackstageConfig;
};

type BackstageUploadTokenPayload = {
  authUserId: string;
  exp: number;
  packageId: string;
};

type BackstageUploadCompletionTokenPayload = BackstageUploadTokenPayload & {
  uploadAttemptId?: string;
  byteSize: number;
  deliveryName: string;
  kind: 'backstage-upload-complete';
  objectKey: string;
  sha256: string;
  sourceContentType: string;
  uploadSessionId: string;
};

type BackstageProductQueryResult = {
  data: Array<{
    _id: string;
    aliases?: string[];
    canonicalSlug: string;
    displayName: string;
    thumbnailUrl?: string;
    productId: string;
    provider: string;
    providerProductRef: string;
    status: string;
    supportsAutoDiscovery: boolean;
    updatedAt: number;
    canArchive?: boolean;
    canRestore?: boolean;
    canDelete?: boolean;
    deleteBlockedReason?: string;
    catalogTiers?: Array<{
      _id: string;
      catalogProductId?: string;
      provider: string;
      providerTierRef: string;
      displayName: string;
      description?: string;
      amountCents?: number;
      currency?: string;
      status: string;
      metadata?: unknown;
      createdAt: number;
      updatedAt: number;
    }>;
    backstagePackages?: Array<{
      packageId: string;
      packageName?: string;
      displayName?: string;
      status: string;
      repositoryVisibility: 'hidden' | 'listed';
      defaultChannel?: string;
      latestPublishedVersion?: string;
      latestRelease: null | {
        deliveryPackageReleaseId: string;
        version: string;
        channel: string;
        releaseStatus: string;
        repositoryVisibility: 'hidden' | 'listed';
        artifactKey?: string;
        contentType?: string;
        createdAt: number;
        deliveryName?: string;
        metadata?: unknown;
        aliasContract?: YucpAliasPackageContract;
        publishedAt?: number;
        unityVersion?: string;
        updatedAt: number;
        zipSha256?: string;
      };
      releases: Array<{
        deliveryPackageReleaseId: string;
        version: string;
        channel: string;
        releaseStatus: string;
        repositoryVisibility: 'hidden' | 'listed';
        artifactKey?: string;
        contentType?: string;
        createdAt: number;
        deliveryName?: string;
        metadata?: unknown;
        aliasContract?: YucpAliasPackageContract;
        publishedAt?: number;
        unityVersion?: string;
        updatedAt: number;
        zipSha256?: string;
      }>;
    }>;
  }>;
};

type BackstageProductQueryRow = BackstageProductQueryResult['data'][number];
type LiveProviderProduct = Awaited<ReturnType<typeof listProviderProductsViaApi>>['products'];
type LiveProviderProductRecord = NonNullable<LiveProviderProduct>[number];
type LiveProviderTier = Awaited<ReturnType<typeof listProviderTiersViaApi>>['tiers'];
type LiveProviderTierRecord = NonNullable<LiveProviderTier>[number];
type BackstageProductMetadataOverride = {
  displayName?: string;
  thumbnailUrl?: string;
};
type BackstageProductIdentityPayload = BackstageProductMetadataOverride & {
  canonicalSlug?: string;
  aliases?: string[];
};
type BackstageCatalogTierRow = NonNullable<BackstageProductQueryRow['catalogTiers']>[number];
type BackstagePackageReleaseRow = NonNullable<
  BackstageProductQueryRow['backstagePackages']
>[number]['releases'][number];

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

class BackstageLiveSyncTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'BackstageLiveSyncTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

class BackstageSourceMaterializationLimitError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super('Backstage source exceeds the in-process publish limit');
    this.name = 'BackstageSourceMaterializationLimitError';
    this.limitBytes = limitBytes;
  }
}

class BackstagePackageMediaLimitError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super('Backstage package media exceeds the maximum allowed size');
    this.name = 'BackstagePackageMediaLimitError';
    this.limitBytes = limitBytes;
  }
}

function isCdngineBackstageDependencyError(error: unknown): boolean {
  return (
    error instanceof CdngineApiRequestError ||
    isFetchAbortOrTimeoutError(error) ||
    hasCdngineErrorMessage(error)
  );
}

function isFetchAbortOrTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const name = error.name.trim().toLowerCase();
  if (name === 'aborterror' || name === 'timeouterror') {
    return true;
  }
  const message = error.message.trim().toLowerCase();
  return message.includes('aborted') || message.includes('timed out');
}

function cdngineBackstageUnavailableResponse(error: string): Response {
  return jsonResponse({ error }, 502);
}

function getCdngineSourceOwnershipError(input: {
  authUserId: string;
  expectedServiceNamespaceId: string;
  source: CdngineBackstageSourceReference;
}): string | null {
  if (input.source.assetOwner !== `creator:${input.authUserId}`) {
    return 'CDNgine source is not owned by this creator';
  }
  if (input.source.tenantId !== input.authUserId) {
    return 'CDNgine source is not owned by this creator';
  }
  if (input.source.serviceNamespaceId !== input.expectedServiceNamespaceId) {
    return 'CDNgine source is not owned by this creator';
  }
  return null;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function trimTrailingForwardSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function signBackstageUploadToken(payload: BackstageUploadTokenPayload, secret: string): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifyBackstageUploadToken(
  token: string,
  secret: string
): BackstageUploadTokenPayload | null {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }
  const expected = createHmac('sha256', secret).update(encodedPayload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    return null;
  }
  let payload: BackstageUploadTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as BackstageUploadTokenPayload;
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.authUserId !== 'string' ||
    typeof payload.packageId !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp < Date.now()
  ) {
    return null;
  }
  return payload;
}

function signBackstageUploadCompletionToken(
  payload: BackstageUploadCompletionTokenPayload,
  secret: string
): string {
  return signBackstageUploadToken(payload, secret);
}

function verifyBackstageUploadCompletionToken(
  token: string,
  secret: string
): BackstageUploadCompletionTokenPayload | null {
  const payload = verifyBackstageUploadToken(token, secret);
  if (
    !payload ||
    (payload as Partial<BackstageUploadCompletionTokenPayload>).kind !==
      'backstage-upload-complete' ||
    typeof (payload as Partial<BackstageUploadCompletionTokenPayload>).uploadSessionId !==
      'string' ||
    typeof (payload as Partial<BackstageUploadCompletionTokenPayload>).objectKey !== 'string' ||
    typeof (payload as Partial<BackstageUploadCompletionTokenPayload>).deliveryName !== 'string' ||
    typeof (payload as Partial<BackstageUploadCompletionTokenPayload>).sourceContentType !==
      'string' ||
    typeof (payload as Partial<BackstageUploadCompletionTokenPayload>).sha256 !== 'string' ||
    typeof (payload as Partial<BackstageUploadCompletionTokenPayload>).byteSize !== 'number'
  ) {
    return null;
  }
  return payload as BackstageUploadCompletionTokenPayload;
}

function buildBackstageSourceUploadIdempotencyBase(input: {
  authUserId: string;
  packageId: string;
  sha256: string;
  uploadAttemptId: string;
}): string {
  return `backstage-source:${input.authUserId}:${input.packageId}:${input.sha256}:${input.uploadAttemptId}`;
}

function getBackstageLiveSyncTimeoutMs(): number {
  const configured = process.env.BACKSTAGE_LIVE_SYNC_TIMEOUT_MS?.trim();
  if (!configured) {
    return DEFAULT_BACKSTAGE_LIVE_SYNC_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_BACKSTAGE_LIVE_SYNC_TIMEOUT_MS;
  }

  return parsed;
}

async function withBackstageLiveSyncTimeout<T>(
  operation: string,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = getBackstageLiveSyncTimeoutMs();
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new BackstageLiveSyncTimeoutError(operation, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function decodeOptionalHeaderValue(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return null;
  }
}

function normalizeBackstagePackageMediaKind(
  value: string | null
): BackstagePackageMediaKind | null {
  const normalized = value?.trim();
  if (normalized === BACKSTAGE_PACKAGE_MEDIA_KINDS.banner) {
    return BACKSTAGE_PACKAGE_MEDIA_KINDS.banner;
  }
  if (normalized === BACKSTAGE_PACKAGE_MEDIA_KINDS.icon) {
    return BACKSTAGE_PACKAGE_MEDIA_KINDS.icon;
  }
  return null;
}

function normalizePackageMediaContentType(contentType: string | null): string | null {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase();
  if (!normalized || !BACKSTAGE_PACKAGE_MEDIA_CONTENT_TYPES.has(normalized)) {
    return null;
  }
  return normalized;
}

function assertPackageId(packageId: string): string {
  const normalized = decodeURIComponent(packageId).trim();
  if (!PACKAGE_ID_RE.test(normalized)) {
    throw new Error('Invalid packageId format');
  }
  return normalized;
}

function buildBackstageProductRecordKey(provider: string, providerProductRef: string): string {
  return `${provider.trim().toLowerCase()}:${providerProductRef.trim()}`;
}

function buildLiveProductMetadataOverride(
  product: LiveProviderProductRecord
): BackstageProductMetadataOverride | null {
  const displayName = product.name?.trim();
  const thumbnailUrl = product.thumbnailUrl?.trim();
  if (!displayName && !thumbnailUrl) {
    return null;
  }
  return {
    ...(displayName ? { displayName } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function normalizeLiveProductIdentityString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeLiveProductAliases(aliases?: readonly string[] | null): string[] | undefined {
  if (!aliases?.length) {
    return undefined;
  }

  const normalizedAliases: string[] = [];
  const seen = new Set<string>();
  for (const alias of aliases) {
    const normalizedAlias = normalizeLiveProductIdentityString(alias);
    if (!normalizedAlias || seen.has(normalizedAlias)) {
      continue;
    }
    seen.add(normalizedAlias);
    normalizedAliases.push(normalizedAlias);
  }

  return normalizedAliases.length > 0 ? normalizedAliases : undefined;
}

function buildLiveProductIdentityPayload(
  product: LiveProviderProductRecord
): BackstageProductIdentityPayload {
  return {
    ...(buildLiveProductMetadataOverride(product) ?? {}),
    ...(normalizeLiveProductIdentityString(product.canonicalSlug)
      ? { canonicalSlug: normalizeLiveProductIdentityString(product.canonicalSlug) }
      : {}),
    ...(normalizeLiveProductAliases(product.aliases)
      ? { aliases: normalizeLiveProductAliases(product.aliases) }
      : {}),
  };
}

function areLiveProductAliasesEqual(left?: readonly string[], right?: readonly string[]): boolean {
  const normalizedLeft = normalizeLiveProductAliases(left);
  const normalizedRight = normalizeLiveProductAliases(right);
  if (!normalizedLeft && !normalizedRight) {
    return true;
  }
  if (!normalizedLeft || !normalizedRight || normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function shouldUpsertLiveProduct(args: {
  existingProduct?: BackstageProductQueryRow;
  livePayload: BackstageProductIdentityPayload;
}): boolean {
  const { existingProduct, livePayload } = args;
  if (!existingProduct) {
    return true;
  }

  return (
    (livePayload.displayName !== undefined &&
      existingProduct.displayName !== livePayload.displayName) ||
    (livePayload.thumbnailUrl !== undefined &&
      existingProduct.thumbnailUrl !== livePayload.thumbnailUrl) ||
    (livePayload.canonicalSlug !== undefined &&
      existingProduct.canonicalSlug !== livePayload.canonicalSlug) ||
    (livePayload.aliases !== undefined &&
      !areLiveProductAliasesEqual(existingProduct.aliases, livePayload.aliases))
  );
}

function decodeHtmlEntity(entity: string): string {
  const named = HTML_ENTITY_REPLACEMENTS[entity];
  if (named) {
    return named;
  }

  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const parsed = Number.parseInt(entity.slice(2), 16);
    return decodeHtmlCodePoint(parsed, entity);
  }

  if (entity.startsWith('#')) {
    const parsed = Number.parseInt(entity.slice(1), 10);
    return decodeHtmlCodePoint(parsed, entity);
  }

  return `&${entity};`;
}

function decodeHtmlCodePoint(parsed: number, entity: string): string {
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > 0x10ffff ||
    (parsed >= 0xd800 && parsed <= 0xdfff)
  ) {
    return `&${entity};`;
  }

  return String.fromCodePoint(parsed);
}

function normalizeRichTextToPlainText(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const plainText = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([^;]+);/g, (_, entity: string) => decodeHtmlEntity(entity))
    .replace(/\s+/g, ' ')
    .trim();

  return plainText || undefined;
}

function normalizeBackstageMetadataInput(input: {
  metadata?: unknown;
  dependencyVersions?: Array<{ packageId: string; version: string }>;
}): Record<string, unknown> | undefined {
  if (input.metadata != null && !isRecord(input.metadata)) {
    throw new Error('metadata must be an object when provided.');
  }
  const baseMetadata: Record<string, unknown> = input.metadata ? { ...input.metadata } : {};
  if (!input.dependencyVersions?.length) {
    return Object.keys(baseMetadata).length > 0 ? baseMetadata : undefined;
  }

  const mergedDependencies = {
    ...(isRecord(baseMetadata.vpmDependencies) ? baseMetadata.vpmDependencies : {}),
    ...(isRecord(baseMetadata.dependencies) ? baseMetadata.dependencies : {}),
    ...Object.fromEntries(
      input.dependencyVersions.map((dependency) => [dependency.packageId, dependency.version])
    ),
  };

  const { dependencies: _legacyDependencies, ...metadataWithoutLegacyDependencies } = baseMetadata;
  return {
    ...metadataWithoutLegacyDependencies,
    vpmDependencies: mergedDependencies,
  };
}

function normalizeAmountCents(value: bigint | number | null | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : undefined;
  }
  return undefined;
}

function resolveLiveTierStatus(
  tier: LiveProviderTierRecord,
  existingTier?: BackstageCatalogTierRow
): 'active' | 'archived' {
  if (tier.active === true) {
    return 'active';
  }
  if (tier.active === false) {
    return 'archived';
  }
  return existingTier?.status === 'archived' ? 'archived' : 'active';
}

function shouldUpsertLiveTier(args: {
  existingTier?: BackstageCatalogTierRow;
  liveTier: LiveProviderTierRecord;
}): boolean {
  const { existingTier, liveTier } = args;
  if (!existingTier) {
    return true;
  }

  const nextDescription = normalizeRichTextToPlainText(liveTier.description);
  const nextAmountCents = normalizeAmountCents(liveTier.amountCents);
  const nextCurrency = liveTier.currency?.trim();
  const nextStatus = resolveLiveTierStatus(liveTier, existingTier);

  return (
    existingTier.displayName !== (liveTier.name?.trim() || existingTier.displayName) ||
    existingTier.description !== nextDescription ||
    existingTier.amountCents !== nextAmountCents ||
    existingTier.currency !== nextCurrency ||
    existingTier.status !== nextStatus
  );
}

async function getConnectedCatalogProviders(args: {
  convex: ReturnType<typeof getConvexClientFromUrl>;
  config: PackagesConfig;
  authUserId: string;
}): Promise<string[]> {
  const connectionStatus = (await args.convex.query(api.providerConnections.getConnectionStatus, {
    apiSecret: args.config.convexApiSecret,
    authUserId: args.authUserId,
  })) as Record<string, boolean>;

  return CATALOG_SYNC_PROVIDER_KEYS.filter((providerKey) => connectionStatus[providerKey]);
}

function mapBackstageProductForResponse(
  product: BackstageProductQueryRow,
  override?: BackstageProductMetadataOverride
) {
  const mapBackstageReleaseForResponse = (release: BackstagePackageReleaseRow) => ({
    deliveryPackageReleaseId: release.deliveryPackageReleaseId,
    version: release.version,
    channel: release.channel,
    releaseStatus: release.releaseStatus,
    repositoryVisibility: release.repositoryVisibility,
    artifactKey: release.artifactKey,
    contentType: release.contentType,
    createdAt: release.createdAt,
    deliveryName: release.deliveryName,
    metadata: release.metadata,
    aliasContract: release.aliasContract,
    importerDelivery: buildBackstageImporterDelivery(release.aliasContract),
    publishedAt: release.publishedAt,
    unityVersion: release.unityVersion,
    updatedAt: release.updatedAt,
    zipSha256: release.zipSha256,
  });

  return {
    aliases: product.aliases ?? [],
    catalogTiers: (product.catalogTiers ?? []).map((tier) => ({
      catalogTierId: String(tier._id),
      catalogProductId: tier.catalogProductId ? String(tier.catalogProductId) : undefined,
      provider: tier.provider,
      providerTierRef: tier.providerTierRef,
      displayName: tier.displayName,
      description: normalizeRichTextToPlainText(tier.description),
      amountCents: tier.amountCents,
      currency: tier.currency,
      status: tier.status,
      metadata: tier.metadata,
      createdAt: tier.createdAt,
      updatedAt: tier.updatedAt,
    })),
    backstagePackages: (product.backstagePackages ?? []).map((pkg) => ({
      packageId: pkg.packageId,
      packageName: pkg.packageName,
      displayName: pkg.displayName,
      status: pkg.status,
      repositoryVisibility: pkg.repositoryVisibility,
      defaultChannel: pkg.defaultChannel,
      latestPublishedVersion: pkg.latestPublishedVersion,
      latestRelease: pkg.latestRelease ? mapBackstageReleaseForResponse(pkg.latestRelease) : null,
      releases: (pkg.releases ?? []).map(mapBackstageReleaseForResponse),
    })),
    canonicalSlug: product.canonicalSlug,
    catalogProductId: String(product._id),
    displayName: override?.displayName ?? product.displayName,
    thumbnailUrl: override?.thumbnailUrl ?? product.thumbnailUrl,
    productId: product.productId,
    provider: product.provider,
    providerProductRef: product.providerProductRef,
    status: product.status,
    supportsAutoDiscovery: product.supportsAutoDiscovery,
    updatedAt: product.updatedAt,
    canArchive: product.canArchive ?? product.status === 'active',
    canRestore: product.canRestore ?? product.status === 'archived',
    canDelete: product.canDelete ?? false,
    deleteBlockedReason: product.deleteBlockedReason,
  };
}

async function reconcileBackstageCatalogFromConnectedProviders(args: {
  connectedCatalogProviders: string[];
  convex: ReturnType<typeof getConvexClientFromUrl>;
  config: PackagesConfig;
  authUserId: string;
  existingProducts: BackstageProductQueryRow[];
}): Promise<{ refreshCatalog: boolean; overrides: Map<string, BackstageProductMetadataOverride> }> {
  if (args.connectedCatalogProviders.length === 0) {
    return { refreshCatalog: false, overrides: new Map() };
  }

  const providerResults = await Promise.all(
    args.connectedCatalogProviders.map(async (provider) => {
      const existingProductsByKey = new Map(
        args.existingProducts
          .filter((product) => product.provider === provider)
          .map(
            (product) =>
              [
                buildBackstageProductRecordKey(product.provider, product.providerProductRef),
                product,
              ] as const
          )
      );
      const providerOverrides = new Map<string, BackstageProductMetadataOverride>();
      let refreshCatalog = false;

      try {
        const liveProducts = await withBackstageLiveSyncTimeout(
          `Backstage ${provider} product sync`,
          (signal) =>
            listProviderProductsViaApi(
              {
                apiBaseUrl: args.config.apiBaseUrl,
                convexApiSecret: args.config.convexApiSecret,
              },
              {
                authUserId: args.authUserId,
                provider,
              },
              undefined,
              { signal }
            )
        );

        for (const liveProduct of liveProducts.products ?? []) {
          const providerProductRef = liveProduct.id?.trim();
          if (!providerProductRef) {
            continue;
          }

          const productKey = buildBackstageProductRecordKey(provider, providerProductRef);
          const livePayload = buildLiveProductIdentityPayload(liveProduct);
          if (livePayload.displayName || livePayload.thumbnailUrl) {
            providerOverrides.set(productKey, {
              ...(livePayload.displayName ? { displayName: livePayload.displayName } : {}),
              ...(livePayload.thumbnailUrl ? { thumbnailUrl: livePayload.thumbnailUrl } : {}),
            });
          }

          if (
            !shouldUpsertLiveProduct({
              existingProduct: existingProductsByKey.get(productKey),
              livePayload,
            })
          ) {
            continue;
          }

          const canonicalUrl =
            liveProduct.productUrl?.trim() ?? buildCatalogProductUrl(provider, providerProductRef);
          if (!canonicalUrl) {
            logger.warn('Skipping Backstage provider product without canonical URL', {
              authUserId: args.authUserId,
              provider,
              providerProductRef,
            });
            continue;
          }

          await args.convex.mutation(api.role_rules.addCatalogProduct, {
            apiSecret: args.config.convexApiSecret,
            authUserId: args.authUserId,
            productId: providerProductRef,
            providerProductRef,
            provider,
            canonicalUrl,
            supportsAutoDiscovery: getProviderDescriptor(provider)?.supportsAutoDiscovery ?? false,
            ...(livePayload.displayName ? { displayName: livePayload.displayName } : {}),
            ...(livePayload.thumbnailUrl ? { thumbnailUrl: livePayload.thumbnailUrl } : {}),
            ...(livePayload.canonicalSlug ? { canonicalSlug: livePayload.canonicalSlug } : {}),
            ...(livePayload.aliases ? { aliases: livePayload.aliases } : {}),
          });
          refreshCatalog = true;
        }
      } catch (error) {
        logger.warn('Failed to reconcile Backstage provider products from live catalog', {
          authUserId: args.authUserId,
          provider,
          timeoutMs: error instanceof BackstageLiveSyncTimeoutError ? error.timeoutMs : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return {
        refreshCatalog,
        overrides: [...providerOverrides.entries()] as Array<
          readonly [string, BackstageProductMetadataOverride]
        >,
      };
    })
  );

  return {
    refreshCatalog: providerResults.some((result) => result.refreshCatalog),
    overrides: new Map(providerResults.flatMap((result) => result.overrides)),
  };
}

async function reconcileBackstageTiersFromConnectedProviders(args: {
  connectedCatalogProviders: string[];
  convex: ReturnType<typeof getConvexClientFromUrl>;
  config: PackagesConfig;
  authUserId: string;
  existingProducts: BackstageProductQueryRow[];
}): Promise<boolean> {
  if (args.connectedCatalogProviders.length === 0) {
    return false;
  }

  const refreshCatalog = await Promise.all(
    args.existingProducts.map(async (product) => {
      if (!args.connectedCatalogProviders.includes(product.provider)) {
        return false;
      }

      const descriptor = getProviderDescriptor(product.provider);
      if (
        !descriptor?.capabilities.includes('tier_entitlements') &&
        !descriptor?.capabilities.includes('subscriptions')
      ) {
        return false;
      }

      const liveProductId = product.providerProductRef?.trim() || product.productId?.trim();
      if (!liveProductId) {
        return false;
      }

      let productRefreshCatalog = false;

      try {
        const liveTiers = await withBackstageLiveSyncTimeout(
          `Backstage ${product.provider} tier sync for ${liveProductId}`,
          (signal) =>
            listProviderTiersViaApi(
              {
                apiBaseUrl: args.config.apiBaseUrl,
                convexApiSecret: args.config.convexApiSecret,
              },
              {
                authUserId: args.authUserId,
                provider: product.provider,
                productId: liveProductId,
              },
              undefined,
              { signal }
            )
        );

        const existingTierMap = new Map(
          (product.catalogTiers ?? []).map((tier) => [tier.providerTierRef, tier] as const)
        );

        for (const liveTier of liveTiers.tiers ?? []) {
          const providerTierRef = liveTier.id?.trim();
          if (!providerTierRef) {
            continue;
          }

          const existingTier = existingTierMap.get(providerTierRef);
          if (!shouldUpsertLiveTier({ existingTier, liveTier })) {
            continue;
          }

          await args.convex.mutation(api.catalogTiers.upsertCatalogTier, {
            apiSecret: args.config.convexApiSecret,
            authUserId: args.authUserId,
            provider: product.provider,
            productId: product.productId,
            catalogProductId: product._id as Id<'product_catalog'>,
            providerProductRef: product.providerProductRef,
            providerTierRef,
            displayName: liveTier.name?.trim() || existingTier?.displayName || providerTierRef,
            description: normalizeRichTextToPlainText(liveTier.description),
            amountCents: normalizeAmountCents(liveTier.amountCents),
            currency: liveTier.currency?.trim(),
            status: resolveLiveTierStatus(liveTier, existingTier),
          });
          productRefreshCatalog = true;
        }
      } catch (error) {
        logger.warn('Failed to reconcile Backstage provider tiers from live catalog', {
          authUserId: args.authUserId,
          provider: product.provider,
          productId: product.productId,
          timeoutMs: error instanceof BackstageLiveSyncTimeoutError ? error.timeoutMs : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return productRefreshCatalog;
    })
  );

  return refreshCatalog.some(Boolean);
}

async function resolveViewer(
  request: Request,
  auth: Auth,
  config: PackagesConfig,
  requiredScopes: readonly PublicApiScope[] = ['profile:read']
): Promise<{ authUserId: string; actorBinding: ApiActorBinding } | Response> {
  const authHeader = request.headers.get('authorization')?.trim() ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    const verified = await verifyBetterAuthAccessToken(token, {
      convexSiteUrl: config.convexSiteUrl,
      audience: 'yucp-public-api',
      requiredScopes: Array.from(requiredScopes),
      logger,
      logContext: 'Package routes OAuth token verification failed',
    });
    if (!verified.ok) {
      if (verified.reason === 'insufficient_scope') {
        return jsonResponse(
          { error: `Token missing required scope: ${requiredScopes.join(', ')}` },
          403
        );
      }
      return jsonResponse({ error: 'Authentication required' }, 401);
    }

    return {
      authUserId: verified.token.sub,
      actorBinding: await createAuthUserActorBinding({
        authUserId: verified.token.sub,
        source: 'oauth',
        scopes: requiredScopes,
      }),
    };
  }

  const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins(config));
  if (csrfBlock) {
    return csrfBlock;
  }

  const session = await auth.getSession(request);
  if (!session) {
    return jsonResponse({ error: 'Authentication required' }, 401);
  }

  return {
    authUserId: session.user.id,
    actorBinding: await createAuthUserActorBinding({
      authUserId: session.user.id,
      source: 'session',
    }),
  };
}

const PRODUCTS_READ_SCOPES: readonly PublicApiScope[] = ['products:read'];
const PRODUCTS_WRITE_SCOPES: readonly PublicApiScope[] = ['products:write'];

async function resolveProductReadViewer(
  request: Request,
  auth: Auth,
  config: PackagesConfig
): Promise<{ authUserId: string; actorBinding: ApiActorBinding } | Response> {
  return await resolveViewer(request, auth, config, PRODUCTS_READ_SCOPES);
}

async function resolveProductWriteViewer(
  request: Request,
  auth: Auth,
  config: PackagesConfig
): Promise<{ authUserId: string; actorBinding: ApiActorBinding } | Response> {
  return await resolveViewer(request, auth, config, PRODUCTS_WRITE_SCOPES);
}

export function createPackageRoutes(auth: Auth, config: PackagesConfig) {
  async function getBackstageRepoAccess(request: Request): Promise<Response> {
    const viewer = await resolveProductReadViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    try {
      const subject = await convex.query(api.backstageRepos.getSubjectByAuthUserForApi, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
      });
      if (!subject) {
        return jsonResponse({ error: 'No active subject found for this account' }, 404);
      }

      const now = Date.now();
      const issued = await convex.mutation(api.backstageRepos.issueRepoTokenForApi, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        subjectId: subject._id,
        label: 'Dashboard Backstage Repos',
        expiresAt: now + BACKSTAGE_REPO_TOKEN_TTL_MS,
      });
      const creatorRepoIdentity = await getCreatorRepoIdentity({
        convex,
        convexApiSecret: config.convexApiSecret,
        authUserId: viewer.authUserId,
      });
      const repositoryUrl = buildBackstageRepositoryUrls(
        config.apiBaseUrl,
        creatorRepoIdentity.creatorRepoRef
      ).repositoryUrl;
      return jsonResponse({
        creatorName: creatorRepoIdentity.creatorName,
        creatorRepoRef: creatorRepoIdentity.creatorRepoRef,
        repositoryUrl,
        repositoryName: creatorRepoIdentity.repositoryName,
        addRepoUrl: buildBackstageAddRepoUrl(repositoryUrl, issued.token),
        expiresAt: issued.expiresAt,
      });
    } catch (error) {
      logger.error('Failed to issue Backstage repo access for dashboard package routes', {
        authUserId: viewer.authUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to issue Backstage repo access' }, 500);
    }
  }

  async function listBackstageProducts(request: Request): Promise<Response> {
    const viewer = await resolveProductReadViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    try {
      const liveSync = new URL(request.url).searchParams.get('liveSync') === 'true';
      let result = (await convex.query(api.packageRegistry.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
      })) as BackstageProductQueryResult;
      let overrides = new Map<string, BackstageProductMetadataOverride>();

      if (liveSync) {
        const connectedCatalogProviders = await getConnectedCatalogProviders({
          convex,
          config,
          authUserId: viewer.authUserId,
        });

        const reconciliationResult = await reconcileBackstageCatalogFromConnectedProviders({
          connectedCatalogProviders,
          convex,
          config,
          authUserId: viewer.authUserId,
          existingProducts: result.data,
        });
        overrides = reconciliationResult.overrides;
        if (reconciliationResult.refreshCatalog) {
          result = (await convex.query(api.packageRegistry.listByAuthUser, {
            apiSecret: config.convexApiSecret,
            actor: viewer.actorBinding,
            authUserId: viewer.authUserId,
          })) as BackstageProductQueryResult;
        }

        const refreshTiers = await reconcileBackstageTiersFromConnectedProviders({
          connectedCatalogProviders,
          convex,
          config,
          authUserId: viewer.authUserId,
          existingProducts: result.data,
        });
        if (refreshTiers) {
          result = (await convex.query(api.packageRegistry.listByAuthUser, {
            apiSecret: config.convexApiSecret,
            actor: viewer.actorBinding,
            authUserId: viewer.authUserId,
          })) as BackstageProductQueryResult;
        }
      }

      return jsonResponse({
        products: result.data.map((product) =>
          mapBackstageProductForResponse(
            product,
            overrides.get(
              buildBackstageProductRecordKey(product.provider, product.providerProductRef)
            )
          )
        ),
      });
    } catch (error) {
      logger.error('Failed to list Backstage package products', {
        authUserId: viewer.authUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to load Backstage products' }, 500);
    }
  }

  async function listPackages(request: Request): Promise<Response> {
    const viewer = await resolveProductReadViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    try {
      const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true';
      const result = await convex.query(api.packageRegistry.listForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        ...(includeArchived ? { includeArchived: true } : {}),
      });
      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to list creator packages', {
        authUserId: viewer.authUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to load packages' }, 500);
    }
  }

  async function renamePackage(request: Request, packageIdParam: string): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }

    let body: { packageName?: string };
    try {
      body = (await request.json()) as { packageName?: string };
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.packageName || !body.packageName.trim()) {
      return jsonResponse({ error: 'packageName is required' }, 400);
    }

    try {
      const result = await convex.mutation(api.packageRegistry.renameForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        packageId,
        packageName: body.packageName,
      });

      if (!result.updated) {
        const status = result.reason === 'Package not found.' ? 404 : 409;
        return jsonResponse({ error: result.reason }, status);
      }

      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to rename creator package', {
        authUserId: viewer.authUserId,
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to rename package' }, 500);
    }
  }

  async function archivePackage(request: Request, packageIdParam: string): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }

    try {
      const result = await convex.mutation(api.packageRegistry.archiveForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        packageId,
      });

      if (!result.archived) {
        const status = result.reason === 'Package not found.' ? 404 : 409;
        return jsonResponse({ error: result.reason }, status);
      }

      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to archive creator package', {
        authUserId: viewer.authUserId,
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to archive package' }, 500);
    }
  }

  async function restorePackage(request: Request, packageIdParam: string): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }

    try {
      const result = await convex.mutation(api.packageRegistry.restoreForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        packageId,
      });

      if (!result.restored) {
        const status = result.reason === 'Package not found.' ? 404 : 409;
        return jsonResponse({ error: result.reason }, status);
      }

      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to restore creator package', {
        authUserId: viewer.authUserId,
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to restore package' }, 500);
    }
  }

  async function deletePackage(request: Request, packageIdParam: string): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }

    try {
      const result = await convex.mutation(api.packageRegistry.deleteForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        packageId,
      });

      if (!result.deleted) {
        const status = result.reason === 'Package not found.' ? 404 : 409;
        return jsonResponse({ error: result.reason }, status);
      }

      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to delete creator package', {
        authUserId: viewer.authUserId,
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to delete package' }, 500);
    }
  }

  async function archiveBackstageProduct(
    request: Request,
    catalogProductId: string
  ): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    try {
      const result = await convex.mutation(api.packageRegistry.archiveProductForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        catalogProductId: catalogProductId as Id<'product_catalog'>,
      });

      if (!result.archived) {
        const status = result.reason === 'Catalog product not found.' ? 404 : 409;
        return jsonResponse({ error: result.reason }, status);
      }

      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to archive Backstage product link', {
        authUserId: viewer.authUserId,
        catalogProductId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to hide product link' }, 500);
    }
  }

  async function restoreBackstageProduct(
    request: Request,
    catalogProductId: string
  ): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    try {
      const result = await convex.mutation(api.packageRegistry.restoreProductForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        catalogProductId: catalogProductId as Id<'product_catalog'>,
      });

      if (!result.restored) {
        const status = result.reason === 'Catalog product not found.' ? 404 : 409;
        return jsonResponse({ error: result.reason }, status);
      }

      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to restore Backstage product link', {
        authUserId: viewer.authUserId,
        catalogProductId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to restore product link' }, 500);
    }
  }

  async function deleteBackstageProduct(
    request: Request,
    catalogProductId: string
  ): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    try {
      const result = await convex.mutation(api.packageRegistry.deleteProductForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        catalogProductId: catalogProductId as Id<'product_catalog'>,
      });

      if (!result.deleted) {
        const status = result.reason === 'Catalog product not found.' ? 404 : 409;
        return jsonResponse({ error: result.reason }, status);
      }

      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to delete Backstage product link', {
        authUserId: viewer.authUserId,
        catalogProductId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to delete product link' }, 500);
    }
  }

  async function archiveBackstageRelease(
    request: Request,
    packageIdParam: string,
    deliveryPackageReleaseId: string
  ): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }

    try {
      const result = await convex.mutation(api.packageRegistry.archiveReleaseForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        packageId,
        deliveryPackageReleaseId: deliveryPackageReleaseId as Id<'delivery_package_releases'>,
      });

      if (!result.archived) {
        const status =
          result.reason === 'Delivery package not found.' ||
          result.reason === 'Delivery package release not found.'
            ? 404
            : 409;
        return jsonResponse({ error: result.reason }, status);
      }

      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to archive Backstage release', {
        authUserId: viewer.authUserId,
        packageId,
        deliveryPackageReleaseId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to archive Backstage release' }, 500);
    }
  }

  async function deleteBackstageRelease(
    request: Request,
    packageIdParam: string,
    deliveryPackageReleaseId: string
  ): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }

    try {
      const result = await convex.mutation(api.packageRegistry.deleteReleaseForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        packageId,
        deliveryPackageReleaseId: deliveryPackageReleaseId as Id<'delivery_package_releases'>,
      });

      if (!result.deleted) {
        const status =
          result.reason === 'Delivery package not found.' ||
          result.reason === 'Delivery package release not found.'
            ? 404
            : 409;
        return jsonResponse({ error: result.reason }, status);
      }

      return jsonResponse(result);
    } catch (error) {
      logger.error('Failed to delete Backstage release', {
        authUserId: viewer.authUserId,
        packageId,
        deliveryPackageReleaseId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to delete Backstage release' }, 500);
    }
  }

  function parseBackstageDirectUploadRequest(body: unknown):
    | {
        byteSize: number;
        deliveryName: string;
        sha256: string;
        sourceContentType: string;
      }
    | Response {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const record = body as Record<string, unknown>;
    const byteSizeRaw = record.byteSize;
    const deliveryName =
      typeof record.deliveryName === 'string'
        ? record.deliveryName.trim()
        : typeof record.fileName === 'string'
          ? record.fileName.trim()
          : '';
    const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim().toLowerCase() : '';
    const sourceContentType =
      typeof record.sourceContentType === 'string' && record.sourceContentType.trim()
        ? record.sourceContentType.trim()
        : 'application/octet-stream';

    if (typeof byteSizeRaw !== 'number' || !Number.isSafeInteger(byteSizeRaw) || byteSizeRaw < 0) {
      return jsonResponse({ error: 'byteSize must be a non-negative safe integer' }, 400);
    }
    const byteSize = byteSizeRaw;
    if (byteSize > MAX_BACKSTAGE_PACKAGE_BYTES) {
      return jsonResponse({ error: 'Backstage package uploads are limited to 5 GiB.' }, 413);
    }
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      return jsonResponse({ error: 'sha256 must be a lowercase hex SHA-256 digest' }, 400);
    }
    if (!deliveryName) {
      return jsonResponse({ error: 'deliveryName is required' }, 400);
    }

    return {
      byteSize,
      deliveryName,
      sha256,
      sourceContentType,
    };
  }

  async function createBackstageReleaseUploadSession(
    request: Request,
    packageIdParam: string
  ): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }

    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }
    if (!config.cdngine?.apiBaseUrl || !config.cdngine.accessToken) {
      return jsonResponse({ error: 'CDNgine Backstage delivery is not configured' }, 503);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = parseBackstageDirectUploadRequest(body);
    if (parsed instanceof Response) {
      return parsed;
    }

    try {
      const assetOwner = `creator:${viewer.authUserId}`;
      const objectKey = [
        'staging',
        sanitizeCdngineObjectKeySegment(config.cdngine?.serviceNamespaceId ?? 'yucp-backstage'),
        sanitizeCdngineObjectKeySegment(viewer.authUserId),
        'backstage-source',
        sanitizeCdngineObjectKeySegment(packageId),
        parsed.sha256,
        sanitizeCdngineObjectKeySegment(parsed.deliveryName),
      ].join('/');
      const uploadAttemptId = randomUUID();
      const idempotencyBase = buildBackstageSourceUploadIdempotencyBase({
        authUserId: viewer.authUserId,
        packageId,
        sha256: parsed.sha256,
        uploadAttemptId,
      });
      const session = await createBackstageUploadSessionInCdngine({
        byteSize: parsed.byteSize,
        config: config.cdngine,
        contentType: parsed.sourceContentType,
        deliveryName: parsed.deliveryName,
        idempotencyBase,
        objectKey,
        assetOwner,
        tenantId: viewer.authUserId,
        sha256: parsed.sha256,
      });
      const completionToken = signBackstageUploadCompletionToken(
        {
          authUserId: viewer.authUserId,
          byteSize: parsed.byteSize,
          deliveryName: parsed.deliveryName,
          exp: Date.now() + 60 * 60 * 1000,
          kind: 'backstage-upload-complete',
          objectKey,
          packageId,
          sha256: parsed.sha256,
          sourceContentType: parsed.sourceContentType,
          uploadAttemptId,
          uploadSessionId: session.uploadSessionId,
        },
        config.convexApiSecret
      );
      const completeUrl = `${trimTrailingForwardSlashes(config.apiBaseUrl)}/api/packages/${encodeURIComponent(
        packageId
      )}/backstage/upload-session/complete`;

      return jsonResponse({
        completionToken,
        completeUrl,
        packageId,
        uploadSessionId: session.uploadSessionId,
        uploadTarget: session.uploadTarget,
      });
    } catch (error) {
      if (isCdngineBackstageDependencyError(error)) {
        logger.warn('Backstage CDNgine upload session creation is temporarily unavailable', {
          authUserId: viewer.authUserId,
          packageId,
          error: error instanceof Error ? error.message : String(error),
        });
        return cdngineBackstageUnavailableResponse(
          'Backstage upload service is temporarily unavailable'
        );
      }
      logger.error('Failed to create Backstage CDNgine upload session', {
        authUserId: viewer.authUserId,
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to create Backstage upload session' }, 500);
    }
  }

  async function completeBackstageReleaseUploadSession(
    request: Request,
    packageIdParam: string
  ): Promise<Response> {
    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }
    if (!config.cdngine?.apiBaseUrl || !config.cdngine.accessToken) {
      return jsonResponse({ error: 'CDNgine Backstage delivery is not configured' }, 503);
    }

    const completionToken =
      request.headers.get(BACKSTAGE_UPLOAD_COMPLETION_TOKEN_HEADER)?.trim() ?? '';
    const tokenPayload = verifyBackstageUploadCompletionToken(
      completionToken,
      config.convexApiSecret
    );
    if (!tokenPayload || tokenPayload.packageId !== packageId) {
      return jsonResponse({ error: 'Invalid upload completion token' }, 401);
    }

    try {
      const assetOwner = `creator:${tokenPayload.authUserId}`;
      const idempotencyBase = buildBackstageSourceUploadIdempotencyBase({
        authUserId: tokenPayload.authUserId,
        packageId,
        sha256: tokenPayload.sha256,
        uploadAttemptId: tokenPayload.uploadAttemptId ?? tokenPayload.uploadSessionId,
      });
      const cdngineSource = await completeBackstageUploadSessionInCdngine({
        assetOwner,
        byteSize: tokenPayload.byteSize,
        config: config.cdngine,
        idempotencyBase,
        objectKey: tokenPayload.objectKey,
        sha256: tokenPayload.sha256,
        tenantId: tokenPayload.authUserId,
        uploadSessionId: tokenPayload.uploadSessionId,
      });
      return jsonResponse({
        cdngineSource,
        deliveryName: tokenPayload.deliveryName,
        sourceContentType: tokenPayload.sourceContentType,
      });
    } catch (error) {
      if (
        error instanceof CdngineApiRequestError &&
        error.status === 410 &&
        error.problemType === 'https://docs.cdngine.dev/problems/upload-session-expired'
      ) {
        return jsonResponse(
          {
            code: 'BACKSTAGE_UPLOAD_SESSION_EXPIRED',
            error: 'Backstage upload session expired. Start a new upload session and try again.',
          },
          410
        );
      }
      if (isCdngineBackstageDependencyError(error)) {
        logger.warn('Backstage CDNgine upload session completion is temporarily unavailable', {
          authUserId: tokenPayload.authUserId,
          packageId,
          uploadSessionId: tokenPayload.uploadSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return cdngineBackstageUnavailableResponse(
          'Backstage upload service is temporarily unavailable'
        );
      }
      logger.error('Failed to complete Backstage CDNgine upload session', {
        authUserId: tokenPayload.authUserId,
        packageId,
        uploadSessionId: tokenPayload.uploadSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to complete Backstage upload session' }, 500);
    }
  }

  async function uploadBackstageReleaseMedia(
    request: Request,
    packageIdParam: string
  ): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }

    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }

    const requestUrl = new URL(request.url);
    const mediaKind = normalizeBackstagePackageMediaKind(
      request.headers.get('x-yucp-media-kind') ?? requestUrl.searchParams.get('kind')
    );
    if (!mediaKind) {
      return jsonResponse({ error: 'media kind must be either icon or banner' }, 400);
    }

    const contentType = normalizePackageMediaContentType(request.headers.get('content-type'));
    if (!contentType) {
      return jsonResponse({ error: 'Backstage package media must be a supported image type' }, 415);
    }

    if (!config.cdngine?.apiBaseUrl || !config.cdngine.accessToken) {
      return jsonResponse({ error: 'CDNgine Backstage delivery is not configured' }, 503);
    }

    const contentLength = readContentLength(request.headers);
    if (contentLength !== null && contentLength > MAX_BACKSTAGE_PACKAGE_MEDIA_BYTES) {
      return jsonResponse(
        { error: 'Backstage package media exceeds the maximum allowed size' },
        413
      );
    }

    try {
      const cdngineConfig = requireCdngineBackstageConfig(config.cdngine);
      const bytes = await readBoundedArrayBuffer(
        request,
        MAX_BACKSTAGE_PACKAGE_MEDIA_BYTES,
        (limitBytes) => new BackstagePackageMediaLimitError(limitBytes)
      );
      if (bytes.byteLength === 0) {
        return jsonResponse({ error: 'Backstage package media cannot be empty' }, 400);
      }

      const encodedDeliveryName = request.headers.get('x-yucp-file-name');
      const decodedDeliveryName = decodeOptionalHeaderValue(encodedDeliveryName);
      if (encodedDeliveryName && decodedDeliveryName === null) {
        return jsonResponse({ error: 'Invalid x-yucp-file-name header encoding' }, 400);
      }
      const deliveryName = decodedDeliveryName ?? `${packageId}-${mediaKind}`;
      const sourcePath = request.headers.get('x-yucp-source-path')?.trim();
      const sha256 = await sha256ArrayBuffer(bytes);
      const cdngineUpload = await uploadBackstageBytesToCdngine({
        bytes,
        byteSize: bytes.byteLength,
        config: cdngineConfig,
        contentType,
        deliveryName,
        idempotencyBase: `backstage-media:${viewer.authUserId}:${packageId}:${mediaKind}:${sha256}`,
        objectKey: [
          'staging',
          sanitizeCdngineObjectKeySegment(cdngineConfig.serviceNamespaceId),
          sanitizeCdngineObjectKeySegment(viewer.authUserId),
          'backstage-media',
          sanitizeCdngineObjectKeySegment(packageId),
          mediaKind,
          sha256,
          sanitizeCdngineObjectKeySegment(deliveryName),
        ].join('/'),
        assetOwner: `creator:${viewer.authUserId}`,
        tenantId: viewer.authUserId,
        sha256,
      });
      const cdngineDelivery = {
        ...cdngineUpload,
        deliveryScopeId: cdngineConfig.deliveryScopeId,
        variant: cdngineConfig.variant,
      };
      await waitForCdngineBackstageDeliveryPublication({
        config: cdngineConfig,
        delivery: cdngineDelivery,
      });

      const reference: BackstagePackageMediaReference = {
        byteSize: bytes.byteLength,
        cdngineDelivery,
        contentType,
        deliveryName,
        kind: mediaKind,
        sha256,
        ...(sourcePath ? { sourcePath } : {}),
      };
      return jsonResponse(reference, 201);
    } catch (error) {
      if (error instanceof BackstagePackageMediaLimitError) {
        return jsonResponse({ error: error.message }, 413);
      }
      if (isCdngineBackstageDependencyError(error)) {
        logger.warn('Backstage package media upload is temporarily unavailable', {
          authUserId: viewer.authUserId,
          packageId,
          mediaKind,
          error: error instanceof Error ? error.message : String(error),
        });
        return cdngineBackstageUnavailableResponse(
          'Backstage package media upload is temporarily unavailable'
        );
      }
      logger.error('Failed to upload Backstage package media', {
        authUserId: viewer.authUserId,
        packageId,
        mediaKind,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to upload Backstage package media' }, 500);
    }
  }

  function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  async function materializeCdngineSourceDeliverableForPublish(input: {
    authUserId: string;
    cdngineSource: CdngineBackstageSourceReference;
    contentType?: string;
    deliveryName?: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
    packageId: string;
    version: string;
  }): Promise<{
    cdngineDelivery: CdngineBackstageDeliveryReference;
    contentType: 'application/zip' | 'application/octet-stream';
    deliveryName: string;
    byteSize: number;
    sha256: string;
    sourceContentType: string;
    sourceDeliveryName: string;
  }> {
    const cdngineConfig = requireCdngineBackstageConfig(config.cdngine);
    const sourceUrl = await authorizeCdngineBackstageSource({
      config: cdngineConfig,
      source: input.cdngineSource,
      idempotencyKey: [
        'backstage-publish-source',
        input.authUserId,
        input.packageId,
        input.version,
        input.cdngineSource.assetId,
        input.cdngineSource.versionId,
      ].join(':'),
    });
    const sourceResponse = await fetchWithTimeout(
      sourceUrl,
      {
        headers: {
          accept: 'application/octet-stream, application/zip;q=0.9, */*;q=0.1',
        },
      },
      cdngineConfig.timeoutMs
    );
    if (!sourceResponse.ok) {
      throw new Error(
        `CDNgine source download failed while materializing Backstage deliverable: ${sourceResponse.status} ${sourceResponse.statusText}`
      );
    }
    const decodedSourceName = decodeOptionalHeaderValue(
      new URL(sourceUrl).pathname.split('/').pop() ?? null
    );
    const sourceDeliveryName =
      input.deliveryName?.trim() || decodedSourceName || `${input.packageId}.zip`;
    const sourceContentType =
      sourceResponse.headers.get('content-type')?.trim() ||
      input.contentType ||
      'application/octet-stream';
    const sourceBuffer = await readBoundedArrayBuffer(
      sourceResponse,
      MAX_BACKSTAGE_IN_PROCESS_MATERIALIZATION_BYTES,
      (limitBytes) => new BackstageSourceMaterializationLimitError(limitBytes)
    );
    const sourceSha256 = await sha256ArrayBuffer(sourceBuffer);
    if (sourceSha256 !== input.cdngineSource.sha256.trim().toLowerCase()) {
      throw new Error('CDNgine source download digest did not match the upload completion record.');
    }
    const sourceBytes = new Uint8Array(sourceBuffer);
    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes,
      deliveryName: sourceDeliveryName,
      contentType: sourceContentType,
      packageId: input.packageId,
      version: input.version,
      displayName: input.displayName,
      metadata: input.metadata,
    });
    const objectKey = [
      'staging',
      sanitizeCdngineObjectKeySegment(cdngineConfig.serviceNamespaceId),
      sanitizeCdngineObjectKeySegment(input.authUserId),
      'backstage-deliverable',
      sanitizeCdngineObjectKeySegment(input.packageId),
      sanitizeCdngineObjectKeySegment(input.version),
      materialized.sha256,
      sanitizeCdngineObjectKeySegment(materialized.deliveryName),
    ].join('/');
    const uploadedDeliverable = await uploadBackstageBytesToCdngine({
      bytes: toOwnedArrayBuffer(materialized.bytes),
      byteSize: materialized.byteSize,
      config: cdngineConfig,
      contentType: materialized.contentType,
      deliveryName: materialized.deliveryName,
      idempotencyBase: `backstage-deliverable:${input.authUserId}:${input.packageId}:${input.version}:${materialized.sha256}`,
      objectKey,
      assetOwner: `creator:${input.authUserId}`,
      tenantId: input.authUserId,
      sha256: materialized.sha256,
    });
    const cdngineDelivery = {
      ...uploadedDeliverable,
      deliveryScopeId: cdngineConfig.deliveryScopeId,
      variant: cdngineConfig.variant,
    };
    await waitForCdngineBackstageDeliveryPublication({
      config: cdngineConfig,
      delivery: cdngineDelivery,
    });

    return {
      byteSize: materialized.byteSize,
      cdngineDelivery,
      contentType: materialized.contentType,
      deliveryName: materialized.deliveryName,
      sha256: materialized.sha256,
      sourceContentType,
      sourceDeliveryName,
    };
  }

  async function publishBackstageRelease(
    request: Request,
    packageIdParam: string
  ): Promise<Response> {
    const viewer = await resolveProductWriteViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    let packageId: string;
    try {
      packageId = assertPackageId(packageIdParam);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'Invalid packageId' },
        400
      );
    }

    let body: {
      catalogProductId?: string;
      catalogProductIds?: string[];
      accessSelectors?: unknown[];
      cdngineSource?: CdngineBackstageSourceReference;
      version?: string;
      channel?: string;
      packageName?: string;
      displayName?: string;
      description?: string;
      repositoryVisibility?: 'hidden' | 'listed';
      defaultChannel?: string;
      unityVersion?: string;
      dependencyVersions?: Array<{ packageId?: string; version?: string }>;
      metadata?: unknown;
      deliveryName?: string;
      sourceContentType?: string;
      releaseStatus?: 'draft' | 'published' | 'revoked' | 'superseded';
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const catalogProductIds = Array.from(
      new Set(
        (Array.isArray(body.catalogProductIds)
          ? body.catalogProductIds
          : body.catalogProductId
            ? [body.catalogProductId]
            : []
        )
          .map((catalogProductId) => catalogProductId?.trim())
          .filter((catalogProductId): catalogProductId is string => Boolean(catalogProductId))
      )
    );
    const accessSelectors = Array.from(
      new Map(
        (Array.isArray(body.accessSelectors)
          ? normalizeProductSelectorList(body.accessSelectors)
          : legacyProductIdsToSelectors(catalogProductIds)
        ).map((selector) => [
          selector.kind === 'catalogTier'
            ? `tier:${selector.catalogTierId}`
            : `product:${selector.catalogProductId}`,
          selector,
        ])
      ).values()
    );
    let dependencyVersions:
      | Array<{
          packageId: string;
          version: string;
        }>
      | undefined;
    try {
      dependencyVersions = Array.isArray(body.dependencyVersions)
        ? body.dependencyVersions.map((dependency) => {
            const packageId = dependency?.packageId?.trim();
            const version = dependency?.version?.trim();
            if (!packageId || !version) {
              throw new Error('Each dependency version must include packageId and version.');
            }
            return { packageId, version };
          })
        : undefined;
    } catch (error) {
      return jsonResponse(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Each dependency version must include packageId and version.',
        },
        400
      );
    }
    if (
      accessSelectors.length === 0 ||
      !isCdngineBackstageSourceReference(body.cdngineSource) ||
      !body.version
    ) {
      return jsonResponse(
        { error: 'accessSelectors, cdngineSource, and version are required' },
        400
      );
    }
    const cdngineSourceOwnershipError = getCdngineSourceOwnershipError({
      authUserId: viewer.authUserId,
      expectedServiceNamespaceId: config.cdngine?.serviceNamespaceId ?? 'yucp-backstage',
      source: body.cdngineSource,
    });
    if (cdngineSourceOwnershipError) {
      return jsonResponse({ error: cdngineSourceOwnershipError }, 403);
    }

    try {
      const aliasMetadata = await convex.query(
        api.backstageRepos.resolveAliasContractMetadataForApi,
        {
          apiSecret: config.convexApiSecret,
          actor: viewer.actorBinding,
          authUserId: viewer.authUserId,
          accessSelectors: accessSelectors.map((selector) =>
            selector.kind === 'catalogTier'
              ? {
                  kind: 'catalogTier' as const,
                  catalogTierId: selector.catalogTierId as Id<'catalog_tiers'>,
                }
              : {
                  kind: 'catalogProduct' as const,
                  catalogProductId: selector.catalogProductId as Id<'product_catalog'>,
                }
          ),
        }
      );
      const channel = body.channel?.trim() || 'stable';
      const metadata = normalizeBackstageMetadataInput({
        metadata: mergeYucpAliasPackageMetadata({
          metadata: body.metadata,
          aliasId: aliasMetadata.aliasId,
          catalogProductIds: aliasMetadata.catalogProductIds,
          channel,
        }),
        dependencyVersions,
      });
      const deliverable = await materializeCdngineSourceDeliverableForPublish({
        authUserId: viewer.authUserId,
        cdngineSource: body.cdngineSource,
        contentType: body.sourceContentType?.trim(),
        deliveryName: body.deliveryName,
        displayName: body.displayName,
        metadata,
        packageId,
        version: body.version,
      });
      const preparedArtifact = prepareBackstageArtifactDescriptorForPublish({
        packageId,
        version: body.version,
        displayName: body.displayName,
        description: body.description,
        unityVersion: body.unityVersion,
        metadata,
        sourceContentType: deliverable.sourceContentType,
        sourceFileName: deliverable.sourceDeliveryName,
        sourceSha256: body.cdngineSource.sha256,
      });
      const result = await convex.mutation(api.backstageRepos.publishCdngineReleaseForAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
        accessSelectors: accessSelectors.map((selector) =>
          selector.kind === 'catalogTier'
            ? {
                kind: 'catalogTier' as const,
                catalogTierId: selector.catalogTierId as Id<'catalog_tiers'>,
              }
            : {
                kind: 'catalogProduct' as const,
                catalogProductId: selector.catalogProductId as Id<'product_catalog'>,
              }
        ),
        packageId,
        version: body.version,
        channel,
        packageName: body.packageName,
        displayName: body.displayName,
        description: body.description,
        repositoryVisibility: body.repositoryVisibility,
        defaultChannel: body.defaultChannel,
        unityVersion: body.unityVersion,
        metadata: preparedArtifact.metadata,
        rawDeliveryName: deliverable.sourceDeliveryName,
        rawContentType: deliverable.sourceContentType,
        rawSha256: body.cdngineSource.sha256,
        rawByteSize: body.cdngineSource.byteSize,
        cdngineSource: body.cdngineSource,
        deliverableDeliveryName: deliverable.deliveryName,
        deliverableContentType: deliverable.contentType,
        deliverableSha256: deliverable.sha256,
        deliverableByteSize: deliverable.byteSize,
        cdngineDelivery: deliverable.cdngineDelivery,
        releaseStatus: body.releaseStatus,
      });
      return jsonResponse(result, 201);
    } catch (error) {
      if (error instanceof BackstageSourceMaterializationLimitError) {
        logger.warn('Backstage source exceeds the in-process publish limit', {
          authUserId: viewer.authUserId,
          packageId,
          limitBytes: error.limitBytes,
        });
        return jsonResponse(
          {
            error: 'Backstage source exceeds the in-process publish limit',
            limitBytes: error.limitBytes,
          },
          413
        );
      }
      if (isCdngineBackstageDependencyError(error)) {
        logger.warn('Backstage package delivery publication is temporarily unavailable', {
          authUserId: viewer.authUserId,
          packageId,
          error: error instanceof Error ? error.message : String(error),
        });
        return cdngineBackstageUnavailableResponse(
          'Backstage package delivery is temporarily unavailable'
        );
      }
      logger.error('Failed to publish Backstage release', {
        authUserId: viewer.authUserId,
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to publish Backstage release' }, 500);
    }
  }

  return {
    getBackstageRepoAccess,
    listBackstageProducts,
    listPackages,
    renamePackage,
    archivePackage,
    restorePackage,
    deletePackage,
    archiveBackstageProduct,
    restoreBackstageProduct,
    deleteBackstageProduct,
    archiveBackstageRelease,
    deleteBackstageRelease,
    createBackstageReleaseUploadSession,
    completeBackstageReleaseUploadSession,
    uploadBackstageReleaseMedia,
    publishBackstageRelease,
  };
}
