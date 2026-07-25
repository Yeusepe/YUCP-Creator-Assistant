export interface VerifiedOAuthAccessToken {
  grantedScopes: string[];
  scope?: string;
  sub: string;
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

export type VerifyOAuthAccessTokenResult =
  | { ok: true; token: VerifiedOAuthAccessToken }
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
