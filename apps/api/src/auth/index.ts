import { createHash, createHmac } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { logger } from '../lib/logger';
import { createCertificateBillingPortalSession } from '../lib/polar';
import { loadRequestScoped, requestScopeKey } from '../lib/requestScope';

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
  trustedOrigin?: string;
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

export type BetterAuthEmailOtpType = 'email-verification' | 'sign-in' | 'forget-password';

interface BetterAuthSessionResponse {
  session?: unknown;
  user?: {
    id?: unknown;
    email?: unknown;
    name?: unknown;
    image?: unknown;
  } | null;
}

interface BetterAuthOAuthClientResponse {
  client_id?: string;
  client_name?: string | null;
  redirect_uris?: string[] | null;
  scope?: string;
  client_id_issued_at?: number | null;
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none' | null;
  grant_types?: string[] | null;
  response_types?: string[] | null;
  disabled?: boolean | null;
}

interface BetterAuthApiKeyResponse {
  id: string;
  userId: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  permissions?: Record<string, string[]> | null;
  metadata?: unknown;
  lastRequest?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface PolarCheckoutRequest {
  products?: string | string[];
  slug?: string;
  referenceId?: string;
  metadata?: Record<string, string | number | boolean>;
  externalCustomerId?: string;
  embedOrigin?: string;
  redirect?: boolean;
  successUrl?: string;
  returnUrl?: string;
}

interface PolarCheckoutResponse {
  url: string;
  redirect: boolean;
}

interface PolarPortalRequest {
  redirect?: boolean;
}

interface BetterAuthEmailOtpResponse {
  success?: boolean;
  message?: string;
}

function extractBetterAuthErrorDetail(body: unknown, bodyText: string): string | null {
  if (body && typeof body === 'object') {
    const value = body as Record<string, unknown>;
    if (typeof value.error === 'string' && value.error.trim()) {
      return value.error.trim();
    }
    if (typeof value.message === 'string' && value.message.trim()) {
      return value.message.trim();
    }
  }

  return bodyText.trim() ? bodyText.trim() : null;
}

export class BetterAuthEndpointError extends Error {
  override readonly name = 'BetterAuthEndpointError';

  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly bodyText: string
  ) {
    const detail = extractBetterAuthErrorDetail(body, bodyText);
    super(
      detail
        ? `Better Auth request to ${path} failed with status ${status}: ${detail}`
        : `Better Auth request to ${path} failed with status ${status}`
    );
  }
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

  async function resolveViewer(request: Request): Promise<ViewerData | null> {
    return loadRequestScoped(request, 'auth:viewer', async () => {
      const authToken = getAuthToken(request);
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
    });
  }

  function getAuthToken(request: Request): string | null {
    const authToken = request.headers.get('x-auth-token')?.trim();
    return authToken || null;
  }

