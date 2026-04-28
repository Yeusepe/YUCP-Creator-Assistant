import {
  buildCatalogProductUrl,
  CATALOG_SYNC_PROVIDER_KEYS,
  getProviderDescriptor,
} from '@yucp/providers/providerMetadata';
import type { ApiActorBinding } from '@yucp/shared/apiActor';
import { legacyProductIdsToSelectors, normalizeProductSelectorList } from '@yucp/shared/product';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { listProviderProductsViaApi, listProviderTiersViaApi } from '../internalRpc/router';
import { createAuthUserActorBinding } from '../lib/apiActor';
import { buildBackstageRepositoryUrls, getCreatorRepoIdentity } from '../lib/backstageRepoIdentity';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { verifyBetterAuthAccessToken } from '../lib/oauthAccessToken';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
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
type BackstageCatalogTierRow = NonNullable<BackstageProductQueryRow['catalogTiers']>[number];

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
      latestRelease: pkg.latestRelease
        ? {
            deliveryPackageReleaseId: pkg.latestRelease.deliveryPackageReleaseId,
            version: pkg.latestRelease.version,
            channel: pkg.latestRelease.channel,
            releaseStatus: pkg.latestRelease.releaseStatus,
            repositoryVisibility: pkg.latestRelease.repositoryVisibility,
            artifactKey: pkg.latestRelease.artifactKey,
            contentType: pkg.latestRelease.contentType,
            createdAt: pkg.latestRelease.createdAt,
            deliveryName: pkg.latestRelease.deliveryName,
            metadata: pkg.latestRelease.metadata,
            publishedAt: pkg.latestRelease.publishedAt,
            unityVersion: pkg.latestRelease.unityVersion,
            updatedAt: pkg.latestRelease.updatedAt,
            zipSha256: pkg.latestRelease.zipSha256,
          }
        : null,
      releases: (pkg.releases ?? []).map((release) => ({
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
        publishedAt: release.publishedAt,
        unityVersion: release.unityVersion,
        updatedAt: release.updatedAt,
        zipSha256: release.zipSha256,
      })),
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
      const knownProducts = new Set(
        args.existingProducts
          .filter((product) => product.provider === provider)
          .map((product) =>
            buildBackstageProductRecordKey(product.provider, product.providerProductRef)
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
          const override = buildLiveProductMetadataOverride(liveProduct);
          if (override) {
            providerOverrides.set(productKey, override);
          }

          if (knownProducts.has(productKey)) {
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
            ...(liveProduct.name?.trim() ? { displayName: liveProduct.name.trim() } : {}),
            ...(liveProduct.thumbnailUrl?.trim()
              ? { thumbnailUrl: liveProduct.thumbnailUrl.trim() }
              : {}),
          });
          knownProducts.add(productKey);
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
      let result = (await convex.query(api.packageRegistry.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        authUserId: viewer.authUserId,
      })) as BackstageProductQueryResult;

      const connectedCatalogProviders = await getConnectedCatalogProviders({
        convex,
        config,
        authUserId: viewer.authUserId,
      });

      const { refreshCatalog, overrides } = await reconcileBackstageCatalogFromConnectedProviders({
        connectedCatalogProviders,
        convex,
        config,
        authUserId: viewer.authUserId,
        existingProducts: result.data,
      });
      if (refreshCatalog) {
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

  async function createBackstageReleaseUploadUrl(
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

    try {
      const uploadUrl = await convex.mutation(
        api.backstageRepos.generateReleaseUploadUrlForAuthUser,
        {
          apiSecret: config.convexApiSecret,
          actor: viewer.actorBinding,
          authUserId: viewer.authUserId,
        }
      );
      return jsonResponse({ packageId, uploadUrl });
    } catch (error) {
      logger.error('Failed to generate Backstage release upload URL', {
        authUserId: viewer.authUserId,
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: 'Failed to create upload URL' }, 500);
    }
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
      storageId?: string;
      version?: string;
      zipSha256?: string;
      channel?: string;
      packageName?: string;
      displayName?: string;
      description?: string;
      repositoryVisibility?: 'hidden' | 'listed';
      defaultChannel?: string;
      unityVersion?: string;
      metadata?: unknown;
      deliveryName?: string;
      contentType?: string;
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
    const zipSha256 = body.zipSha256?.trim().toLowerCase();
    if (accessSelectors.length === 0 || !body.storageId || !body.version || !zipSha256) {
      return jsonResponse(
        { error: 'accessSelectors, storageId, version, and zipSha256 are required' },
        400
      );
    }
    if (!SHA256_HEX_RE.test(zipSha256)) {
      return jsonResponse(
        { error: 'zipSha256 must be a lowercase 64-character SHA-256 hex digest' },
        400
      );
    }

    try {
      const result = await convex.action(api.backstageRepos.publishUploadedReleaseForAuthUser, {
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
        storageId: body.storageId as Id<'_storage'>,
        version: body.version,
        zipSha256,
        channel: body.channel,
        packageName: body.packageName,
        displayName: body.displayName,
        description: body.description,
        repositoryVisibility: body.repositoryVisibility,
        defaultChannel: body.defaultChannel,
        unityVersion: body.unityVersion,
        metadata: body.metadata,
        deliveryName: body.deliveryName,
        contentType: body.contentType,
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
    createBackstageReleaseUploadUrl,
    publishBackstageRelease,
  };
}
