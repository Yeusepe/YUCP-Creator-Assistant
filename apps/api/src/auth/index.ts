/**
 * Better Auth configuration for YUCP Creator Assistant
 *
 * Auth runs on Convex. Bun acts as a transparent proxy for /api/auth/*.
 * - handler: proxies requests to Convex .site URL
 * - getSession / signOut: minimal helpers that hit our proxy (so traffic flows through our API)
 *
 * Convex owns Better Auth. Bun does not implement auth; it only proxies.
 */

export interface AuthConfig {
  /** Base URL for our API (clients and server-side helpers hit this; we proxy to Convex) */
  baseUrl: string;
  /** Convex site URL (where we proxy auth requests) */
  convexSiteUrl: string;
}

/** Better Auth session shape (from get-session endpoint) */
export interface SessionData {
  user: { id: string; email?: string | null; name?: string | null; image?: string | null };
  session: { id: string; expiresAt: number };
}

/**
 * Auth instance for the Bun API.
 * - handler: transparent proxy for /api/auth/* -> Convex
 * - getSession, signOut: minimal helpers for server-side checks (hit our proxy, which forwards to Convex)
 */
export function createAuth(config: AuthConfig) {
  const base = config.baseUrl.replace(/\/$/, '');
  const apiBase = `${base}/api/auth`;

  return {
    handler: createAuthProxyHandler(config.convexSiteUrl),

    /** Get session by forwarding request cookies through our proxy to Convex. */
    async getSession(request: Request): Promise<SessionData | null> {
      const res = await fetch(`${apiBase}/get-session`, {
        method: 'GET',
        headers: {
          cookie: request.headers.get('cookie') ?? '',
          'content-type': 'application/json',
        },
      });
      const json = (await res.json()) as { data?: SessionData | null };
      return json?.data ?? null;
    },

    /** Sign out by forwarding request cookies through our proxy to Convex. */
    async signOut(request: Request): Promise<void> {
      await fetch(`${apiBase}/sign-out`, {
        method: 'POST',
        headers: {
          cookie: request.headers.get('cookie') ?? '',
          'content-type': 'application/json',
        },
      });
    },

    /** Admin: revoke session by token. Forwards through our proxy. */
    async revokeSession(opts: { body: { token: string }; headers?: Headers }): Promise<void> {
      await fetch(`${apiBase}/revoke-session`, {
        method: 'POST',
        headers: {
          cookie: opts.headers?.get('cookie') ?? '',
          'content-type': 'application/json',
        },
        body: JSON.stringify(opts.body),
      });
    },

    /** Admin: revoke all sessions for a user. Forwards through our proxy. */
    async revokeUserSessions(opts: { body: { userId: string }; headers?: Headers }): Promise<void> {
      await fetch(`${apiBase}/revoke-sessions`, {
        method: 'POST',
        headers: {
          cookie: opts.headers?.get('cookie') ?? '',
          'content-type': 'application/json',
        },
        body: JSON.stringify(opts.body),
      });
    },

    /** Admin: list sessions for a user. Forwards through our proxy. */
    async listUserSessions(opts: { body: { userId: string }; headers?: Headers }): Promise<unknown[]> {
      const res = await fetch(`${apiBase}/list-sessions`, {
        method: 'POST',
        headers: {
          cookie: opts.headers?.get('cookie') ?? '',
          'content-type': 'application/json',
        },
        body: JSON.stringify(opts.body),
      });
      const json = (await res.json()) as { data?: unknown[] };
      return json?.data ?? [];
    },
  };
}

/**
 * Rewrites Set-Cookie headers to remove domain so cookies work for our API domain.
 */
function rewriteSetCookie(headers: Headers): void {
  const setCookie = headers.get('set-cookie');
  if (setCookie) {
    headers.delete('set-cookie');
    const rewritten = setCookie
      .split(', ')
      .map((c) => {
        const parts = c.split('; ');
        return parts
          .filter((p) => !p.toLowerCase().startsWith('domain='))
          .join('; ');
      })
      .join(', ');
    headers.append('set-cookie', rewritten);
  }
}

/**
 * Proxies /api/auth/* requests to Convex site URL.
 * Rewrites Set-Cookie domain so cookies work for our API domain.
 * Forwards X-Forwarded-Host and X-Forwarded-Proto so Better Auth sees the original
 * client URL (e.g. localhost:3001) instead of the Convex URL, fixing OAuth state verification.
 */
function createAuthProxyHandler(convexSiteUrl: string) {
  const base = convexSiteUrl.replace(/\/$/, '');
  const apiPath = '/api/auth';

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith(apiPath)) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const targetPath = path.slice(apiPath.length) || '/';
    const targetUrl = `${base}${apiPath}${targetPath}${url.search}`;

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('host', new URL(base).host);
    // Better Auth uses these to derive the request URL for OAuth state verification.
    // Without them, Convex sees the Convex URL and state lookup fails (different origin).
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

    const res = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      // Preserve compression: pass through raw body so browser decodes correctly.
      // Without this, Bun decompresses and we'd forward decompressed body with
      // Content-Encoding: gzip -> ERR_CONTENT_DECODING_FAILED.
      decompress: false,
    });

    const resHeaders = new Headers(res.headers);

    // Better Auth on Convex uses a custom header to bypass Convex HTTP router limitations.
    // We must convert it back to a standard Set-Cookie header for the browser.
    const betterAuthCookie = resHeaders.get('set-better-auth-cookie');
    if (betterAuthCookie) {
      resHeaders.append('set-cookie', betterAuthCookie);
      resHeaders.delete('set-better-auth-cookie');
    }

    rewriteSetCookie(resHeaders);

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    });
  };
}

// Re-export types and utilities
export type { SessionManager, SessionInfo } from './session';
export { createSessionManager } from './session';
export { validateDiscordConfig, createDiscordProvider } from './discord';

/**
 * Auth instance type
 */
export type Auth = ReturnType<typeof createAuth>;
