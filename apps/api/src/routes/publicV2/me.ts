import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { resolveAuth } from './auth';
import { errorResponse, generateRequestId, jsonResponse } from './helpers';
import type { PublicV2Config } from './types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export async function handleMeRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();

  if (subPath === '/me') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }

    const auth = await resolveAuth(request, config, [], reqId);
    if (auth instanceof Response) return auth;

    return jsonResponse(
      {
        object: 'api_key_info',
        authUserId: auth.authUserId,
        scopes: auth.scopes,
        keyId: auth.keyId ?? null,
        expiresAt: auth.expiresAt ?? null,
      },
      200,
      reqId
    );
  }

  if (subPath === '/me/profile') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }

    const auth = await resolveAuth(request, config, ['profile:read'], reqId);
    if (auth instanceof Response) return auth;

    const convex = getConvexClientFromUrl(config.convexUrl);
    try {
      const viewer = await convex.query(api.authViewer.getViewerByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
      });

      if (!viewer) {
        return errorResponse('not_found', 'Profile not found', 404, reqId);
      }

      return jsonResponse(
        {
          object: 'profile',
          authUserId: viewer.authUserId,
          name: viewer.name,
          image: viewer.image,
        },
        200,
        reqId
      );
    } catch (err) {
      logger.error('me.profile failed', {
        error: String(err),
        authUserId: auth.authUserId,
      });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
