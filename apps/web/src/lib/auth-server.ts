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

/**
 * Converts a POST redirect response to a JSON { redirectTo } payload.
 *
 * @convex-dev/better-auth/react-start's handler fetches Convex with
 * redirect:'manual' and passes 3xx responses straight through. When the
 * browser's fetch() (default redirect:'follow') receives that 302 from
 * POST /api/auth/oauth2/consent, it follows the entire redirect chain
 * silently (Convex callback → Unity loopback server). The consent page
 * never sees the redirect target and falls back to window.location.reload().
 *
 * By converting POST redirects to JSON here, the JS client reads the URL
 * from data.redirectTo and navigates programmatically — the same pattern
 * used by the Bun API proxy (apps/api/src/index.ts).
 *
 * GET redirects pass through unchanged so the browser navigates natively
 * (e.g. the Discord OAuth redirect during sign-in).
 */
export function convertPostRedirectToJson(method: string, response: Response): Response {
  if (method === 'POST' && response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '';
    return Response.json({ redirectTo: location }, { headers: { 'cache-control': 'no-store' } });
  }
  return response;
}

/**
 * Wraps the Better Auth handler, applying convertPostRedirectToJson so that
 * POST requests that result in redirects (e.g. /api/auth/oauth2/consent)
 * return a JSON body the JS client can act on.
 */
export async function handleAuthRequest(request: Request): Promise<Response> {
  const res = await handler(request);
  return convertPostRedirectToJson(request.method, res);
}

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

  // This is an internal server-to-server token fetch. In production behind a
  // proxy, forwarding the full browser header set into /api/auth/convex/token
  // can break the request path even though direct probes still work.
  // Upstream refs:
  // - https://github.com/get-convex/better-auth/issues/294
  // - https://github.com/get-convex/better-auth/issues/295
  // - https://github.com/get-convex/better-auth/pull/253
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
