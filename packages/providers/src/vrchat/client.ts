/**
 * VRChat API Client
 *
 * Uses direct HTTP calls for login, 2FA, and ownership checks so the Bun
 * verification flow does not depend on SDK-local cookie jar state across
 * requests. This keeps the public interface stable while avoiding provider
 * session bugs in multi-step login.
 */

import type { StructuredLogger } from '@yucp/shared';
import { createLogger } from '@yucp/shared';
import { withProviderRequestSpan } from '../core/observability';
import type {
  RequiresTwoFactorAuth,
  TwoFactorAuthType,
  VrchatBeginLoginResult,
  VrchatCurrentUser,
  VrchatLicensedAvatar,
  VrchatPendingLoginState,
  VrchatProductListing,
  VrchatSessionTokens,
  VrchatVerifyOwnershipResult,
} from './types';
import { VrchatSessionExpiredError } from './types';

const VRCHAT_API_BASE = 'https://api.vrchat.cloud/api/1';
const VRCHAT_USER_AGENT = 'YUCP Creator Assistant/0.1.0 (https://yucp.app)';
const AUTH_COOKIE = 'auth';
const TWO_FACTOR_AUTH_COOKIE = 'twoFactorAuth';
interface VrchatApiConfig {
  clientApiKey?: string;
}

function buildBasicAuth(username: string, password: string): string {
  const encoded = Buffer.from(
    `${encodeURIComponent(username)}:${encodeURIComponent(password)}`,
    'utf-8'
  ).toString('base64');
  return `Basic ${encoded}`;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }

  const raw = headers.get('set-cookie');
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

function extractCookieValue(headers: Headers, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const setCookie of getSetCookieHeaders(headers)) {
    const firstSegment = setCookie.split(';', 1)[0]?.trim();
    if (!firstSegment?.startsWith(prefix)) continue;
    return firstSegment.slice(prefix.length);
  }
  return undefined;
}

function buildCookieHeader(tokens: VrchatSessionTokens): string {
  const pairs = [`${AUTH_COOKIE}=${tokens.authToken}`];
  if (tokens.twoFactorAuthToken) {
    pairs.push(`${TWO_FACTOR_AUTH_COOKIE}=${tokens.twoFactorAuthToken}`);
  }
  return pairs.join('; ');
}

function extractClientApiKey(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const clientApiKey = (data as { clientApiKey?: unknown }).clientApiKey;
  return typeof clientApiKey === 'string' && clientApiKey.length > 0 ? clientApiKey : undefined;
}

function isTwoFactorRequired(data: unknown): data is RequiresTwoFactorAuth {
  return (
    !!data &&
    typeof data === 'object' &&
    Array.isArray((data as RequiresTwoFactorAuth).requiresTwoFactorAuth)
  );
}

function isCurrentUser(data: unknown): data is VrchatCurrentUser {
  return !!data && typeof data === 'object' && typeof (data as VrchatCurrentUser).id === 'string';
}

function sanitizeTwoFactorMethods(methods: readonly string[]): TwoFactorAuthType[] {
  return methods.filter(
    (method): method is TwoFactorAuthType =>
      method === 'totp' || method === 'emailOtp' || method === 'otp'
  );
}

function serializePendingState(state: VrchatPendingLoginState): string {
  return JSON.stringify(state);
}

function parsePendingState(pendingState: string): VrchatPendingLoginState {
  const parsed = JSON.parse(pendingState) as Partial<VrchatPendingLoginState>;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.authToken !== 'string' ||
    !Array.isArray(parsed.requiresTwoFactorAuth)
  ) {
    throw new Error('Invalid pending VRChat login state');
  }

  const requiresTwoFactorAuth = sanitizeTwoFactorMethods(parsed.requiresTwoFactorAuth);
  if (requiresTwoFactorAuth.length === 0) {
    throw new Error('Invalid pending VRChat login state');
  }

  return {
    authToken: parsed.authToken,
    requiresTwoFactorAuth,
  };
}

async function parseResponseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function request(
  path: string,
  init: RequestInit = {}
): Promise<{ response: Response; data: unknown }> {
  return withProviderRequestSpan(
    'vrchat',
    init.method ?? 'GET',
    path,
    {
      'server.address': new URL(VRCHAT_API_BASE).host,
      hasBody: init.body !== undefined,
    },
    async () => {
      const headers = new Headers(init.headers);
      headers.set('user-agent', VRCHAT_USER_AGENT);
      const response = await fetch(`${VRCHAT_API_BASE}${path}`, {
        ...init,
        headers,
      });
      const data = await parseResponseJson(response);
      return { response, data };
    }
  );
}

