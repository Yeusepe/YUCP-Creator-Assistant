import { createHash, createHmac } from 'node:crypto';
import { createLogger } from '@yucp/shared';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';

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
  baseUrl: string;
  convexSiteUrl: string;
  convexUrl: string;
}

export interface SessionData {
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
  };
  discordUserId?: string | null;
}

type ViewerData = {
  authUserId: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  discordUserId?: string | null;
};

function getConvexClient(url: string): ConvexHttpClient {
  const convexUrl = url.startsWith('http')
    ? url
    : `https://${url.includes(':') ? url.split(':')[1] : url}.convex.cloud`;
  return new ConvexHttpClient(convexUrl);
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

export function createAuth(config: AuthConfig) {
  const convexAuthBase = `${config.convexSiteUrl.replace(/\/$/, '')}/api/auth`;

  function getInternalAuthSecret(): string {
    const secret = process.env.INTERNAL_SERVICE_AUTH_SECRET;
    if (!secret) {
      throw new Error('INTERNAL_SERVICE_AUTH_SECRET is required');
    }
    return secret;
  }

  async function resolveViewer(authToken: string | null | undefined): Promise<ViewerData | null> {
    if (!authToken) {
      return null;
    }

    try {
      const convexClient = getConvexClient(config.convexUrl);
      convexClient.setAuth(authToken);
      return (await convexClient.query(api.authViewer.getViewer, {})) as ViewerData | null;
    } catch (error) {
      logger.warn('Failed to resolve viewer from Convex auth token', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  function getAuthToken(request: Request): string | null {
    const authToken = request.headers.get('x-auth-token')?.trim();
    return authToken || null;
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

  return {
    async getSession(request: Request): Promise<SessionData | null> {
      const viewer = await resolveViewer(getAuthToken(request));
      if (!viewer) {
        return null;
      }

      return {
        user: {
          id: viewer.authUserId,
          email: viewer.email ?? null,
          name: viewer.name ?? null,
          image: viewer.image ?? null,
        },
        discordUserId: viewer.discordUserId ?? null,
      };
    },

    async getDiscordUserId(request: Request): Promise<string | null> {
      const viewer = await resolveViewer(getAuthToken(request));
      return viewer?.discordUserId ?? null;
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

export { createDiscordProvider, validateDiscordConfig } from './discord';
export type Auth = ReturnType<typeof createAuth>;
