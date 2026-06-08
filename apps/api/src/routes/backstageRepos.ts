import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import type { ApiActorBinding } from '@yucp/shared/apiActor';
import {
  type CdngineBackstageDeliveryReference,
  isCdngineBackstageDeliveryReference,
} from '@yucp/shared/cdngineBackstageDelivery';
import { sha256Hex } from '@yucp/shared/crypto';
import {
  YUCP_FORWARDED_TOOLCHAIN_PACKAGE_IDS,
  type YucpAliasPackageContract,
} from '@yucp/shared/yucpAliasPackageContract';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { createApiServiceActorBinding, createAuthUserActorBinding } from '../lib/apiActor';
import { buildBackstageImporterDelivery } from '../lib/backstageImporterDelivery';
import type { CreatorRepoIdentity } from '../lib/backstageRepoIdentity';
import { buildBackstageRepositoryUrls, getCreatorRepoIdentity } from '../lib/backstageRepoIdentity';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { verifyBetterAuthAccessToken } from '../lib/oauthAccessToken';
import { normalizeHostedVerificationRequirements } from '../verification/hostedIntents';
import { getVerificationConfig } from '../verification/verificationConfig';

const BACKSTAGE_REPO_TOKEN_HEADER = 'X-YUCP-Repo-Token';
const BACKSTAGE_REPO_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BACKSTAGE_ALIAS_INSTALL_PLAN_TTL_MS = 5 * 60 * 1000;
const BACKSTAGE_FORWARDED_UPSTREAM_TIMEOUT_MS = 2_000;
const BACKSTAGE_FORWARDED_UPSTREAM_MAX_BYTES = 1024 * 1024;
const BACKSTAGE_RAW_DOWNLOAD_BODY_MAX_BYTES = 4 * 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// Forward the shared toolchain packages from the public YUCP VPM source:
// https://vpm.yucp.club/index.json
const BACKSTAGE_FORWARDED_UPSTREAM_REPOSITORY_URL = 'https://vpm.yucp.club/index.json';

type BackstageRepositoryPackageEntry = Record<string, unknown>;
type BackstageRepositoryPackages = Record<string, BackstageRepositoryPackageEntry>;

type BackstageAccessViewer = {
  authUserId: string;
  actorBinding: ApiActorBinding;
};

type PublicBackstageAccessRecord = {
  creatorAuthUserId: string;
  creatorSlug?: string;
  catalogProductId: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  canonicalSlug?: string;
  displayName?: string;
  thumbnailUrl?: string;
  primaryPackageId?: string;
  primaryPackageName?: string;
  packageSummaries: Array<{
    packageId: string;
    displayName?: string;
    latestPublishedVersion?: string;
    latestReleaseChannel?: string;
    aliasContract?: YucpAliasPackageContract;
  }>;
};

type AuthorizedAliasInstallPlanRecord = {
  creatorAuthUserId: string;
  creatorSlug?: string;
  providerProductRef: string;
  canonicalSlug?: string;
  displayName?: string;
  thumbnailUrl?: string;
  packages: Array<{
    packageId: string;
    displayName?: string;
    version: string;
    channel: string;
    zipSha256?: string;
    aliasContract: YucpAliasPackageContract;
  }>;
};

