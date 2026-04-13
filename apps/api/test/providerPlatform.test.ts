/**
 * Provider Platform REST API integration tests
 *
 * Covers the non-webhook routes registered by createProviderPlatformRoutes():
 *   POST /v1/tenants/:userId/provider-connections
 *   POST /v1/provider-connections/:id/credentials
 *   POST /v1/provider-connections/:id/catalog-sync-jobs
 *   POST /v1/provider-connections/:id/reconciliation-jobs
 *   POST /v1/verification-sessions
 *   POST /v1/verification-sessions/:id/complete
 *
 * LemonSqueezy webhook tests (/v1/webhooks/lemonsqueezy/:id) already live in
 * webhooks.test.ts, this file focuses on the management REST API.
 *
 * The test server uses stub auth (always returns null session) so every
 * auth-guarded route returns 401 without needing real Discord credentials.
 * Routes that query Convex before the auth check return 500 (no backend).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

let server: TestServerHandle;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(() => {
  server.stop();
});

// ---------------------------------------------------------------------------
// Auth-guarded routes, 401 before any Convex call
//
// requireTenantAccess() calls auth.getSession() → null (stub) → 401.
// No Convex query is made before this guard for these routes.
// ---------------------------------------------------------------------------

describe('Provider connections, auth guards', () => {
  it('POST /v1/tenants/:userId/provider-connections without auth → 401', async () => {
    // requireTenantAccess runs before body parsing for this route.
    const res = await server.fetch('/v1/tenants/test-user-id/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerKey: 'lemonsqueezy' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body).toHaveProperty('error');
  });

  it('POST /v1/tenants/:userId/provider-connections returns JSON content-type on 401', async () => {
    const res = await server.fetch('/v1/tenants/some-user/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerKey: 'lemonsqueezy' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('POST /v1/tenants/:userId/provider-connections sets X-Request-Id header on 401', async () => {
    const res = await server.fetch('/v1/tenants/some-user/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerKey: 'lemonsqueezy' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Verification session routes, 401 before Convex call
//
// Both handlers parse the JSON body first, then call requireTenantAccess().
// A valid JSON body with authUserId reaches the auth guard → 401 (stub).
// ---------------------------------------------------------------------------

describe('Verification sessions, auth guards', () => {
  it('POST /v1/verification-sessions with valid JSON but no auth → 401', async () => {
    const res = await server.fetch('/v1/verification-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authUserId: 'test-user-id',
        providerKey: 'lemonsqueezy',
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body).toHaveProperty('error');
  });

  it('POST /v1/verification-sessions/:id/complete with valid JSON but no auth → 401', async () => {
    const res = await server.fetch('/v1/verification-sessions/sess-abc123/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authUserId: 'test-user-id',
        providerKey: 'lemonsqueezy',
        licenseKey: 'AAAA-BBBB-CCCC-DDDD',
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// Routes that query Convex before auth, return error without backend
//
// requireConnectionAccess() fetches the connection from Convex first.
// Without a real Convex backend the network call throws → outer catch → 500.
// ---------------------------------------------------------------------------

describe('Connection management, Convex-dependent (no backend in tests)', () => {
  it('POST /v1/provider-connections/:id/credentials → not 200 (Convex lookup precedes auth)', async () => {
    const res = await server.fetch('/v1/provider-connections/conn-abc/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: [{ credentialKey: 'api_token', kind: 'api_token', value: 'tok' }],
      }),
    });
    expect(res.status).not.toBe(200);
  });

  it('POST /v1/provider-connections/:id/catalog-sync-jobs → not 200', async () => {
    const res = await server.fetch('/v1/provider-connections/conn-abc/catalog-sync-jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).not.toBe(200);
  });

  it('POST /v1/provider-connections/:id/reconciliation-jobs → not 200', async () => {
    const res = await server.fetch('/v1/provider-connections/conn-abc/reconciliation-jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).not.toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Route matching, unrecognised paths fall through to 404
// ---------------------------------------------------------------------------

describe('Provider platform, route matching', () => {
  it('GET /v1/tenants/:userId/provider-connections → 404 (only POST is handled)', async () => {
    // providerPlatform only registers POST for this path; GET falls through to
    // the global 404 handler in createServer.
    const res = await server.fetch('/v1/tenants/test-user/provider-connections', {
      method: 'GET',
    });
    expect(res.status).toBe(404);
  });

  it('POST /v1/unknown-v1-path → 404 (no route matches)', async () => {
    const res = await server.fetch('/v1/unknown-path-that-does-not-exist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('GET /v1/provider-connections/:id/credentials → 404 (only POST handled)', async () => {
    const res = await server.fetch('/v1/provider-connections/conn-abc/credentials', {
      method: 'GET',
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /v1/provider-connections/:id/credentials → 404 (only POST handled)', async () => {
    const res = await server.fetch('/v1/provider-connections/conn-abc/credentials', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Idempotency key header, replayed responses
// ---------------------------------------------------------------------------

describe('Provider platform, idempotency', () => {
  it('two requests with same Idempotency-Key return same status', async () => {
    const idempotencyKey = `test-idem-${Date.now()}`;
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        authUserId: 'test-user-id',
        providerKey: 'lemonsqueezy',
      }),
    };

    const res1 = await server.fetch('/v1/verification-sessions', init);
    const res2 = await server.fetch('/v1/verification-sessions', init);

    // Both should return the same status (first response is cached and replayed).
    expect(res2.status).toBe(res1.status);
  });

  it('replayed response includes Idempotency-Replayed header', async () => {
    const idempotencyKey = `test-replay-${Date.now()}`;
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        authUserId: 'test-user-id',
        providerKey: 'lemonsqueezy',
      }),
    };

    await server.fetch('/v1/verification-sessions', init); // prime
    const res2 = await server.fetch('/v1/verification-sessions', init);

    // Second request should be served from the idempotency cache.
    expect(res2.headers.get('Idempotency-Replayed')).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// Webhook route, covered in detail in webhooks.test.ts; minimal smoke here
// ---------------------------------------------------------------------------

describe('LemonSqueezy webhook route (smoke only, full coverage in webhooks.test.ts)', () => {
  it('POST /v1/webhooks/lemonsqueezy/:id → not 200 (no Convex backend)', async () => {
    const res = await server.fetch('/v1/webhooks/lemonsqueezy/test-conn-id', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': 'aaaa'.repeat(16),
      },
      body: JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } }),
    });
    expect(res.status).not.toBe(200);
  });

  it('GET /v1/webhooks/lemonsqueezy/:id → 404 (GET not handled by providerPlatform)', async () => {
    const res = await server.fetch('/v1/webhooks/lemonsqueezy/test-conn-id', {
      method: 'GET',
    });
    expect(res.status).toBe(404);
  });
});
