import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { logger } from '../../lib/logger';
import { resolveAuth } from './auth';
import { errorResponse, generateRequestId, jsonResponse } from './helpers';
import type { PublicV2Config } from './types';

export async function handleSettingsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const convex = getConvexClientFromUrl(config.convexUrl);

  if (subPath !== '/settings') {
    return errorResponse('not_found', 'Route not found', 404, reqId);
  }

  if (request.method === 'GET') {
    const auth = await resolveAuth(request, config, ['settings:read'], reqId);
    if (auth instanceof Response) return auth;

    try {
      const result = await convex.query(api.creatorProfiles.getByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
      });
      if (!result) {
        return errorResponse('not_found', 'Settings not found for this account', 404, reqId);
      }
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('creatorProfiles.getByAuthUser failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  if (request.method === 'PATCH') {
    const auth = await resolveAuth(request, config, ['settings:write'], reqId);
    if (auth instanceof Response) return auth;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse('bad_request', 'Invalid JSON body', 400, reqId);
    }

    try {
      const result = await convex.mutation(api.creatorProfiles.updatePolicy, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        policyPatch: body,
      });
      return jsonResponse(result, 200, reqId);
    } catch (err) {
      logger.error('creatorProfiles.updatePolicy failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
}