type BuyerAccessCatalogProduct = {
  catalogProductId: string;
  creatorAuthUserId: string;
  providerProductRef: string;
  canonicalSlug?: string;
  displayName?: string;
  thumbnailUrl?: string;
  status: 'active';
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

type BackstageRawPackageDownloadRecord = {
  deliveryArtifactId: Id<'delivery_release_artifacts'>;
  downloadUrl: string;
  contentType: string;
  deliveryName: string;
  packageSha256: string;
  sourceKind: 'zip' | 'unitypackage';
  version: string;
  channel: string;
  cdngineDelivery?: CdngineBackstageDeliveryReference;
};

type ConfiguredCdngineBackstageDelivery = {
  accessToken: string;
  apiBaseUrl: string;
  required?: boolean;
  timeoutMs?: number;
};

class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function requireInstallableBackstageRawPackageDownload(
  resolved: BackstageRawPackageDownloadRecord,
  packageId: string
): { packageSha256: string; sourceKind: 'zip' | 'unitypackage' } {
  const packageSha256 = resolved.packageSha256.trim().toLowerCase();
  if (!SHA256_HEX_RE.test(packageSha256)) {
    throw new Error(`Alias package '${packageId}' has an invalid raw artifact digest`);
  }

  return { packageSha256, sourceKind: resolved.sourceKind };
}

export type BackstageRepoConfig = {
  auth?: Auth;
  apiBaseUrl: string;
  enableSessionAccess?: boolean;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexSiteUrl: string;
  convexUrl: string;
  cdngine?: {
    accessToken?: string;
    apiBaseUrl: string;
    required?: boolean;
    timeoutMs?: number;
  };
};

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractForwardedToolchainPackages(repository: unknown): BackstageRepositoryPackages {
  if (!isRecord(repository) || !isRecord(repository.packages)) {
    throw new Error('Forwarded toolchain repository is missing a packages object.');
  }

  const forwardedPackages: BackstageRepositoryPackages = {};
  for (const packageId of YUCP_FORWARDED_TOOLCHAIN_PACKAGE_IDS) {
    const packageEntry = repository.packages[packageId];
    if (!isRecord(packageEntry) || !isRecord(packageEntry.versions)) {
      throw new Error(`Forwarded toolchain package '${packageId}' is missing versions.`);
    }
    forwardedPackages[packageId] = packageEntry;
  }

  return forwardedPackages;
}

async function fetchForwardedToolchainPackages(): Promise<BackstageRepositoryPackages> {
  try {
    const response = await fetchWithTimeout(
      BACKSTAGE_FORWARDED_UPSTREAM_REPOSITORY_URL,
      {
        headers: {
          accept: 'application/json',
        },
      },
      BACKSTAGE_FORWARDED_UPSTREAM_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(
        `Forwarded toolchain repository request failed with ${response.status} ${response.statusText}.`
      );
    }
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(contentLength) && contentLength > BACKSTAGE_FORWARDED_UPSTREAM_MAX_BYTES) {
      throw new Error('Forwarded toolchain repository response exceeded the byte limit.');
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > BACKSTAGE_FORWARDED_UPSTREAM_MAX_BYTES) {
      throw new Error('Forwarded toolchain repository response exceeded the byte limit.');
    }
    return extractForwardedToolchainPackages(JSON.parse(text));
  } catch (error) {
    logger.warn('Forwarded toolchain repository unavailable; serving creator packages only', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function mergeRepositoryPackages(
  repository: Record<string, unknown>,
  forwardedPackages: BackstageRepositoryPackages
): Record<string, unknown> {
  const packages = isRecord(repository.packages) ? { ...repository.packages } : {};
  for (const [packageId, packageEntry] of Object.entries(forwardedPackages)) {
    packages[packageId] = packageEntry;
  }
  return {
    ...repository,
    packages,
  };
}

function buildBackstageAddRepoUrl(repositoryUrl: string, repoToken: string): string {
  const addRepoUrl = new URL('vcc://vpm/addRepo');
  addRepoUrl.searchParams.set('url', repositoryUrl);
  addRepoUrl.searchParams.append('headers[]', `${BACKSTAGE_REPO_TOKEN_HEADER}:${repoToken}`);
  return addRepoUrl.toString();
}

function getConfiguredCdngine(
  config: BackstageRepoConfig
): ConfiguredCdngineBackstageDelivery | null {
  if (!config.cdngine?.apiBaseUrl || !config.cdngine.accessToken) {
    return null;
  }
  return {
    ...config.cdngine,
    accessToken: config.cdngine.accessToken,
    apiBaseUrl: config.cdngine.apiBaseUrl.replace(/\/+$/, ''),
  };
}

function isCdngineVersionNotReady(status: number, payload: Record<string, unknown>): boolean {
  if (status !== 409) {
    return false;
  }
  const type = typeof payload.type === 'string' ? payload.type : '';
  const title = typeof payload.title === 'string' ? payload.title : '';
  const detail = typeof payload.detail === 'string' ? payload.detail : '';
  return (
    type.includes('version-not-ready') ||
    title.toLowerCase() === 'version not ready' ||
    detail.toLowerCase().includes('not ready')
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCdngineDownloadUrl(input: {
  access: { authUserId: string; subjectId: string; tokenId?: string; accessScopeId?: string };
  cdngine: ConfiguredCdngineBackstageDelivery;
  delivery: CdngineBackstageDeliveryReference;
  packageId: string;
  request: Request;
  resolved: BackstagePackageDownloadRecord | BackstageRawPackageDownloadRecord;
}): Promise<string> {
  const idempotencyHash = await sha256Hex(
    [
      'backstage-package-download-v1',
      input.access.authUserId,
      input.access.subjectId,
      input.access.tokenId ?? input.access.accessScopeId ?? '',
      input.packageId,
      input.resolved.version,
      input.resolved.channel,
      'artifactId' in input.resolved
        ? (input.resolved.deliveryArtifactId ??
          input.resolved.artifactId ??
          input.resolved.artifactKey ??
          '')
        : input.resolved.deliveryArtifactId,
      input.delivery.assetId,
      input.delivery.versionId,
      input.delivery.deliveryScopeId,
      input.delivery.variant,
    ].join('|')
  );
  const cdngineBaseUrl = input.cdngine.apiBaseUrl.replace(/\/+$/, '');
  const authorizeHeaders = {
    accept: 'application/json',
    authorization: `Bearer ${input.cdngine.accessToken}`,
    'content-type': 'application/json',
    ...(input.request.headers.get('traceparent')
      ? { traceparent: input.request.headers.get('traceparent') as string }
      : {}),
  };
  const response = await fetchWithTimeout(
    `${cdngineBaseUrl}/v1/assets/${encodeURIComponent(input.delivery.assetId)}/versions/${encodeURIComponent(input.delivery.versionId)}/deliveries/${encodeURIComponent(input.delivery.deliveryScopeId)}/authorize`,
    {
      body: JSON.stringify({
        responseFormat: 'url',
        variant: input.delivery.variant,
      }),
      headers: {
        ...authorizeHeaders,
        'idempotency-key': `backstage-download-${idempotencyHash}`,
      },
      method: 'POST',
    },
    input.cdngine.timeoutMs ?? 5000
  );
  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (response.ok) {
    if (typeof payload.url !== 'string' || payload.url.length === 0) {
      throw new Error('CDNgine delivery authorization did not return a URL.');
    }
    return new URL(payload.url, `${cdngineBaseUrl}/`).toString();
  }

  if (response.status !== 404 && !isCdngineVersionNotReady(response.status, payload)) {
    const detail = typeof payload.detail === 'string' ? payload.detail : response.statusText;
    throw new Error(`CDNgine delivery authorization failed: ${response.status} ${detail}`);
  }

  const sourceResponse = await fetchWithTimeout(
    `${cdngineBaseUrl}/v1/assets/${encodeURIComponent(input.delivery.assetId)}/versions/${encodeURIComponent(input.delivery.versionId)}/source/authorize`,
    {
      body: JSON.stringify({
        responseFormat: 'url',
      }),
      headers: {
        ...authorizeHeaders,
        'idempotency-key': `backstage-source-download-${idempotencyHash}`,
      },
      method: 'POST',
    },
    input.cdngine.timeoutMs ?? 5000
  );
  const sourceText = await sourceResponse.text();
  const sourcePayload =
    sourceText.length > 0 ? (JSON.parse(sourceText) as Record<string, unknown>) : {};
  if (!sourceResponse.ok) {
    const detail =
      typeof sourcePayload.detail === 'string' ? sourcePayload.detail : sourceResponse.statusText;
    throw new Error(`CDNgine source authorization failed: ${sourceResponse.status} ${detail}`);
  }
  if (typeof sourcePayload.url !== 'string' || sourcePayload.url.length === 0) {
    throw new Error('CDNgine source authorization did not return a URL.');
  }
  return new URL(sourcePayload.url, `${cdngineBaseUrl}/`).toString();
}

function buildHostedVerificationUrl(frontendBaseUrl: string, intentId: string): string {
  return `${frontendBaseUrl.replace(/\/$/, '')}/verify/purchase?intent=${encodeURIComponent(intentId)}`;
}

function parseCreatorRepoRoute(
  pathname: string
): { creatorRepoRef: string; routeType: 'index' | 'package' } | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== 'backstage' || parts[2] !== 'repos') {
    return null;
  }

  const creatorRepoRef = safeDecodeURIComponent(parts[3] ?? '')?.trim();
  if (!creatorRepoRef) {
    return null;
  }

  if (parts[4] === 'index.json') {
    return { creatorRepoRef, routeType: 'index' };
  }
  if (parts[4] === 'package') {
    return { creatorRepoRef, routeType: 'package' };
  }
  return null;
}

function getAllowedOrigins(config: BackstageRepoConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

function normalizeFrontendReturnUrl(config: BackstageRepoConfig, value: string): string | null {
  try {
    const frontendBase = new URL(config.frontendBaseUrl);
    const returnUrl = new URL(value, frontendBase);
    if (returnUrl.origin !== frontendBase.origin) {
      return null;
    }
    return returnUrl.toString();
  } catch {
    return null;
  }
}

function buildBuyerAccessRequirements(product: PublicBackstageAccessRecord) {
  const descriptor = getProviderDescriptor(product.provider);
  if (!descriptor) {
    throw new Error(`Provider '${product.provider}' is not registered`);
  }

  const supportsAccountLink =
    descriptor.buyerVerificationMethods.includes('account_link') &&
    descriptor.supportsBuyerOAuthLink === true &&
    Boolean(getVerificationConfig(product.provider));
  const supportsManualLicense = descriptor.buyerVerificationMethods.includes('license_key');
  const requirements = [];

  if (supportsAccountLink) {
    requirements.push({
      methodKey: `${product.provider}-entitlement`,
      providerKey: product.provider,
      kind: 'existing_entitlement' as const,
      creatorAuthUserId: product.creatorAuthUserId,
      productId: product.productId,
    });
    requirements.push({
      methodKey: `${product.provider}-account-link`,
      providerKey: product.provider,
      kind: 'buyer_provider_link' as const,
      creatorAuthUserId: product.creatorAuthUserId,
      productId: product.productId,
    });
  }

  if (supportsManualLicense) {
    requirements.push({
      methodKey: `${product.provider}-license-key`,
      providerKey: product.provider,
      kind: 'manual_license' as const,
      providerProductRef: product.providerProductRef,
    });
  }

  if (requirements.length === 0) {
    throw new Error(`Provider '${product.provider}' does not support buyer verification`);
  }

  return normalizeHostedVerificationRequirements(requirements);
}

async function requireSessionAuthUserId(
  request: Request,
  config: BackstageRepoConfig
): Promise<string | Response> {
  if (!config.auth) {
    return errorResponse('Authentication required', 401);
  }

  const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins(config));
  if (csrfBlock) {
    return csrfBlock;
  }

  const session = await config.auth.getSession(request);
  if (!session) {
    return errorResponse('Authentication required', 401);
  }

  return session.user.id;
}

async function getPublicProductAccess(
  config: BackstageRepoConfig,
  creatorRef: string,
  productRef: string,
  actorBinding?: ApiActorBinding
): Promise<{
  access: PublicBackstageAccessRecord;
  creatorRepoIdentity: CreatorRepoIdentity;
} | null> {
  const actor =
    actorBinding ??
    (await createApiServiceActorBinding({
      service: 'backstage-access',
      scopes: ['creator:delegate'],
    }));
  const convex = getConvexClientFromUrl(config.convexUrl, actor);
  const access = (await convex.query(api.packageRegistry.getPublicBackstageProductAccessByRef, {
    apiSecret: config.convexApiSecret,
    creatorRef,
    productRef,
  })) as PublicBackstageAccessRecord | null;
  if (!access) {
    return null;
  }

  const creatorRepoIdentity = await getCreatorRepoIdentity({
    convex,
    convexApiSecret: config.convexApiSecret,
    authUserId: access.creatorAuthUserId,
  });

  return { access, creatorRepoIdentity };
}

async function getActiveSubjectId(
  convex: ReturnType<typeof getConvexClientFromUrl>,
  config: BackstageRepoConfig,
  authUserId: string
): Promise<Id<'subjects'> | null> {
  const subject = await convex.query(api.backstageRepos.getSubjectByAuthUserForApi, {
    apiSecret: config.convexApiSecret,
    authUserId,
  });
  return subject?._id ?? null;
}

async function authenticateBackstageAccess(
  request: Request,
  config: BackstageRepoConfig,
  auth?: Auth
): Promise<BackstageAccessViewer | Response> {
  const authHeader = request.headers.get('authorization')?.trim() ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const verified = await verifyBetterAuthAccessToken(authHeader.slice('Bearer '.length).trim(), {
      convexSiteUrl: config.convexSiteUrl,
      audience: 'yucp-public-api',
      requiredScopes: ['products:read'],
      logger,
      logContext: 'Backstage repo access token verification failed',
    });
    if (!verified.ok) {
      if (verified.reason === 'insufficient_scope') {
        return errorResponse('Token missing required scope: products:read', 403);
      }
      return errorResponse('Invalid or expired token', 401);
    }

    return {
      authUserId: verified.token.sub,
      actorBinding: await createAuthUserActorBinding({
        authUserId: verified.token.sub,
        source: 'oauth',
        scopes: ['products:read'],
      }),
    };
  }

  if (!auth) {
    return errorResponse('Authorization: Bearer <access_token> required', 401);
  }

  const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins(config));
  if (csrfBlock) {
    return csrfBlock;
  }

  const session = await auth.getSession(request);
  if (!session) {
    return errorResponse('Authentication required', 401);
  }

  return {
    authUserId: session.user.id,
    actorBinding: await createAuthUserActorBinding({
      authUserId: session.user.id,
      source: 'session',
    }),
  };
}

async function resolveRepoAccess(
  request: Request,
  config: BackstageRepoConfig,
  expectedCreatorRepoRef?: string
): Promise<
  | {
      ok: true;
      rawToken: string;
      tokenId: string;
      authUserId: string;
      subjectId: string;
      creatorRepoIdentity: CreatorRepoIdentity;
    }
  | { ok: false }
> {
  const rawToken = request.headers.get(BACKSTAGE_REPO_TOKEN_HEADER)?.trim() ?? '';
  if (!rawToken) {
    return { ok: false };
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const access = await convex.query(api.backstageRepos.getRepoAccessByTokenForApi, {
    apiSecret: config.convexApiSecret,
    tokenHash: await sha256Hex(rawToken),
  });
  if (!access) {
    return { ok: false };
  }

  const creatorRepoIdentity = await getCreatorRepoIdentity({
    convex,
    convexApiSecret: config.convexApiSecret,
    authUserId: access.authUserId,
  });
  if (expectedCreatorRepoRef && creatorRepoIdentity.creatorRepoRef !== expectedCreatorRepoRef) {
    return { ok: false };
  }

  await convex.mutation(api.backstageRepos.touchRepoTokenForApi, {
    apiSecret: config.convexApiSecret,
    tokenId: access.tokenId,
  });

  return {
    ok: true,
    rawToken,
    tokenId: access.tokenId,
    authUserId: access.authUserId,
    subjectId: access.subjectId,
    creatorRepoIdentity,
  };
}

async function issueRepoAccess(
  request: Request,
  config: BackstageRepoConfig,
  auth?: Auth
): Promise<Response> {
  const viewer = await authenticateBackstageAccess(request, config, auth);
  if (viewer instanceof Response) {
    return viewer;
  }

  const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);
  const subjectId = await getActiveSubjectId(convex, config, viewer.authUserId);
  if (!subjectId) {
    return errorResponse('No active subject found for this account', 404);
  }

  const requestUrl = new URL(request.url);
  let repoAuthUserId = viewer.authUserId;
  let repoLabel = 'VCC Backstage Repos';

  const requestedCatalogProductId = requestUrl.searchParams.get('catalogProductId')?.trim() ?? '';
  const requestedCreatorRef = requestUrl.searchParams.get('creatorRef')?.trim() ?? '';
  const requestedProductRef = requestUrl.searchParams.get('productRef')?.trim() ?? '';
  if (requestedCatalogProductId) {
    const product = (await convex.query(
      api.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        apiSecret: config.convexApiSecret,
        catalogProductId: requestedCatalogProductId as Id<'product_catalog'>,
      }
    )) as BuyerAccessCatalogProduct | null;
    if (!product) {
      return errorResponse('Alias product access not found', 404);
    }
    const creatorRef = product.creatorAuthUserId?.trim();
    const productRef = product.canonicalSlug?.trim() || product.providerProductRef?.trim();
    if (!creatorRef || !productRef) {
      throw new Error('Alias product access context was incomplete.');
    }
    const plan = (await convex.query(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
      apiSecret: config.convexApiSecret,
      authUserId: product.creatorAuthUserId,
      subjectId,
      creatorRef,
      productRef,
    })) as AuthorizedAliasInstallPlanRecord | null;
    if (!plan) {
      return errorResponse('Alias install plan not found', 404);
    }
    repoAuthUserId = product.creatorAuthUserId;
    repoLabel = `VCC Backstage Repos: ${productRef}`;
  } else if (requestedCreatorRef || requestedProductRef) {
    if (!requestedCreatorRef || !requestedProductRef) {
      return errorResponse('creatorRef and productRef are both required', 400);
    }
    const resolved = await getPublicProductAccess(
      config,
      requestedCreatorRef,
      requestedProductRef,
      viewer.actorBinding
    );
    if (!resolved) {
      return errorResponse('Product not found', 404);
    }
    const plan = (await convex.query(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
      apiSecret: config.convexApiSecret,
      authUserId: resolved.access.creatorAuthUserId,
      subjectId,
      creatorRef: requestedCreatorRef,
      productRef: requestedProductRef,
    })) as AuthorizedAliasInstallPlanRecord | null;
    if (!plan) {
      return errorResponse('Alias install plan not found', 404);
    }
    repoAuthUserId = resolved.access.creatorAuthUserId;
    repoLabel = `VCC Backstage Repos: ${requestedCreatorRef}/${requestedProductRef}`;
  }

  const now = Date.now();
  const issued = await convex.mutation(api.backstageRepos.issueRepoTokenForApi, {
    apiSecret: config.convexApiSecret,
    authUserId: repoAuthUserId,
    subjectAuthUserId: viewer.authUserId,
    subjectId,
    label: repoLabel,
    expiresAt: now + BACKSTAGE_REPO_TOKEN_TTL_MS,
  });

  const creatorRepoIdentity = await getCreatorRepoIdentity({
    convex,
    convexApiSecret: config.convexApiSecret,
    authUserId: repoAuthUserId,
  });
  const repositoryUrl = buildBackstageRepositoryUrls(
    config.apiBaseUrl,
    creatorRepoIdentity.creatorRepoRef
  ).repositoryUrl;
  const addRepoUrl = buildBackstageAddRepoUrl(repositoryUrl, issued.token);
  if (requestUrl.searchParams.get('mode') === 'redirect') {
    return Response.redirect(addRepoUrl, 302);
  }

  return jsonResponse({
    creatorName: creatorRepoIdentity.creatorName,
    creatorRepoRef: creatorRepoIdentity.creatorRepoRef,
    repositoryUrl,
    repositoryName: creatorRepoIdentity.repositoryName,
    addRepoUrl,
    expiresAt: issued.expiresAt,
  });
}

