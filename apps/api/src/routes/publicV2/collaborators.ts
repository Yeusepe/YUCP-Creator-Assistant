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

export async function handleCollaboratorsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  if (subPath === '/collaborators') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['collaborators:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const provider = url.searchParams.get('provider') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;

    try {
      const result = await convex.query(api.collaboratorInvites.listConnectionsByOwner, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        provider,
        status,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('collaboratorInvites.listConnectionsByOwner failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const idMatch = subPath.match(/^\/collaborators\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['collaborators:read'], reqId);
    if (auth instanceof Response) return auth;

    const connectionId = idMatch[1];
    try {
      const result = await convex.query(api.collaboratorInvites.getConnectionById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        connectionId,
      });
      if (!result) {
        return errorResponse(
          'not_found',
          `Collaborator with ID ${connectionId} was not found`,
          404,
          reqId
        );
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('collaboratorInvites.getConnectionById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
