import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  buildCatalogProductUrl,
  CATALOG_SYNC_PROVIDER_KEYS,
  getProviderDescriptor,
} from '@yucp/providers/providerMetadata';
import { mergeYucpAliasPackageMetadata, type YucpAliasPackageContract } from '@yucp/shared';
import type { ApiActorBinding } from '@yucp/shared/apiActor';
import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import { detectBackstageVpmDeliverySourceKind } from '@yucp/shared/backstageVpmDelivery';
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
  type CdngineBackstageConfig,
  completeBackstageUploadSessionInCdngine,
  createBackstageUploadSessionInCdngine,
  requireCdngineBackstageConfig,
  sanitizeCdngineObjectKeySegment,
  sha256ArrayBuffer,
  uploadBackstageBytesToCdngine,
} from '../lib/cdngineBackstage';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { verifyBetterAuthAccessToken } from '../lib/oauthAccessToken';
import { MAX_BACKSTAGE_PACKAGE_BYTES } from '../lib/requestBodyLimits';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const BACKSTAGE_REPO_TOKEN_HEADER = 'X-YUCP-Repo-Token';
const BACKSTAGE_REPO_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_BACKSTAGE_LIVE_SYNC_TIMEOUT_MS = 1_500;
const BACKSTAGE_LIVE_SYNC_TIMEOUT_MS = getBackstageLiveSyncTimeoutMs();

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
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'BackstageLiveSyncTimeoutError';
  }
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
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
  const actual = Buffer.from(signature, 'base64url');
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    return null;
  }
  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as BackstageUploadTokenPayload;
  if (
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

async function withBackstageLiveSyncTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new BackstageLiveSyncTimeoutError(operation, BACKSTAGE_LIVE_SYNC_TIMEOUT_MS));
        }, BACKSTAGE_LIVE_SYNC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function getAllowedOrigins(config: PackagesConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

function assertPackageId(packageId: string): string {
  const normalized = decodeURIComponent(packageId).trim();
  if (!PACKAGE_ID_RE.test(normalized)) {
    throw new Error('Invalid packageId format');
  }
  return normalized;
}

function buildBackstageAddRepoUrl(repositoryUrl: string, repoToken: string): string {
  const addRepoUrl = new URL('vcc://vpm/addRepo');
  addRepoUrl.searchParams.set('url', repositoryUrl);
  addRepoUrl.searchParams.append('headers[]', `${BACKSTAGE_REPO_TOKEN_HEADER}:${repoToken}`);
  return addRepoUrl.toString();
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
    return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : `&${entity};`;
  }

  if (entity.startsWith('#')) {
    const parsed = Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : `&${entity};`;
  }

  return `&${entity};`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
          listProviderProductsViaApi(
            {
              apiBaseUrl: args.config.apiBaseUrl,
              convexApiSecret: args.config.convexApiSecret,
            },
            {
              authUserId: args.authUserId,
              provider,
            }
          ),
          `Backstage ${provider} product sync`
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
          timeoutMs:
            error instanceof BackstageLiveSyncTimeoutError
              ? BACKSTAGE_LIVE_SYNC_TIMEOUT_MS
              : undefined,
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
          listProviderTiersViaApi(
            {
              apiBaseUrl: args.config.apiBaseUrl,
              convexApiSecret: args.config.convexApiSecret,
            },
            {
              authUserId: args.authUserId,
              provider: product.provider,
              productId: liveProductId,
            }
          ),
          `Backstage ${product.provider} tier sync for ${liveProductId}`
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
          timeoutMs:
            error instanceof BackstageLiveSyncTimeoutError
              ? BACKSTAGE_LIVE_SYNC_TIMEOUT_MS
              : undefined,
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
  config: PackagesConfig
): Promise<{ authUserId: string; actorBinding: ApiActorBinding } | Response> {
  const authHeader = request.headers.get('authorization')?.trim() ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    const verified = await verifyBetterAuthAccessToken(token, {
      convexSiteUrl: config.convexSiteUrl,
      audience: 'yucp-public-api',
      requiredScopes: ['profile:read'],
      logger,
      logContext: 'Package routes OAuth token verification failed',
    });
    if (!verified.ok) {
      return jsonResponse({ error: 'Authentication required' }, 401);
    }

    return {
      authUserId: verified.token.sub,
      actorBinding: await createAuthUserActorBinding({
        authUserId: verified.token.sub,
        source: 'oauth',
        scopes: ['profile:read'],
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

export function createPackageRoutes(auth: Auth, config: PackagesConfig) {
  async function getBackstageRepoAccess(request: Request): Promise<Response> {
    const viewer = await resolveViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);

    try {
      const subject = await convex.query(api.backstageRepos.getSubjectByAuthUserForApi, {
        apiSecret: config.convexApiSecret,
        authUserId: viewer.authUserId,
      });
      if (!subject) {
        return jsonResponse({ error: 'No active subject found for this account' }, 404);
      }

      const now = Date.now();
      const issued = await convex.mutation(api.backstageRepos.issueRepoTokenForApi, {
        apiSecret: config.convexApiSecret,
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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
    const viewer = await resolveViewer(request, auth, config);
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

  async function createBackstageReleaseUploadUrl(
    request: Request,
    packageIdParam: string
  ): Promise<Response> {
    const viewer = await resolveViewer(request, auth, config);
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

    const token = signBackstageUploadToken(
      {
        authUserId: viewer.authUserId,
        exp: Date.now() + 15 * 60 * 1000,
        packageId,
      },
      config.convexApiSecret
    );
    const uploadUrl = `${config.apiBaseUrl.replace(/\/+$/, '')}/api/packages/${encodeURIComponent(
      packageId
    )}/backstage/upload-source?uploadToken=${encodeURIComponent(token)}`;
    return jsonResponse({ packageId, uploadUrl });
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
    const viewer = await resolveViewer(request, auth, config);
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
      const idempotencyBase = `backstage-source:${viewer.authUserId}:${packageId}:${parsed.sha256}`;
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
          uploadSessionId: session.uploadSessionId,
        },
        config.convexApiSecret
      );
      const completeUrl = `${config.apiBaseUrl.replace(/\/+$/, '')}/api/packages/${encodeURIComponent(
        packageId
      )}/backstage/upload-session/complete?completionToken=${encodeURIComponent(completionToken)}`;

      return jsonResponse({
        completeUrl,
        packageId,
        uploadSessionId: session.uploadSessionId,
        uploadTarget: session.uploadTarget,
      });
    } catch (error) {
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

    const completionToken = new URL(request.url).searchParams.get('completionToken') ?? '';
    const tokenPayload = verifyBackstageUploadCompletionToken(
      completionToken,
      config.convexApiSecret
    );
    if (!tokenPayload || tokenPayload.packageId !== packageId) {
      return jsonResponse({ error: 'Invalid upload completion token' }, 401);
    }

    try {
      const assetOwner = `creator:${tokenPayload.authUserId}`;
      const cdngineSource = await completeBackstageUploadSessionInCdngine({
        assetOwner,
        byteSize: tokenPayload.byteSize,
        config: config.cdngine,
        idempotencyBase: `backstage-source:${tokenPayload.authUserId}:${packageId}:${tokenPayload.sha256}`,
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
      logger.error('Failed to complete Backstage CDNgine upload session', {
        authUserId: tokenPayload.authUserId,
        packageId,
        uploadSessionId: tokenPayload.uploadSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to complete Backstage upload session' }, 500);
    }
  }

  async function uploadBackstageReleaseSource(
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

    const uploadToken = new URL(request.url).searchParams.get('uploadToken') ?? '';
    const tokenPayload = verifyBackstageUploadToken(uploadToken, config.convexApiSecret);
    if (!tokenPayload || tokenPayload.packageId !== packageId) {
      return jsonResponse({ error: 'Invalid upload token' }, 401);
    }
    if (!config.cdngine?.apiBaseUrl || !config.cdngine.accessToken) {
      return jsonResponse({ error: 'CDNgine Backstage delivery is not configured' }, 503);
    }

    try {
      const bytes = await request.arrayBuffer();
      const deliveryName =
        decodeURIComponent(request.headers.get('x-yucp-file-name') ?? '').trim() ||
        `${packageId}.zip`;
      const contentType = request.headers.get('content-type')?.trim() || 'application/octet-stream';
      const sha256 = await sha256ArrayBuffer(bytes);
      const assetOwner = `creator:${tokenPayload.authUserId}`;
      const objectKey = [
        'staging',
        sanitizeCdngineObjectKeySegment(config.cdngine?.serviceNamespaceId ?? 'yucp-backstage'),
        sanitizeCdngineObjectKeySegment(tokenPayload.authUserId),
        'backstage-source',
        sanitizeCdngineObjectKeySegment(packageId),
        sha256,
        sanitizeCdngineObjectKeySegment(deliveryName),
      ].join('/');
      const cdngineSource = await uploadBackstageBytesToCdngine({
        bytes,
        byteSize: bytes.byteLength,
        config: config.cdngine,
        contentType,
        deliveryName,
        idempotencyBase: `backstage-source:${tokenPayload.authUserId}:${packageId}:${sha256}`,
        objectKey,
        assetOwner,
        tenantId: tokenPayload.authUserId,
        sha256,
      });
      return jsonResponse({
        cdngineSource,
        deliveryName,
        sourceContentType: contentType,
      });
    } catch (error) {
      logger.error('Failed to upload Backstage release source to CDNgine', {
        authUserId: tokenPayload.authUserId,
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to upload Backstage release' }, 500);
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
    const declaredSourceKind = detectBackstageVpmDeliverySourceKind({
      deliveryName: input.deliveryName,
      contentType: input.contentType,
    });
    let sourceBytes: Uint8Array;
    let sourceContentType: string;
    let sourceDeliveryName: string;
    if (declaredSourceKind === 'unitypackage') {
      sourceBytes = new Uint8Array();
      sourceContentType = input.contentType || 'application/octet-stream';
      sourceDeliveryName = input.deliveryName?.trim() || `${input.packageId}.unitypackage`;
    } else {
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
      const sourceResponse = await fetch(sourceUrl, {
        headers: {
          accept: 'application/octet-stream, application/zip;q=0.9, */*;q=0.1',
        },
      });
      if (!sourceResponse.ok) {
        throw new Error(
          `CDNgine source download failed while materializing Backstage deliverable: ${sourceResponse.status} ${sourceResponse.statusText}`
        );
      }
      sourceDeliveryName =
        input.deliveryName?.trim() ||
        decodeURIComponent(new URL(sourceUrl).pathname.split('/').pop() ?? '').trim() ||
        `${input.packageId}.zip`;
      sourceContentType =
        sourceResponse.headers.get('content-type')?.trim() ||
        input.contentType ||
        'application/octet-stream';
      sourceBytes = new Uint8Array(await sourceResponse.arrayBuffer());
    }
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

    return {
      byteSize: materialized.byteSize,
      cdngineDelivery: {
        ...uploadedDeliverable,
        deliveryScopeId: cdngineConfig.deliveryScopeId,
        variant: cdngineConfig.variant,
      },
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
    const viewer = await resolveViewer(request, auth, config);
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
    createBackstageReleaseUploadUrl,
    createBackstageReleaseUploadSession,
    completeBackstageReleaseUploadSession,
    uploadBackstageReleaseSource,
    publishBackstageRelease,
  };
}