async function issueAuthorizedAliasInstallPlan(
  request: Request,
  config: BackstageRepoConfig,
  creatorRef: string,
  productRef: string
): Promise<Response> {
  const viewer = await authenticateBackstageAccess(request, config, config.auth);
  if (viewer instanceof Response) {
    return viewer;
  }

  try {
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);
    const subjectId = await getActiveSubjectId(convex, config, viewer.authUserId);
    if (!subjectId) {
      return errorResponse('No active subject found for this account', 404);
    }

    const resolved = await getPublicProductAccess(
      config,
      creatorRef,
      productRef,
      viewer.actorBinding
    );
    if (!resolved) {
      return errorResponse('Alias install plan not found', 404);
    }

    const plan = (await convex.query(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
      apiSecret: config.convexApiSecret,
      authUserId: resolved.access.creatorAuthUserId,
      subjectId,
      creatorRef,
      productRef,
    })) as AuthorizedAliasInstallPlanRecord | null;
    if (!plan) {
      return errorResponse('Alias install plan not found', 404);
    }

    return await buildAuthorizedAliasInstallPlanResponse(
      config,
      convex,
      plan,
      subjectId,
      String(resolved.access.catalogProductId)
    );
  } catch (error) {
    logger.error('Failed to issue alias install plan', {
      authUserId: viewer.authUserId,
      creatorRef,
      productRef,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to issue alias install plan', 500);
  }
}

async function issueAuthorizedAliasInstallPlanForCatalogProduct(
  request: Request,
  config: BackstageRepoConfig,
  catalogProductId: string
): Promise<Response> {
  const viewer = await authenticateBackstageAccess(request, config, config.auth);
  if (viewer instanceof Response) {
    return viewer;
  }

  try {
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);
    const subjectId = await getActiveSubjectId(convex, config, viewer.authUserId);
    if (!subjectId) {
      return errorResponse('No active subject found for this account', 404);
    }

    const product = (await convex.query(
      api.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        apiSecret: config.convexApiSecret,
        catalogProductId: catalogProductId as Id<'product_catalog'>,
      }
    )) as BuyerAccessCatalogProduct | null;
    if (!product) {
      return errorResponse('Alias product access not found', 404);
    }

    const creatorRef = product.creatorAuthUserId?.trim();
    const productRef = product.canonicalSlug?.trim() || product.providerProductRef?.trim();
    if (!creatorRef || !productRef) {
      throw new Error('Alias product access context was incomplete.');
    }

    const plan = (await convex.query(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
      apiSecret: config.convexApiSecret,
      authUserId: product.creatorAuthUserId,
      subjectId,
      creatorRef,
      productRef,
    })) as AuthorizedAliasInstallPlanRecord | null;
    if (!plan) {
      return errorResponse('Alias install plan not found', 404);
    }

    return await buildAuthorizedAliasInstallPlanResponse(
      config,
      convex,
      plan,
      subjectId,
      catalogProductId
    );
  } catch (error) {
    logger.error('Failed to issue catalog-product alias install plan', {
      authUserId: viewer.authUserId,
      catalogProductId,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to issue alias install plan', 500);
  }
}

async function buildAuthorizedAliasInstallPlanResponse(
  config: BackstageRepoConfig,
  convex: ReturnType<typeof getConvexClientFromUrl>,
  plan: AuthorizedAliasInstallPlanRecord,
  subjectId: string,
  catalogProductId: string
): Promise<Response> {
  const creatorRepoIdentity = await getCreatorRepoIdentity({
    convex,
    convexApiSecret: config.convexApiSecret,
    authUserId: plan.creatorAuthUserId,
  });
  const repositoryUrl = buildBackstageRepositoryUrls(
    config.apiBaseUrl,
    creatorRepoIdentity.creatorRepoRef
  ).repositoryUrl;

  return jsonResponse({
    kind: 'alias-install-plan-v1',
    expiresAt: Date.now() + BACKSTAGE_ALIAS_INSTALL_PLAN_TTL_MS,
    creatorName: creatorRepoIdentity.creatorName,
    creatorRepoRef: creatorRepoIdentity.creatorRepoRef,
    productRef: plan.canonicalSlug ?? plan.providerProductRef,
    title: plan.displayName ?? plan.packages[0]?.displayName ?? plan.providerProductRef,
    thumbnailUrl: plan.thumbnailUrl,
    repositoryUrl,
    packages: await Promise.all(
      plan.packages.map(async (pkg) => {
        const importerDelivery = buildBackstageImporterDelivery(pkg.aliasContract);
        if (!importerDelivery) {
          throw new Error(`Alias package '${pkg.packageId}' is missing importer delivery metadata`);
        }
        const resolvedDownload = (await convex.query(
          api.backstageRepos.resolveRawPackageDownloadForApi,
          {
            apiSecret: config.convexApiSecret,
            authUserId: plan.creatorAuthUserId,
            subjectId: subjectId as Id<'subjects'>,
            packageId: pkg.packageId,
            version: pkg.version,
            channel: pkg.channel,
          }
        )) as BackstageRawPackageDownloadRecord | null;
        if (!resolvedDownload) {
          throw new Error(
            `Alias package '${pkg.packageId}' is missing a package delivery artifact`
          );
        }
        const installableDownload = requireInstallableBackstageRawPackageDownload(
          resolvedDownload,
          pkg.packageId
        );
        return {
          packageId: pkg.packageId,
          displayName: pkg.displayName,
          version: pkg.version,
          channel: pkg.channel,
          zipSha256: pkg.zipSha256,
          packageSha256: installableDownload.packageSha256,
          sourceKind: installableDownload.sourceKind,
          downloadAuthorizationUrl: `${config.apiBaseUrl.replace(/\/+$/, '')}/api/backstage/access/products/${encodeURIComponent(catalogProductId)}/packages/${encodeURIComponent(pkg.packageId)}/download`,
          aliasContract: pkg.aliasContract,
          importerDelivery,
        };
      })
    ),
  });
}

async function readRequestTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyError('Request body too large', 413);
  }
  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        throw new RequestBodyError('Request body too large', 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bodyBytes);
}

