/**
 * Auth module for the Bun API server.
 *
 * Auth runs on Convex. The browser talks directly to the Convex .site URL
 * for sign-in, callbacks, and session management. This module provides:
 *
 * - getSession: verifies sessions by calling Convex directly
 * - exchangeOTT: exchanges a one-time-token for a session (post-OAuth)
 *
 * No proxy is needed - the cross-domain plugin on Convex handles the
 * cookie gap between the Bun API server and Convex via custom headers
 * and one-time-tokens.
 */

import { createLogger } from '@yucp/shared';
import { createHash, createHmac } from 'node:crypto';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
const INTERNAL_AUTH_TS_HEADER = 'x-yucp-internal-auth-ts';
const INTERNAL_AUTH_SIG_HEADER = 'x-yucp-internal-auth-sig';

export type TwoFactorAuthType = 'totp' | 'emailOtp' | 'otp';

export interface VrchatOwnershipPayload {
  vrchatUserId: string;
  displayName: string;
  ownedAvatarIds: string[];
}

export interface VrchatSessionTokensPayload {
  authToken: string;
  twoFactorAuthToken?: string;
}

export interface VrchatSessionUserPayload {
  id: string;
  displayName?: string;
  username?: string;
}

export interface VrchatInternalResponse {
  response: Response;
  browserSetCookies: string[];
  betterAuthCookieHeader: string;
}

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

  function getInternalAuthSecret(): string {
    const secret = process.env.INTERNAL_SERVICE_AUTH_SECRET;
    if (secret) {
      return secret;
    }
    if (process.env.NODE_ENV !== 'production' && process.env.BETTER_AUTH_SECRET) {
      return process.env.BETTER_AUTH_SECRET;
    }
    throw new Error('INTERNAL_SERVICE_AUTH_SECRET is required for internal auth requests');
  }

  function canonicalizeValue(value: unknown): unknown {
    if (value === null) return null;
    if (Array.isArray(value)) return value.map(canonicalizeValue);
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entryValue]) => entryValue !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entryValue]) => [key, canonicalizeValue(entryValue)])
      );
    }
    return value;
  }

  function canonicalizeJson(value: unknown): string {
    if (value === undefined) return '';
    return JSON.stringify(canonicalizeValue(value));
  }

  function splitSetCookieHeader(raw: string): string[] {
    if (!raw) return [];

    const cookies: string[] = [];
    let start = 0;
    let inExpires = false;

    for (let index = 0; index < raw.length; index += 1) {
      const slice = raw.slice(index, index + 8).toLowerCase();
      if (slice === 'expires=') {
        inExpires = true;
        index += 7;
        continue;
      }

      const char = raw[index];
      if (inExpires && char === ';') {
        inExpires = false;
        continue;
      }

      if (!inExpires && char === ',' && raw[index + 1] === ' ') {
        cookies.push(raw.slice(start, index).trim());
        start = index + 2;
      }
    }

    cookies.push(raw.slice(start).trim());
    return cookies.filter(Boolean);
  }

  function getResponseSetCookies(headers: Headers): string[] {
    const nextHeaders = headers as Headers & {
      getSetCookie?: () => string[];
    };

    const standardCookies =
      typeof nextHeaders.getSetCookie === 'function'
        ? nextHeaders.getSetCookie()
        : splitSetCookieHeader(headers.get('set-cookie') ?? '');
    const betterAuthRaw = headers.get('set-better-auth-cookie');
    const betterAuthCookies = betterAuthRaw ? splitSetCookieHeader(betterAuthRaw) : [];

    return [...new Set([...standardCookies, ...betterAuthCookies].filter(Boolean))];
  }

  function toCookieHeader(setCookies: string[]): string {
    return setCookies
      .map((cookie) => cookie.split(';', 1)[0]?.trim())
      .filter((cookie): cookie is string => Boolean(cookie))
      .join('; ');
  }

  function buildInternalHeaders(
    method: string,
    path: string,
    body: unknown,
    cookieHeader?: string,
    betterAuthCookieHeader?: string
  ): Headers {
    const timestamp = Date.now().toString();
    const bodyText = canonicalizeJson(body);
    const bodyHash = createHash('sha256').update(bodyText).digest('base64');
    const secret = getInternalAuthSecret();
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${method.toUpperCase()}.${path}.${bodyHash}`)
      .digest('base64');

    const headers = new Headers({
      [INTERNAL_AUTH_TS_HEADER]: timestamp,
      [INTERNAL_AUTH_SIG_HEADER]: signature,
      origin: config.baseUrl,
    });

    if (body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    if (cookieHeader) {
      headers.set('cookie', cookieHeader);
    }
    if (betterAuthCookieHeader) {
      headers.set('Better-Auth-Cookie', betterAuthCookieHeader);
    }

    return headers;
  }

  async function callInternalAuth(
    path: string,
    init: {
      method: 'GET' | 'POST';
      body?: unknown;
      cookieHeader?: string;
      betterAuthCookieHeader?: string;
    }
  ): Promise<VrchatInternalResponse> {
    const bodyText = init.body === undefined ? undefined : canonicalizeJson(init.body);
    const response = await fetch(`${convexAuthBase}${path}`, {
      method: init.method,
      headers: buildInternalHeaders(
        init.method,
        `/api/auth${path}`,
        init.body,
        init.cookieHeader,
        init.betterAuthCookieHeader
      ),
      ...(bodyText !== undefined ? { body: bodyText } : {}),
    });

    const browserSetCookies = getResponseSetCookies(response.headers);
    return {
      response,
      browserSetCookies,
      betterAuthCookieHeader: toCookieHeader(browserSetCookies),
    };
  }

  function summarizeCookieNames(cookieHeader: string): string[] {
    return cookieHeader
      .split(';')
      .map((part) => part.trim().split('=')[0])
      .filter(Boolean)
      .slice(0, 10);
  }

  return {
    /** Get session by calling Convex get-session directly with the request cookies. */
    async getSession(request: Request): Promise<SessionData | null> {
      const getSessionUrl = `${convexAuthBase}/get-session`;
      try {
        const cookie = request.headers.get('cookie') ?? '';
        logger.debug('getSession: calling Convex', {
          url: getSessionUrl,
          cookieLength: cookie.length,
          cookieNames: summarizeCookieNames(cookie),
          requestOrigin: request.headers.get('origin'),
          requestHost: request.headers.get('host'),
        });

        const res = await fetch(getSessionUrl, {
          method: 'GET',
          headers: {
            'Better-Auth-Cookie': cookie,
            'content-type': 'application/json',
          },
        });

        const responseBody = await res.text().catch(() => '');

        if (!res.ok) {
          logger.warn('Better Auth get-session returned non-OK', {
            url: getSessionUrl,
            status: res.status,
            statusText: res.statusText,
            requestOrigin: request.headers.get('origin'),
            requestHost: request.headers.get('host'),
            hasCookieHeader: Boolean(cookie),
            cookieLength: cookie.length,
            cookieNames: summarizeCookieNames(cookie),
            responseBodyPreview: responseBody.slice(0, 500),
            setCookieHeader: res.headers.get('set-cookie'),
            setBetterAuthCookieHeader: res.headers.get('set-better-auth-cookie'),
          });
          return null;
        }

        let json: SessionData | null = null;
        try {
          json = responseBody ? (JSON.parse(responseBody) as SessionData) : null;
        } catch (parseErr) {
          logger.warn('Better Auth get-session: response OK but body not valid JSON', {
            url: getSessionUrl,
            responseBodyPreview: responseBody.slice(0, 500),
            parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
          });
          return null;
        }

        if (json) {
          logger.debug('getSession: session found', {
            userId: json.user?.id,
            sessionId: json.session?.id?.slice(0, 8) + '...',
          });
        } else if (cookie.length > 0) {
          logger.warn('Better Auth get-session returned empty session despite cookies', {
            url: getSessionUrl,
            requestOrigin: request.headers.get('origin'),
            requestHost: request.headers.get('host'),
            cookieLength: cookie.length,
            cookieNames: summarizeCookieNames(cookie),
            responseBodyRaw: responseBody.slice(0, 500),
            responseBodyLength: responseBody.length,
            setCookieHeader: res.headers.get('set-cookie'),
            setBetterAuthCookieHeader: res.headers.get('set-better-auth-cookie'),
          });
        }
        return json ?? null;
      } catch (err) {
        logger.error('Better Auth get-session failed', {
          url: getSessionUrl,
          message: err instanceof Error ? err.message : String(err),
          requestOrigin: request.headers.get('origin'),
          requestHost: request.headers.get('host'),
        });
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
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token: ott }),
        });

        const body = await res.text();

        if (!res.ok) {
          return { session: null, setCookieHeaders: [] };
        }

        // Extract cookies from the response
        const setCookieHeaders: string[] = [];
        const betterAuthCookie = res.headers.get('set-better-auth-cookie');
        const regularSetCookie = res.headers.get('set-cookie');

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
          // Non-fatal: body was not valid JSON
        }

        return { session: json, setCookieHeaders };
      } catch (err) {
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

    async persistVrchatSession(
      vrchatUser: VrchatSessionUserPayload,
      session: VrchatSessionTokensPayload,
      requestCookieHeader?: string
    ): Promise<VrchatInternalResponse> {
      return callInternalAuth('/sign-in/vrchat/session', {
        method: 'POST',
        body: {
          vrchatUser,
          authToken: session.authToken,
          twoFactorAuthToken: session.twoFactorAuthToken,
        },
        cookieHeader: requestCookieHeader,
      });
    },

    async getVrchatSessionTokens(
      betterAuthCookieHeader: string,
      requestCookieHeader?: string
    ): Promise<VrchatInternalResponse> {
      return callInternalAuth('/vrchat/session-tokens', {
        method: 'GET',
        betterAuthCookieHeader,
        cookieHeader: requestCookieHeader,
      });
    },

    async clearVrchatSession(
      betterAuthCookieHeader: string,
      requestCookieHeader?: string
    ): Promise<VrchatInternalResponse> {
      return callInternalAuth('/vrchat/session-clear', {
        method: 'POST',
        betterAuthCookieHeader,
        cookieHeader: requestCookieHeader,
      });
    },

    async clearVrchatSessionForUser(
      vrchatUser: VrchatSessionUserPayload,
      requestCookieHeader?: string
    ): Promise<VrchatInternalResponse> {
      return callInternalAuth('/vrchat/session-clear-provider', {
        method: 'POST',
        body: {
          vrchatUser,
        },
        cookieHeader: requestCookieHeader,
      });
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
