import { resolveConvexSiteUrl } from '@yucp/shared';
import { ConvexError } from 'convex/values';
import { logWebError } from '@/lib/webDiagnostics';
import { filterForwardedSessionCookieHeader } from './server/forwardedAuthCookies';
import { getWebRuntimeEnv } from './server/runtimeEnv';

const AUTH_COOKIE_PREFIX = 'yucp';
const AUTH_COOKIE_NAME_PREFIXES = [
  `${AUTH_COOKIE_PREFIX}.`,
  `__Secure-${AUTH_COOKIE_PREFIX}.`,
  `__Host-${AUTH_COOKIE_PREFIX}.`,
] as const;

function isConvexAuthError(error: unknown): boolean {
  const message =
    (error instanceof ConvexError ? String(error.data ?? '') : undefined) ??
    (error instanceof Error ? error.message : String(error));

  return /auth/i.test(message);
}

const AUTH_TOKEN_OPTIONS = {
  cookiePrefix: AUTH_COOKIE_PREFIX,
  // Official experimental guidance from Convex Better Auth recommends reusing
  // the cached JWT cookie for SSR/server helpers and pairing it with a broad
  // auth-error detector. This avoids an extra token round-trip on many
  // authenticated requests while still allowing a refresh when needed.
  // Ref: https://labs.convex.dev/better-auth/experimental
  jwtCache: {
    enabled: true,
    isAuthError: isConvexAuthError,
  },
} as const;

/**
 * Server-side auth utilities for TanStack Start.
 *
 * - `handleAuthRequest`: Proxies /api/auth/* requests to Convex
 * - `getToken`: Gets JWT from session cookies (for SSR auth in beforeLoad)
 *
 * Env vars CONVEX_URL and CONVEX_SITE_URL come from Worker bindings or local
 * Worker env files during development.
 * Ref: https://labs.convex.dev/better-auth/framework-guides/tanstack-start
 */
function resolveAuthRuntimeConfig(env = getWebRuntimeEnv()) {
  const convexSiteUrl = resolveConvexSiteUrl(env) ?? '';

  return {
    convexSiteUrl,
  };
}

function parseJwtExpiration(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) {
    return undefined;
  }

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const paddingLength = (4 - (normalized.length % 4)) % 4;
    const decoded = JSON.parse(atob(normalized.padEnd(normalized.length + paddingLength, '='))) as {
      exp?: unknown;
    };
    return typeof decoded.exp === 'number' ? decoded.exp : undefined;
  } catch {
    return undefined;
  }
}

function getCachedConvexJwt(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const expectedNames = new Set(AUTH_COOKIE_NAME_PREFIXES.map((prefix) => `${prefix}convex_jwt`));
  for (const entry of cookieHeader.split(';')) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex < 1) {
      continue;
    }

    const name = entry.slice(0, separatorIndex).trim();
    if (!expectedNames.has(name)) {
      continue;
    }

    const value = entry.slice(separatorIndex + 1).trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

