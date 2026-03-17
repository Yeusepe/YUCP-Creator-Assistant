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

export async function handleSubjectsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  // GET /subjects
  if (subPath === '/subjects') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['subjects:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const status = url.searchParams.get('status') ?? undefined;
    const q = url.searchParams.get('q') ?? undefined;

    try {
      const result = await convex.query(api.subjects.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        status,
        q,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('subjects.listByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /subjects/:id/entitlements
  const entMatch = subPath.match(/^\/subjects\/([^/]+)\/entitlements$/);
  if (entMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['subjects:read', 'entitlements:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    try {
      const result = await convex.query(api.entitlements.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subjectId: entMatch[1],
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('entitlements.listByAuthUser (subject) failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /subjects/:id/transactions
  const txMatch = subPath.match(/^\/subjects\/([^/]+)\/transactions$/);
  if (txMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['subjects:read', 'transactions:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    try {
      const result = await convex.query(api.providerConnections.listTransactionsByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subjectId: txMatch[1],
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('providerConnections.listTransactionsByAuthUser (subject) failed', {
        error: String(err),
      });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /subjects/:id/memberships
  const memMatch = subPath.match(/^\/subjects\/([^/]+)\/memberships$/);
  if (memMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['subjects:read', 'transactions:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    try {
      const result = await convex.query(api.providerConnections.listMembershipsByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subjectId: memMatch[1],
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('providerConnections.listMembershipsByAuthUser (subject) failed', {
        error: String(err),
      });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /subjects/:id/bindings
  const bindMatch = subPath.match(/^\/subjects\/([^/]+)\/bindings$/);
  if (bindMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['subjects:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    try {
      const result = await convex.query(api.bindings.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subjectId: bindMatch[1],
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('bindings.listByAuthUser (subject) failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // GET /subjects/:id
  const idMatch = subPath.match(/^\/subjects\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['subjects:read'], reqId);
    if (auth instanceof Response) return auth;

    const subjectId = idMatch[1];
    try {
      const result = await convex.query(api.subjects.resolveSubjectForPublicApi, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        selector: { subjectId },
      });
      if (!result) {
        return errorResponse('not_found', `Subject with ID ${subjectId} was not found`, 404, reqId);
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('subjects.resolveSubjectForPublicApi failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
