import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { logger } from '../../lib/logger';
import { buildTimedResponse, RouteTimingCollector } from '../../lib/requestTiming';
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

export async function handleProductsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);
  const timing = new RouteTimingCollector();
  const respond = (
    buildResponse: () => Response,
    description = 'serialize json response'
  ): Response => buildTimedResponse(timing, buildResponse, description);

  // GET /products/:id/entitlements
  const entMatch = subPath.match(/^\/products\/([^/]+)\/entitlements$/);
  if (entMatch) {
    if (request.method !== 'GET') {
      return respond(() => errorResponse('method_not_allowed', 'Method not allowed', 405, reqId));
    }
    const auth = await resolveAuth(request, config, ['products:read'], reqId, timing);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    try {
      const result = await timing.measure(
        'convex_product_entitlements',
        () =>
          convex.query(api.entitlements.listByAuthUser, {
            apiSecret: config.convexApiSecret,
            authUserId: auth.authUserId,
            productId: entMatch[1],
            cursor,
            limit,
          }),
        'list product entitlements'
      );
      const { data, hasMore, nextCursor } = extractListData(result);
      return respond(() => listResponse(data, hasMore, nextCursor, reqId));
    } catch (err) {
      logger.error('entitlements.listByAuthUser (product) failed', { error: String(err) });
      return respond(() =>
        errorResponse('internal_error', 'An internal error occurred', 500, reqId)
      );
    }
  }

  // GET /products/:id/role-rules
  const rrMatch = subPath.match(/^\/products\/([^/]+)\/role-rules$/);
  if (rrMatch) {
    if (request.method !== 'GET') {
      return respond(() => errorResponse('method_not_allowed', 'Method not allowed', 405, reqId));
    }
    const auth = await resolveAuth(request, config, ['products:read'], reqId, timing);
    if (auth instanceof Response) return auth;

    try {
      const result = await timing.measure(
        'convex_role_rules',
        () =>
          convex.query(api.role_rules.listByAuthUser, {
            apiSecret: config.convexApiSecret,
            authUserId: auth.authUserId,
            productId: rrMatch[1],
          }),
        'list product role rules'
      );
      const { data, hasMore, nextCursor } = extractListData(result);
      return respond(() => listResponse(data, hasMore, nextCursor, reqId));
    } catch (err) {
      logger.error('role_rules.listByAuthUser (product) failed', { error: String(err) });
      return respond(() =>
        errorResponse('internal_error', 'An internal error occurred', 500, reqId)
      );
    }
  }

  // GET /products
  if (subPath === '/products') {
    if (request.method !== 'GET') {
      return respond(() => errorResponse('method_not_allowed', 'Method not allowed', 405, reqId));
    }
    const auth = await resolveAuth(request, config, ['products:read'], reqId, timing);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const provider = url.searchParams.get('provider') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;

    try {
      const result = await timing.measure(
        'convex_products',
        () =>
          convex.query(api.packageRegistry.listByAuthUser, {
            apiSecret: config.convexApiSecret,
            authUserId: auth.authUserId,
            provider,
            status,
            cursor,
            limit,
          }),
        'list products'
      );
      const { data, hasMore, nextCursor } = extractListData(result);
      return respond(() => listResponse(data, hasMore, nextCursor, reqId));
    } catch (err) {
      logger.error('packageRegistry.listByAuthUser failed', { error: String(err) });
      return respond(() =>
        errorResponse('internal_error', 'An internal error occurred', 500, reqId)
      );
    }
  }

  // GET /products/:id
  const idMatch = subPath.match(/^\/products\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return respond(() => errorResponse('method_not_allowed', 'Method not allowed', 405, reqId));
    }
    const auth = await resolveAuth(request, config, ['products:read'], reqId, timing);
    if (auth instanceof Response) return auth;

    const catalogProductId = idMatch[1];
    try {
      const result = await timing.measure(
        'convex_product',
        () =>
          convex.query(api.packageRegistry.getByIdForAuthUser, {
            apiSecret: config.convexApiSecret,
            authUserId: auth.authUserId,
            catalogProductId,
          }),
        'get product'
      );
      if (!result) {
        return respond(() =>
          errorResponse(
            'not_found',
            `Product with ID ${catalogProductId} was not found`,
            404,
            reqId
          )
        );
      }
      return respond(() => jsonResponse(result, 200, reqId));
    } catch (err) {
      logger.error('packageRegistry.getByIdForAuthUser failed', { error: String(err) });
      return respond(() =>
        errorResponse('internal_error', 'An internal error occurred', 500, reqId)
      );
    }
  }

  return respond(() => errorResponse('not_found', 'Route not found', 404, reqId));
}
