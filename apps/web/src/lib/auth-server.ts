import { convexBetterAuthReactStart } from '@convex-dev/better-auth/react-start';
import { getToken as fetchConvexAuthToken } from '@convex-dev/better-auth/utils';
import { resolveConvexSiteUrl } from '@yucp/shared';
import { logWebError } from '@/lib/webDiagnostics';

const convexSiteUrl = resolveConvexSiteUrl(process.env) ?? '';

/**
 * Server-side auth utilities for TanStack Start.
 *
 * - `handler`: Proxies /api/auth/* requests to Convex
 * - `getToken`: Gets JWT from session cookies (for SSR auth in beforeLoad)
 * - `fetchAuthQuery/Mutation/Action`: Call Convex functions with auth from server fns
 *
 * Env vars CONVEX_URL and CONVEX_SITE_URL come from Infisical bootstrap.
 * Ref: https://labs.convex.dev/better-auth/framework-guides/tanstack-start
 */
const authRuntime = convexBetterAuthReactStart({
  convexUrl: process.env.CONVEX_URL ?? '',
  convexSiteUrl,
});

export const { handler, fetchAuthQuery, fetchAuthMutation, fetchAuthAction } = authRuntime;

function getCookieNames(cookieHeader: string | null): string[] | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const cookieNames = cookieHeader
    .split(';')
    .map((entry) => entry.split('=')[0]?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 12);

  return cookieNames.length > 0 ? cookieNames : undefined;
}

function summarizeRequestHeaders(headers: Headers): Record<string, unknown> {
  const cookieHeader = headers.get('cookie');

  return {
    requestHost: headers.get('host') ?? undefined,
    forwardedHost: headers.get('x-forwarded-host') ?? undefined,
    forwardedProto: headers.get('x-forwarded-proto') ?? undefined,
    hasCookieHeader: Boolean(cookieHeader),
    cookieHeaderLength: cookieHeader?.length,
    cookieNames: getCookieNames(cookieHeader),
    headerCount: Array.from(headers.keys()).length,
  };
}

async function probeConvexAuthEndpoints(convexSiteUrl: string): Promise<Record<string, unknown>> {
  const getSessionUrl = new URL('/api/auth/get-session', convexSiteUrl);
  const tokenUrl = new URL('/api/auth/convex/token', convexSiteUrl);

  try {
    const [getSessionResponse, tokenResponse] = await Promise.all([
      fetch(getSessionUrl, {
        headers: { accept: 'application/json' },
      }),
      fetch(tokenUrl, {
        headers: { accept: 'application/json' },
      }),
    ]);

    return {
      directGetSessionStatus: getSessionResponse.status,
      directTokenStatus: tokenResponse.status,
    };
  } catch (error) {
    return {
      directProbeError: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildAuthTokenRequestHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers();
  const cookieHeader = requestHeaders.get('cookie');

  if (cookieHeader) {
    headers.set('cookie', cookieHeader);
  }

  headers.set('accept', 'application/json');
  headers.set('accept-encoding', 'identity');

  return headers;
}

async function getCurrentRequestHeaders(): Promise<Headers> {
  const { getRequestHeaders } = await import('@tanstack/react-start/server');

  return new Headers(getRequestHeaders());
}

export async function collectAuthRuntimeDiagnostics(): Promise<Record<string, unknown>> {
  const headers = await getCurrentRequestHeaders();

  return {
    convexSiteUrl: convexSiteUrl || undefined,
    ...summarizeRequestHeaders(headers),
    forwardedTokenHeaderNames: Array.from(buildAuthTokenRequestHeaders(headers).keys()),
    ...(convexSiteUrl ? await probeConvexAuthEndpoints(convexSiteUrl) : {}),
  };
}

export async function getToken(): Promise<string | undefined> {
  try {
    const headers = await getCurrentRequestHeaders();
    const token = await fetchConvexAuthToken(convexSiteUrl, buildAuthTokenRequestHeaders(headers));

    return token.token;
  } catch (error) {
    try {
      logWebError('Auth token fetch failed', error, {
        phase: 'auth-server-getToken',
        ...(await collectAuthRuntimeDiagnostics()),
      });
    } catch (diagnosticError) {
      logWebError('Auth token diagnostics failed', diagnosticError, {
        phase: 'auth-server-getToken',
      });
    }

    throw error;
  }
}
