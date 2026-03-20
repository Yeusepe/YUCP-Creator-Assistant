/**
 * VRChat Connect Plugin unit tests — TDD
 *
 * Tests the connect plugin routes:
 * - GET /api/connect/vrchat/begin → creates state token, redirects to /setup/vrchat?mode=connect
 * - POST /api/connect/vrchat/session → validates token, calls VrchatApiClient, stores session
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { InMemoryStateStore } from '../../lib/stateStore';
import type { ConnectContext } from '../types';

// Ensure pending state secret is available for tests (mirrors buyer pending.ts behaviour)
process.env.BETTER_AUTH_SECRET ??= 'test-better-auth-secret-for-pending!!';

// ── Module mock: replace getStateStore() with our test store ──────────────────
// Must be declared before the connect module is imported so the mock takes effect.
let activeStore = new InMemoryStateStore();
const mutationCalls: Array<[string, unknown]> = [];
const encryptedCalls: Array<{ value: string; purpose: string }> = [];

mock.module('../../lib/stateStore', () => ({
  getStateStore: () => activeStore,
  InMemoryStateStore,
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    mutation: mock(async (path: string, args: unknown) => {
      mutationCalls.push([path, args]);
      return null;
    }),
  }),
}));

mock.module('../../lib/encrypt', () => ({
  encrypt: mock(async (value: string, _secret: string, purpose: string) => {
    encryptedCalls.push({ value, purpose });
    return `enc:${purpose}:${Buffer.from(value).toString('base64url')}`;
  }),
  decrypt: mock(async (value: string, _secret: string, purpose: string) => {
    const prefix = `enc:${purpose}:`;
    if (!value.startsWith(prefix)) {
      throw new Error('Invalid ciphertext');
    }
    return Buffer.from(value.slice(prefix.length), 'base64url').toString();
  }),
}));

// Imported AFTER mock.module so the module sees the mock
const { vrchatConnect } = await import('./connect');

const originalFetch = globalThis.fetch;

beforeEach(() => {
  activeStore = new InMemoryStateStore();
  mutationCalls.length = 0;
  encryptedCalls.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const MOCK_CONFIG = {
  apiBaseUrl: 'https://api.example.com',
  frontendBaseUrl: 'https://app.example.com',
  convexSiteUrl: 'https://convex.example.com',
  convexUrl: 'https://convex.example.com',
  convexApiSecret: 'test-api-secret-min-32-characters!!',
  discordClientId: 'discord-client-id',
  discordClientSecret: 'discord-client-secret',
  encryptionSecret: 'test-encryption-secret-min-32-ch!',
};

function makeContext(
  boundResult:
    | {
        ok: true;
        setupSession: { authUserId: string; guildId: string; discordUserId: string };
        authSession: unknown;
        authDiscordUserId: string;
      }
    | { ok: false; response: Response } = {
    ok: true,
    setupSession: {
      authUserId: 'auth_user_123',
      guildId: 'guild_456',
      discordUserId: 'discord_789',
    },
    authSession: { user: { id: 'auth_user_123' } },
    authDiscordUserId: 'discord_789',
  }
) {
  return {
    config: MOCK_CONFIG,
    auth: { getSession: mock(async () => null) },
    requireBoundSetupSession: mock(async (_request: Request) => boundResult),
    getSetupSessionTokenFromRequest: mock((_request: Request) => null as string | null),
    isTenantOwnedBySessionUser: mock(async () => true),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/connect/vrchat/begin
// ──────────────────────────────────────────────────────────────────────────────

describe('VRChat connect — GET /begin', () => {
  it('redirects to /setup/vrchat with token and mode=connect when setup session is valid', async () => {
    const ctx = makeContext();
    const beginRoute = vrchatConnect.routes.find(
      (r) => r.method === 'GET' && r.path.endsWith('/begin')
    );
    expect(beginRoute).toBeDefined();
    if (!beginRoute) throw new Error('GET /begin route not registered in vrchatConnect');

    const request = new Request('https://api.example.com/api/connect/vrchat/begin');
    const response = await beginRoute.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toContain('/setup/vrchat');
    expect(location).toContain('mode=connect');
    expect(location).toContain('token=');
  });

  it('forwards guild_id and tenant_id to the verify page redirect URL', async () => {
    const ctx = makeContext();
    const beginRoute = vrchatConnect.routes.find(
      (r) => r.method === 'GET' && r.path.endsWith('/begin')
    );
    if (!beginRoute) throw new Error('GET /begin route not registered in vrchatConnect');

    const request = new Request(
      'https://api.example.com/api/connect/vrchat/begin?guildId=guild_abc&tenantId=tenant_xyz'
    );
    const response = await beginRoute.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).not.toBeNull();
    if (!location) throw new Error('location header missing');
    expect(location).toContain('guild_id=guild_abc');
    expect(location).toContain('tenant_id=tenant_xyz');
  });

  it('redirects to /setup/vrchat when authenticated via dashboard session (no setup session)', async () => {
    // Dashboard flow: user has a viewer token but no bot-issued setup session cookie.
    const ctx = makeContext({
      ok: false,
      response: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    // No setup session token in request
    ctx.getSetupSessionTokenFromRequest.mockImplementation(() => null);
    // But a valid auth session exists
    ctx.auth.getSession.mockImplementation(
      async () => ({ user: { id: 'dashboard_user_456' } }) as never
    );

    const beginRoute = vrchatConnect.routes.find(
      (r) => r.method === 'GET' && r.path.endsWith('/begin')
    );
    if (!beginRoute) throw new Error('GET /begin route not registered in vrchatConnect');
    const request = new Request('https://api.example.com/api/connect/vrchat/begin');
    const response = await beginRoute.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toContain('/setup/vrchat');
    expect(location).toContain('mode=connect');
    expect(location).toContain('token=');
  });

  it('returns 401 when no setup session and no auth session (unauthenticated)', async () => {
    const ctx = makeContext({
      ok: false,
      response: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    ctx.getSetupSessionTokenFromRequest.mockImplementation(() => null);
    // auth.getSession returns null (default in makeContext)

    const beginRoute = vrchatConnect.routes.find(
      (r) => r.method === 'GET' && r.path.endsWith('/begin')
    );
    if (!beginRoute) throw new Error('GET /begin route not registered in vrchatConnect');
    const request = new Request('https://api.example.com/api/connect/vrchat/begin');
    const response = await beginRoute.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(401);
  });

  it('returns 401 when a setup session token was present but failed validation', async () => {
    const ctx = makeContext({
      ok: false,
      response: Response.json({ error: 'Invalid token' }, { status: 401 }),
    });
    // Token IS present in request (invalid/expired)
    ctx.getSetupSessionTokenFromRequest.mockImplementation(() => 'some-bad-token');

    const beginRoute = vrchatConnect.routes.find(
      (r) => r.method === 'GET' && r.path.endsWith('/begin')
    );
    if (!beginRoute) throw new Error('GET /begin route not registered in vrchatConnect');
    const request = new Request('https://api.example.com/api/connect/vrchat/begin');
    const response = await beginRoute.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(401);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/connect/vrchat/session
// ──────────────────────────────────────────────────────────────────────────────

describe('VRChat connect — POST /session', () => {
  let sessionRoute: (typeof vrchatConnect.routes)[number];

  beforeEach(() => {
    const found = vrchatConnect.routes.find(
      (r) => r.method === 'POST' && r.path.endsWith('/session')
    );
    expect(found).toBeDefined();
    if (!found) throw new Error('POST /session route not registered in vrchatConnect');
    sessionRoute = found;
  });

  it('returns 401 when token is missing and no authenticated dashboard session exists', async () => {
    const ctx = makeContext();
    const request = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'user', password: 'pass' }),
    });
    const response = await sessionRoute.handler(request, ctx as unknown as ConnectContext);
    expect(response.status).toBe(401);
  });

  it('returns 401 when the connect token does not exist and no authenticated dashboard session exists', async () => {
    const ctx = makeContext();
    const request = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nonexistent-token', username: 'user', password: 'pass' }),
    });
    const response = await sessionRoute.handler(request, ctx as unknown as ConnectContext);
    expect(response.status).toBe(401);
  });

  it('allows authenticated dashboard connects without a begin token', async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith('/config')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'cf_clearance=config-cookie; Path=/; HttpOnly');
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
          headers: responseHeaders,
        });
      }

      if (url.includes('/auth/user')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'auth=auth-tok; Path=/; HttpOnly');
        responseHeaders.append('set-cookie', 'twoFactorAuth=2fa-tok; Path=/; HttpOnly');
        return new Response(
          JSON.stringify({ id: 'usr_123', username: 'user', displayName: 'User Display' }),
          {
            status: 200,
            headers: responseHeaders,
          }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeContext();
    ctx.auth.getSession.mockImplementation(
      async () => ({ user: { id: 'dashboard_user_456' } }) as never
    );

    const request = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'user', password: 'pass' }),
    });
    const response = await sessionRoute.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mutationCalls[0]?.[1]).toMatchObject({
      authUserId: 'dashboard_user_456',
      providerKey: 'vrchat',
    });
  });

  it('returns a handled form error when VRChat login fails (bad credentials)', async () => {
    await activeStore.set(
      'vrchat_connect:valid-token',
      JSON.stringify({ authUserId: 'auth_user_123' }),
      10 * 60 * 1000
    );

    // Mock VRChat API: login attempt returns 401 — no auth cookie
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith('/config')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'cf_clearance=config-cookie; Path=/; HttpOnly');
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
          headers: responseHeaders,
        });
      }

      if (url.includes('/auth/user')) {
        return new Response(JSON.stringify({ error: { message: 'Invalid credentials' } }), {
          status: 401,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeContext();
    const request = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'valid-token', username: 'bad-user', password: 'bad-pass' }),
    });
    const response = await sessionRoute.handler(request, ctx as unknown as ConnectContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Invalid VRChat credentials',
      needsCredentials: true,
    });
  });

  it('returns 200 with needsTwoFactor when VRChat requires 2FA', async () => {
    await activeStore.set(
      'vrchat_connect:valid-token',
      JSON.stringify({ authUserId: 'auth_user_123' }),
      10 * 60 * 1000
    );

    const fetchMock = mock(async (url: string) => {
      if (url.endsWith('/config')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'cf_clearance=config-cookie; Path=/; HttpOnly');
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
          headers: responseHeaders,
        });
      }

      if (url.includes('/auth/user')) {
        const responseHeaders = new Headers();
        responseHeaders.set('set-cookie', 'auth=auth-tok; Path=/; HttpOnly');
        return new Response(JSON.stringify({ requiresTwoFactorAuth: ['emailOtp'] }), {
          status: 200,
          headers: responseHeaders,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeContext();
    const request = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'valid-token', username: 'user', password: 'pass' }),
    });
    const response = await sessionRoute.handler(request, ctx as unknown as ConnectContext);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { twoFactorRequired?: boolean; types?: string[] };
    // Must match the canonical shape that vrchat-verify.html checks: twoFactorRequired + types
    expect(body.twoFactorRequired).toBe(true);
    expect(body.types).toEqual(['emailOtp']);
  });

  it('stores the encrypted creator session when VRChat login succeeds without 2FA', async () => {
    await activeStore.set(
      'vrchat_connect:valid-token',
      JSON.stringify({ authUserId: 'auth_user_123' }),
      10 * 60 * 1000
    );

    const fetchMock = mock(async (url: string) => {
      if (url.endsWith('/config')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'cf_clearance=config-cookie; Path=/; HttpOnly');
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
          headers: responseHeaders,
        });
      }

      if (url.includes('/auth/user')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'auth=auth-tok; Path=/; HttpOnly');
        responseHeaders.append('set-cookie', 'twoFactorAuth=2fa-tok; Path=/; HttpOnly');
        return new Response(
          JSON.stringify({ id: 'usr_123', username: 'user', displayName: 'User Display' }),
          {
            status: 200,
            headers: responseHeaders,
          }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeContext();
    const request = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'valid-token', username: 'user', password: 'pass' }),
    });
    const response = await sessionRoute.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(encryptedCalls).toEqual([
      {
        value: JSON.stringify({ authToken: 'auth-tok', twoFactorAuthToken: '2fa-tok' }),
        purpose: 'vrchat-creator-session',
      },
    ]);
    expect(mutationCalls).toHaveLength(1);
    expect(mutationCalls[0]?.[1]).toMatchObject({
      authUserId: 'auth_user_123',
      providerKey: 'vrchat',
      authMode: 'session',
      credentials: [
        {
          credentialKey: 'vrchat_session',
          kind: 'api_token',
          encryptedValue:
            'enc:vrchat-creator-session:eyJhdXRoVG9rZW4iOiJhdXRoLXRvayIsInR3b0ZhY3RvckF1dGhUb2tlbiI6IjJmYS10b2sifQ',
        },
      ],
    });
    expect(await activeStore.get('vrchat_connect:valid-token')).toBeNull();
  });

  it('completes 2FA and stores the creator session', async () => {
    await activeStore.set(
      'vrchat_connect:valid-token',
      JSON.stringify({ authUserId: 'auth_user_123' }),
      10 * 60 * 1000
    );

    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/config')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'cf_clearance=config-cookie; Path=/; HttpOnly');
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), {
          status: 200,
          headers: responseHeaders,
        });
      }

      if (url.includes('/auth/user')) {
        const responseHeaders = new Headers();
        const requestHeaders = new Headers(init?.headers);
        const cookie = requestHeaders.get('cookie');
        if (cookie?.includes('twoFactorAuth=2fa-tok')) {
          return new Response(
            JSON.stringify({ id: 'usr_123', username: 'user', displayName: 'User Display' }),
            { status: 200 }
          );
        }

        responseHeaders.append('set-cookie', 'auth=auth-tok; Path=/; HttpOnly');
        return new Response(JSON.stringify({ requiresTwoFactorAuth: ['emailOtp'] }), {
          status: 200,
          headers: responseHeaders,
        });
      }

      if (url.includes('/auth/twofactorauth/emailotp/verify')) {
        const responseHeaders = new Headers();
        responseHeaders.append('set-cookie', 'twoFactorAuth=2fa-tok; Path=/; HttpOnly');
        return new Response(JSON.stringify({ verified: true }), {
          status: 200,
          headers: responseHeaders,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeContext();
    const firstRequest = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'valid-token', username: 'user', password: 'pass' }),
    });
    const firstResponse = await sessionRoute.handler(
      firstRequest,
      ctx as unknown as ConnectContext
    );
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as {
      twoFactorRequired?: boolean;
      types?: string[];
    };
    expect(firstBody).toEqual({ twoFactorRequired: true, types: ['emailOtp'] });

    const pendingCookie = firstResponse.headers.get('set-cookie');
    expect(pendingCookie).toContain('yucp_vrchat_connect_pending=');

    const secondRequest = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: pendingCookie ?? '',
      },
      body: JSON.stringify({ token: 'valid-token', twoFactorCode: '123456' }),
    });
    const secondResponse = await sessionRoute.handler(
      secondRequest,
      ctx as unknown as ConnectContext
    );

    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({ success: true });
    expect(encryptedCalls.at(-1)).toEqual({
      value: JSON.stringify({ authToken: 'auth-tok', twoFactorAuthToken: '2fa-tok' }),
      purpose: 'vrchat-creator-session',
    });
    expect(mutationCalls).toHaveLength(1);
    expect(secondResponse.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await activeStore.get('vrchat_connect:valid-token')).toBeNull();
  });
});
