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

export async function handleVerificationSessionsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config,
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  if (subPath === '/verification-sessions') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['verification:read'], reqId);
    if (auth instanceof Response) return auth;

    const { limit, cursor } = parsePagination(url);
    const subjectId = url.searchParams.get('subject_id') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const mode = url.searchParams.get('mode') ?? undefined;

    try {
      const result = await convex.query(api.verificationSessions.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subjectId,
        status,
        mode,
        cursor,
        limit,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('verificationSessions.listByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const idMatch = subPath.match(/^\/verification-sessions\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['verification:read'], reqId);
    if (auth instanceof Response) return auth;

    const sessionId = idMatch[1];
    try {
      const result = await convex.query(api.verificationSessions.getSessionById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        sessionId,
      });
      if (!result) {
        return errorResponse(
          'not_found',
          `Verification session with ID ${sessionId} was not found`,
          404,
          reqId,
        );
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('verificationSessions.getSessionById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
