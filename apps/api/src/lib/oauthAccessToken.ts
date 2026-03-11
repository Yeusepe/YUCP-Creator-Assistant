export interface VerifiedOAuthAccessToken {
  grantedScopes: string[];
  scope?: string;
  sub: string;
}

interface LoggerLike {
  warn(message: string, metadata?: Record<string, unknown>): void;
}

interface VerifyOAuthAccessTokenOptions {
  audience: string;
  convexSiteUrl: string;
  logger?: LoggerLike;
  logContext?: string;
  requiredScopes?: string[];
}

export type VerifyOAuthAccessTokenResult =
  | { ok: true; token: VerifiedOAuthAccessToken }
  | { ok: false; reason: 'invalid' | 'insufficient_scope' };

export async function verifyBetterAuthAccessToken(
  token: string,
  options: VerifyOAuthAccessTokenOptions
): Promise<VerifyOAuthAccessTokenResult> {
  try {
    const { verifyAccessToken } = await import('better-auth/oauth2');
    const authBase = `${options.convexSiteUrl.replace(/\/$/, '')}/api/auth`;
    const verified = await verifyAccessToken(token, {
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
    options.logger?.warn(options.logContext ?? 'OAuth access token verification failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'invalid' };
  }
}
