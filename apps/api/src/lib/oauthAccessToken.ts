import type { DpopReplayStore } from 'better-auth/oauth2';
import { DpopNonceRequiredError, verifyDpopProof } from '../../../../ops/storage-core/dpop';
import type { DpopNonceManager } from '../../../../ops/storage-core/dpopNonce';
import {
  PACKAGE_INSTALL_DPOP_ACCEPTED_FUTURE_SKEW_SECONDS,
  PACKAGE_INSTALL_DPOP_PROOF_MAX_AGE_SECONDS,
} from '../../../../ops/storage-core/dpopReplayPolicy';

export interface VerifiedOAuthAccessToken {
  grantedScopes: string[];
  scope?: string;
  sub: string;
}

export interface VerifiedOAuthAccessRequest extends VerifiedOAuthAccessToken {
  deviceKeyThumbprint: string;
}

interface LoggerLike {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface VerifyOAuthAccessTokenOptions {
  audience: string;
  convexSiteUrl: string;
  logger?: LoggerLike;
  logContext?: string;
  requiredScopes?: string[];
}

export interface VerifyOAuthAccessRequestOptions extends VerifyOAuthAccessTokenOptions {
  dpopNonceManager?: DpopNonceManager;
  dpopReplayStore: DpopReplayStore;
  publicResourceBaseUrl: string;
  requiredAuthorizedParty?: string;
}

export type VerifyOAuthAccessTokenResult =
  | { ok: true; token: VerifiedOAuthAccessToken }
  | { ok: false; reason: 'invalid' | 'insufficient_scope' };

export type VerifyOAuthAccessRequestResult =
  | { ok: true; token: VerifiedOAuthAccessRequest }
  | { dpopNonce: string; ok: false; reason: 'use_dpop_nonce' }
  | { ok: false; reason: 'invalid' | 'insufficient_scope' | 'unavailable' };

const EXPECTED_VERIFICATION_ERROR_NAMES = new Set([
  'JWTInvalid',
  'JWTExpired',
  'JWKSNoMatchingKey',
  'JWSSignatureVerificationFailed',
]);

const EXPECTED_VERIFICATION_ERROR_MESSAGES = [
  'no applicable key found in the json web key set',
  'jwt expired',
  'signature verification failed',
  'invalid compact jws',
  'invalid jwt',
];

const VERIFICATION_DEPENDENCY_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
]);

function isExpectedVerificationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (EXPECTED_VERIFICATION_ERROR_NAMES.has(error.name)) {
    return true;
  }

  const normalizedMessage = error.message.trim().toLowerCase();
  return EXPECTED_VERIFICATION_ERROR_MESSAGES.some((fragment) =>
    normalizedMessage.includes(fragment)
  );
}

function isVerificationDependencyFailure(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 3) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && VERIFICATION_DEPENDENCY_ERROR_CODES.has(code.toUpperCase())) {
    return true;
  }
  return isVerificationDependencyFailure((error as Error & { cause?: unknown }).cause, depth + 1);
}

function proofContainsNonce(proof: string | null): boolean {
  if (!proof) {
    return false;
  }
  const parts = proof.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return Boolean(
      payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        Object.hasOwn(payload, 'nonce')
    );
  } catch {
    return false;
  }
}

function isDpopClockWindowFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.message === 'DPoP proof iat is outside the accepted window'
  );
}

async function verifyNonceCapableAccessRequest(
  request: Request,
  options: VerifyOAuthAccessRequestOptions,
  publicRequestUrl: URL,
  authBase: string
) {
  const authorization = /^DPoP\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  const proof = request.headers.get('dpop')?.trim();
  if (!authorization?.[1] || !proof || !options.dpopNonceManager) {
    throw new Error('DPoP authorization is incomplete');
  }
  const accessToken = authorization[1];
  const { getDpopJktFromPayload, verifyJwsAccessToken } = await import('better-auth/oauth2');
  const verified = await verifyJwsAccessToken(accessToken, {
    jwksFetch: `${authBase}/jwks`,
    verifyOptions: {
      issuer: authBase,
      audience: options.audience,
    },
  });
  const jkt = getDpopJktFromPayload(verified);
  if (!jkt) {
    throw new Error('DPoP-bound access token confirmation key is missing');
  }
  const expectedThumbprint = Buffer.from(jkt, 'base64url');
  if (expectedThumbprint.byteLength !== 32 || expectedThumbprint.toString('base64url') !== jkt) {
    throw new Error('DPoP-bound access token confirmation key is invalid');
  }
  await verifyDpopProof({
    acceptedFutureSkewSeconds: PACKAGE_INSTALL_DPOP_ACCEPTED_FUTURE_SKEW_SECONDS,
    accessToken,
    clockWindowSeconds: PACKAGE_INSTALL_DPOP_PROOF_MAX_AGE_SECONDS,
    expectedThumbprint,
    method: request.method,
    nonceVerifier: options.dpopNonceManager,
    proof,
    replayStore: options.dpopReplayStore,
    url: publicRequestUrl.href,
  });
  return verified;
}

