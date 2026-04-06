import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { logger } from '../../lib/logger';
import { verifyBetterAuthAccessToken } from '../../lib/oauthAccessToken';
import { buildTimedResponse, type RouteTimingCollector } from '../../lib/requestTiming';
import { errorResponse, generateRequestId } from './helpers';
import type { PublicV2Config } from './types';

const PUBLIC_API_KEY_PATTERN = /^ypsk_[0-9a-f]{48}$/;
const PUBLIC_API_KEY_PREFIX = 'ypsk_';
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';

export interface AuthResult {
  authUserId: string;
  scopes: string[];
  keyId?: string;
  expiresAt?: number;
}

function getPublicApiKeyScopes(permissions: Record<string, unknown>): string[] {
  const ns = permissions[PUBLIC_API_KEY_PERMISSION_NAMESPACE];
  if (!Array.isArray(ns)) return [];
  return ns.filter((s): s is string => typeof s === 'string');
}

function hasRequiredScopes(granted: string[], required: string[]): boolean {
  return required.every((s) => granted.includes(s));
}

/**
 * Resolves the caller identity and checks that all requiredScopes are granted.
 * Returns an AuthResult on success or a Response (401/403) on failure.
 */
export async function resolveAuth(
  request: Request,
  config: PublicV2Config,
  requiredScopes: string[],
  requestId?: string,
  timing?: RouteTimingCollector
): Promise<AuthResult | Response> {
  const reqId = requestId ?? generateRequestId();
  const buildErrorResponse = (error: string, message: string, status: number): Response =>
    timing
      ? buildTimedResponse(
          timing,
          () => errorResponse(error, message, status, reqId),
          'serialize auth error response'
        )
      : errorResponse(error, message, status, reqId);

  const apiKeyHeader = request.headers.get('x-api-key');
  const authHeader = request.headers.get('authorization');

  let apiKey: string | null = null;
  let bearerToken: string | null = null;

  if (apiKeyHeader && PUBLIC_API_KEY_PATTERN.test(apiKeyHeader)) {
    apiKey = apiKeyHeader;
  } else if (authHeader?.startsWith('Bearer ')) {
    const tokenValue = authHeader.slice(7);
    if (tokenValue.startsWith(PUBLIC_API_KEY_PREFIX) && PUBLIC_API_KEY_PATTERN.test(tokenValue)) {
      apiKey = tokenValue;
    } else if (tokenValue.length > 0) {
      bearerToken = tokenValue;
    }
  }

  if (!apiKey && !bearerToken) {
    return buildErrorResponse(
      'unauthorized',
      'Missing authentication credentials. Provide x-api-key header or Authorization: Bearer token.',
      401
    );
  }

  if (apiKey) {
    const convex = getConvexClientFromUrl(config.convexUrl);
    try {
      const result = timing
        ? await timing.measure(
            'auth_api_key',
            () =>
              convex.mutation(api.betterAuthApiKeys.verifyApiKey, {
                apiSecret: config.convexApiSecret,
                key: apiKey,
              }),
            'verify public api key'
          )
        : await convex.mutation(api.betterAuthApiKeys.verifyApiKey, {
            apiSecret: config.convexApiSecret,
            key: apiKey,
          });

      if (!result?.key) {
        return buildErrorResponse('unauthorized', 'Invalid or expired API key', 401);
      }

      const keyData = result.key as {
        id?: string;
        metadata?: Record<string, unknown>;
        permissions?: Record<string, unknown>;
        expiresAt?: number | null;
      };

      const authUserId = keyData.metadata?.authUserId as string | undefined;
      if (!authUserId) {
        return buildErrorResponse('unauthorized', 'API key has no associated user', 401);
      }

      const scopes = getPublicApiKeyScopes((keyData.permissions as Record<string, unknown>) ?? {});

      if (!hasRequiredScopes(scopes, requiredScopes)) {
        return buildErrorResponse(
          'forbidden',
          `Missing required scopes: ${requiredScopes.join(', ')}`,
          403
        );
      }

      return {
        authUserId,
        scopes,
        keyId: typeof keyData.id === 'string' ? keyData.id : undefined,
        expiresAt: typeof keyData.expiresAt === 'number' ? keyData.expiresAt : undefined,
      };
    } catch (err) {
      logger.error('API key verification error', { error: String(err) });
      return buildErrorResponse('internal_error', 'Authentication service unavailable', 500);
    }
  }

  // OAuth bearer token path
  if (!bearerToken) {
    return buildErrorResponse('invalid_token', 'Missing bearer token', 401);
  }

  try {
    const oauthResult = timing
      ? await timing.measure(
          'auth_oauth',
          () =>
            verifyBetterAuthAccessToken(bearerToken, {
              convexSiteUrl: config.convexSiteUrl,
              audience: config.oauthAudience ?? 'yucp-public-api',
              requiredScopes,
              logger,
            }),
          'verify OAuth access token'
        )
      : await verifyBetterAuthAccessToken(bearerToken, {
          convexSiteUrl: config.convexSiteUrl,
          audience: config.oauthAudience ?? 'yucp-public-api',
          requiredScopes,
          logger,
        });

    if (!oauthResult.ok) {
      if (oauthResult.reason === 'insufficient_scope') {
        return buildErrorResponse(
          'forbidden',
          `Missing required scopes: ${requiredScopes.join(', ')}`,
          403
        );
      }
      return buildErrorResponse('unauthorized', 'Invalid or expired access token', 401);
    }

    return {
      authUserId: oauthResult.token.sub,
      scopes: oauthResult.token.grantedScopes,
    };
  } catch (err) {
    logger.error('OAuth token verification error', { error: String(err) });
    return buildErrorResponse('internal_error', 'Authentication service unavailable', 500);
  }
}
