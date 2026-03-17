import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { resolveAuth } from './auth';
import {
  errorResponse,
  extractListData,
  generateRequestId,
  listResponse,
  parsePagination,
} from './helpers';
import type { PublicV2Config } from './types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export async function handleAuditLogRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  if (subPath !== '/audit-log') {
    return errorResponse('not_found', 'Route not found', 404, reqId);
  }

  if (request.method !== 'GET') {
    return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
  }

  const auth = await resolveAuth(request, config, ['events:read'], reqId);
  if (auth instanceof Response) return auth;

  const { limit, cursor } = parsePagination(url);
  const type = url.searchParams.get('type') ?? undefined;
  const subjectId = url.searchParams.get('subject_id') ?? undefined;

  try {
    const result = await convex.query(api.audit_events.listByAuthUser, {
      apiSecret: config.convexApiSecret,
      authUserId: auth.authUserId,
      type,
      subjectId,
      cursor,
      limit,
    });
    const { data, hasMore, nextCursor } = extractListData(result);
    return listResponse(data, hasMore, nextCursor, reqId);
  } catch (err) {
    logger.error('audit_events.listByAuthUser failed', { error: String(err) });
    return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
  }
}
