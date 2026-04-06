import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { verifyBetterAuthAccessToken } from '../lib/oauthAccessToken';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;

export type PackagesConfig = {
  apiBaseUrl: string;
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

async function resolveViewer(
  request: Request,
  auth: Auth,
  config: PackagesConfig
): Promise<{ authUserId: string } | Response> {
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

    return { authUserId: verified.token.sub };
  }

  const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins(config));
  if (csrfBlock) {
    return csrfBlock;
  }

  const session = await auth.getSession(request);
  if (!session) {
    return jsonResponse({ error: 'Authentication required' }, 401);
  }

  return { authUserId: session.user.id };
}

export function createPackageRoutes(auth: Auth, config: PackagesConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);

  async function listPackages(request: Request): Promise<Response> {
    const viewer = await resolveViewer(request, auth, config);
    if (viewer instanceof Response) {
      return viewer;
    }

    try {
      const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true';
      const result = await convex.query(api.packageRegistry.listForAuthUser, {
        apiSecret: config.convexApiSecret,
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

  return {
    listPackages,
    renamePackage,
    archivePackage,
    restorePackage,
    deletePackage,
  };
}
