/**
 * Auth module for the Bun API server.
 *
 * Auth runs on Convex. The browser talks directly to the Convex .site URL
 * for sign-in, callbacks, and session management. This module provides:
 *
 * - getSession: verifies sessions by calling Convex directly
 * - exchangeOTT: exchanges a one-time-token for a session (post-OAuth)
 *
 * No proxy is needed — the cross-domain plugin on Convex handles the
 * cookie gap between the Bun API server and Convex via custom headers
 * and one-time-tokens.
 */

export interface AuthConfig {
  /** Base URL for the Bun API server (e.g. http://localhost:3001) */
  baseUrl: string;
  /** Convex site URL (e.g. https://rare-squid-409.convex.site) */
  convexSiteUrl: string;
}

/** Better Auth session shape (from get-session endpoint) */
export interface SessionData {
  user: { id: string; email?: string | null; name?: string | null; image?: string | null };
  session: { id: string; expiresAt: number; token: string };
}

/**
 * Auth instance for the Bun API.
 * - getSession: checks session by forwarding cookies to Convex
 * - exchangeOTT: exchanges a one-time-token for a session token
 */
export function createAuth(config: AuthConfig) {
  const convexAuthBase = `${config.convexSiteUrl.replace(/\/$/, '')}/api/auth`;

  return {
    /** Get session by calling Convex get-session directly with the request cookies. */
    async getSession(request: Request): Promise<SessionData | null> {
      try {
        const cookie = request.headers.get('cookie') ?? '';
        // Send cookie as Better-Auth-Cookie header (cross-domain pattern)
        const res = await fetch(`${convexAuthBase}/get-session`, {
          method: 'GET',
          headers: {
            'Better-Auth-Cookie': cookie,
            'content-type': 'application/json',
          },
        });

        if (!res.ok) return null;

        // Also check Set-Better-Auth-Cookie for any updated cookies
        const json = (await res.json()) as SessionData | null;
        return json ?? null;
      } catch {
        return null;
      }
    },

    /**
     * Exchange a one-time-token (OTT) for a session.
     * Called after the OAuth callback redirects the user back with ?ott=<token>.
     * Returns response headers containing Set-Cookie for the session.
     */
    async exchangeOTT(ott: string): Promise<{
      session: SessionData | null;
      setCookieHeaders: string[];
    }> {
      const url = `${convexAuthBase}/cross-domain/one-time-token/verify`;
      console.log(`[AUTH] Exchanging OTT: ${ott.substring(0, 8)}... at ${url}`);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token: ott }),
        });

        console.log(`[AUTH] OTT response: ${res.status} ${res.statusText}`);
        console.log(`[AUTH] OTT response headers:`, Object.fromEntries(res.headers.entries()));

        const body = await res.text();
        console.log(`[AUTH] OTT response body: ${body.substring(0, 500)}`);

        if (!res.ok) {
          console.error(`[AUTH] OTT exchange failed: ${res.status} ${res.statusText} - ${body}`);
          return { session: null, setCookieHeaders: [] };
        }

        // Extract cookies from the response
        const setCookieHeaders: string[] = [];
        const betterAuthCookie = res.headers.get('set-better-auth-cookie');
        const regularSetCookie = res.headers.get('set-cookie');
        console.log(`[AUTH] set-better-auth-cookie: ${betterAuthCookie ?? '(none)'}`);
        console.log(`[AUTH] set-cookie: ${regularSetCookie ?? '(none)'}`);

        if (betterAuthCookie) {
          const cookies = betterAuthCookie.split(', ');
          setCookieHeaders.push(...cookies);
        }
        if (regularSetCookie) {
          const cookies = regularSetCookie.split(', ');
          setCookieHeaders.push(...cookies);
        }

        let json: SessionData | null = null;
        try {
          json = JSON.parse(body) as SessionData;
        } catch {
          console.error('[AUTH] Failed to parse OTT response body as JSON');
        }

        console.log(`[AUTH] OTT exchange result: session=${!!json}, cookies=${setCookieHeaders.length}`);
        return { session: json, setCookieHeaders };
      } catch (err) {
        console.error('[AUTH] OTT exchange error:', err);
        return { session: null, setCookieHeaders: [] };
      }
    },

    /** Sign out by calling Convex directly. */
    async signOut(request: Request): Promise<void> {
      const cookie = request.headers.get('cookie') ?? '';
      await fetch(`${convexAuthBase}/sign-out`, {
        method: 'POST',
        headers: {
          'Better-Auth-Cookie': cookie,
          'content-type': 'application/json',
        },
      });
    },

    /**
     * Get the linked Discord user ID from the current session.
     * Calls Better Auth's list-accounts endpoint via the cross-domain pattern.
     */
    async getDiscordUserId(request: Request): Promise<string | null> {
      try {
        const cookie = request.headers.get('cookie') ?? '';
        const res = await fetch(`${convexAuthBase}/list-accounts`, {
          method: 'GET',
          headers: {
            'Better-Auth-Cookie': cookie,
            'content-type': 'application/json',
          },
        });

        if (!res.ok) return null;

        const accounts = (await res.json()) as Array<{
          accountId: string;
          providerId: string;
          [key: string]: any;
        }>;

        const discordAccount = accounts?.find?.(
          (a) => a.providerId === 'discord'
        );
        return discordAccount?.accountId ?? null;
      } catch {
        return null;
      }
    },
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
