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

export async function handleEntitlementsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  // GET /entitlements
  if (subPath === '/entitlements') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['entitlements:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const subjectId = url.searchParams.get('subject_id') ?? undefined;
    const productId = url.searchParams.get('product_id') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const sourceProvider = url.searchParams.get('source_provider') ?? undefined;

    try {
      const result = await convex.query(api.entitlements.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subjectId,
        productId,
        status,
        sourceProvider,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('entitlements.listByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /entitlements/:id
  const idMatch = subPath.match(/^\/entitlements\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['entitlements:read'], reqId);
    if (auth instanceof Response) return auth;

    const entitlementId = idMatch[1];
    try {
      const result = await convex.query(api.entitlements.getByIdForAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        entitlementId,
      });
      if (!result) {
        return errorResponse(
          'not_found',
          `Entitlement with ID ${entitlementId} was not found`,
          404,
          reqId
        );
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('entitlements.getByIdForAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