export async function verifyBetterAuthAccessToken(
  token: string,
  options: VerifyOAuthAccessTokenOptions
): Promise<VerifyOAuthAccessTokenResult> {
  try {
    // Better Auth 1.7 verifier migration:
    // https://better-auth.com/docs/guides/1-7-upgrade-guide#dpop-renames-the-token-verifier
    const { verifyBearerToken } = await import('better-auth/oauth2');
    const authBase = `${options.convexSiteUrl.replace(/\/$/, '')}/api/auth`;
    const verified = await verifyBearerToken(token, {
      verifyOptions: {
        issuer: authBase,
        audience: options.audience,
      },
      jwksUrl: `${authBase}/jwks`,
    });

    if (!verified || typeof verified.sub !== 'string') {
      return { ok: false, reason: 'invalid' };
    }

    const grantedScopes =
      typeof (verified as { scope?: unknown }).scope === 'string'
        ? (verified as { scope: string }).scope.split(/\s+/).filter(Boolean)
        : [];
    const scope =
      typeof (verified as { scope?: unknown }).scope === 'string'
        ? (verified as { scope: string }).scope
        : undefined;

    if (options.requiredScopes?.some((s) => !grantedScopes.includes(s)) ?? false) {
      return { ok: false, reason: 'insufficient_scope' };
    }

    return {
      ok: true,
      token: { sub: verified.sub, scope, grantedScopes },
    };
  } catch (error) {
    const logMessage = options.logContext ?? 'OAuth access token verification failed';
    const metadata = {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.name ? { name: error.name } : {}),
    };

    if (isExpectedVerificationFailure(error)) {
      options.logger?.debug?.(logMessage, metadata);
    } else {
      options.logger?.warn(logMessage, metadata);
    }

    return { ok: false, reason: 'invalid' };
  }
}

