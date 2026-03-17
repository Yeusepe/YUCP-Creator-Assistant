/**
 * VRChat Connect Plugin unit tests — TDD
 *
 * Tests the connect plugin routes:
 * - GET /api/connect/vrchat/begin → creates state token, redirects to vrchat-verify?mode=connect
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

mock.module('../../lib/stateStore', () => ({
  getStateStore: () => activeStore,
  InMemoryStateStore,
}));

// Imported AFTER mock.module so the module sees the mock
const { vrchatConnect } = await import('./connect');

const originalFetch = globalThis.fetch;

beforeEach(() => {
  activeStore = new InMemoryStateStore();
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
  it('redirects to vrchat-verify.html with token and mode=connect when setup session is valid', async () => {
    const ctx = makeContext();
    const beginRoute = vrchatConnect.routes.find(
      (r) => r.method === 'GET' && r.path.endsWith('/begin')
    );
    expect(beginRoute).toBeDefined();

    const request = new Request('https://api.example.com/api/connect/vrchat/begin');
    const response = await beginRoute!.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toContain('/vrchat-verify');
    expect(location).toContain('mode=connect');
    expect(location).toContain('token=');
  });

  it('forwards guild_id and tenant_id to the verify page redirect URL', async () => {
    const ctx = makeContext();
    const beginRoute = vrchatConnect.routes.find(
      (r) => r.method === 'GET' && r.path.endsWith('/begin')
    );

    const request = new Request(
      'https://api.example.com/api/connect/vrchat/begin?guildId=guild_abc&tenantId=tenant_xyz'
    );
    const response = await beginRoute!.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(302);
    const location = response.headers.get('location')!;
    expect(location).toContain('guild_id=guild_abc');
    expect(location).toContain('tenant_id=tenant_xyz');
  });

  it('redirects to vrchat-verify when authenticated via dashboard session (no setup session)', async () => {
    // Dashboard flow: user has a Better Auth session but no bot-issued setup session cookie.
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
    const request = new Request('https://api.example.com/api/connect/vrchat/begin');
    const response = await beginRoute!.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toContain('/vrchat-verify');
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
    const request = new Request('https://api.example.com/api/connect/vrchat/begin');
    const response = await beginRoute!.handler(request, ctx as unknown as ConnectContext);

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
    const request = new Request('https://api.example.com/api/connect/vrchat/begin');
    const response = await beginRoute!.handler(request, ctx as unknown as ConnectContext);

    expect(response.status).toBe(401);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/connect/vrchat/session
// ──────────────────────────────────────────────────────────────────────────────

describe('VRChat connect — POST /session', () => {
  let sessionRoute: (typeof vrchatConnect.routes)[number] | undefined;

  beforeEach(() => {
    sessionRoute = vrchatConnect.routes.find(
      (r) => r.method === 'POST' && r.path.endsWith('/session')
    );
    expect(sessionRoute).toBeDefined();
  });

  it('returns 400 when token is missing from request body', async () => {
    const ctx = makeContext();
    const request = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'user', password: 'pass' }),
    });
    const response = await sessionRoute!.handler(request, ctx as unknown as ConnectContext);
    expect(response.status).toBe(400);
  });

  it('returns 400 when the connect token does not exist in the state store', async () => {
    const ctx = makeContext();
    const request = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nonexistent-token', username: 'user', password: 'pass' }),
    });
    const response = await sessionRoute!.handler(request, ctx as unknown as ConnectContext);
    expect(response.status).toBe(400);
  });

  it('returns 401 when VRChat login fails (bad credentials)', async () => {
    await activeStore.set(
      'vrchat_connect:valid-token',
      JSON.stringify({ authUserId: 'auth_user_123' }),
      10 * 60 * 1000
    );

    // Mock VRChat API: login attempt returns 401 — no auth cookie
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Invalid credentials' } }), { status: 401 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctx = makeContext();
    const request = new Request('https://api.example.com/api/connect/vrchat/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'valid-token', username: 'bad-user', password: 'bad-pass' }),
    });
    const response = await sessionRoute!.handler(request, ctx as unknown as ConnectContext);
    expect(response.status).toBe(401);
  });

  it('returns 200 with needsTwoFactor when VRChat requires 2FA', async () => {
    await activeStore.set(
      'vrchat_connect:valid-token',
      JSON.stringify({ authUserId: 'auth_user_123' }),
      10 * 60 * 1000
    );

    const fetchMock = mock(async (url: string) => {
      if (url.endsWith('/auth/user')) {
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
    const response = await sessionRoute!.handler(request, ctx as unknown as ConnectContext);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { twoFactorRequired?: boolean; types?: string[] };
    // Must match the canonical shape that vrchat-verify.html checks: twoFactorRequired + types
    expect(body.twoFactorRequired).toBe(true);
    expect(body.types).toEqual(['emailOtp']);
  });
});
