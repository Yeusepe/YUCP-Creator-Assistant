import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import { YUCP_FORWARDED_TOOLCHAIN_PACKAGE_IDS, type YucpAliasPackageContract } from '@yucp/shared';
import type { ApiActorBinding } from '@yucp/shared/apiActor';
import {
  type CdngineBackstageDeliveryReference,
  isCdngineBackstageDeliveryReference,
} from '@yucp/shared/cdngineBackstageDelivery';
import { sha256Hex } from '@yucp/shared/crypto';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { createAuthUserActorBinding } from '../lib/apiActor';
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

type ConfiguredCdngineBackstageDelivery = {
  accessToken: string;
  apiBaseUrl: string;
  required?: boolean;
  timeoutMs?: number;
};

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
  const response = await fetch(BACKSTAGE_FORWARDED_UPSTREAM_REPOSITORY_URL, {
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(
      `Forwarded toolchain repository request failed with ${response.status} ${response.statusText}.`
    );
  }
  return extractForwardedToolchainPackages(await response.json());
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

async function resolveCdngineDownloadUrl(input: {
  access: { authUserId: string; subjectId: string; tokenId: string };
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
      input.access.tokenId,
      input.packageId,
      input.resolved.version,
      input.resolved.channel,
      input.resolved.deliveryArtifactId ??
        input.resolved.artifactId ??
        input.resolved.artifactKey ??
        '',
      input.delivery.assetId,
      input.delivery.versionId,
      input.delivery.deliveryScopeId,
      input.delivery.variant,
    ].join('|')
  );
  const response = await fetchWithTimeout(
    `${input.cdngine.apiBaseUrl.replace(/\/+$/, '')}/v1/assets/${encodeURIComponent(input.delivery.assetId)}/versions/${encodeURIComponent(input.delivery.versionId)}/deliveries/${encodeURIComponent(input.delivery.deliveryScopeId)}/authorize`,
    {
      body: JSON.stringify({
        responseFormat: 'url',
        variant: input.delivery.variant,
      }),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.cdngine.accessToken}`,
        'content-type': 'application/json',
        'idempotency-key': `backstage-download-${idempotencyHash}`,
        ...(input.request.headers.get('traceparent')
          ? { traceparent: input.request.headers.get('traceparent') as string }
          : {}),
      },
      method: 'POST',
    },
    input.cdngine.timeoutMs ?? 5000
  );
  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : response.statusText;
    throw new Error(`CDNgine delivery authorization failed: ${response.status} ${detail}`);
  }
  if (typeof payload.url !== 'string' || payload.url.length === 0) {
    throw new Error('CDNgine delivery authorization did not return a URL.');
  }
  return new URL(payload.url, `${input.cdngine.apiBaseUrl.replace(/\/+$/, '')}/`).toString();
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

  const creatorRepoRef = decodeURIComponent(parts[3] ?? '').trim();
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
  productRef: string
): Promise<{
  access: PublicBackstageAccessRecord;
  creatorRepoIdentity: CreatorRepoIdentity;
} | null> {
  const convex = getConvexClientFromUrl(config.convexUrl);
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

  const now = Date.now();
  const issued = await convex.mutation(api.backstageRepos.issueRepoTokenForApi, {
    apiSecret: config.convexApiSecret,
    authUserId: viewer.authUserId,
    subjectId,
    label: 'VCC Backstage Repos',
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
  const addRepoUrl = buildBackstageAddRepoUrl(repositoryUrl, issued.token);
  const requestUrl = new URL(request.url);
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

    const plan = (await convex.query(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
      apiSecret: config.convexApiSecret,
      authUserId: viewer.authUserId,
      subjectId,
      creatorRef,
      productRef,
    })) as AuthorizedAliasInstallPlanRecord | null;
    if (!plan) {
      return errorResponse('Alias install plan not found', 404);
    }

    return await buildAuthorizedAliasInstallPlanResponse(config, convex, plan);
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
      authUserId: viewer.authUserId,
      subjectId,
      creatorRef,
      productRef,
    })) as AuthorizedAliasInstallPlanRecord | null;
    if (!plan) {
      return errorResponse('Alias install plan not found', 404);
    }

    return await buildAuthorizedAliasInstallPlanResponse(config, convex, plan);
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
  plan: AuthorizedAliasInstallPlanRecord
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
    packages: plan.packages.map((pkg) => {
      const importerDelivery = buildBackstageImporterDelivery(pkg.aliasContract);
      if (!importerDelivery) {
        throw new Error(`Alias package '${pkg.packageId}' is missing importer delivery metadata`);
      }
      return {
        packageId: pkg.packageId,
        displayName: pkg.displayName,
        version: pkg.version,
        channel: pkg.channel,
        zipSha256: pkg.zipSha256,
        aliasContract: pkg.aliasContract,
        importerDelivery,
      };
    }),
  });
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

  const resolved = await getPublicProductAccess(config, creatorRef, productRef);
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

  try {
    const convex = getConvexClientFromUrl(config.convexUrl);
    const actor = await createAuthUserActorBinding({
      authUserId,
      source: 'session',
    });
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
      returnUrl: body.returnUrl,
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
      if (request.method === 'GET' && buyerAccessMatch) {
        return await getBuyerAccessInfo(
          config,
          decodeURIComponent(buyerAccessMatch[1] ?? ''),
          decodeURIComponent(buyerAccessMatch[2] ?? '')
        );
      }
      if (request.method === 'POST' && buyerCatalogInstallPlanMatch) {
        return await issueAuthorizedAliasInstallPlanForCatalogProduct(
          request,
          config,
          decodeURIComponent(buyerCatalogInstallPlanMatch[1] ?? '')
        );
      }
      if (request.method === 'POST' && buyerInstallPlanMatch) {
        return await issueAuthorizedAliasInstallPlan(
          request,
          config,
          decodeURIComponent(buyerInstallPlanMatch[1] ?? ''),
          decodeURIComponent(buyerInstallPlanMatch[2] ?? '')
        );
      }
      if (request.method === 'POST' && buyerIntentMatch) {
        return await bootstrapBuyerVerificationIntent(
          request,
          config,
          decodeURIComponent(buyerIntentMatch[1] ?? ''),
          decodeURIComponent(buyerIntentMatch[2] ?? '')
        );
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
