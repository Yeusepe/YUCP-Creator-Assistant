import { errorResponse, generateRequestId, jsonResponse } from './helpers';
import { resolveAuth } from './auth';
import type { PublicV2Config } from './types';

export async function handleMeRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config,
): Promise<Response> {
  const reqId = generateRequestId();

  if (subPath !== '/me') {
    return errorResponse('not_found', 'Route not found', 404, reqId);
  }

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
    reqId,
  );
}
