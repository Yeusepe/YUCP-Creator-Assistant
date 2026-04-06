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

export async function handleTransactionRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  // --- Transactions ---

  if (subPath === '/transactions') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['transactions:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const provider = url.searchParams.get('provider') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const subjectId = url.searchParams.get('subject_id') ?? undefined;

    try {
      const result = await convex.query(api.providerConnections.listTransactionsByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        provider,
        status,
        subjectId,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('providerConnections.listTransactionsByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const txIdMatch = subPath.match(/^\/transactions\/([^/]+)$/);
  if (txIdMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['transactions:read'], reqId);
    if (auth instanceof Response) return auth;

    const transactionId = txIdMatch[1];
    try {
      const result = await convex.query(api.providerConnections.getTransactionById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        transactionId,
      });
      if (!result) {
        return errorResponse(
          'not_found',
          `Transaction with ID ${transactionId} was not found`,
          404,
          reqId
        );
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('providerConnections.getTransactionById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // --- Memberships ---

  if (subPath === '/memberships') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['transactions:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const provider = url.searchParams.get('provider') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const subjectId = url.searchParams.get('subject_id') ?? undefined;

    try {
      const result = await convex.query(api.providerConnections.listMembershipsByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        provider,
        status,
        subjectId,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('providerConnections.listMembershipsByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const memIdMatch = subPath.match(/^\/memberships\/([^/]+)$/);
  if (memIdMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['transactions:read'], reqId);
    if (auth instanceof Response) return auth;

    const membershipId = memIdMatch[1];
    try {
      const result = await convex.query(api.providerConnections.getMembershipById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        membershipId,
      });
      if (!result) {
        return errorResponse(
          'not_found',
          `Membership with ID ${membershipId} was not found`,
          404,
          reqId
        );
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('providerConnections.getMembershipById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // --- Provider Licenses ---

  if (subPath === '/provider-licenses') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['transactions:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const provider = url.searchParams.get('provider') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const subjectId = url.searchParams.get('subject_id') ?? undefined;

    try {
      const result = await convex.query(api.providerConnections.listProviderLicensesByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        provider,
        status,
        subjectId,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('providerConnections.listProviderLicensesByAuthUser failed', {
        error: String(err),
      });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const licIdMatch = subPath.match(/^\/provider-licenses\/([^/]+)$/);
  if (licIdMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['transactions:read'], reqId);
    if (auth instanceof Response) return auth;

    const licenseId = licIdMatch[1];
    try {
      const result = await convex.query(api.providerConnections.getProviderLicenseById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        licenseId,
      });
      if (!result) {
        return errorResponse(
          'not_found',
          `Provider license with ID ${licenseId} was not found`,
          404,
          reqId
        );
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('providerConnections.getProviderLicenseById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
