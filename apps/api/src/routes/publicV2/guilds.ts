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

export async function handleGuildsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  // GET /guilds/:id/role-rules
  const rrMatch = subPath.match(/^\/guilds\/([^/]+)\/role-rules$/);
  if (rrMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['guilds:read'], reqId);
    if (auth instanceof Response) return auth;

    try {
      const result = await convex.query(api.role_rules.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        guildId: rrMatch[1],
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('role_rules.listByAuthUser (guild) failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /guilds/:id/downloads
  const dlMatch = subPath.match(/^\/guilds\/([^/]+)\/downloads$/);
  if (dlMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['guilds:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    try {
      const result = await convex.query(api.downloads.listRoutesByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        guildId: dlMatch[1],
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('downloads.listRoutesByAuthUser (guild) failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /guilds
  if (subPath === '/guilds') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['guilds:read'], reqId);
    if (auth instanceof Response) return auth;

    const status = url.searchParams.get('status') ?? undefined;

    try {
      const result = await convex.query(api.guildLinks.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        status,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('guildLinks.listByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /guilds/:id
  const idMatch = subPath.match(/^\/guilds\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['guilds:read'], reqId);
    if (auth instanceof Response) return auth;

    const guildId = idMatch[1];
    try {
      const result = await convex.query(api.guildLinks.getByGuildId, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        guildId,
      });
      if (!result) {
        return errorResponse('not_found', `Guild with ID ${guildId} was not found`, 404, reqId);
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('guildLinks.getByGuildId failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
