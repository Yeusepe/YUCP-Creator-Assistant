import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { getConvexClientFromUrl } from '../../lib/convex';
import {
  type HostedVerificationIntentRecord,
  mapHostedVerificationIntentResponse,
  normalizeHostedVerificationRequirements,
  type StoredVerificationIntentRequirement,
  type VerificationIntentRequirementInput,
} from '../../verification/hostedIntents';
import { resolveAuth } from './auth';
import { errorResponse, generateRequestId, jsonResponse } from './helpers';
import type { PublicV2Config } from './types';

export async function handleVerificationIntentsRoutes(
  request: Request,
  subPath: string,
  config: PublicV2Config
): Promise<Response> {
  const reqId = generateRequestId();
  const convex = getConvexClientFromUrl(config.convexUrl);

  if (subPath === '/verification-intents') {
    if (request.method !== 'POST') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }

    const auth = await resolveAuth(request, config, ['verification:read'], reqId);
    if (auth instanceof Response) return auth;

    let body: {
      packageId?: string;
      packageName?: string;
      machineFingerprint?: string;
      codeChallenge?: string;
      returnUrl?: string;
      idempotencyKey?: string;
      requirements?: VerificationIntentRequirementInput[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse('bad_request', 'Invalid JSON body', 400, reqId);
    }

    if (
      !body?.packageId ||
      !body.machineFingerprint ||
      !body.codeChallenge ||
      !body.returnUrl ||
      !Array.isArray(body.requirements)
    ) {
      return errorResponse(
        'bad_request',
        'packageId, machineFingerprint, codeChallenge, returnUrl, and requirements are required',
        400,
        reqId
      );
    }

    let requirements: StoredVerificationIntentRequirement[];
    try {
      requirements = normalizeHostedVerificationRequirements(body.requirements);
    } catch (error) {
      return errorResponse(
        'bad_request',
        error instanceof Error ? error.message : 'Invalid verification requirements',
        400,
        reqId
      );
    }

    const result = await convex.mutation(api.verificationIntents.createVerificationIntent, {
      apiSecret: config.convexApiSecret,
      authUserId: auth.authUserId,
      packageId: body.packageId,
      packageName: body.packageName,
      machineFingerprint: body.machineFingerprint,
      codeChallenge: body.codeChallenge,
      returnUrl: body.returnUrl,
      idempotencyKey: body.idempotencyKey,
      requirements,
    });

    const intent = await convex.action(api.verificationIntents.getVerificationIntent, {
      apiSecret: config.convexApiSecret,
      authUserId: auth.authUserId,
      intentId: result.intentId,
    });

    return jsonResponse(
      mapHostedVerificationIntentResponse(
        intent as HostedVerificationIntentRecord | null,
        config.frontendBaseUrl
      ),
      200,
      reqId
    );
  }

  const redeemMatch = subPath.match(/^\/verification-intents\/([^/]+)\/redeem$/);
  if (redeemMatch) {
    if (request.method !== 'POST') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['verification:read'], reqId);
    if (auth instanceof Response) return auth;

    let body: {
      codeVerifier?: string;
      machineFingerprint?: string;
      grantToken?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse('bad_request', 'Invalid JSON body', 400, reqId);
    }
    if (!body?.codeVerifier || !body.machineFingerprint || !body.grantToken) {
      return errorResponse(
        'bad_request',
        'codeVerifier, machineFingerprint, and grantToken are required',
        400,
        reqId
      );
    }

    const result = await convex.action(api.verificationIntents.redeemVerificationIntent, {
      apiSecret: config.convexApiSecret,
      authUserId: auth.authUserId,
      intentId: redeemMatch[1] as Id<'verification_intents'>,
      codeVerifier: body.codeVerifier,
      machineFingerprint: body.machineFingerprint,
      grantToken: body.grantToken,
      issuerBaseUrl: config.apiBaseUrl,
    });
    if (!result.success) {
      return errorResponse(
        'verification_redeem_failed',
        result.error ?? 'Could not redeem verification intent',
        422,
        reqId
      );
    }
    return jsonResponse(
      {
        object: 'verification_redemption',
        success: true,
        token: result.token,
        expiresAt: result.expiresAt,
      },
      200,
      reqId
    );
  }

  const idMatch = subPath.match(/^\/verification-intents\/([^/]+)$/);
  if (idMatch) {
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Method not allowed', 405, reqId);
    }
    const auth = await resolveAuth(request, config, ['verification:read'], reqId);
    if (auth instanceof Response) return auth;

    const intent = await convex.action(api.verificationIntents.getVerificationIntent, {
      apiSecret: config.convexApiSecret,
      authUserId: auth.authUserId,
      intentId: idMatch[1] as Id<'verification_intents'>,
    });
    if (!intent) {
      return errorResponse('not_found', 'Verification intent not found', 404, reqId);
    }
    return jsonResponse(
      mapHostedVerificationIntentResponse(
        intent as HostedVerificationIntentRecord | null,
        config.frontendBaseUrl
      ),
      200,
      reqId
    );
  }

  return errorResponse('not_found', 'Route not found', 404, reqId);
}
