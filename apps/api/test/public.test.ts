/**
 * Public API integration tests, /api/public/* endpoints
 *
 * These routes authenticate via API key (x-api-key header or
 * Authorization: Bearer ypsk_...) rather than session cookies.
 *
 * Tests 1–8 run without a live Convex backend:
 *   - Auth tests (1–4): need a fully-valid request body to reach the auth
 *     layer (body validation precedes auth in verification/check).
 *   - Validation tests (5–8): deliberately omit body fields; these return 400
 *     before any auth or Convex call is made.
 *
 * Tests 9–11 require a real Convex instance with seeded data and are
 * marked it.todo() until Phase 2 Convex integration is wired up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createPublicRoutes, type PublicRouteConfig } from '../src/routes/public';
import type { TestServerHandle } from './helpers/testServer';
import { startTestServer } from './helpers/testServer';

// Minimal valid body for POST /api/public/verification/check.
// All three fields must be present to pass body validation and reach auth.
const VALID_BODY = {
  authUserId: 'test-auth-user-id',
  subject: { subjectId: 'test-subject-id' },
  productIds: ['gumroad:prod_test'],
};

const TEST_PUBLIC_CONFIG: PublicRouteConfig = {
  convexUrl: 'https://convex.example.com',
  convexApiSecret: 'test-api-secret-min-32-characters!!',
  convexSiteUrl: 'https://convex.example.com',
};

function post(
  server: TestServerHandle,
  body: object,
  headers: Record<string, string> = {}
): Promise<Response> {
  return server.fetch('/api/public/verification/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
describe('Public API, authentication', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('returns 401 with no Authorization header', async () => {
    const res = await post(server, VALID_BODY);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'unauthorized');
    expect(body).toHaveProperty('message');
    expect(body).toHaveProperty('supportCode');
  });

  it('returns 401 with malformed Authorization (Basic scheme, not Bearer)', async () => {
    // Basic scheme is not a recognised API key form; extractApiKey returns null.
    const res = await post(server, VALID_BODY, {
      authorization: 'Basic dXNlcjpwYXNz',
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'unauthorized');
  });

  it('returns 401 when Bearer token lacks the ypsk_ API-key prefix', async () => {
    // A Bearer token that does not start with ypsk_ is not treated as an API
    // key by extractApiKey, it returns null immediately with no Convex call.
    const res = await post(server, VALID_BODY, {
      authorization: 'Bearer not_a_valid_api_key',
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'unauthorized');
  });

  it('returns 401 for a correctly-formatted ypsk_ key that fails hash verification', async () => {
    // The key has the right prefix so the route attempts Convex verification,
    // which fails with connection-refused (no backend in tests). The catch
    // block in defaultVerifyApiKey returns null → 401.
    const res = await post(server, VALID_BODY, {
      authorization: 'Bearer ypsk_00000000000000000000000000000000000000000000000000',
    });
    expect([401, 403]).toContain(res.status);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('supportCode');
  });
});

// ---------------------------------------------------------------------------
// Request body validation (runs before auth, no key required for 400s)
// ---------------------------------------------------------------------------
describe('Public API, request body validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('returns 400 when authUserId is missing', async () => {
    const res = await post(server, {
      subject: { subjectId: 'test-subject-id' },
      productIds: ['gumroad:prod_test'],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'bad_request');
    expect(body).toHaveProperty('supportCode');
  });

  it('returns 400 when subject selector is missing', async () => {
    const res = await post(server, {
      authUserId: 'test-auth-user-id',
      productIds: ['gumroad:prod_test'],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'bad_request');
  });

  it('returns 400 when productIds is absent', async () => {
    const res = await post(server, {
      authUserId: 'test-auth-user-id',
      subject: { subjectId: 'test-subject-id' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'bad_request');
  });

  it('returns 400 when productIds exceeds the 50-item limit', async () => {
    // MAX_PRODUCT_IDS_PER_CHECK = 50; 51 items should be rejected.
    const res = await post(server, {
      authUserId: 'test-auth-user-id',
      subject: { subjectId: 'test-subject-id' },
      productIds: Array.from({ length: 51 }, (_, i) => `gumroad:prod_${i}`),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'bad_request');
  });
});

// ---------------------------------------------------------------------------
// Response shape
// These tests require a real Convex instance with seeded API keys and
// entitlements. Mark as todo until Phase 2 Convex integration is complete.
//
// Expected shape for 200 OK:
//   { results: [{ productId: string, verified: boolean }] }
// ---------------------------------------------------------------------------
describe('Public API, response shape', () => {
  it.todo(
    '200 with verified:true for a subject that has an active entitlement ' +
      '— needs real Convex + seeded ypsk_ key and entitlement record',
    () => {}
  );

  it.todo(
    '200 with verified:false for an unknown subjectId (graceful not-found) ' +
      '— needs real Convex + seeded ypsk_ key; subject resolution returns 200 empty',
    () => {}
  );

  it.todo(
    '403 when API key belongs to creator A but authUserId targets creator B ' +
      '(data isolation), needs real Convex + two seeded creators with separate ypsk_ keys',
    () => {}
  );
});

describe('Public API, security boundaries', () => {
  function createSecurityHarness(verifiedKey: Record<string, unknown> | null) {
    let verifyApiKeyCalls = 0;
    let convexQueryCalls = 0;

    const routes = createPublicRoutes(TEST_PUBLIC_CONFIG, {
      verifyApiKey: async () => {
        verifyApiKeyCalls += 1;
        return verifiedKey as never;
      },
      createConvexClient: () =>
        ({
          query: async () => {
            convexQueryCalls += 1;
            throw new Error('Convex should not be reached for rejected requests');
          },
        }) as never,
    });

    return {
      routes,
      getVerifyApiKeyCalls: () => verifyApiKeyCalls,
      getConvexQueryCalls: () => convexQueryCalls,
    };
  }

  async function callSecurityRoute(
    harness: ReturnType<typeof createSecurityHarness>,
    headers: Record<string, string>
  ) {
    return harness.routes.handleRequest(
      new Request('https://api.example.com/api/public/verification/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(VALID_BODY),
      }),
      '/api/public/verification/check'
    );
  }

  it('rejects malformed x-api-key values before verification lookup', async () => {
    const harness = createSecurityHarness({
      id: 'key_live',
      userId: VALID_BODY.authUserId,
      enabled: true,
      metadata: { kind: 'public-api', authUserId: VALID_BODY.authUserId },
      permissions: { publicApi: ['verification:read'] },
    });

    const res = await callSecurityRoute(harness, { 'x-api-key': 'not-a-public-api-key' });

    expect(res?.status).toBe(401);
    expect(harness.getVerifyApiKeyCalls()).toBe(0);
    expect(harness.getConvexQueryCalls()).toBe(0);
  });

  it('rejects expired API keys before any tenant data lookup', async () => {
    const harness = createSecurityHarness({
      id: 'key_expired',
      userId: VALID_BODY.authUserId,
      enabled: true,
      metadata: { kind: 'public-api', authUserId: VALID_BODY.authUserId },
      permissions: { publicApi: ['verification:read'] },
      expiresAt: Date.now() - 1_000,
    });

    const res = await callSecurityRoute(harness, {
      'x-api-key': 'ypsk_0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    expect(res?.status).toBe(401);
    expect(harness.getVerifyApiKeyCalls()).toBe(1);
    expect(harness.getConvexQueryCalls()).toBe(0);
  });

  it('rejects API keys scoped to a different tenant without querying subject data', async () => {
    const harness = createSecurityHarness({
      id: 'key_other_tenant',
      userId: 'other-user-id',
      enabled: true,
      metadata: { kind: 'public-api', authUserId: 'other-user-id' },
      permissions: { publicApi: ['verification:read'] },
      expiresAt: Date.now() + 60_000,
    });

    const res = await callSecurityRoute(harness, {
      'x-api-key': 'ypsk_abcdef0123456789abcdef0123456789abcdef0123456789',
    });

    expect(res?.status).toBe(403);
    expect(harness.getVerifyApiKeyCalls()).toBe(1);
    expect(harness.getConvexQueryCalls()).toBe(0);
  });

  it('rejects mismatched Better Auth owner IDs even when metadata is forged to match', async () => {
    const harness = createSecurityHarness({
      id: 'key_forged_metadata',
      userId: 'other-owner',
      enabled: true,
      metadata: { kind: 'public-api', authUserId: VALID_BODY.authUserId },
      permissions: { publicApi: ['verification:read'] },
      expiresAt: Date.now() + 60_000,
    });

    const res = await callSecurityRoute(harness, {
      'x-api-key': 'ypsk_fedcba9876543210fedcba9876543210fedcba9876543210',
    });

    expect(res?.status).toBe(403);
    expect(harness.getVerifyApiKeyCalls()).toBe(1);
    expect(harness.getConvexQueryCalls()).toBe(0);
  });
});