async function parseJsonObjectBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readRequestTextWithLimit(request, BACKSTAGE_RAW_DOWNLOAD_BODY_MAX_BYTES);
  if (!text.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError('Invalid JSON body', 400);
  }
  if (!isRecord(parsed)) {
    throw new RequestBodyError('Request body must be a JSON object.', 400);
  }
  return parsed;
}

function readOptionalBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

async function issueAuthorizedRawPackageDownloadForCatalogProduct(
  request: Request,
  config: BackstageRepoConfig,
  catalogProductId: string,
  packageId: string
): Promise<Response> {
  const viewer = await authenticateBackstageAccess(request, config, config.auth);
  if (viewer instanceof Response) {
    return viewer;
  }

  try {
    const body = await parseJsonObjectBody(request);
    const requestedVersion = readOptionalBodyString(body, 'version');
    const requestedChannel = readOptionalBodyString(body, 'channel');
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);
    const subjectId = await getActiveSubjectId(convex, config, viewer.authUserId);
    if (!subjectId) {
      return errorResponse('No active subject found for this account', 404);
    }

    const product = (await convex.query(
      api.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        apiSecret: config.convexApiSecret,
        catalogProductId: catalogProductId as Id<'product_catalog'>,
      }
    )) as BuyerAccessCatalogProduct | null;
    if (!product) {
      return errorResponse('Alias product access not found', 404);
    }

    const creatorRef = product.creatorAuthUserId?.trim();
    const productRef = product.canonicalSlug?.trim() || product.providerProductRef?.trim();
    if (!creatorRef || !productRef) {
      throw new Error('Alias product access context was incomplete.');
    }

    const plan = (await convex.query(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
      apiSecret: config.convexApiSecret,
      authUserId: product.creatorAuthUserId,
      subjectId,
      creatorRef,
      productRef,
    })) as AuthorizedAliasInstallPlanRecord | null;
    const planPackage = plan?.packages.find((pkg) => pkg.packageId === packageId);
    if (!planPackage) {
      return errorResponse('Package not found', 404);
    }

    const version = requestedVersion ?? planPackage.version;
    const channel = requestedChannel ?? planPackage.channel;
    if (version !== planPackage.version || channel !== planPackage.channel) {
      return errorResponse('Package not found', 404);
    }

    const resolved = (await convex.query(api.backstageRepos.resolveRawPackageDownloadForApi, {
      apiSecret: config.convexApiSecret,
      authUserId: product.creatorAuthUserId,
      subjectId,
      packageId,
      version,
      channel,
    })) as BackstageRawPackageDownloadRecord | null;
    if (!resolved) {
      return errorResponse('Package not found', 404);
    }
    const installableDownload = requireInstallableBackstageRawPackageDownload(resolved, packageId);

    let downloadUrl = resolved.downloadUrl;
    if (isCdngineBackstageDeliveryReference(resolved.cdngineDelivery)) {
      const cdngine = getConfiguredCdngine(config);
      if (!cdngine) {
        logger.error('CDNgine raw Backstage delivery is configured but not available', {
          authUserId: product.creatorAuthUserId,
          deliveryArtifactId: resolved.deliveryArtifactId,
          packageId,
          version,
          channel,
        });
        return errorResponse('Package delivery is temporarily unavailable', 502);
      }
      downloadUrl = await resolveCdngineDownloadUrl({
        access: {
          authUserId: product.creatorAuthUserId,
          subjectId,
          accessScopeId: `catalog-product:${catalogProductId}`,
        },
        cdngine,
        delivery: resolved.cdngineDelivery,
        packageId,
        request,
        resolved,
      });
    }

    if (!downloadUrl) {
      return errorResponse('Package delivery is temporarily unavailable', 502);
    }

    return jsonResponse({
      downloadUrl,
      packageSha256: installableDownload.packageSha256,
      sourceKind: installableDownload.sourceKind,
      version: resolved.version,
      channel: resolved.channel,
      contentType: resolved.contentType,
      deliveryName: resolved.deliveryName,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return errorResponse(error.message, error.status);
    }
    logger.error('Failed to authorize raw package download', {
      authUserId: viewer.authUserId,
      catalogProductId,
      packageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to authorize package download', 500);
  }
}

async function getBuyerAccessInfo(
  config: BackstageRepoConfig,
  creatorRef: string,
  productRef: string
): Promise<Response> {
  const resolved = await getPublicProductAccess(config, creatorRef, productRef);
  if (!resolved) {
    return errorResponse('Product not found', 404);
  }

  const packageSummaries = resolved.access.packageSummaries.map((summary) => ({
    ...summary,
    importerDelivery: buildBackstageImporterDelivery(summary.aliasContract),
  }));
  const primaryPackage = packageSummaries[0] ?? null;

  return jsonResponse({
    creatorName: resolved.creatorRepoIdentity.creatorName,
    creatorRepoRef: resolved.creatorRepoIdentity.creatorRepoRef,
    productRef: resolved.access.canonicalSlug ?? resolved.access.providerProductRef,
    title:
      resolved.access.displayName ??
      resolved.access.primaryPackageName ??
      resolved.access.providerProductRef,
    thumbnailUrl: resolved.access.thumbnailUrl,
    provider: resolved.access.provider,
    primaryPackageId: resolved.access.primaryPackageId,
    primaryPackage,
    packageSummaries,
    ready: Boolean(resolved.access.primaryPackageId),
  });
}

async function bootstrapBuyerVerificationIntent(
  request: Request,
  config: BackstageRepoConfig,
  creatorRef: string,
  productRef: string
): Promise<Response> {
  const authUserId = await requireSessionAuthUserId(request, config);
  if (authUserId instanceof Response) {
    return authUserId;
  }

  const actor = await createAuthUserActorBinding({
    authUserId,
    source: 'session',
  });
  const resolved = await getPublicProductAccess(config, creatorRef, productRef, actor);
  if (!resolved) {
    return errorResponse('Product not found', 404);
  }
  if (!resolved.access.primaryPackageId) {
    return errorResponse('This product is not ready for Unity yet', 409);
  }

  let body: {
    returnUrl?: string;
    machineFingerprint?: string;
    codeChallenge?: string;
    idempotencyKey?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!body.returnUrl || !body.machineFingerprint || !body.codeChallenge) {
    return errorResponse('returnUrl, machineFingerprint, and codeChallenge are required', 400);
  }
  const returnUrl = normalizeFrontendReturnUrl(config, body.returnUrl);
  if (!returnUrl) {
    return errorResponse('Invalid returnUrl', 400);
  }

  try {
    const convex = getConvexClientFromUrl(config.convexUrl);
    const requirements = buildBuyerAccessRequirements(resolved.access);
    const result = await convex.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: config.convexApiSecret,
      actor,
      authUserId,
      packageId: resolved.access.primaryPackageId,
      packageName:
        resolved.access.displayName ??
        resolved.access.primaryPackageName ??
        resolved.access.providerProductRef,
      machineFingerprint: body.machineFingerprint,
      codeChallenge: body.codeChallenge,
      returnUrl,
      idempotencyKey: body.idempotencyKey,
      requirements,
    });

    return jsonResponse({
      intentId: String(result.intentId),
      verificationUrl: buildHostedVerificationUrl(config.frontendBaseUrl, String(result.intentId)),
    });
  } catch (error) {
    logger.error('Failed to bootstrap buyer verification intent', {
      authUserId,
      creatorRef,
      productRef,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to start verification', 500);
  }
}

async function serveRepositoryIndex(
  request: Request,
  config: BackstageRepoConfig,
  expectedCreatorRepoRef?: string
): Promise<Response> {
  const access = await resolveRepoAccess(request, config, expectedCreatorRepoRef);
  if (!access.ok) {
    return errorResponse('Repository not found', 404);
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const repositoryUrls = buildBackstageRepositoryUrls(
    config.apiBaseUrl,
    access.creatorRepoIdentity.creatorRepoRef
  );
  try {
    const [repository, forwardedPackages] = await Promise.all([
      convex.query(api.backstageRepos.buildRepositoryForApi, {
        apiSecret: config.convexApiSecret,
        authUserId: access.authUserId,
        subjectId: access.subjectId,
        repositoryId: access.creatorRepoIdentity.repositoryId,
        repositoryName: access.creatorRepoIdentity.repositoryName,
        repositoryUrl: repositoryUrls.repositoryUrl,
        packageBaseUrl: repositoryUrls.packageBaseUrl,
        packageHeaders: {
          [BACKSTAGE_REPO_TOKEN_HEADER]: access.rawToken,
        },
      }),
      fetchForwardedToolchainPackages(),
    ]);

    if (!isRecord(repository)) {
      throw new Error('Backstage repository response was not an object.');
    }

    return jsonResponse(mergeRepositoryPackages(repository, forwardedPackages));
  } catch (error) {
    logger.error('Failed to build creator repository index', {
      authUserId: access.authUserId,
      creatorRepoRef: access.creatorRepoIdentity.creatorRepoRef,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to build repository', 500);
  }
}

async function servePackageDownload(
  request: Request,
  config: BackstageRepoConfig,
  expectedCreatorRepoRef?: string
): Promise<Response> {
  const access = await resolveRepoAccess(request, config, expectedCreatorRepoRef);
  if (!access.ok) {
    return errorResponse('Package not found', 404);
  }

  const requestUrl = new URL(request.url);
  const packageId = requestUrl.searchParams.get('packageId')?.trim() ?? '';
  const version = requestUrl.searchParams.get('version')?.trim() ?? '';
  const channel = requestUrl.searchParams.get('channel')?.trim() ?? '';
  if (!packageId || !version || !channel) {
    return errorResponse('packageId, version, and channel are required', 400);
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const resolved = (await convex.query(api.backstageRepos.resolvePackageDownloadForApi, {
    apiSecret: config.convexApiSecret,
    authUserId: access.authUserId,
    subjectId: access.subjectId,
    packageId,
    version,
    channel,
  })) as BackstagePackageDownloadRecord | null;
  if (!resolved) {
    return errorResponse('Package not found', 404);
  }
  const cdngine = getConfiguredCdngine(config);
  if (isCdngineBackstageDeliveryReference(resolved.cdngineDelivery)) {
    if (!cdngine) {
      logger.error('CDNgine Backstage delivery is configured on the release but not on the API', {
        authUserId: access.authUserId,
        deliveryArtifactId: resolved.deliveryArtifactId,
        packageId,
        version,
        channel,
      });
      return errorResponse('Package delivery is temporarily unavailable', 502);
    }
    try {
      const cdngineUrl = await resolveCdngineDownloadUrl({
        access,
        cdngine,
        delivery: resolved.cdngineDelivery,
        packageId,
        request,
        resolved,
      });
      return Response.redirect(cdngineUrl, 302);
    } catch (error) {
      logger.warn('CDNgine Backstage delivery authorization failed', {
        authUserId: access.authUserId,
        deliveryArtifactId: resolved.deliveryArtifactId,
        packageId,
        version,
        channel,
        required: cdngine.required === true,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!resolved.downloadUrl) {
        return errorResponse('Package delivery is temporarily unavailable', 502);
      }
      if (cdngine.required === true) {
        return errorResponse('Package delivery is temporarily unavailable', 502);
      }
    }
  }
  if (!resolved.downloadUrl) {
    return errorResponse('Package delivery is temporarily unavailable', 502);
  }
  return Response.redirect(resolved.downloadUrl, 302);
}

export function createBackstageRepoRoutes(config: BackstageRepoConfig) {
  return {
    async handleRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const creatorRepoRoute = parseCreatorRepoRoute(url.pathname);
      const buyerAccessMatch = url.pathname.match(/^\/api\/backstage\/access\/([^/]+)\/([^/]+)$/);
      const buyerInstallPlanMatch = url.pathname.match(
        /^\/api\/backstage\/access\/([^/]+)\/([^/]+)\/install-plan$/
      );
      const buyerCatalogInstallPlanMatch = url.pathname.match(
        /^\/api\/backstage\/access\/products\/([^/]+)\/install-plan$/
      );
      const buyerCatalogPackageDownloadMatch = url.pathname.match(
        /^\/api\/backstage\/access\/products\/([^/]+)\/packages\/([^/]+)\/download$/
      );
      const buyerIntentMatch = url.pathname.match(
        /^\/api\/backstage\/access\/([^/]+)\/([^/]+)\/verification-intent$/
      );
      if (request.method === 'GET' && url.pathname === '/v1/backstage/repos/access') {
        return await issueRepoAccess(request, config);
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/backstage/repos/access' &&
        config.enableSessionAccess === true
      ) {
        return await issueRepoAccess(request, config, config.auth);
      }
      if (request.method === 'GET' && creatorRepoRoute?.routeType === 'index') {
        return await serveRepositoryIndex(request, config, creatorRepoRoute.creatorRepoRef);
      }
      if (request.method === 'GET' && creatorRepoRoute?.routeType === 'package') {
        return await servePackageDownload(request, config, creatorRepoRoute.creatorRepoRef);
      }
      if (request.method === 'POST' && buyerCatalogPackageDownloadMatch) {
        const catalogProductId = safeDecodeURIComponent(buyerCatalogPackageDownloadMatch[1] ?? '');
        const packageId = safeDecodeURIComponent(buyerCatalogPackageDownloadMatch[2] ?? '');
        if (catalogProductId === null || packageId === null) {
          return errorResponse('Malformed path parameter encoding', 400);
        }
        return await issueAuthorizedRawPackageDownloadForCatalogProduct(
          request,
          config,
          catalogProductId,
          packageId
        );
      }
      if (request.method === 'GET' && buyerAccessMatch) {
        const creatorRef = safeDecodeURIComponent(buyerAccessMatch[1] ?? '');
        const productRef = safeDecodeURIComponent(buyerAccessMatch[2] ?? '');
        if (creatorRef === null || productRef === null) {
          return errorResponse('Malformed path parameter encoding', 400);
        }
        return await getBuyerAccessInfo(config, creatorRef, productRef);
      }
      if (request.method === 'POST' && buyerCatalogInstallPlanMatch) {
        const catalogProductId = safeDecodeURIComponent(buyerCatalogInstallPlanMatch[1] ?? '');
        if (catalogProductId === null) {
          return errorResponse('Malformed path parameter encoding', 400);
        }
        return await issueAuthorizedAliasInstallPlanForCatalogProduct(
          request,
          config,
          catalogProductId
        );
      }
      if (request.method === 'POST' && buyerInstallPlanMatch) {
        const creatorRef = safeDecodeURIComponent(buyerInstallPlanMatch[1] ?? '');
        const productRef = safeDecodeURIComponent(buyerInstallPlanMatch[2] ?? '');
        if (creatorRef === null || productRef === null) {
          return errorResponse('Malformed path parameter encoding', 400);
        }
        return await issueAuthorizedAliasInstallPlan(request, config, creatorRef, productRef);
      }
      if (request.method === 'POST' && buyerIntentMatch) {
        const creatorRef = safeDecodeURIComponent(buyerIntentMatch[1] ?? '');
        const productRef = safeDecodeURIComponent(buyerIntentMatch[2] ?? '');
        if (creatorRef === null || productRef === null) {
          return errorResponse('Malformed path parameter encoding', 400);
        }
        return await bootstrapBuyerVerificationIntent(request, config, creatorRef, productRef);
      }
      if (request.method === 'GET' && url.pathname === '/v1/backstage/repos/index.json') {
        return await serveRepositoryIndex(request, config);
      }
      if (request.method === 'GET' && url.pathname === '/v1/backstage/package') {
        return await servePackageDownload(request, config);
      }
      return null;
    },
  };
}