function verificationPathForType(type: TwoFactorAuthType): string {
  switch (type) {
    case 'totp':
      return '/auth/twofactorauth/totp/verify';
    case 'emailOtp':
      return '/auth/twofactorauth/emailotp/verify';
    case 'otp':
      return '/auth/twofactorauth/otp/verify';
  }
}

function isVerifiedResponse(data: unknown): data is { verified?: boolean } {
  return !!data && typeof data === 'object' && 'verified' in data;
}

function getVerifiedFactorSession(headers: Headers, authToken: string): VrchatSessionTokens {
  return {
    authToken: extractCookieValue(headers, AUTH_COOKIE) ?? authToken,
    twoFactorAuthToken: extractCookieValue(headers, TWO_FACTOR_AUTH_COOKIE),
  };
}

/**
 * Extract VRChat avatar ID from URL or raw ID.
 * @see https://vrchat.com/home/avatar/avtr_xxx
 */
export function extractVrchatAvatarId(urlOrId: string): string | null {
  const trimmed = urlOrId?.trim() ?? '';
  const directMatch = trimmed.match(/avtr_[a-f0-9-]{36}/i);
  if (directMatch) return directMatch[0];
  const urlMatch = trimmed.match(/vrchat\.com\/home\/avatar\/(avtr_[a-f0-9-]{36})/i);
  return urlMatch ? urlMatch[1] : null;
}

/**
 * VRChat API Client - direct HTTP login, 2FA, and licensed avatar retrieval.
 */
export class VrchatApiClient {
  private apiConfigPromise?: Promise<VrchatApiConfig>;
  private readonly logger: StructuredLogger;

  constructor(options: { logger?: StructuredLogger } = {}) {
    this.logger = options.logger ?? createLogger();
  }

  private async getApiConfig(): Promise<VrchatApiConfig> {
    if (!this.apiConfigPromise) {
      this.apiConfigPromise = request('/config', { method: 'GET' }).then(({ data }) => ({
        clientApiKey: extractClientApiKey(data),
      }));
    }

    return this.apiConfigPromise;
  }

  /**
   * Makes an authenticated VRChat API request.
   * Automatically appends ?apiKey=<clientApiKey> as a URL query parameter on every call
   * except /config itself (which is how we get the key in the first place).
   *
   * Per VRChat spec (APIConfig.yaml): clientApiKey is "apiKey to be used for all other requests".
   * Community SDK implementations (vrchatapi-python, vrchatapi-js) all send it as ?apiKey=<value>.
   * Sending it as a header does not work, VRChat returns 401.
   *
   * Source: https://github.com/vrchatapi/specification/blob/main/openapi/components/schemas/APIConfig.yaml
   */
  private async apiRequest(
    path: string,
    init: RequestInit = {}
  ): Promise<{ response: Response; data: unknown }> {
    const { clientApiKey } = await this.getApiConfig();
    if (clientApiKey) {
      const separator = path.includes('?') ? '&' : '?';
      return request(`${path}${separator}apiKey=${encodeURIComponent(clientApiKey)}`, init);
    }
    return request(path, init);
  }

  private buildRequestHeaders(headersInit?: HeadersInit): Headers {
    return new Headers(headersInit);
  }

