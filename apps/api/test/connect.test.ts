/**
 * Connect routes integration tests — Phase 6.2
 *
 * Tests HTTP-level auth guards and input validation for all /api/connect/*
 * and related routes. The test server uses stub auth that always returns null,
 * so every route guarded by auth.getSession() or resolveSetupToken() will
 * return 401 without needing real credentials.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createAuth } from '../src/auth';
import { DISCORD_ROLE_SETUP_COOKIE } from '../src/lib/browserSessions';
import { createSetupSession, resolveSetupSession } from '../src/lib/setupSession';
import { getStateStore } from '../src/lib/stateStore';
import type { ConnectConfig } from '../src/providers/types';
import { createConnectRoutes } from '../src/routes/connect';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

const TEST_CONNECT_CONFIG: ConnectConfig = {
  apiBaseUrl: 'https://api.example.com',
  frontendBaseUrl: 'https://app.example.com',
  convexSiteUrl: 'https://convex.example.com',
  convexUrl: 'https://convex.example.com',
  convexApiSecret: 'test-api-secret-min-32-characters!!',
  discordClientId: 'discord-client-id',
  discordClientSecret: 'discord-client-secret',
  encryptionSecret: 'test-encryption-secret-32-chars!!',
};

function createConnectSecurityRoutes() {
  return createConnectRoutes(
    createAuth({
      baseUrl: TEST_CONNECT_CONFIG.apiBaseUrl,
      convexSiteUrl: TEST_CONNECT_CONFIG.convexSiteUrl,
      convexUrl: TEST_CONNECT_CONFIG.convexUrl,
    }),
    TEST_CONNECT_CONFIG
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard tests — stub auth always returns null → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('Connect routes — auth guards', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('GET /connect?guild_id=test redirects browser traffic to the frontend route', async () => {
    const frontendServer = await startTestServer({
      baseUrl: 'http://localhost:3101',
      frontendUrl: 'http://localhost:3000',
    });

    try {
      const res = await frontendServer.fetch('/connect?guild_id=test', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('http://localhost:3000/connect?guild_id=test');
    } finally {
      frontendServer.stop();
    }
  });

  it('GET /api/connect/status without auth returns 401', async () => {
    const res = await server.fetch('/api/connect/status');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('POST /api/connect/complete without auth returns 401', async () => {
    // Auth check happens before body parsing, so no body is required.
    const res = await server.fetch('/api/connect/complete', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('POST /api/connect/public-api/keys without auth returns 401', async () => {
    // requireOwnerSessionForTenant checks authUserId first (400 if absent),
    // then auth session. Supplying authUserId ensures we reach the auth check.
    const res = await server.fetch('/api/connect/public-api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authUserId: 'test-user-id' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('DELETE /api/connect/oauth-apps/test-app-id without auth returns 401', async () => {
    // deleteOAuthApp reads authUserId from the JSON body before the auth check.
    const res = await server.fetch('/api/connect/oauth-apps/test-app-id', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authUserId: 'test-user-id' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Token / input validation tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Connect routes — token validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('GET /api/connections without setup session returns 401', async () => {
    // requireBoundSetupSession checks the setup session cookie first.
    // With no cookie and no auth header the response is 401.
    const res = await server.fetch('/api/connections');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('POST /api/connect/bootstrap with empty body returns 400', async () => {
    // bootstrap requires exactly one of setupToken or connectToken.
    // An empty body supplies neither → "Provide exactly one token".
    const res = await server.fetch('/api/connect/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('GET /api/connect/complete (wrong method on POST-only endpoint) returns 405', async () => {
    // completeSetup rejects non-POST requests before any auth or body checks.
    const res = await server.fetch('/api/connect/complete');
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});

describe('Connect routes — setup session security', () => {
  it('rejects tampered setup-session tokens without mutating the original session', async () => {
    const routes = createConnectSecurityRoutes();
    const setupToken = await createSetupSession(
      'user_tamper',
      'guild_tamper',
      'discord_tamper',
      TEST_CONNECT_CONFIG.encryptionSecret
    );
    const tamperedToken = `${setupToken}x`;

    const res = await routes.exchangeConnectBootstrap(
      new Request(`${TEST_CONNECT_CONFIG.apiBaseUrl}/api/connect/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupToken: tamperedToken }),
      })
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();

    const originalSession = await resolveSetupSession(
      setupToken,
      TEST_CONNECT_CONFIG.encryptionSecret
    );
    expect(originalSession).toMatchObject({
      authUserId: 'user_tamper',
      guildId: 'guild_tamper',
      discordUserId: 'discord_tamper',
    });
  });

  it('rejects setup sessions that exceed the absolute lifetime and deletes them', async () => {
    const routes = createConnectSecurityRoutes();
    const setupToken = await createSetupSession(
      'user_expired',
      'guild_expired',
      'discord_expired',
      TEST_CONNECT_CONFIG.encryptionSecret
    );
    const store = getStateStore();
    const key = `setup_session:${setupToken}`;
    const now = Date.now();
    await store.set(
      key,
      JSON.stringify({
        authUserId: 'user_expired',
        guildId: 'guild_expired',
        discordUserId: 'discord_expired',
        createdAt: now - 2 * 60 * 60 * 1000,
        expiresAt: now + 5 * 60 * 1000,
      }),
      5 * 60 * 1000
    );

    const res = await routes.exchangeConnectBootstrap(
      new Request(`${TEST_CONNECT_CONFIG.apiBaseUrl}/api/connect/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupToken }),
      })
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await store.get(key)).toBeNull();
  });
});

describe('Connect routes — OAuth state boundaries', () => {
  it('replays discord-role OAuth state only once and keeps redirects pinned to the configured frontend', async () => {
    const routes = createConnectSecurityRoutes();
    const store = getStateStore();
    const roleToken = `role_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const roleSessionKey = `discord_role_setup:${roleToken}`;
    await store.set(
      roleSessionKey,
      JSON.stringify({
        authUserId: 'user_oauth',
        guildId: 'guild_oauth',
        adminDiscordUserId: 'discord-admin',
        completed: false,
      }),
      30 * 60 * 1000
    );

    const beginRes = await routes.discordRoleOAuthBegin(
      new Request(`${TEST_CONNECT_CONFIG.apiBaseUrl}/api/setup/discord-role-oauth/begin`, {
        headers: { cookie: `${DISCORD_ROLE_SETUP_COOKIE}=${roleToken}` },
      })
    );
    expect(beginRes.status).toBe(302);

    const authLocation = beginRes.headers.get('location');
    expect(authLocation).toBeTruthy();
    const state = new URL(authLocation as string).searchParams.get('state');
    expect(state).toBeTruthy();
    expect(state).not.toContain(roleToken);
    expect(await store.get(`discord_role_oauth:${state as string}`)).toBe(roleToken);

    const originalFetch = globalThis.fetch;
    let oauthFetchCalls = 0;
    let tokenExchangeBody = '';
    const fetchSignals: Array<AbortSignal | null | undefined> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      oauthFetchCalls += 1;
      fetchSignals.push(init?.signal);
      const url = String(input);
      if (url.endsWith('/oauth2/token')) {
        tokenExchangeBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ access_token: 'oauth-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/users/@me')) {
        return new Response(JSON.stringify({ id: 'discord-admin' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/users/@me/guilds')) {
        return new Response(
          JSON.stringify([{ id: '2', name: 'Guild Z', icon: null, owner: true, permissions: '8' }]),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    try {
      const callbackUrl = `https://evil.example/api/setup/discord-role-oauth/callback?code=oauth-code&state=${encodeURIComponent(state as string)}`;
      const firstRes = await routes.discordRoleOAuthCallback(new Request(callbackUrl));
      expect(firstRes.status).toBe(302);
      expect(firstRes.headers.get('location')).toBe(
        `${TEST_CONNECT_CONFIG.frontendBaseUrl}/setup/discord-role`
      );

      const redirectUri = new URLSearchParams(tokenExchangeBody).get('redirect_uri');
      expect(redirectUri).toBe(
        `${TEST_CONNECT_CONFIG.apiBaseUrl}/api/setup/discord-role-oauth/callback`
      );

      const storedSession = JSON.parse((await store.get(roleSessionKey)) as string) as {
        guilds?: Array<{ name: string }>;
      };
      expect(storedSession.guilds?.map((guild) => guild.name)).toEqual(['Guild Z']);

      const replayRes = await routes.discordRoleOAuthCallback(new Request(callbackUrl));
      expect(replayRes.status).toBe(302);
      expect(replayRes.headers.get('location')).toBe(
        `${TEST_CONNECT_CONFIG.frontendBaseUrl}/setup/discord-role?error=invalid_state`
      );
      expect(oauthFetchCalls).toBe(3);
      expect(fetchSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('encodes OAuth errors without allowing open redirects', async () => {
    const routes = createConnectSecurityRoutes();

    const res = await routes.discordRoleOAuthCallback(
      new Request(
        `${TEST_CONNECT_CONFIG.apiBaseUrl}/api/setup/discord-role-oauth/callback?error=${encodeURIComponent('https://evil.example/phish')}`
      )
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBe(
      `${TEST_CONNECT_CONFIG.frontendBaseUrl}/setup/discord-role?error=${encodeURIComponent('https://evil.example/phish')}`
    );
    expect(new URL(location as string).origin).toBe(
      new URL(TEST_CONNECT_CONFIG.frontendBaseUrl).origin
    );
  });

  it('rejects non-object JSON bodies for Discord role setup endpoints', async () => {
    const routes = createConnectSecurityRoutes();
    const store = getStateStore();
    const roleToken = `role_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await store.set(
      `discord_role_setup:${roleToken}`,
      JSON.stringify({
        authUserId: 'user_json',
        guildId: 'guild_json',
        adminDiscordUserId: 'discord_json',
        completed: false,
      }),
      30 * 60 * 1000
    );

    const createResponse = await routes.createDiscordRoleSession(
      new Request(`${TEST_CONNECT_CONFIG.apiBaseUrl}/api/connect/discord-role/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      })
    );
    expect(createResponse.status).toBe(400);

    const saveResponse = await routes.saveDiscordRoleSelection(
      new Request(`${TEST_CONNECT_CONFIG.apiBaseUrl}/api/setup/discord-role/save`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${DISCORD_ROLE_SETUP_COOKIE}=${roleToken}`,
        },
        body: 'null',
      })
    );
    expect(saveResponse.status).toBe(400);

    const exchangeResponse = await routes.exchangeDiscordRoleSetupSession(
      new Request(`${TEST_CONNECT_CONFIG.apiBaseUrl}/api/setup/discord-role/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      })
    );
    expect(exchangeResponse.status).toBe(400);
  });

  it('requires a verified guild and valid match mode before completing Discord role setup', async () => {
    const routes = createConnectSecurityRoutes();
    const store = getStateStore();
    const roleToken = `role_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const roleSessionKey = `discord_role_setup:${roleToken}`;

    await store.set(
      roleSessionKey,
      JSON.stringify({
        authUserId: 'user_roles',
        guildId: 'guild_roles',
        adminDiscordUserId: 'discord_roles',
        guilds: [
          {
            id: 'verified_guild',
            name: 'Verified Guild',
            icon: null,
            owner: true,
            permissions: '8',
          },
        ],
        completed: false,
      }),
      30 * 60 * 1000
    );

    const invalidModeResponse = await routes.saveDiscordRoleSelection(
      new Request(`${TEST_CONNECT_CONFIG.apiBaseUrl}/api/setup/discord-role/save`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${DISCORD_ROLE_SETUP_COOKIE}=${roleToken}`,
        },
        body: JSON.stringify({
          sourceGuildId: 'verified_guild',
          sourceRoleIds: ['12345678901234567', '22345678901234567'],
          requiredRoleMatchMode: 'bogus',
        }),
      })
    );
    expect(invalidModeResponse.status).toBe(400);

    const unverifiedGuildResponse = await routes.saveDiscordRoleSelection(
      new Request(`${TEST_CONNECT_CONFIG.apiBaseUrl}/api/setup/discord-role/save`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${DISCORD_ROLE_SETUP_COOKIE}=${roleToken}`,
        },
        body: JSON.stringify({
          sourceGuildId: 'unverified_guild',
          sourceRoleIds: ['12345678901234567'],
        }),
      })
    );
    expect(unverifiedGuildResponse.status).toBe(400);

    const storedSession = JSON.parse((await store.get(roleSessionKey)) as string) as {
      completed: boolean;
      sourceGuildId?: string;
      requiredRoleMatchMode?: string;
    };
    expect(storedSession.completed).toBe(false);
    expect(storedSession.sourceGuildId).toBeUndefined();
    expect(storedSession.requiredRoleMatchMode).toBeUndefined();
  });
});
