/**
 * Verification routes integration tests
 *
 * Unlike session-based routes, verification routes authenticate via:
 *   - apiSecret header field  → 401 Unauthorized when absent/wrong
 *   - Origin header           → 403 Forbidden when absent/invalid
 *
 * Public routes (/begin, /complete) validate input and return 400 on
 * missing or invalid fields without any auth check.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  createVerificationRoutes,
  type VerificationConfig,
} from '../src/verification/sessionManager';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

const TEST_VERIFICATION_CONFIG: VerificationConfig = {
  baseUrl: 'https://api.example.com',
  frontendUrl: 'https://app.example.com',
  convexUrl: 'https://convex.example.com',
  convexApiSecret: 'test-api-secret-min-32-characters!!',
  gumroadClientId: 'gumroad-client-id',
  gumroadClientSecret: 'gumroad-client-secret',
};

// ─────────────────────────────────────────────────────────────────────────────
// API-secret authentication, missing / wrong secret → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('Verification routes, authentication', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/verification/panel/bind without apiSecret returns 401', async () => {
    // apiSecret is checked before any other field; empty body triggers 401 immediately.
    const res = await server.fetch('/api/verification/panel/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('error');
  });

  it('POST /api/verification/disconnect without apiSecret returns 401', async () => {
    const res = await server.fetch('/api/verification/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Origin validation, foreign / missing Origin header → 403
// ─────────────────────────────────────────────────────────────────────────────

describe('Verification routes, origin validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/verification/panel/refresh with invalid Origin returns 403', async () => {
    // The route validates that Origin matches the server baseUrl / frontendUrl.
    // An arbitrary third-party origin must be rejected.
    const res = await server.fetch('/api/verification/panel/refresh', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ panelToken: 'test-panel-token' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation, missing / invalid fields → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('Verification routes, validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/verification/begin with empty body returns 400', async () => {
    // authUserId, mode, and redirectUri are all required.
    const res = await server.fetch('/api/verification/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('error');
  });

  it('POST /api/verification/begin with unrecognised mode returns 400', async () => {
    // mode must be one of: gumroad | discord | discord_role | jinxxy | vrchat.
    const res = await server.fetch('/api/verification/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authUserId: 'user_test_abc123',
        mode: 'not-a-real-mode',
        redirectUri: 'https://example.com/callback',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('error');
  });

  it('POST /api/verification/complete with empty body returns 400', async () => {
    // sessionId and subjectId are both required.
    const res = await server.fetch('/api/verification/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response shape, all error responses share { success: false, error: string }
// ─────────────────────────────────────────────────────────────────────────────

describe('Verification routes, response shape', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/verification/panel/bind with valid apiSecret but missing body fields returns 400 with correct shape', async () => {
    // Providing the correct apiSecret passes the auth check; absent required fields
    // (applicationId, discordUserId, guildId, …) then trigger a 400 validation error.
    const res = await server.fetch('/api/verification/panel/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiSecret: 'test-api-secret-min-32-characters!!',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('success', false);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });
});

describe('Verification routes, security boundaries', () => {
  it('rejects wrong apiSecret for panel binding without storing the panel token', async () => {
    const routes = createVerificationRoutes(TEST_VERIFICATION_CONFIG);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('fetch should not run for rejected panel bind requests');
    }) as unknown as typeof fetch;

    try {
      const denied = await routes.bindVerifyPanel(
        new Request('https://api.example.com/api/verification/panel/bind', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            apiSecret: 'wrong-secret',
            applicationId: 'app_123',
            discordUserId: 'discord_123',
            guildId: 'guild_123',
            interactionToken: 'interaction_123',
            messageId: 'message_123',
            panelToken: 'panel_denied',
            authUserId: 'user_123',
          }),
        })
      );
      expect(denied.status).toBe(401);

      const refresh = await routes.refreshVerifyPanel(
        new Request('https://api.example.com/api/verification/panel/refresh', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: TEST_VERIFICATION_CONFIG.baseUrl,
          },
          body: JSON.stringify({ panelToken: 'panel_denied' }),
        })
      );

      expect(refresh.status).toBe(404);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves verify panel state when a cross-origin refresh is rejected', async () => {
    const routes = createVerificationRoutes(TEST_VERIFICATION_CONFIG);
    const bind = await routes.bindVerifyPanel(
      new Request('https://api.example.com/api/verification/panel/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiSecret: TEST_VERIFICATION_CONFIG.convexApiSecret,
          applicationId: 'app_456',
          discordUserId: 'discord_456',
          guildId: 'guild_456',
          interactionToken: 'interaction_456',
          messageId: 'message_456',
          panelToken: 'panel_kept',
          authUserId: 'user_456',
        }),
      })
    );
    expect(bind.status).toBe(200);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    try {
      const rejected = await routes.refreshVerifyPanel(
        new Request('https://api.example.com/api/verification/panel/refresh', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://evil.example.com',
          },
          body: JSON.stringify({ panelToken: 'panel_kept' }),
        })
      );
      expect(rejected.status).toBe(403);

      const accepted = await routes.refreshVerifyPanel(
        new Request('https://api.example.com/api/verification/panel/refresh', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: TEST_VERIFICATION_CONFIG.baseUrl,
          },
          body: JSON.stringify({ panelToken: 'panel_kept' }),
        })
      );
      expect(accepted.status).toBe(200);
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