  async beginLogin(username: string, password: string): Promise<VrchatBeginLoginResult> {
    // Per VRChat OpenAPI spec, /auth/user has parameters: [] and security: [{authHeader: []}]
    // meaning it uses HTTP Basic auth only, no ?apiKey= query parameter.
    // Adding ?apiKey= to this endpoint causes VRChat to return 401 (Missing Credentials).
    // Use request() directly to match the same contract as the working VrchatWebClient.
    const { response, data } = await request('/auth/user', {
      method: 'GET',
      headers: {
        authorization: buildBasicAuth(username, password),
      },
    });

    this.logger.info('VRChat client beginLogin', {
      status: response.status,
      hasAuthCookie: Boolean(extractCookieValue(response.headers, AUTH_COOKIE)),
      hasTwoFactorAuthCookie: Boolean(extractCookieValue(response.headers, TWO_FACTOR_AUTH_COOKIE)),
      requiresTwoFactorAuth: isTwoFactorRequired(data)
        ? sanitizeTwoFactorMethods(data.requiresTwoFactorAuth)
        : [],
      isCurrentUser: isCurrentUser(data),
      redirected: response.redirected,
      // Log full body on non-200 to surface VRChat's exact error message for diagnosis.
      // Safe to log: 401 responses never contain credentials.
      errorBody: response.status !== 200 ? JSON.stringify(data) : undefined,
    });

    const authToken = extractCookieValue(response.headers, AUTH_COOKIE);
    if (!authToken) {
      throw new Error(`Verification failed: missing auth cookie (status ${response.status})`);
    }

    if (isTwoFactorRequired(data)) {
      const requiresTwoFactorAuth = sanitizeTwoFactorMethods(data.requiresTwoFactorAuth);
      if (requiresTwoFactorAuth.length === 0) {
        throw new Error('Verification failed');
      }

      return {
        success: false,
        requiresTwoFactorAuth,
        pendingState: serializePendingState({
          authToken,
          requiresTwoFactorAuth,
        }),
      };
    }

    if (!isCurrentUser(data)) {
      throw new Error('Verification failed');
    }

    return {
      success: true,
      user: data,
      session: {
        authToken,
        twoFactorAuthToken: extractCookieValue(response.headers, TWO_FACTOR_AUTH_COOKIE),
      },
    };
  }

  async completePendingLogin(
    pendingState: string,
    code: string,
    type?: TwoFactorAuthType
  ): Promise<{ user: VrchatCurrentUser; session: VrchatSessionTokens }> {
    const pending = parsePendingState(pendingState);
    const methods = type ? [type] : pending.requiresTwoFactorAuth;
    const allowedMethods = methods.filter((method) =>
      pending.requiresTwoFactorAuth.includes(method)
    );

    if (!allowedMethods.length) {
      throw new Error('Verification failed');
    }

    let session: VrchatSessionTokens | null = null;

    for (const method of allowedMethods) {
      const headers = this.buildRequestHeaders({
        'content-type': 'application/json',
        cookie: `${AUTH_COOKIE}=${pending.authToken}`,
      });
      const { response, data } = await this.apiRequest(verificationPathForType(method), {
        method: 'POST',
        headers,
        body: JSON.stringify({ code }),
      });

      this.logger.info('VRChat client completePendingLogin verify', {
        method,
        status: response.status,
        verified: isVerifiedResponse(data) ? Boolean(data.verified) : false,
        hasAuthCookie: Boolean(extractCookieValue(response.headers, AUTH_COOKIE)),
        hasTwoFactorAuthCookie: Boolean(
          extractCookieValue(response.headers, TWO_FACTOR_AUTH_COOKIE)
        ),
      });

      if (!isVerifiedResponse(data) || !data.verified) {
        continue;
      }

      session = getVerifiedFactorSession(response.headers, pending.authToken);
      break;
    }

    if (!session) {
      this.logger.warn('VRChat client completePendingLogin failed: no verified factor');
      throw new Error('Verification failed');
    }

    const user = await this.getCurrentUser(session.authToken, session.twoFactorAuthToken);
    this.logger.info('VRChat client completePendingLogin current user', {
      hasTwoFactorAuthToken: Boolean(session.twoFactorAuthToken),
      isCurrentUser: Boolean(user),
    });
    if (!user) {
      throw new Error('Verification failed');
    }

    return { user, session };
  }

  async login(
    username: string,
    password: string,
    twoFactorCode?: string
  ): Promise<{ user: VrchatCurrentUser; session: VrchatSessionTokens }> {
    const initial = await this.beginLogin(username, password);
    if (initial.success) {
      return initial;
    }

    if (!twoFactorCode) {
      throw new Error('Verification failed');
    }

    return this.completePendingLogin(initial.pendingState, twoFactorCode);
  }

  async getCurrentUser(
    authToken: string,
    twoFactorAuthToken?: string
  ): Promise<VrchatCurrentUser | null> {
    const headers = this.buildRequestHeaders({
      cookie: buildCookieHeader({ authToken, twoFactorAuthToken }),
    });
    const { response, data } = await this.apiRequest('/auth/user', {
      method: 'GET',
      headers,
    });

    if (!isCurrentUser(data)) {
      this.logger.info('VRChat client getCurrentUser non-user response', {
        status: response.status,
        requiresTwoFactorAuth: isTwoFactorRequired(data)
          ? sanitizeTwoFactorMethods(data.requiresTwoFactorAuth)
          : [],
      });
    }

    if (!data || isTwoFactorRequired(data) || !isCurrentUser(data)) {
      return null;
    }

    return data;
  }

