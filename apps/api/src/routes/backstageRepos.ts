import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import type { ApiActorBinding } from '@yucp/shared/apiActor';
import {
  BACKSTAGE_PACKAGE_MEDIA_KINDS,
  type BackstagePackageMediaKind,
  type BackstagePackageMediaMap,
  type BackstagePackageMediaReference,
} from '@yucp/shared/backstagePackageMedia';
import {
  type CdngineBackstageDeliveryReference,
  type CdngineBackstageSourceReference,
  isCdngineBackstageDeliveryReference,
  isCdngineBackstageSourceReference,
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
import { authorizeCdngineBackstageSource } from '../lib/cdngineBackstage';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { verifyBetterAuthAccessToken } from '../lib/oauthAccessToken';
import {
  RequestBodyError,
  readJsonObjectBodyWithLimit,
  readRequestTextWithLimit,
} from '../lib/requestBody';
import { normalizeHostedVerificationRequirements } from '../verification/hostedIntents';
import { getVerificationConfig } from '../verification/verificationConfig';

const BACKSTAGE_REPO_TOKEN_HEADER = 'X-YUCP-Repo-Token';
const BACKSTAGE_REPO_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BACKSTAGE_ALIAS_INSTALL_PLAN_TTL_MS = 5 * 60 * 1000;
const BACKSTAGE_FORWARDED_UPSTREAM_TIMEOUT_MS = 2_000;
const BACKSTAGE_FORWARDED_UPSTREAM_MAX_BYTES = 1024 * 1024;
const BACKSTAGE_PACKAGE_DOWNLOAD_BODY_MAX_BYTES = 4 * 1024;
const BACKSTAGE_VERIFICATION_BOOTSTRAP_BODY_MAX_BYTES = 4 * 1024;
const BACKSTAGE_VERIFICATION_REDEEM_BODY_MAX_BYTES = 4 * 1024;
const CDNGINE_AUTHORIZATION_RESPONSE_MAX_BYTES = 16 * 1024;
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
    media?: BackstagePackageMediaMap;
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

type PublicBuyerAccessPackageSummary = {
  packageId: string;
  displayName?: string;
  latestPublishedVersion?: string;
  latestReleaseChannel?: string;
  importerDelivery?: ReturnType<typeof buildBackstageImporterDelivery>;
};

function resolvePublicProductRef(input: {
  canonicalSlug?: string;
  providerProductRef?: string;
}): string | null {
  return input.canonicalSlug?.trim() || input.providerProductRef?.trim() || null;
}

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
  cdngineSource?: CdngineBackstageSourceReference;
};

type ConfiguredCdngineBackstageDelivery = {
  accessToken: string;
  apiBaseUrl: string;
  required?: boolean;
  timeoutMs?: number;
};

function requireRawBackstagePackageDownload(
  resolved: BackstageRawPackageDownloadRecord,
  packageId: string
): {
  packageSha256: string;
  sourceKind: 'zip' | 'unitypackage';
  cdngineSource: CdngineBackstageSourceReference;
} {
  const packageSha256 = resolved.packageSha256?.trim().toLowerCase() ?? '';
  if (!SHA256_HEX_RE.test(packageSha256)) {
    throw new Error(`Alias package '${packageId}' has an invalid raw package digest`);
  }
  if (!isCdngineBackstageSourceReference(resolved.cdngineSource)) {
    throw new Error(`Alias package '${packageId}' is missing CDNgine source coordinates`);
  }
  return {
    packageSha256,
    sourceKind: resolved.sourceKind,
    cdngineSource: resolved.cdngineSource,
  };
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

function redirectNoStore(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
    },
  });
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
    const text = await readResponseTextWithLimit(
      response,
      BACKSTAGE_FORWARDED_UPSTREAM_MAX_BYTES,
      'Forwarded toolchain repository response exceeded the byte limit.'
    );
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

type CdngineDeliveryAuthorizationResult =
  | {
      ok: true;
      url: string;
    }
  | {
      ok: false;
      payload: Record<string, unknown>;
      status: number;
      statusText: string;
    };

