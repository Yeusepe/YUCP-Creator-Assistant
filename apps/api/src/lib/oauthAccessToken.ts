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

export async function verifyBetterAuthAccessToken(
  token: string,
  options: VerifyOAuthAccessTokenOptions
): Promise<VerifiedOAuthAccessToken | null> {
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

    const grantedScopes =
      typeof (verified as { scope?: unknown }).scope === 'string'
        ? (verified as { scope: string }).scope.split(/\s+/).filter(Boolean)
        : [];
    const scope =
      typeof (verified as { scope?: unknown }).scope === 'string'
        ? (verified as { scope: string }).scope
        : undefined;

    if (
      !verified ||
      typeof verified.sub !== 'string' ||
      (options.requiredScopes?.some((scope) => !grantedScopes.includes(scope)) ?? false)
    ) {
      return null;
    }

    return {
      sub: verified.sub,
      scope,
      grantedScopes,
    };
  } catch (error) {
    options.logger?.warn(options.logContext ?? 'OAuth access token verification failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
