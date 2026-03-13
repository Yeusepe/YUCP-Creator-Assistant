/**
 * Creator Suite Verification API
 *
 * OAuth 2.1-protected endpoints for third-party apps to verify product entitlements.
 * Requires Bearer token with verification:read scope from "Sign in with Creator Suite".
 */

import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../lib/convex';
import { verifyBetterAuthAccessToken } from '../lib/oauthAccessToken';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const REQUIRED_SCOPE = 'verification:read';
const MAX_PRODUCT_IDS_PER_CHECK = 50;

export interface SuiteConfig {
  convexUrl: string;
  convexApiSecret: string;
  convexSiteUrl: string;
}

interface VerifiedSuiteToken {
  sub: string;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(error: string, message: string, status: number): Response {
  return jsonResponse({ error, message }, status);
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

async function authenticateSuiteRequest(
  request: Request,
  config: SuiteConfig
): Promise<VerifiedSuiteToken | Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return errorResponse('unauthorized', 'Missing or invalid Authorization header', 401);
  }

  const result = await verifyBetterAuthAccessToken(token, {
    convexSiteUrl: config.convexSiteUrl,
    audience: 'yucp-public-api',
    requiredScopes: [REQUIRED_SCOPE],
    logger,
    logContext: 'Suite token verification failed',
  });
  if (!result.ok) {
    if (result.reason === 'insufficient_scope') {
      return errorResponse('forbidden', `Token missing required scope: ${REQUIRED_SCOPE}`, 403);
    }
    return errorResponse('unauthorized', 'Invalid or expired token', 401);
  }

  return { sub: result.token.sub };
}

async function getSubjectIdByAuthUserId(
  authUserId: string,
  config: SuiteConfig
): Promise<{ found: true; subjectId: string } | { found: false }> {
  const convex = getConvexClientFromUrl(config.convexUrl);
  const subjectResult = await convex.query(api.subjects.getSubjectByAuthId, {
    authUserId,
  });

  if (!subjectResult?.found || !subjectResult.subject) {
    return { found: false };
  }

  return {
    found: true,
    subjectId: subjectResult.subject._id,
  };
}

/**
 * GET /api/suite/verification/status?authUserId=xxx
 */
export async function getVerificationStatus(
  request: Request,
  config: SuiteConfig
): Promise<Response> {
  const auth = await authenticateSuiteRequest(request, config);
  if (auth instanceof Response) {
    return auth;
  }

  const url = new URL(request.url);
  const authUserId = url.searchParams.get('authUserId');
  if (!authUserId) {
    return errorResponse('bad_request', 'authUserId query parameter is required', 400);
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const subjectResult = await getSubjectIdByAuthUserId(auth.sub, config);
  if (!subjectResult.found) {
    return errorResponse('forbidden', 'Subject not found', 403);
  }

  const entitlements = await convex.query(api.entitlements.getEntitlementsBySubject, {
    apiSecret: config.convexApiSecret,
    authUserId,
    subjectId: subjectResult.subjectId,
    includeInactive: false,
  });

  const products = (entitlements ?? []).map(
    (e: { productId: string; status: string; grantedAt: number }) => ({
      productId: e.productId,
      status: e.status,
      grantedAt: e.grantedAt,
    })
  );

  return jsonResponse({
    verified: true,
    subjectId: subjectResult.subjectId,
    products,
  });
}

/**
 * GET /api/suite/verification/products?authUserId=xxx
 */
export async function getVerifiedProducts(
  request: Request,
  config: SuiteConfig
): Promise<Response> {
  const auth = await authenticateSuiteRequest(request, config);
  if (auth instanceof Response) {
    return auth;
  }

  const url = new URL(request.url);
  const authUserId = url.searchParams.get('authUserId');
  if (!authUserId) {
    return errorResponse('bad_request', 'authUserId query parameter is required', 400);
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const subjectResult = await getSubjectIdByAuthUserId(auth.sub, config);
  if (!subjectResult.found) {
    return jsonResponse({ productIds: [] });
  }

  const entitlements = await convex.query(api.entitlements.getEntitlementsBySubject, {
    apiSecret: config.convexApiSecret,
    authUserId,
    subjectId: subjectResult.subjectId,
    includeInactive: false,
  });

  const productIds = [
    ...new Set((entitlements ?? []).map((e: { productId: string }) => e.productId)),
  ];
  return jsonResponse({ productIds });
}

/**
 * POST /api/suite/verification/check
 * Body: { authUserId: string, productIds: string[] }
 */
export async function checkVerification(request: Request, config: SuiteConfig): Promise<Response> {
  const auth = await authenticateSuiteRequest(request, config);
  if (auth instanceof Response) {
    return auth;
  }

  let body: { authUserId?: string; productIds?: string[] };
  try {
    body = (await request.json()) as { authUserId?: string; productIds?: string[] };
  } catch {
    return errorResponse('bad_request', 'Invalid JSON body', 400);
  }

  const { authUserId, productIds } = body;
  if (!authUserId) {
    return errorResponse('bad_request', 'authUserId is required', 400);
  }
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return errorResponse('bad_request', 'productIds must be a non-empty array', 400);
  }
  if (productIds.length > MAX_PRODUCT_IDS_PER_CHECK) {
    return errorResponse(
      'bad_request',
      `productIds must not exceed ${MAX_PRODUCT_IDS_PER_CHECK} items`,
      400
    );
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const subjectResult = await getSubjectIdByAuthUserId(auth.sub, config);
  if (!subjectResult.found) {
    return jsonResponse({
      results: productIds.map((productId) => ({ productId, verified: false })),
    });
  }

  const results = await Promise.all(
    productIds.map(async (productId: string) => {
      const verified = await convex.query(api.entitlements.hasActiveEntitlement, {
        apiSecret: config.convexApiSecret,
        authUserId,
        subjectId: subjectResult.subjectId,
        productId,
      });
      return { productId, verified: verified === true };
    })
  );

  return jsonResponse({ results });
}

/**
 * GET /api/suite/tenants/:slug
 */
export async function getTenantBySlug(
  request: Request,
  config: SuiteConfig,
  slug: string
): Promise<Response> {
  const auth = await authenticateSuiteRequest(request, config);
  if (auth instanceof Response) {
    return auth;
  }

  const convex = getConvexClientFromUrl(config.convexUrl);
  const tenant = await convex.query(api.creatorProfiles.getCreatorBySlug, {
    apiSecret: config.convexApiSecret,
    slug,
  });

  if (!tenant) {
    return errorResponse('not_found', 'Tenant not found', 404);
  }

  return jsonResponse({
    authUserId: tenant.authUserId,
    name: tenant.name,
    slug: tenant.slug,
  });
}

/**
 * Create suite route handlers for the given config.
 */
export function createSuiteRoutes(config: SuiteConfig) {
  return {
    async handleRequest(request: Request, pathname: string): Promise<Response | null> {
      if (pathname === '/api/suite/verification/status' && request.method === 'GET') {
        return getVerificationStatus(request, config);
      }
      if (pathname === '/api/suite/verification/products' && request.method === 'GET') {
        return getVerifiedProducts(request, config);
      }
      if (pathname === '/api/suite/verification/check' && request.method === 'POST') {
        return checkVerification(request, config);
      }
      if (pathname.startsWith('/api/suite/tenants/') && request.method === 'GET') {
        const slug = pathname.replace(/^\/api\/suite\/tenants\//, '').split('/')[0];
        if (slug) {
          return getTenantBySlug(request, config, decodeURIComponent(slug));
        }
      }
      return null;
    },
  };
}