function parseCdngineJsonObject(text: string): Record<string, unknown> {
  if (text.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { detail: text };
  } catch {
    return { detail: text };
  }
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  errorMessage: string
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel('response body exceeded limit').catch(() => undefined);
      throw new Error(errorMessage);
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

function isCdngineBackstageDependencyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('CDNgine');
}

async function authorizeCdngineBackstageDeliveryUrl(input: {
  cdngine: ConfiguredCdngineBackstageDelivery;
  delivery: CdngineBackstageDeliveryReference;
  idempotencyKey: string;
  request: Request;
  variant?: string;
}): Promise<CdngineDeliveryAuthorizationResult> {
  const cdngineBaseUrl = input.cdngine.apiBaseUrl.replace(/\/+$/, '');
  const response = await fetchWithTimeout(
    `${cdngineBaseUrl}/v1/assets/${encodeURIComponent(input.delivery.assetId)}/versions/${encodeURIComponent(input.delivery.versionId)}/deliveries/${encodeURIComponent(input.delivery.deliveryScopeId)}/authorize`,
    {
      body: JSON.stringify({
        responseFormat: 'url',
        variant: input.variant ?? input.delivery.variant,
      }),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.cdngine.accessToken}`,
        'content-type': 'application/json',
        'idempotency-key': input.idempotencyKey,
        ...(input.request.headers.get('traceparent')
          ? { traceparent: input.request.headers.get('traceparent') as string }
          : {}),
      },
      method: 'POST',
    },
    input.cdngine.timeoutMs ?? 5000
  );
  const text = await readResponseTextWithLimit(
    response,
    CDNGINE_AUTHORIZATION_RESPONSE_MAX_BYTES,
    'CDNgine authorization response exceeded the byte limit.'
  );
  const payload = parseCdngineJsonObject(text);
  if (!response.ok) {
    return {
      ok: false,
      payload,
      status: response.status,
      statusText: response.statusText,
    };
  }
  if (typeof payload.url !== 'string' || payload.url.length === 0) {
    throw new Error('CDNgine delivery authorization did not return a URL.');
  }
  return {
    ok: true,
    url: new URL(payload.url, `${cdngineBaseUrl}/`).toString(),
  };
}

async function resolveCdngineDownloadUrl(input: {
  access: { authUserId: string; subjectId: string; tokenId?: string; accessScopeId?: string };
  cdngine: ConfiguredCdngineBackstageDelivery;
  delivery: CdngineBackstageDeliveryReference;
  packageId: string;
  request: Request;
  resolved: BackstagePackageDownloadRecord;
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
  const deliveryAuthorization = await authorizeCdngineBackstageDeliveryUrl({
    cdngine: input.cdngine,
    delivery: input.delivery,
    idempotencyKey: `backstage-download-${idempotencyHash}`,
    request: input.request,
  });
  if (deliveryAuthorization.ok) {
    return deliveryAuthorization.url;
  }

  const detail =
    typeof deliveryAuthorization.payload.detail === 'string'
      ? deliveryAuthorization.payload.detail
      : deliveryAuthorization.statusText;
  throw new Error(
    `CDNgine delivery authorization failed: ${deliveryAuthorization.status} ${detail}`
  );
}

async function resolveCdngineSourceDownloadUrl(input: {
  access: { authUserId: string; subjectId: string; tokenId?: string; accessScopeId?: string };
  cdngine: ConfiguredCdngineBackstageDelivery;
  packageId: string;
  resolved: BackstageRawPackageDownloadRecord;
  source: CdngineBackstageSourceReference;
}): Promise<string> {
  const idempotencyHash = await sha256Hex(
    [
      'backstage-package-source-download-v1',
      input.access.authUserId,
      input.access.subjectId,
      input.access.tokenId ?? input.access.accessScopeId ?? '',
      input.packageId,
      input.resolved.version,
      input.resolved.channel,
      input.resolved.deliveryArtifactId,
      input.source.assetId,
      input.source.versionId,
    ].join('|')
  );
  return await authorizeCdngineBackstageSource({
    config: input.cdngine,
    source: input.source,
    idempotencyKey: `backstage-source-download-${idempotencyHash}`,
  });
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
      creatorAuthUserId: product.creatorAuthUserId,
      productId: product.productId,
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
    actor,
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

async function resolveAliasInstallPlanActor(
  viewer: BackstageAccessViewer,
  creatorAuthUserId: string
): Promise<ApiActorBinding> {
  if (viewer.authUserId === creatorAuthUserId) {
    return viewer.actorBinding;
  }

  return await createApiServiceActorBinding({
    service: 'backstage-access',
    scopes: ['creator:delegate'],
    authUserId: creatorAuthUserId,
  });
}

async function getAuthorizedAliasInstallPlanForViewer(
  config: BackstageRepoConfig,
  viewer: BackstageAccessViewer,
  input: {
    authUserId: string;
    subjectId: Id<'subjects'>;
    creatorRef: string;
    productRef: string;
  }
): Promise<{
  convex: ReturnType<typeof getConvexClientFromUrl>;
  actor: ApiActorBinding;
  plan: AuthorizedAliasInstallPlanRecord | null;
}> {
  const actor = await resolveAliasInstallPlanActor(viewer, input.authUserId);
  const convex = getConvexClientFromUrl(config.convexUrl, actor);
  const plan = (await convex.query(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
    apiSecret: config.convexApiSecret,
    actor,
    authUserId: input.authUserId,
    subjectId: input.subjectId,
    creatorRef: input.creatorRef,
    productRef: input.productRef,
  })) as AuthorizedAliasInstallPlanRecord | null;

  return { convex, actor, plan };
}

async function getActiveSubjectId(
  convex: ReturnType<typeof getConvexClientFromUrl>,
  config: BackstageRepoConfig,
  authUserId: string,
  actor: ApiActorBinding
): Promise<Id<'subjects'> | null> {
  const subject = await convex.query(api.backstageRepos.getSubjectByAuthUserForApi, {
    apiSecret: config.convexApiSecret,
    actor,
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
      tokenHash: string;
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
  const tokenHash = await sha256Hex(rawToken);
  const access = await convex.query(api.backstageRepos.getRepoAccessByTokenForApi, {
    apiSecret: config.convexApiSecret,
    tokenHash,
  });
  if (!access) {
    return { ok: false };
  }
  if (access.status !== 'active') {
    return { ok: false };
  }
  if (typeof access.expiresAt === 'number' && access.expiresAt <= Date.now()) {
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
    tokenHash,
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
  const subjectId = await getActiveSubjectId(
    convex,
    config,
    viewer.authUserId,
    viewer.actorBinding
  );
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
        actor: viewer.actorBinding,
        catalogProductId: requestedCatalogProductId,
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
    const { plan } = await getAuthorizedAliasInstallPlanForViewer(config, viewer, {
      authUserId: product.creatorAuthUserId,
      subjectId,
      creatorRef,
      productRef,
    });
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
    const { plan } = await getAuthorizedAliasInstallPlanForViewer(config, viewer, {
      authUserId: resolved.access.creatorAuthUserId,
      subjectId,
      creatorRef: requestedCreatorRef,
      productRef: requestedProductRef,
    });
    if (!plan) {
      return errorResponse('Alias install plan not found', 404);
    }
    repoAuthUserId = resolved.access.creatorAuthUserId;
    repoLabel = `VCC Backstage Repos: ${requestedCreatorRef}/${requestedProductRef}`;
  }

  const now = Date.now();
  const issued = await convex.mutation(api.backstageRepos.issueRepoTokenForApi, {
    apiSecret: config.convexApiSecret,
    actor: viewer.actorBinding,
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
    return redirectNoStore(addRepoUrl);
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
    const subjectId = await getActiveSubjectId(
      convex,
      config,
      viewer.authUserId,
      viewer.actorBinding
    );
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

    const {
      convex: planConvex,
      actor: planActor,
      plan,
    } = await getAuthorizedAliasInstallPlanForViewer(config, viewer, {
      authUserId: resolved.access.creatorAuthUserId,
      subjectId,
      creatorRef,
      productRef,
    });
    if (!plan) {
      return errorResponse('Alias install plan not found', 404);
    }

    const publicCatalogProductRef = resolvePublicProductRef(resolved.access);
    if (!publicCatalogProductRef) {
      throw new Error('Alias product access context was incomplete.');
    }

    return await buildAuthorizedAliasInstallPlanResponse(
      config,
      planConvex,
      planActor,
      plan,
      subjectId,
      publicCatalogProductRef,
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

  // Optional machine fingerprint: when present, the install plan mints a machine-bound
  // license token per package so the client can apply per-buyer coupling. Absent/malformed
  // body is non-fatal, the plan is still issued, just without coupling tokens.
  let machineFingerprint: string | null = null;
  try {
    const rawBody = await readRequestTextWithLimit(request, 4096);
    if (rawBody) {
      const parsedBody = JSON.parse(rawBody) as { machineFingerprint?: unknown };
      if (
        typeof parsedBody.machineFingerprint === 'string' &&
        parsedBody.machineFingerprint.trim().length > 0
      ) {
        machineFingerprint = parsedBody.machineFingerprint.trim();
      }
    }
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return errorResponse(error.message, error.status);
    }
    machineFingerprint = null;
  }

  try {
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);
    const subjectId = await getActiveSubjectId(
      convex,
      config,
      viewer.authUserId,
      viewer.actorBinding
    );
    if (!subjectId) {
      return errorResponse('No active subject found for this account', 404);
    }

    const product = (await convex.query(
      api.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        catalogProductId,
      }
    )) as BuyerAccessCatalogProduct | null;
    if (!product) {
      return errorResponse('Alias product access not found', 404);
    }

    const creatorRef = product.creatorAuthUserId?.trim();
    const productRef = resolvePublicProductRef(product);
    if (!creatorRef || !productRef) {
      throw new Error('Alias product access context was incomplete.');
    }

    const {
      convex: planConvex,
      actor: planActor,
      plan,
    } = await getAuthorizedAliasInstallPlanForViewer(config, viewer, {
      authUserId: product.creatorAuthUserId,
      subjectId,
      creatorRef,
      productRef,
    });
    if (!plan) {
      return errorResponse('Alias install plan not found', 404);
    }

    return await buildAuthorizedAliasInstallPlanResponse(
      config,
      planConvex,
      planActor,
      plan,
      subjectId,
      productRef,
      String(product.catalogProductId),
      machineFingerprint
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
  actor: ApiActorBinding,
  plan: AuthorizedAliasInstallPlanRecord,
  subjectId: string,
  publicCatalogProductRef: string,
  resolvedCatalogProductId: string,
  machineFingerprint: string | null = null
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
    productRef: publicCatalogProductRef,
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
            actor,
            authUserId: plan.creatorAuthUserId,
            subjectId: subjectId as Id<'subjects'>,
            packageId: pkg.packageId,
            version: pkg.version,
            channel: pkg.channel,
          }
        )) as BackstageRawPackageDownloadRecord | null;
        if (!resolvedDownload) {
          throw new Error(
            `Alias package '${pkg.packageId}' is missing a raw package source artifact`
          );
        }
        const sourceDownload = requireRawBackstagePackageDownload(resolvedDownload, pkg.packageId);

        // Mint a machine-bound license token for per-buyer coupling when the client
        // supplied a fingerprint. Best-effort: a mint failure never blocks the install
        // (the plan is still returned, just without a coupling token for this package).
        let licenseToken: string | undefined;
        if (machineFingerprint) {
          try {
            const mint = (await convex.action(api.yucpLicenses.issueAliasInstallLicenseToken, {
              apiSecret: config.convexApiSecret,
              creatorAuthUserId: plan.creatorAuthUserId,
              subjectId: subjectId as Id<'subjects'>,
              catalogProductId: resolvedCatalogProductId as Id<'product_catalog'>,
              packageId: pkg.packageId,
              machineFingerprint,
            })) as { success: boolean; token?: string; error?: string };
            if (mint.success && mint.token) {
              licenseToken = mint.token;
            } else {
              logger.warn('Alias install license token mint did not succeed', {
                packageId: pkg.packageId,
                error: mint.error,
              });
            }
          } catch (error) {
            logger.warn('Alias install license token mint failed', {
              packageId: pkg.packageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return {
          packageId: pkg.packageId,
          displayName: pkg.displayName,
          version: pkg.version,
          channel: pkg.channel,
          zipSha256: pkg.zipSha256,
          packageSha256: sourceDownload.packageSha256,
          sourceKind: sourceDownload.sourceKind,
          downloadAuthorizationUrl: `${config.apiBaseUrl.replace(/\/+$/, '')}/api/backstage/access/products/${encodeURIComponent(publicCatalogProductRef)}/packages/${encodeURIComponent(pkg.packageId)}/download`,
          licenseToken,
          media: buildPackageMediaInstallPlanDescriptors({
            apiBaseUrl: config.apiBaseUrl,
            catalogProductId: publicCatalogProductRef,
            media: pkg.media,
            packageId: pkg.packageId,
          }),
          importerDelivery,
        };
      })
    ),
  });
}

async function parseJsonObjectBody(
  request: Request,
  maxBytes = BACKSTAGE_PACKAGE_DOWNLOAD_BODY_MAX_BYTES
): Promise<Record<string, unknown>> {
  return readJsonObjectBodyWithLimit(request, maxBytes);
}

function readOptionalBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function buildPackageMediaDownloadUrl(input: {
  apiBaseUrl: string;
  catalogProductId: string;
  kind: BackstagePackageMediaKind;
  packageId: string;
}): string {
  return `${input.apiBaseUrl.replace(/\/+$/, '')}/api/backstage/access/products/${encodeURIComponent(input.catalogProductId)}/packages/${encodeURIComponent(input.packageId)}/media/${encodeURIComponent(input.kind)}`;
}

function buildPackageMediaInstallPlanDescriptors(input: {
  apiBaseUrl: string;
  catalogProductId: string;
  media?: BackstagePackageMediaMap;
  packageId: string;
}):
  | Partial<
      Record<
        BackstagePackageMediaKind,
        Omit<BackstagePackageMediaReference, 'cdngineDelivery' | 'deliveryName'> & {
          downloadUrl: string;
        }
      >
    >
  | undefined {
  const result: Partial<
    Record<
      BackstagePackageMediaKind,
      Omit<BackstagePackageMediaReference, 'cdngineDelivery' | 'deliveryName'> & {
        downloadUrl: string;
      }
    >
  > = {};
  for (const kind of Object.values(BACKSTAGE_PACKAGE_MEDIA_KINDS)) {
    const media = input.media?.[kind];
    if (!media) {
      continue;
    }
    result[kind] = {
      byteSize: media.byteSize,
      contentType: media.contentType,
      downloadUrl: buildPackageMediaDownloadUrl({
        apiBaseUrl: input.apiBaseUrl,
        catalogProductId: input.catalogProductId,
        kind,
        packageId: input.packageId,
      }),
      kind,
      sha256: media.sha256,
      ...(media.sourcePath ? { sourcePath: media.sourcePath } : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function issueAuthorizedPackageDownloadForCatalogProduct(
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
    const subjectId = await getActiveSubjectId(
      convex,
      config,
      viewer.authUserId,
      viewer.actorBinding
    );
    if (!subjectId) {
      return errorResponse('No active subject found for this account', 404);
    }

    const product = (await convex.query(
      api.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        catalogProductId,
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

    const {
      convex: planConvex,
      actor: planActor,
      plan,
    } = await getAuthorizedAliasInstallPlanForViewer(config, viewer, {
      authUserId: product.creatorAuthUserId,
      subjectId,
      creatorRef,
      productRef,
    });
    const planPackage = plan?.packages.find((pkg) => pkg.packageId === packageId);
    if (!planPackage) {
      return errorResponse('Package not found', 404);
    }

    const version = requestedVersion ?? planPackage.version;
    const channel = requestedChannel ?? planPackage.channel;
    if (version !== planPackage.version || channel !== planPackage.channel) {
      return errorResponse('Package not found', 404);
    }

    const resolved = (await planConvex.query(api.backstageRepos.resolveRawPackageDownloadForApi, {
      apiSecret: config.convexApiSecret,
      actor: planActor,
      authUserId: product.creatorAuthUserId,
      subjectId,
      packageId,
      version,
      channel,
    })) as BackstageRawPackageDownloadRecord | null;
    if (!resolved) {
      return errorResponse('Package not found', 404);
    }
    const sourceDownload = requireRawBackstagePackageDownload(resolved, packageId);
    const cdngine = getConfiguredCdngine(config);
    if (!cdngine) {
      logger.error('CDNgine Backstage package source delivery is configured but not available', {
        authUserId: product.creatorAuthUserId,
        deliveryArtifactId: resolved.deliveryArtifactId,
        packageId,
        version,
        channel,
      });
      return errorResponse('Package delivery is temporarily unavailable', 502);
    }
    let downloadUrl: string;
    try {
      downloadUrl = await resolveCdngineSourceDownloadUrl({
        access: {
          authUserId: product.creatorAuthUserId,
          subjectId,
          accessScopeId: `catalog-product:${catalogProductId}`,
        },
        cdngine,
        packageId,
        resolved,
        source: sourceDownload.cdngineSource,
      });
    } catch (error) {
      logger.warn('CDNgine Backstage package source authorization failed', {
        authUserId: product.creatorAuthUserId,
        deliveryArtifactId: resolved.deliveryArtifactId,
        packageId,
        version,
        channel,
        required: cdngine.required === true,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse('Package delivery is temporarily unavailable', 502);
    }

    return jsonResponse({
      downloadUrl,
      packageSha256: sourceDownload.packageSha256,
      sourceKind: sourceDownload.sourceKind,
      version: resolved.version,
      channel: resolved.channel,
      contentType: resolved.contentType,
      deliveryName: resolved.deliveryName,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return errorResponse(error.message, error.status);
    }
    logger.error('Failed to authorize package download', {
      authUserId: viewer.authUserId,
      catalogProductId,
      packageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to authorize package download', 500);
  }
}

async function issueAuthorizedPackageMediaDownloadForCatalogProduct(
  request: Request,
  config: BackstageRepoConfig,
  catalogProductId: string,
  packageId: string,
  kind: string
): Promise<Response> {
  const mediaKind =
    kind === BACKSTAGE_PACKAGE_MEDIA_KINDS.banner || kind === BACKSTAGE_PACKAGE_MEDIA_KINDS.icon
      ? kind
      : null;
  if (!mediaKind) {
    return errorResponse('Package media not found', 404);
  }

  const viewer = await authenticateBackstageAccess(request, config, config.auth);
  if (viewer instanceof Response) {
    return viewer;
  }

  try {
    const convex = getConvexClientFromUrl(config.convexUrl, viewer.actorBinding);
    const subjectId = await getActiveSubjectId(
      convex,
      config,
      viewer.authUserId,
      viewer.actorBinding
    );
    if (!subjectId) {
      return errorResponse('No active subject found for this account', 404);
    }

    const product = (await convex.query(
      api.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        apiSecret: config.convexApiSecret,
        actor: viewer.actorBinding,
        catalogProductId,
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

    const { plan } = await getAuthorizedAliasInstallPlanForViewer(config, viewer, {
      authUserId: product.creatorAuthUserId,
      subjectId,
      creatorRef,
      productRef,
    });
    const planPackage = plan?.packages.find((pkg) => pkg.packageId === packageId);
    const media = planPackage?.media?.[mediaKind];
    if (!planPackage || !media) {
      return errorResponse('Package media not found', 404);
    }
    if (!isCdngineBackstageDeliveryReference(media.cdngineDelivery)) {
      return errorResponse('Package media is temporarily unavailable', 502);
    }

    const cdngine = getConfiguredCdngine(config);
    if (!cdngine) {
      logger.error('CDNgine Backstage package media delivery is configured but not available', {
        authUserId: product.creatorAuthUserId,
        catalogProductId,
        packageId,
        version: planPackage.version,
        channel: planPackage.channel,
        mediaKind,
      });
      return errorResponse('Package media is temporarily unavailable', 502);
    }

    const idempotencyHash = await sha256Hex(
      [
        'backstage-package-media-download-v1',
        product.creatorAuthUserId,
        viewer.authUserId,
        subjectId,
        catalogProductId,
        packageId,
        planPackage.version,
        planPackage.channel,
        mediaKind,
        media.sha256,
        media.cdngineDelivery.assetId,
        media.cdngineDelivery.versionId,
      ].join('|')
    );
    let authorization: Awaited<ReturnType<typeof authorizeCdngineBackstageDeliveryUrl>>;
    try {
      authorization = await authorizeCdngineBackstageDeliveryUrl({
        cdngine,
        delivery: media.cdngineDelivery,
        idempotencyKey: `backstage-media-download-${idempotencyHash}`,
        request,
      });
    } catch (error) {
      logger.warn('CDNgine Backstage package media delivery authorization failed', {
        authUserId: product.creatorAuthUserId,
        catalogProductId,
        packageId,
        version: planPackage.version,
        channel: planPackage.channel,
        mediaKind,
        required: cdngine.required === true,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse('Package media is temporarily unavailable', 502);
    }
    if (!authorization.ok) {
      const detail =
        typeof authorization.payload.detail === 'string'
          ? authorization.payload.detail
          : authorization.statusText;
      logger.warn('CDNgine Backstage package media delivery authorization failed', {
        authUserId: product.creatorAuthUserId,
        catalogProductId,
        packageId,
        version: planPackage.version,
        channel: planPackage.channel,
        mediaKind,
        required: cdngine.required === true,
        error: `CDNgine delivery authorization failed: ${authorization.status} ${detail}`,
      });
      return errorResponse('Package media is temporarily unavailable', 502);
    }
    return redirectNoStore(authorization.url);
  } catch (error) {
    if (isCdngineBackstageDependencyError(error)) {
      logger.warn('CDNgine Backstage package media delivery authorization failed', {
        authUserId: viewer.authUserId,
        catalogProductId,
        packageId,
        mediaKind,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse('Package media is temporarily unavailable', 502);
    }
    logger.error('Failed to authorize package media download', {
      authUserId: viewer.authUserId,
      catalogProductId,
      packageId,
      mediaKind,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to authorize package media download', 500);
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

  const publicProductRef = resolvePublicProductRef(resolved.access);
  if (!publicProductRef) {
    return errorResponse('Product not found', 404);
  }

  const packageSummaries = resolved.access.packageSummaries.map(toPublicBuyerAccessPackageSummary);
  const primaryPackage =
    packageSummaries.find((summary) => summary.packageId === resolved.access.primaryPackageId) ??
    null;

  return jsonResponse({
    creatorName: resolved.creatorRepoIdentity.creatorName,
    creatorRepoRef: resolved.creatorRepoIdentity.creatorRepoRef,
    productRef: publicProductRef,
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

function toPublicBuyerAccessPackageSummary(
  summary: PublicBackstageAccessRecord['packageSummaries'][number]
): PublicBuyerAccessPackageSummary {
  return {
    packageId: summary.packageId,
    displayName: summary.displayName,
    latestPublishedVersion: summary.latestPublishedVersion,
    latestReleaseChannel: summary.latestReleaseChannel,
    importerDelivery: buildBackstageImporterDelivery(summary.aliasContract),
  };
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

  let body: Record<string, unknown>;
  try {
    body = (await parseJsonObjectBody(
      request,
      BACKSTAGE_VERIFICATION_BOOTSTRAP_BODY_MAX_BYTES
    )) as typeof body;
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return errorResponse(error.message, error.status);
    }
    return errorResponse('Invalid JSON body', 400);
  }

  const returnUrlInput = readOptionalBodyString(body, 'returnUrl');
  const machineFingerprint = readOptionalBodyString(body, 'machineFingerprint');
  const codeChallenge = readOptionalBodyString(body, 'codeChallenge');
  const idempotencyKey = readOptionalBodyString(body, 'idempotencyKey');
  if (!returnUrlInput || !machineFingerprint || !codeChallenge) {
    return errorResponse('returnUrl, machineFingerprint, and codeChallenge are required', 400);
  }
  const returnUrl = normalizeFrontendReturnUrl(config, returnUrlInput);
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
      machineFingerprint,
      codeChallenge,
      returnUrl,
      idempotencyKey,
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

async function redeemBuyerVerificationIntent(
  request: Request,
  config: BackstageRepoConfig,
  intentId: string
): Promise<Response> {
  const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins(config));
  if (csrfBlock) {
    return csrfBlock;
  }

  const authUserId = await requireSessionAuthUserId(request, config);
  if (authUserId instanceof Response) {
    return authUserId;
  }

  let body: Record<string, unknown>;
  try {
    body = (await parseJsonObjectBody(
      request,
      BACKSTAGE_VERIFICATION_REDEEM_BODY_MAX_BYTES
    )) as typeof body;
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return errorResponse(error.message, error.status);
    }
    return errorResponse('Invalid JSON body', 400);
  }

  const codeVerifier = readOptionalBodyString(body, 'codeVerifier');
  const machineFingerprint = readOptionalBodyString(body, 'machineFingerprint');
  const grantToken = readOptionalBodyString(body, 'grantToken');
  if (!codeVerifier || !machineFingerprint || !grantToken) {
    return errorResponse('codeVerifier, machineFingerprint, and grantToken are required', 400);
  }

  const actor = await createAuthUserActorBinding({
    authUserId,
    source: 'session',
  });
  const convex = getConvexClientFromUrl(config.convexUrl, actor);

  try {
    const result = await convex.action(api.verificationIntents.redeemVerificationIntent, {
      apiSecret: config.convexApiSecret,
      actor,
      authUserId,
      intentId: intentId as Id<'verification_intents'>,
      codeVerifier,
      machineFingerprint,
      grantToken,
      issuerBaseUrl: config.apiBaseUrl,
    });

    if (!result.success) {
      return errorResponse(result.error ?? 'Could not redeem verification intent', 422);
    }

    return jsonResponse({
      success: true,
      token: result.token,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    logger.error('Failed to redeem buyer verification intent', {
      authUserId,
      intentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Failed to redeem verification intent', 500);
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
    const repository = await convex.query(api.backstageRepos.buildRepositoryForApi, {
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
    });

    if (!isRecord(repository)) {
      throw new Error('Backstage repository response was not an object.');
    }

    const forwardedPackages = await fetchForwardedToolchainPackages();
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
    tokenHash: access.tokenHash,
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
      return redirectNoStore(cdngineUrl);
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
  return redirectNoStore(resolved.downloadUrl);
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
      const buyerCatalogPackageMediaDownloadMatch = url.pathname.match(
        /^\/api\/backstage\/access\/products\/([^/]+)\/packages\/([^/]+)\/media\/([^/]+)$/
      );
      const buyerIntentMatch = url.pathname.match(
        /^\/api\/backstage\/access\/([^/]+)\/([^/]+)\/verification-intent$/
      );
      const buyerIntentRedeemMatch = url.pathname.match(
        /^\/api\/backstage\/access\/verification-intents\/([^/]+)\/redeem$/
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
        return await issueAuthorizedPackageDownloadForCatalogProduct(
          request,
          config,
          catalogProductId,
          packageId
        );
      }
      if (request.method === 'GET' && buyerCatalogPackageMediaDownloadMatch) {
        const catalogProductId = safeDecodeURIComponent(
          buyerCatalogPackageMediaDownloadMatch[1] ?? ''
        );
        const packageId = safeDecodeURIComponent(buyerCatalogPackageMediaDownloadMatch[2] ?? '');
        const mediaKind = safeDecodeURIComponent(buyerCatalogPackageMediaDownloadMatch[3] ?? '');
        if (catalogProductId === null || packageId === null || mediaKind === null) {
          return errorResponse('Malformed path parameter encoding', 400);
        }
        return await issueAuthorizedPackageMediaDownloadForCatalogProduct(
          request,
          config,
          catalogProductId,
          packageId,
          mediaKind
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
      if (request.method === 'POST' && buyerIntentRedeemMatch) {
        const intentId = safeDecodeURIComponent(buyerIntentRedeemMatch[1] ?? '');
        if (intentId === null) {
          return errorResponse('Malformed path parameter encoding', 400);
        }
        return await redeemBuyerVerificationIntent(request, config, intentId);
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
