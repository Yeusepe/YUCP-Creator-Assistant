import type { DpopReplayStore } from 'better-auth/oauth2';

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
  dpopReplayStore: DpopReplayStore;
  requiredAuthorizedParty?: string;
}

export type VerifyOAuthAccessTokenResult =
  | { ok: true; token: VerifiedOAuthAccessToken }
  | { ok: false; reason: 'invalid' | 'insufficient_scope' };

export type VerifyOAuthAccessRequestResult =
  | { ok: true; token: VerifiedOAuthAccessRequest }
  | { ok: false; reason: 'invalid' | 'insufficient_scope' };

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
    const verified = await verifyAccessTokenRequest(requestToResourceInput(request), {
      verifyOptions: {
        issuer: authBase,
        audience: options.audience,
      },
      jwksUrl: `${authBase}/jwks`,
      dpop: {
        proofMaxAgeSeconds: 300,
        replayStore: options.dpopReplayStore,
        signingAlgorithms: ['ES256'],
      },
    });
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
