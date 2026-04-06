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
} from './helpers';
import type { PublicV2Config } from './types';

export async function handleRoleRulesRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const url = new URL(request.url);
  const convex = getConvexClientFromUrl(config.convexUrl);

  if (subPath === '/role-rules') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['guilds:read'], reqId);
    if (auth instanceof Response) return auth;

    const guildId = url.searchParams.get('guild_id') ?? undefined;
    const productId = url.searchParams.get('product_id') ?? undefined;
    const enabledParam = url.searchParams.get('enabled');
    const enabled = enabledParam === 'true' ? true : enabledParam === 'false' ? false : undefined;

    try {
      const result = await convex.query(api.role_rules.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        guildId,
        productId,
        enabled,
      });
      const { data, hasMore, nextCursor } = extractListData(result);
      return listResponse(data, hasMore, nextCursor, reqId);
    } catch (err) {
      logger.error('role_rules.listByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  const idMatch = subPath.match(/^\/role-rules\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['guilds:read'], reqId);
    if (auth instanceof Response) return auth;

    const ruleId = idMatch[1];
    try {
      const result = await convex.query(api.role_rules.getRuleById, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        ruleId,
      });
      if (!result) {
        return errorResponse('not_found', `Role rule with ID ${ruleId} was not found`, 404, reqId);
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('role_rules.getById failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
