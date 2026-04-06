import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { logger } from '../../lib/logger';
import { resolveAuth } from './auth';
import {
  errorResponse,
  extractListData,
  generateRequestId,
  jsonResponse,
  listResponse,
  parsePagination,
} from './helpers';
import type { PublicV2Config } from './types';

export async function handleDownloadsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  // --- Download Routes ---

  if (subPath === '/downloads/routes') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['downloads:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const guildId = url.searchParams.get('guild_id') ?? undefined;
    const enabledParam = url.searchParams.get('enabled');
    const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;

    try {
      const result = await convex.query(api.downloads.listRoutesByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        guildId,
        enabled,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('downloads.listRoutesByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const routeIdMatch = subPath.match(/^\/downloads\/routes\/([^/]+)$/);
  if (routeIdMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['downloads:read'], reqId);
    if (auth instanceof Response) return auth;

    const routeId = routeIdMatch[1];
    try {
      const result = await convex.query(api.downloads.getRouteById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        routeId,
      });
      if (!result) {
        return errorResponse(
          'not_found',
          `Download route with ID ${routeId} was not found`,
          404,
          reqId
        );
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('downloads.getRouteById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // --- Artifacts ---

  if (subPath === '/downloads/artifacts') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['downloads:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const routeId = url.searchParams.get('route_id') ?? undefined;
    const guildId = url.searchParams.get('guild_id') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;

    try {
      const result = await convex.query(api.downloads.listArtifactsByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        routeId,
        guildId,
        status,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('downloads.listArtifactsByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const artifactIdMatch = subPath.match(/^\/downloads\/artifacts\/([^/]+)$/);
  if (artifactIdMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['downloads:read'], reqId);
    if (auth instanceof Response) return auth;

    const artifactId = artifactIdMatch[1];
    try {
      const result = await convex.query(api.downloads.getArtifactById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        artifactId,
      });
      if (!result) {
        return errorResponse(
          'not_found',
          `Download artifact with ID ${artifactId} was not found`,
          404,
          reqId
        );
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('downloads.getArtifactById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
