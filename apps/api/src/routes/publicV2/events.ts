import { api } from '../../../../../convex/_generated/api';
import { createLogger } from '@yucp/shared';
import { getConvexClientFromUrl } from '../../lib/convex';
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

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export async function handleEventsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config,
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  if (subPath === '/events') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['events:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const eventType = url.searchParams.get('type') ?? undefined;
    const resourceId = url.searchParams.get('resource_id') ?? undefined;
    const resourceType = url.searchParams.get('resource_type') ?? undefined;

    try {
      const result = await convex.query(api.creatorEvents.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        eventType,
        resourceId,
        resourceType,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('creatorEvents.listByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const idMatch = subPath.match(/^\/events\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['events:read'], reqId);
    if (auth instanceof Response) return auth;

    const eventId = idMatch[1];
    try {
      const result = await convex.query(api.creatorEvents.getById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        eventId,
      });
      if (!result) {
        return errorResponse('not_found', `Event with ID ${eventId} was not found`, 404, reqId);
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('creatorEvents.getById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
