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
  type BackstageIngestResult,
  type BackstageUploadClaims,
  parseIngestResult,
  parseUploadClaims,
  sign,
  verify,
} from '@yucp/shared/backstageIngest';
import {
  BACKSTAGE_PACKAGE_MEDIA_KINDS,
  type BackstagePackageMediaKind,
  type BackstagePackageMediaReference,
} from '@yucp/shared/backstagePackageMedia';
import { prepareBackstageArtifactDescriptorForPublish } from '@yucp/shared/backstageVpmPackage';
import {
  assertSecureLoreUrl,
  LoreApiRequestError,
  type LoreBackstageConfig,
  loreRepositoryIdForCreator,
  putBackstageBytesToLore,
  requireLoreBackstageConfig,
  sha256ArrayBuffer,
} from '@yucp/shared/loreBackstageClient';
import { type LoreBackstageArtifactReference } from '@yucp/shared/loreBackstageDelivery';
import { legacyProductIdsToSelectors, normalizeProductSelectorList } from '@yucp/shared/product';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { listProviderProductsViaApi, listProviderTiersViaApi } from '../internalRpc/router';
import { createAuthUserActorBinding } from '../lib/apiActor';
import { buildBackstageImporterDelivery } from '../lib/backstageImporterDelivery';
import { buildBackstageRepositoryUrls, getCreatorRepoIdentity } from '../lib/backstageRepoIdentity';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { verifyBetterAuthAccessToken } from '../lib/oauthAccessToken';
import { readBoundedArrayBuffer, readContentLength } from '../lib/readBoundedArrayBuffer';
import { MAX_BACKSTAGE_PACKAGE_BYTES } from '../lib/requestBodyLimits';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const BACKSTAGE_REPO_TOKEN_HEADER = 'X-YUCP-Repo-Token';
const BACKSTAGE_REPO_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_BACKSTAGE_LIVE_SYNC_TIMEOUT_MS = 1_500;
const MAX_BACKSTAGE_PACKAGE_MEDIA_BYTES = 5 * 1024 * 1024;
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
  backstageIngestSecret?: string;
  ingestBaseUrl?: string;
  lore?: LoreBackstageConfig;
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

class BackstagePackageMediaLimitError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super('Backstage package media exceeds the maximum allowed size');
    this.name = 'BackstagePackageMediaLimitError';
    this.limitBytes = limitBytes;
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

