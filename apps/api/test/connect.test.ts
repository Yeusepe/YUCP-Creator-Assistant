/**
 * Connect routes integration tests — Phase 6.2
 *
 * Tests HTTP-level auth guards and input validation for all /api/connect/*
 * and related routes. The test server uses stub auth that always returns null,
 * so every route guarded by auth.getSession() or resolveSetupToken() will
 * return 401 without needing real credentials.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard tests — stub auth always returns null → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('Connect routes — auth guards', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('GET /connect?guild_id=test serves page without internal error', async () => {
    // HTML page route: served from public/connect.html (200) or 404 if file missing in test env.
    // Either is acceptable — we only verify no unhandled 500 occurs.
    const res = await server.fetch('/connect?guild_id=test');
    expect(res.status).not.toBe(500);
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