  async getLicensedAvatars(
    session: VrchatSessionTokens,
    n = 60,
    offset = 0
  ): Promise<VrchatLicensedAvatar[]> {
    const query = new URLSearchParams({
      n: String(Math.min(100, Math.max(1, n))),
      offset: String(Math.max(0, offset)),
    });

    const headers = this.buildRequestHeaders({
      cookie: buildCookieHeader(session),
    });
    const { data } = await this.apiRequest(`/avatars/licensed?${query.toString()}`, {
      method: 'GET',
      headers,
    });

    if (!Array.isArray(data)) {
      throw new Error('Verification failed');
    }

    return data.filter(
      (entry): entry is VrchatLicensedAvatar =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as VrchatLicensedAvatar).id === 'string'
    );
  }

  async getOwnershipFromSession(
    session: VrchatSessionTokens
  ): Promise<VrchatVerifyOwnershipResult | null> {
    const user = await this.getCurrentUser(session.authToken, session.twoFactorAuthToken);
    if (!user) {
      return null;
    }

    const ownedAvatarIds: string[] = [];
    const licensedAvatars: VrchatLicensedAvatar[] = [];
    let offset = 0;
    const pageSize = 60;

    for (;;) {
      const page = await this.getLicensedAvatars(session, pageSize, offset);
      for (const avatar of page) {
        ownedAvatarIds.push(avatar.id);
        // Also track productId so that prod_xxx refs can be verified without
        // a separate lookup. The productId is already present in the type.
        if (avatar.productId) {
          ownedAvatarIds.push(avatar.productId);
        }
        licensedAvatars.push(avatar);
      }
      if (page.length < pageSize) break;
      offset += pageSize;
    }

    return {
      vrchatUserId: user.id,
      displayName: user.displayName ?? user.username ?? user.id,
      ownedAvatarIds,
      licensedAvatars,
    };
  }

  async verifyOwnership(
    username: string,
    password: string,
    twoFactorCode?: string
  ): Promise<VrchatVerifyOwnershipResult> {
    const { session } = await this.login(username, password, twoFactorCode);
    const ownership = await this.getOwnershipFromSession(session);
    if (!ownership) {
      throw new Error('Verification failed');
    }

    return ownership;
  }

  /**
   * Fetch all product listings from this creator's VRChat store.
   *
   * Calls GET /auth/user first to obtain the userId, then calls
   * GET /user/{userId}/listings to retrieve the creator's listings.
   * Throws VrchatSessionExpiredError when the session is invalid (HTTP 401).
   *
   * Source: https://vrchat.community/reference/get-product-listings
   * OpenAPI: https://github.com/vrchatapi/specification/blob/main/openapi/components/paths/economy.yaml
   */
  async getProductListings(session: VrchatSessionTokens): Promise<VrchatProductListing[]> {
    const user = await this.getCurrentUser(session.authToken, session.twoFactorAuthToken);
    if (!user) {
      throw new VrchatSessionExpiredError();
    }

    const headers = this.buildRequestHeaders({
      cookie: buildCookieHeader(session),
    });
    const { response, data } = await this.apiRequest(
      `/user/${encodeURIComponent(user.id)}/listings`,
      {
        method: 'GET',
        headers,
      }
    );

    if (response.status === 401) {
      throw new VrchatSessionExpiredError();
    }

    if (!Array.isArray(data)) return [];

    return data.filter(
      (entry): entry is VrchatProductListing =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as VrchatProductListing).id === 'string'
    );
  }

  /**
   * Look up a single avatar by ID. Returns `{ id, name }` or null if not found / inaccessible.
   * Requires an active session (any authenticated VRChat account).
   *
   * Source: https://vrchat.community/reference/get-avatar
   */
  async getAvatarById(
    session: VrchatSessionTokens,
    avatarId: string
  ): Promise<{ id: string; name: string } | null> {
    const headers = this.buildRequestHeaders({
      cookie: buildCookieHeader(session),
    });
    const { response, data } = await this.apiRequest(`/avatars/${encodeURIComponent(avatarId)}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok || !data || typeof data !== 'object') return null;
    const avatar = data as Record<string, unknown>;
    if (typeof avatar.id !== 'string' || typeof avatar.name !== 'string') return null;
    return { id: avatar.id, name: avatar.name };
  }
}