function isLoreBackstageDependencyError(error: unknown): boolean {
  return (
    error instanceof LoreApiRequestError ||
    isFetchAbortOrTimeoutError(error) ||
    (error instanceof Error && error.message.includes('Lore'))
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

function loreBackstageUnavailableResponse(error: string): Response {
  return jsonResponse({ error }, 502);
}

export function trimTrailingForwardSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
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

  async function authorizeBackstageReleaseUpload(
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
    if (!config.backstageIngestSecret || !config.ingestBaseUrl || !config.lore) {
      return jsonResponse({ error: 'Backstage ingest service is not configured' }, 503);
    }

    let ingestBaseUrl: URL;
    try {
      ingestBaseUrl = assertSecureLoreUrl(config.ingestBaseUrl, 'LORE_INGEST_BASE_URL');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'LORE_INGEST_BASE_URL configuration is invalid.';
      logger.warn('Backstage ingest authorization endpoint configuration is invalid', {
        authUserId: viewer.authUserId,
        packageId,
        error: message,
      });
      return jsonResponse({ error: message }, 503);
    }

    let body: {
      version?: unknown;
      deliveryName?: unknown;
      sourceContentType?: unknown;
      sha256?: unknown;
      byteSize?: unknown;
      materializeMetadata?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const version = typeof body.version === 'string' ? body.version.trim() : '';
    const deliveryName = typeof body.deliveryName === 'string' ? body.deliveryName.trim() : '';
    const sourceContentType =
      typeof body.sourceContentType === 'string' && body.sourceContentType.trim()
        ? body.sourceContentType.trim()
        : 'application/octet-stream';
    const sha256 = typeof body.sha256 === 'string' ? body.sha256.trim() : '';
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      return jsonResponse({ error: 'sha256 must be a lowercase hex SHA-256 digest' }, 400);
    }
    if (!Number.isSafeInteger(body.byteSize) || (body.byteSize as number) < 0) {
      return jsonResponse({ error: 'byteSize must be a non-negative safe integer' }, 400);
    }
    if ((body.byteSize as number) > MAX_BACKSTAGE_PACKAGE_BYTES) {
      return jsonResponse({ error: 'Backstage package uploads are limited to 5 GiB.' }, 413);
    }
    if (!version) {
      return jsonResponse({ error: 'version is required' }, 400);
    }
    if (!deliveryName) {
      return jsonResponse({ error: 'deliveryName is required' }, 400);
    }

    try {
      const loreConfig = requireLoreBackstageConfig(config.lore);
      const repositoryId = loreRepositoryIdForCreator(
        viewer.authUserId,
        loreConfig.repoNamespaceSalt
      );
      const claims = parseUploadClaims({
        typ: 'backstage-upload',
        authUserId: viewer.authUserId,
        packageId,
        version,
        repositoryId,
        deliveryName,
        sourceContentType,
        declaredSha256: sha256,
        byteSize: body.byteSize,
        ...(body.materializeMetadata !== undefined
          ? { materializeMetadata: body.materializeMetadata }
          : {}),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }) satisfies BackstageUploadClaims;
      const uploadToken = await sign(config.backstageIngestSecret, claims);
      return jsonResponse({
        tusEndpoint: `${trimTrailingForwardSlashes(ingestBaseUrl.toString())}/files`,
        uploadToken,
        uploadMetadataKey: 'uploadToken',
        maxByteSize: MAX_BACKSTAGE_PACKAGE_BYTES,
      });
    } catch (error) {
      logger.warn('Backstage ingest authorization configuration is invalid', {
        authUserId: viewer.authUserId,
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error && error.message.startsWith('Upload token materializeMetadata')) {
        return jsonResponse({ error: error.message }, 400);
      }
      return jsonResponse({ error: 'Backstage ingest service is not configured' }, 503);
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

    if (!config.lore) {
      return jsonResponse({ error: 'Lore Backstage storage is not configured' }, 503);
    }

    const contentLength = readContentLength(request.headers);
    if (contentLength !== null && contentLength > MAX_BACKSTAGE_PACKAGE_MEDIA_BYTES) {
      return jsonResponse(
        { error: 'Backstage package media exceeds the maximum allowed size' },
        413
      );
    }

    try {
      const loreConfig = requireLoreBackstageConfig(config.lore);
      const repositoryId = loreRepositoryIdForCreator(
        viewer.authUserId,
        loreConfig.repoNamespaceSalt
      );
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
      const loreUpload = await putBackstageBytesToLore({
        bytes,
        config: loreConfig,
        repositoryId,
      });
      const loreDelivery: LoreBackstageArtifactReference = {
        repositoryId,
        address: loreUpload.address,
        sha256: loreUpload.sha256,
        byteSize: loreUpload.byteSize,
        uploadedAt: new Date().toISOString(),
        tenantId: viewer.authUserId,
      };

      if (loreUpload.sha256 !== sha256) {
        throw new Error('Lore media upload digest did not match the source bytes.');
      }

      const reference: BackstagePackageMediaReference = {
        byteSize: bytes.byteLength,
        loreDelivery,
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
      if (isLoreBackstageDependencyError(error)) {
        logger.warn('Backstage package media upload is temporarily unavailable', {
          authUserId: viewer.authUserId,
          packageId,
          mediaKind,
          error: error instanceof Error ? error.message : String(error),
        });
        return loreBackstageUnavailableResponse(
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
      ingestResult?: unknown;
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
    if (accessSelectors.length === 0 || typeof body.ingestResult !== 'string' || !body.version) {
      return jsonResponse(
        { error: 'accessSelectors, ingestResult, and version are required' },
        400
      );
    }
    if (!config.backstageIngestSecret) {
      return jsonResponse({ error: 'Backstage ingest service is not configured' }, 503);
    }

    let ingestResult: BackstageIngestResult;
    try {
      ingestResult = parseIngestResult(
        await verify(config.backstageIngestSecret, body.ingestResult)
      );
    } catch {
      return jsonResponse({ error: 'Invalid or expired ingest result' }, 400);
    }
    if (ingestResult.authUserId !== viewer.authUserId) {
      return jsonResponse({ error: 'Ingest result is not owned by this creator' }, 403);
    }
    if (ingestResult.packageId !== packageId) {
      return jsonResponse({ error: 'Ingest result does not match the release package' }, 400);
    }
    if (ingestResult.version !== body.version) {
      return jsonResponse(
        { error: 'Ingest result does not match the release version — re-upload' },
        409
      );
    }
    if (
      ingestResult.loreSource.tenantId !== viewer.authUserId ||
      ingestResult.loreDelivery.tenantId !== viewer.authUserId
    ) {
      return jsonResponse({ error: 'Ingest result is not owned by this creator' }, 403);
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
      const preparedArtifact = prepareBackstageArtifactDescriptorForPublish({
        packageId,
        version: body.version,
        displayName: body.displayName,
        description: body.description,
        unityVersion: body.unityVersion,
        metadata,
        sourceContentType: ingestResult.rawContentType,
        sourceFileName: ingestResult.rawDeliveryName,
        sourceSha256: ingestResult.rawSha256,
      });
      const result = await convex.mutation(api.backstageRepos.publishLoreReleaseForAuthUser, {
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
        rawDeliveryName: ingestResult.rawDeliveryName,
        rawContentType: ingestResult.rawContentType,
        rawSha256: ingestResult.rawSha256,
        rawByteSize: ingestResult.rawByteSize,
        loreSource: ingestResult.loreSource,
        deliverableDeliveryName: ingestResult.deliverableDeliveryName,
        deliverableContentType: ingestResult.deliverableContentType,
        deliverableSha256: ingestResult.deliverableSha256,
        deliverableByteSize: ingestResult.deliverableByteSize,
        loreDelivery: ingestResult.loreDelivery,
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
    authorizeBackstageReleaseUpload,
    uploadBackstageReleaseMedia,
    publishBackstageRelease,
  };
}
