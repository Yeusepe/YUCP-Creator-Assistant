import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import { sha256Hex } from '@yucp/shared/crypto';
import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { createAuthUserActorBinding } from '../lib/apiActor';
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
  }>;
};

export type BackstageRepoConfig = {
  auth?: Auth;
  apiBaseUrl: string;
  enableSessionAccess?: boolean;
  frontendBaseUrl: string;
  convexApiSecret: string;
  convexSiteUrl: string;
  convexUrl: string;
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

function buildBackstageAddRepoUrl(repositoryUrl: string, repoToken: string): string {
  const addRepoUrl = new URL('vcc://vpm/addRepo');
  addRepoUrl.searchParams.set('url', repositoryUrl);
  addRepoUrl.searchParams.append('headers[]', `${BACKSTAGE_REPO_TOKEN_HEADER}:${repoToken}`);
  return addRepoUrl.toString();
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

async function authenticateBackstageAccess(
  request: Request,
  config: BackstageRepoConfig,
  auth?: Auth
): Promise<{ authUserId: string } | Response> {
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

    return { authUserId: verified.token.sub };
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

  return { authUserId: session.user.id };
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

  const convex = getConvexClientFromUrl(config.convexUrl);
  const subject = await convex.query(api.backstageRepos.getSubjectByAuthUserForApi, {
    apiSecret: config.convexApiSecret,
    authUserId: viewer.authUserId,
  });
  if (!subject) {
    return errorResponse('No active subject found for this account', 404);
  }

  const now = Date.now();
  const issued = await convex.mutation(api.backstageRepos.issueRepoTokenForApi, {
    apiSecret: config.convexApiSecret,
    authUserId: viewer.authUserId,
    subjectId: subject._id,
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
    repoTokenHeader: BACKSTAGE_REPO_TOKEN_HEADER,
    repoToken: issued.token,
    expiresAt: issued.expiresAt,
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
    packageSummaries: resolved.access.packageSummaries,
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

  return jsonResponse(repository);
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
  const resolved = await convex.query(api.backstageRepos.resolvePackageDownloadForApi, {
    apiSecret: config.convexApiSecret,
    authUserId: access.authUserId,
    subjectId: access.subjectId,
    packageId,
    version,
    channel,
  });
  if (!resolved) {
    return errorResponse('Package not found', 404);
  }
  return Response.redirect(resolved.downloadUrl, 302);
}

export function createBackstageRepoRoutes(config: BackstageRepoConfig) {
  return {
    async handleRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const creatorRepoRoute = parseCreatorRepoRoute(url.pathname);
      const buyerAccessMatch = url.pathname.match(/^\/api\/backstage\/access\/([^/]+)\/([^/]+)$/);
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
