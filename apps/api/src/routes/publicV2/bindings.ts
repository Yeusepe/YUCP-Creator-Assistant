import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
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

export async function handleBindingsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  if (subPath === '/bindings') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['subjects:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const subjectId = url.searchParams.get('subject_id') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const bindingType = url.searchParams.get('binding_type') ?? undefined;

    try {
      const result = await convex.query(api.bindings.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subjectId,
        status,
        bindingType,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('bindings.listByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const idMatch = subPath.match(/^\/bindings\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['subjects:read'], reqId);
    if (auth instanceof Response) return auth;

    const bindingId = idMatch[1];
    try {
      const result = await convex.query(api.bindings.getBindingById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        bindingId,
      });
      if (!result) {
        return errorResponse('not_found', `Binding with ID ${bindingId} was not found`, 404, reqId);
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('bindings.getById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