  function getBetterAuthCookieHeader(request: Request): string | null {
    const explicitCookieHeader = request.headers.get('better-auth-cookie')?.trim();
    if (explicitCookieHeader) {
      return explicitCookieHeader;
    }

    const cookieHeader = request.headers.get('cookie')?.trim();
    return cookieHeader || null;
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
      origin: config.trustedOrigin ?? config.baseUrl,
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

  async function resolveSessionFromBetterAuthCookie(request: Request): Promise<SessionData | null> {
    return loadRequestScoped(request, 'auth:cookie-session', async () => {
      const cookieHeader = getBetterAuthCookieHeader(request);
      if (!cookieHeader) {
        return null;
      }

      try {
        const { response } = await callInternalAuth('/get-session', {
          method: 'GET',
          cookieHeader,
        });

        if (!response.ok) {
          logger.warn('Better Auth cookie session lookup failed', {
            status: response.status,
          });
          return null;
        }

        const payload = (await response.json()) as BetterAuthSessionResponse | null;
        const user = payload?.user;
        if (!user || typeof user.id !== 'string' || !user.id.trim()) {
          return null;
        }

        return {
          user: {
            id: user.id,
            email: typeof user.email === 'string' ? user.email : null,
            name: typeof user.name === 'string' ? user.name : null,
            image: typeof user.image === 'string' ? user.image : null,
          },
          discordUserId: null,
        };
      } catch (error) {
        logger.warn('Failed to resolve Better Auth session from cookies', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    });
  }

  async function getBetterAuthJson<T>(request: Request, path: string): Promise<T | null> {
    return loadRequestScoped(request, requestScopeKey('auth:get', { path }), async () => {
      const cookieHeader = getBetterAuthCookieHeader(request);
      if (!cookieHeader) {
        return null;
      }

      try {
        const { response } = await callInternalAuth(path, {
          method: 'GET',
          cookieHeader,
        });

        if (!response.ok) {
          logger.warn('Better Auth endpoint lookup failed', {
            path,
            status: response.status,
          });
          return null;
        }

        return (await response.json()) as T;
      } catch (error) {
        logger.warn('Failed to read Better Auth endpoint', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    });
  }

  async function postBetterAuthJson<T>(
    request: Request,
    path: string,
    body: unknown
  ): Promise<T | null> {
    const cookieHeader = getBetterAuthCookieHeader(request);
    if (!cookieHeader) {
      return null;
    }

    const { response } = await callInternalAuth(path, {
      method: 'POST',
      cookieHeader,
      body,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      let parsedBody: unknown = null;
      if (bodyText.trim()) {
        try {
          parsedBody = JSON.parse(bodyText) as unknown;
        } catch {
          parsedBody = null;
        }
      }

      logger.warn('Better Auth endpoint mutation failed', {
        path,
        status: response.status,
      });
      throw new BetterAuthEndpointError(path, response.status, parsedBody, bodyText);
    }

    return (await response.json()) as T;
  }

  return {
    async getSession(request: Request): Promise<SessionData | null> {
      const viewer = await resolveViewer(request);
      if (viewer) {
        return {
          user: {
            id: viewer.authUserId,
            email: viewer.email ?? null,
            name: viewer.name ?? null,
            image: viewer.image ?? null,
          },
          discordUserId: viewer.discordUserId ?? null,
        };
      }

      return resolveSessionFromBetterAuthCookie(request);
    },

    async getDiscordUserId(request: Request): Promise<string | null> {
      const viewer = await resolveViewer(request);
      return viewer?.discordUserId ?? null;
    },

    async listOAuthClients(request: Request): Promise<BetterAuthOAuthClientResponse[]> {
      const data = await getBetterAuthJson<BetterAuthOAuthClientResponse[] | null>(
        request,
        '/oauth2/get-clients'
      );
      return Array.isArray(data) ? data : [];
    },

    async listApiKeys(request: Request): Promise<{
      apiKeys: BetterAuthApiKeyResponse[];
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      const data = await getBetterAuthJson<{
        apiKeys?: BetterAuthApiKeyResponse[];
        total?: number;
        limit?: number;
        offset?: number;
      } | null>(request, '/api-key/list');
      return {
        apiKeys: Array.isArray(data?.apiKeys) ? data.apiKeys : [],
        total: data?.total,
        limit: data?.limit,
        offset: data?.offset,
      };
    },

    async createPolarCheckout(
      request: Request,
      payload: PolarCheckoutRequest
    ): Promise<PolarCheckoutResponse | null> {
      return postBetterAuthJson<PolarCheckoutResponse>(request, '/checkout', payload);
    },

    async createPolarPortal(
      request: Request,
      payload?: PolarPortalRequest
    ): Promise<PolarCheckoutResponse | null> {
      const session = await resolveViewer(request);
      const authSession =
        session !== null
          ? {
              user: {
                id: session.authUserId,
                email: session.email ?? null,
                name: session.name ?? null,
                image: session.image ?? null,
              },
            }
          : await resolveSessionFromBetterAuthCookie(request);

      if (!authSession) {
        return null;
      }

      try {
        const portalSession = await createCertificateBillingPortalSession({
          externalCustomerId: authSession.user.id,
          customerEmail: authSession.user.email ?? null,
          customerName: authSession.user.name ?? null,
        });
        if (!portalSession) {
          return null;
        }

        return {
          url: portalSession.customerPortalUrl,
          redirect: payload?.redirect ?? true,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new BetterAuthEndpointError('/customer/portal', 500, { error: detail }, detail);
      }
    },

    async sendEmailOtp(input: {
      email: string;
      type: BetterAuthEmailOtpType;
    }): Promise<BetterAuthEmailOtpResponse | null> {
      const { response } = await callInternalAuth('/email-otp/send-verification-otp', {
        method: 'POST',
        body: input,
      });

      if (!response.ok) {
        const bodyText = await response.text();
        let parsedBody: unknown = null;
        if (bodyText.trim()) {
          try {
            parsedBody = JSON.parse(bodyText) as unknown;
          } catch {
            parsedBody = null;
          }
        }
        throw new BetterAuthEndpointError(
          '/email-otp/send-verification-otp',
          response.status,
          parsedBody,
          bodyText
        );
      }

      return (await response.json()) as BetterAuthEmailOtpResponse;
    },

    async checkEmailOtp(input: {
      email: string;
      type: BetterAuthEmailOtpType;
      otp: string;
    }): Promise<BetterAuthEmailOtpResponse | null> {
      const { response } = await callInternalAuth('/email-otp/check-verification-otp', {
        method: 'POST',
        body: input,
      });

      if (!response.ok) {
        const bodyText = await response.text();
        let parsedBody: unknown = null;
        if (bodyText.trim()) {
          try {
            parsedBody = JSON.parse(bodyText) as unknown;
          } catch {
            parsedBody = null;
          }
        }
        throw new BetterAuthEndpointError(
          '/email-otp/check-verification-otp',
          response.status,
          parsedBody,
          bodyText
        );
      }

      return (await response.json()) as BetterAuthEmailOtpResponse;
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
