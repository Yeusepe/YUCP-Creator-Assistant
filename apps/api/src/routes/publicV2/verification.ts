import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { resolveAuth } from './auth';
import { errorResponse, extractListData, generateRequestId, jsonResponse } from './helpers';
import type { PublicV2Config } from './types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export async function handleVerificationRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const convex = getConvexClientFromUrl(config.convexUrl);

  // GET /verification/status — returns the caller's own entitlements
  if (subPath === '/verification/status') {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['verification:read'], reqId);
    if (auth instanceof Response) return auth;

    try {
      const subject = await convex.query(api.subjects.resolveSubjectForPublicApi, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        selector: { authUserId: auth.authUserId },
      });

      if (!subject) {
        return jsonResponse(
          {
            object: 'verification_status',
            authUserId: auth.authUserId,
            subject: null,
            entitlements: [],
          },
          200,
          reqId
        );
      }

      const entResult = await convex.query(api.entitlements.getEntitlementsBySubject, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subjectId: (subject as Record<string, unknown>)._id as string,
        includeInactive: false,
      });

      const { data } = extractListData(entResult);
      return jsonResponse(
        {
          object: 'verification_status',
          authUserId: auth.authUserId,
          subject,
          entitlements: data,
        },
        200,
        reqId
      );
    } catch (err) {
      logger.error('verification.status failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  // POST /verification/check — multi-product check by subject selector
  if (subPath === '/verification/check') {
    if (request.method !== 'POST') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['verification:read'], reqId);
    if (auth instanceof Response) return auth;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse('bad_request', 'Invalid JSON body', 400, reqId);
    }

    if (!body.subject || typeof body.subject !== 'object') {
      return errorResponse('bad_request', 'subject selector is required', 400, reqId);
    }
    if (!Array.isArray(body.productIds) || body.productIds.length === 0) {
      return errorResponse('bad_request', 'productIds must be a non-empty array', 400, reqId);
    }

    try {
      const subject = await convex.query(api.subjects.resolveSubjectForPublicApi, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        selector: body.subject as Record<string, unknown>,
      });

      if (!subject) {
        return jsonResponse(
          {
            object: 'verification_check',
            subject: null,
            results: (body.productIds as string[]).map((productId: string) => ({
              productId,
              entitled: false,
              entitlement: null,
            })),
          },
          200,
          reqId
        );
      }

      const subjectId = (subject as Record<string, unknown>)._id as string;
      const entResult = await convex.query(api.entitlements.getEntitlementsBySubject, {
        apiSecret: config.convexApiSecret,
        authUserId: auth.authUserId,
        subjectId,
        includeInactive: false,
      });

      const { data: entitlements } = extractListData(entResult);
      const entitlementMap = new Map(
        (entitlements as Record<string, unknown>[]).map((e) => [e.productId as string, e])
      );

      const results = (body.productIds as string[]).map((productId: string) => {
        const entitlement = entitlementMap.get(productId) ?? null;
        return { productId, entitled: entitlement !== null, entitlement };
      });

      return jsonResponse(
        {
          object: 'verification_check',
          subject,
          results,
        },
        200,
        reqId
      );
    } catch (err) {
      logger.error('verification.check failed', { error: String(err) });
      return errorResponse('internal_error', 'An internal error occurred', 500, reqId);
    }
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
