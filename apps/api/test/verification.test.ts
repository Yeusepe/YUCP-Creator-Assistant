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
import { startTestServer, type TestServerHandle } from './helpers/testServer';

// ─────────────────────────────────────────────────────────────────────────────
// API-secret authentication — missing / wrong secret → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('Verification routes — authentication', () => {
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

  it('POST /api/verification/disconnect without apiSecret returns 401',async () => {
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
// Origin validation — foreign / missing Origin header → 403
// ─────────────────────────────────────────────────────────────────────────────

describe('Verification routes — origin validation', () => {
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
// Input validation — missing / invalid fields → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('Verification routes — validation', () => {
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
// Response shape — all error responses share { success: false, error: string }
// ─────────────────────────────────────────────────────────────────────────────

describe('Verification routes — response shape', () => {
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
