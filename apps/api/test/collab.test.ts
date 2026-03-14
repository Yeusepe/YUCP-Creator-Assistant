/**
 * Collab routes integration tests — Phase 6.2
 *
 * Tests HTTP-level auth guards and input validation for /api/collab/* routes.
 *
 * Auth mechanism: collab routes use a setup-session token (Bearer header or
 * yucp_setup_session cookie) resolved by resolveSetupToken(). With neither
 * present the route returns 401 immediately.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard tests — no setup session token present → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — auth guards', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/collab/invite without auth returns 401', async () => {
    const res = await server.fetch('/api/collab/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('GET /api/collab/connections without auth returns 401', async () => {
    const res = await server.fetch('/api/collab/connections');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('DELETE /api/collab/connections/test-conn-id without auth returns 401', async () => {
    const res = await server.fetch('/api/collab/connections/test-conn-id', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation tests — auth-independent input checks
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/collab/session/exchange with missing token returns 400', async () => {
    // exchangeSession checks for the token in the JSON body before any auth check.
    // An empty body (no `token` field) → 400 "Missing token".
    const res = await server.fetch('/api/collab/session/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});