async function fetchConvexAuthToken(
  convexSiteUrl: string,
  headers: Headers,
  options: typeof AUTH_TOKEN_OPTIONS & { forceRefresh?: boolean }
): Promise<{ isFresh: boolean; token?: string }> {
  if (options.jwtCache.enabled && !options.forceRefresh) {
    const cachedToken = getCachedConvexJwt(headers.get('cookie'));
    const expiration = cachedToken ? parseJwtExpiration(cachedToken) : undefined;
    const refreshFloor = Math.floor(Date.now() / 1000) + 60;
    if (cachedToken && expiration !== undefined && expiration > refreshFloor) {
      return { isFresh: false, token: cachedToken };
    }
  }

  const response = await fetch(new URL('/api/auth/convex/token', convexSiteUrl), {
    headers,
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Convex auth token fetch failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { token?: unknown } | null;
  return {
    isFresh: true,
    token: typeof payload?.token === 'string' ? payload.token : undefined,
  };
}

async function proxyAuthRequest(request: Request, convexSiteUrl: string): Promise<Response> {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, convexSiteUrl);
  const headers = new Headers(request.headers);
  headers.delete('transfer-encoding');
  headers.delete('content-length');
  headers.delete('connection');
  headers.set('accept-encoding', 'application/json');
  headers.set('host', targetUrl.host);
  headers.set('x-forwarded-host', requestUrl.host);
  headers.set('x-forwarded-proto', requestUrl.protocol.replace(/:$/, ''));
  headers.set('x-better-auth-forwarded-host', requestUrl.host);
  headers.set('x-better-auth-forwarded-proto', requestUrl.protocol.replace(/:$/, ''));

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  return fetch(targetUrl, init);
}

interface BetterAuthSessionUser {
  id?: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

interface BetterAuthSessionResponse {
  user?: BetterAuthSessionUser | null;
  session?: Record<string, unknown> | null;
}

export interface AuthSessionState {
  isAuthenticated: boolean;
  userId: string | null;
  email: string | null;
  name: string | null;
  image: string | null;
}

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
 * from data.redirectTo and navigates programmatically, the same pattern
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
  const { convexSiteUrl } = resolveAuthRuntimeConfig();
  const res = await proxyAuthRequest(request, convexSiteUrl);
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

function getRecoverableAuthCookieNames(cookieHeader: string | null): string[] {
  return (getCookieNames(cookieHeader) ?? []).filter((cookieName) =>
    AUTH_COOKIE_NAME_PREFIXES.some((prefix) => cookieName.startsWith(prefix))
  );
}

async function clearRecoverableAuthCookies(cookieHeader: string | null): Promise<void> {
  const cookieNames = getRecoverableAuthCookieNames(cookieHeader);
  if (cookieNames.length === 0) {
    return;
  }

  const { deleteCookie } = await import('@tanstack/react-start/server');
  for (const cookieName of cookieNames) {
    deleteCookie(cookieName, {
      path: '/',
      ...(cookieName.startsWith('__Secure-') || cookieName.startsWith('__Host-')
        ? { secure: true }
        : {}),
    });
  }
}

function getRenewedAuthCookies(headers: Headers): string[] {
  const getSetCookie = (
    headers as Headers & {
      getSetCookie?: () => string[];
    }
  ).getSetCookie;
  const cookies =
    typeof getSetCookie === 'function'
      ? getSetCookie.call(headers)
      : [headers.get('set-cookie')].filter((value): value is string => Boolean(value));

  return cookies.filter((cookie) => {
    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex < 1) {
      return false;
    }

    const cookieName = cookie.slice(0, separatorIndex).trim();
    return AUTH_COOKIE_NAME_PREFIXES.some((prefix) => cookieName.startsWith(prefix));
  });
}

async function forwardRenewedAuthCookies(headers: Headers): Promise<void> {
  const cookies = getRenewedAuthCookies(headers);
  if (cookies.length === 0) {
    return;
  }

  // Better Auth renews the durable session cookie through get-session:
  // https://better-auth.com/docs/concepts/session-management#session-expiration
  const { getResponseHeaders } = await import('@tanstack/react-start/server');
  const responseHeaders = getResponseHeaders();
  for (const cookie of cookies) {
    responseHeaders.append('set-cookie', cookie);
  }
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

function buildAuthRequestHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers();
  const cookieHeader = filterForwardedSessionCookieHeader(requestHeaders.get('cookie'));

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
  const { convexSiteUrl } = resolveAuthRuntimeConfig();

  return {
    convexSiteUrl: convexSiteUrl || undefined,
    ...summarizeRequestHeaders(headers),
    forwardedTokenHeaderNames: Array.from(buildAuthRequestHeaders(headers).keys()),
    ...(convexSiteUrl ? await probeConvexAuthEndpoints(convexSiteUrl) : {}),
  };
}

export async function getToken(): Promise<string | undefined> {
  try {
    const headers = await getCurrentRequestHeaders();
    const { convexSiteUrl } = resolveAuthRuntimeConfig();
    const token = await fetchConvexAuthToken(
      convexSiteUrl,
      buildAuthRequestHeaders(headers),
      AUTH_TOKEN_OPTIONS
    );

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

function toUnauthenticatedSessionState(): AuthSessionState {
  return {
    isAuthenticated: false,
    userId: null,
    email: null,
    name: null,
    image: null,
  };
}

export async function getSession(): Promise<AuthSessionState> {
  try {
    const requestHeaders = await getCurrentRequestHeaders();
    const incomingCookieHeader = requestHeaders.get('cookie');
    const authHeaders = buildAuthRequestHeaders(requestHeaders);
    const { convexSiteUrl } = resolveAuthRuntimeConfig();

    if (!authHeaders.has('cookie')) {
      return toUnauthenticatedSessionState();
    }

    const response = await fetch(new URL('/api/auth/get-session', convexSiteUrl), {
      headers: authHeaders,
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Better Auth session fetch failed with status ${response.status}`);
    }

    await forwardRenewedAuthCookies(response.headers);

    const payload = (await response.json()) as BetterAuthSessionResponse | null;
    const user = payload?.user;
    if (!user?.id || !user.id.trim()) {
      await clearRecoverableAuthCookies(incomingCookieHeader);
      return toUnauthenticatedSessionState();
    }

    return {
      isAuthenticated: true,
      userId: user.id,
      email: typeof user.email === 'string' ? user.email : null,
      name: typeof user.name === 'string' ? user.name : null,
      image: typeof user.image === 'string' ? user.image : null,
    };
  } catch (error) {
    try {
      logWebError('Auth session fetch failed', error, {
        phase: 'auth-server-getSession',
        ...(await collectAuthRuntimeDiagnostics()),
      });
    } catch (diagnosticError) {
      logWebError('Auth session diagnostics failed', diagnosticError, {
        phase: 'auth-server-getSession',
      });
    }

    throw error;
  }
}
