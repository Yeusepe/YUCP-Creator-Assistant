/**
 * Backfill route integration tests — Phase 6.2
 *
 * POST /api/internal/backfill-product
 *
 * Auth mechanism: the request body must contain an `apiSecret` field that
 * matches the server's CONVEX_API_SECRET environment variable (compared with
 * timingSafeStringEqual). This is a direct Convex → API call, not a
 * browser-session-guarded route.
 *
 * Tests set CONVEX_API_SECRET on process.env before starting the server so the
 * route handler (which reads the var at request time) sees a known value.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

const TEST_API_SECRET = 'test-backfill-api-secret-value';

const VALID_BODY = {
  apiSecret: TEST_API_SECRET,
  authUserId: 'test-auth-user-id',
  productId: 'test-product-id',
  provider: 'nonexistent_provider',
  providerProductRef: 'test-ref-001',
};

describe('Backfill route — auth and validation', () => {
  let server: TestServerHandle;
  let originalSecret: string | undefined;

  beforeAll(async () => {
    originalSecret = process.env.CONVEX_API_SECRET;
    process.env.CONVEX_API_SECRET = TEST_API_SECRET;
    server = await startTestServer();
  });

  afterAll(() => {
    server.stop();
    if (originalSecret === undefined) {
      delete process.env.CONVEX_API_SECRET;
    } else {
      process.env.CONVEX_API_SECRET = originalSecret;
    }
  });

  it('POST /api/internal/backfill-product with empty body returns 400', async () => {
    // Missing all required fields → 400 before any secret comparison.
    const res = await server.fetch('/api/internal/backfill-product', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('POST /api/internal/backfill-product with wrong apiSecret returns 401', async () => {
    // All required fields present, but apiSecret does not match CONVEX_API_SECRET.
    const res = await server.fetch('/api/internal/backfill-product', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        apiSecret: 'this-is-the-wrong-secret',
      }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('POST /api/internal/backfill-product with valid secret and unknown provider returns 400', async () => {
    // Correct apiSecret passes the auth check.
    // The provider "nonexistent_provider" is not registered → 400.
    const res = await server.fetch('/api/internal/backfill-product', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toContain('nonexistent_provider');
  });
});