export async function verifyBetterAuthAccessRequest(
  request: Request,
  options: VerifyOAuthAccessRequestOptions
): Promise<VerifyOAuthAccessRequestResult> {
  try {
    /**
     * Better Auth recommends request-aware verification for DPoP-bound resources.
     * https://better-auth.com/docs/plugins/oauth-provider#resource-server
     *
     * RFC 9449 binds the proof to method, URL, token hash, and the token key.
     * https://www.rfc-editor.org/rfc/rfc9449#section-7.1
     */
    const { getDpopJktFromPayload, requestToResourceInput, verifyAccessTokenRequest } =
      await import('better-auth/oauth2');
    const authBase = `${options.convexSiteUrl.replace(/\/$/, '')}/api/auth`;
    const publicBaseUrl = new URL(options.publicResourceBaseUrl);
    if (
      (publicBaseUrl.protocol !== 'https:' && publicBaseUrl.protocol !== 'http:') ||
      publicBaseUrl.username ||
      publicBaseUrl.password
    ) {
      throw new Error('OAuth public resource base URL is invalid');
    }
    const internalRequestUrl = new URL(request.url);
    const publicRequestUrl = new URL(
      `${internalRequestUrl.pathname}${internalRequestUrl.search}`,
      publicBaseUrl.origin
    );
    const resourceInput = {
      ...requestToResourceInput(request),
      /**
       * Better Auth compares DPoP `htu` with this exact URL. Its resource-server
       * documentation requires the externally visible URL behind a proxy.
       * The configured public origin is trusted; client-supplied forwarding
       * headers are intentionally ignored.
       * https://better-auth.com/docs/beta/plugins/oauth-provider#verification
       */
      url: publicRequestUrl.href,
    };
    let verified: Awaited<ReturnType<typeof verifyAccessTokenRequest>>;
    if (options.dpopNonceManager && proofContainsNonce(request.headers.get('dpop'))) {
      verified = await verifyNonceCapableAccessRequest(
        request,
        options,
        publicRequestUrl,
        authBase
      );
    } else {
      try {
        verified = await verifyAccessTokenRequest(resourceInput, {
          verifyOptions: {
            issuer: authBase,
            audience: options.audience,
          },
          jwksUrl: `${authBase}/jwks`,
          dpop: {
            proofMaxAgeSeconds: PACKAGE_INSTALL_DPOP_PROOF_MAX_AGE_SECONDS,
            replayStore: options.dpopReplayStore,
            signingAlgorithms: ['ES256'],
          },
        });
      } catch (error) {
        if (!options.dpopNonceManager || !isDpopClockWindowFailure(error)) {
          throw error;
        }
        verified = await verifyNonceCapableAccessRequest(
          request,
          options,
          publicRequestUrl,
          authBase
        );
      }
    }
    const jkt = getDpopJktFromPayload(verified);
    if (
      !verified ||
      typeof verified.sub !== 'string' ||
      !jkt ||
      (options.requiredAuthorizedParty &&
        (verified as { azp?: unknown }).azp !== options.requiredAuthorizedParty)
    ) {
      return { ok: false, reason: 'invalid' };
    }
    let thumbprint: Buffer;
    try {
      thumbprint = Buffer.from(jkt, 'base64url');
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (thumbprint.byteLength !== 32 || thumbprint.toString('base64url') !== jkt) {
      return { ok: false, reason: 'invalid' };
    }
    const grantedScopes =
      typeof (verified as { scope?: unknown }).scope === 'string'
        ? (verified as { scope: string }).scope.split(/\s+/).filter(Boolean)
        : [];
    const scope =
      typeof (verified as { scope?: unknown }).scope === 'string'
        ? (verified as { scope: string }).scope
        : undefined;
    if (options.requiredScopes?.some((value) => !grantedScopes.includes(value)) ?? false) {
      return { ok: false, reason: 'insufficient_scope' };
    }
    return {
      ok: true,
      token: {
        deviceKeyThumbprint: thumbprint.toString('hex'),
        grantedScopes,
        scope,
        sub: verified.sub,
      },
    };
  } catch (error) {
    const logMessage = options.logContext ?? 'OAuth access request verification failed';
    if (error instanceof DpopNonceRequiredError && options.dpopNonceManager) {
      try {
        const challenge = await options.dpopNonceManager.issue();
        options.logger?.warn(logMessage, {
          expected: true,
          message: error.message,
          name: error.name,
          proofClockOffsetSeconds: error.proofClockOffsetSeconds,
          remediation: 'use_dpop_nonce',
        });
        return {
          dpopNonce: challenge.nonce,
          ok: false,
          reason: 'use_dpop_nonce',
        };
      } catch (nonceError) {
        options.logger?.warn('DPoP nonce issuance failed', {
          message: nonceError instanceof Error ? nonceError.message : String(nonceError),
        });
        return { ok: false, reason: 'unavailable' };
      }
    }
    const metadata = {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.name ? { name: error.name } : {}),
      expected: isExpectedVerificationFailure(error),
      ...describeRejectedTokenTiming(request),
    };
    // Request-bound broker verification has exactly one legitimate caller, so even
    // "expected" rejections are actionable and must be visible in production logs.
    options.logger?.warn(logMessage, metadata);
    return {
      ok: false,
      reason: isVerificationDependencyFailure(error) ? 'unavailable' : 'invalid',
    };
  }
}

/**
 * Unverified claim timing for a rejected token: enough to distinguish issuer
 * clock skew from lifetime exhaustion without logging the token itself.
 */
function describeRejectedTokenTiming(request: Request): Record<string, number | string> {
  try {
    const authorization = request.headers.get('authorization') ?? '';
    const token = authorization.replace(/^(DPoP|Bearer)\s+/i, '').trim();
    const payloadSegment = token.split('.')[1];
    if (!payloadSegment) return {};
    const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      azp?: string;
      exp?: number;
      iat?: number;
    };
    const now = Math.floor(Date.now() / 1_000);
    return {
      ...(typeof claims.iat === 'number' ? { tokenIssuedSecondsAgo: now - claims.iat } : {}),
      ...(typeof claims.exp === 'number' ? { tokenExpiresInSeconds: claims.exp - now } : {}),
      ...(typeof claims.exp === 'number' && typeof claims.iat === 'number'
        ? { tokenLifetimeSeconds: claims.exp - claims.iat }
        : {}),
      ...(typeof claims.azp === 'string' ? { tokenAuthorizedParty: claims.azp } : {}),
    };
  } catch {
    return {};
  }
}
