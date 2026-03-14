/**
 * Webhook HTTP-layer integration tests
 *
 * These tests cover routing, auth/signature validation, replay protection, and
 * error handling for all four webhook providers. They run against a real Bun
 * HTTP server (port 0) but WITHOUT a real Convex backend.
 *
 * Without a real Convex backend, certain checks (signature validation requiring
 * a stored secret, connection lookup) cannot run end-to-end. Those are marked
 * with it.todo() and explained below.
 *
 * Key behaviours verified here (all happen BEFORE any Convex I/O):
 *   - Gumroad:  method check, replay protection, missing sale_id early-return
 *   - Jinxxy:   method check, JSON parse, signature rejection (no stored secret)
 *   - Payhip:   method check, JSON parse
 *   - LS:       provider routing, GET method falls through to 404
 *
 * Reference files:
 *   apps/api/src/providers/gumroad/webhook.ts
 *   apps/api/src/providers/jinxxy/webhook.ts
 *   apps/api/src/providers/payhip/webhook.ts
 *   apps/api/src/routes/providerPlatform.ts  (LemonSqueezy: /v1/webhooks/…)
 *   apps/api/src/routes/webhooks.ts          (Gumroad/Jinxxy/Payhip: /webhooks/…)
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  gumroadSalePayload,
  jinxxyOrderPayload,
  lemonSqueezyOrderPayload,
  payhipPaidPayload,
  signJinxxy,
  signLemonSqueezy,
} from './helpers/webhookSignatures';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

// ---------------------------------------------------------------------------
// Shared server instance (started once for all suites)
// ---------------------------------------------------------------------------

let server: TestServerHandle;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(() => {
  server.stop();
});

// ---------------------------------------------------------------------------
// General routing
// ---------------------------------------------------------------------------

describe('General webhook routing', () => {
  it('POST /webhooks/unknownprovider/id → 404', async () => {
    // The webhook dispatcher in routes/webhooks.ts returns 404 when no
    // matching provider plugin is found.
    const res = await server.fetch('/webhooks/unknownprovider/some-route-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('POST /v1/webhooks/unknownprovider/id → 404', async () => {
    // The providerPlatform route (for LemonSqueezy) explicitly 404s any
    // provider other than 'lemonsqueezy' — phase-1 restriction.
    const res = await server.fetch('/v1/webhooks/unknownprovider/some-connection-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('POST /webhooks/jinxxy-collab/id/missing-invite → 404', async () => {
    // The jinxxy-collab extra-provider path requires a 4th path segment
    // (inviteId). With only 3 segments, the handler returns 404.
    const res = await server.fetch('/webhooks/jinxxy-collab/some-owner-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it.todo(
    'Concurrent identical webhook events are deduplicated — requires real Convex state',
    () => {},
  );
});

// ---------------------------------------------------------------------------
// Gumroad webhooks  (/webhooks/gumroad/:routeId)
//
// Security model: NO HMAC. The routeId IS the secret. Content-Type is NOT
// validated by the handler — it reads the raw body and parses as URLSearchParams
// regardless of the declared content-type.
// ---------------------------------------------------------------------------

describe('Gumroad webhooks', () => {
  const GUMROAD_PATH = '/webhooks/gumroad/test-route-id';

  it('GET → 405 (method check happens before any Convex call)', async () => {
    const res = await server.fetch(GUMROAD_PATH, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('POST with old sale_timestamp → 403 (replay protection fires before Convex lookup)', async () => {
    // The handler rejects events older than 5 minutes BEFORE querying Convex.
    // This test works without a real backend.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const body = gumroadSalePayload({
      saleId: 'sale_replay_test',
      saleTimestamp: tenMinutesAgo,
    });
    const res = await server.fetch(GUMROAD_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    expect(res.status).toBe(403);
  });

  it('POST with a fresh timestamp but just-expired boundary (exactly 5 min) → 403', async () => {
    // Boundary: 5 minutes + 1 second → should be rejected.
    const justOver5Min = new Date(Date.now() - 5 * 60 * 1000 - 1000).toISOString();
    const body = gumroadSalePayload({
      saleId: 'sale_boundary_test',
      saleTimestamp: justOver5Min,
    });
    const res = await server.fetch(GUMROAD_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    expect(res.status).toBe(403);
  });

  it('POST with missing sale_id → 200 (handler returns OK early — no DB call)', async () => {
    // Gumroad handler explicitly returns 200 when sale_id is absent:
    //   if (!saleId) return new Response('OK', { status: 200 });
    // This happens BEFORE the Convex connection lookup.
    const params = new URLSearchParams({ refunded: 'false' });
    const res = await server.fetch(GUMROAD_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    expect(res.status).toBe(200);
  });

  it('POST with JSON body (wrong content-type) → 200 (content-type not validated; URLSearchParams cannot find sale_id)', async () => {
    // Gumroad does NOT validate Content-Type. It reads the raw body and parses
    // with URLSearchParams. A JSON body fails URLSearchParams extraction of
    // sale_id → empty string → handler returns 200 early (same path as missing
    // sale_id). No 400/415 is emitted.
    const res = await server.fetch(GUMROAD_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sale_id: 'should-not-matter' }),
    });
    expect(res.status).toBe(200);
  });

  it('POST with valid form body and fresh timestamp → not 200 (Convex unavailable)', async () => {
    // With a valid sale_id and fresh timestamp, the handler proceeds to the
    // Convex connection lookup. Since there is no real Convex backend in tests,
    // the query throws a network error, caught by the outer try/catch → 500.
    const body = gumroadSalePayload({ saleId: 'sale_fresh_001' });
    const res = await server.fetch(GUMROAD_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    // Cannot be 200 — Convex lookup fails. Either 403 (no connection found) or
    // 500 (network error). Either way, not a success.
    expect(res.status).not.toBe(200);
  });

  it.todo(
    'Valid form body + routeId with matching Convex connection → 200 and event stored',
    () => {},
  );
});

// ---------------------------------------------------------------------------
// Jinxxy webhooks  (/webhooks/jinxxy/:routeId)
//
// Security model: HMAC-SHA256 of the raw body, sent as lowercase hex in the
// `x-signature` header. The handler retrieves the stored secret from Convex
// (gracefully returning null on error), then validates the signature AFTER
// parsing JSON. Without a stored secret, signatureValid is always false → 403.
// ---------------------------------------------------------------------------

describe('Jinxxy webhooks', () => {
  const JINXXY_PATH = '/webhooks/jinxxy/test-route-id';

  it('GET → 405 (method check before anything else)', async () => {
    const res = await server.fetch(JINXXY_PATH, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('POST with invalid JSON body → 400 (JSON parse fails before signature enforcement)', async () => {
    // The Jinxxy handler tries to fetch the webhook secret from Convex (catches
    // errors silently → null), then parses JSON. Bad JSON → 400 Bad Request.
    const res = await server.fetch(JINXXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json{{',
    });
    expect(res.status).toBe(400);
  });

  it('POST with wrong content-type (form-encoded body that is not valid JSON) → 400', async () => {
    // Jinxxy always tries JSON.parse. Form-encoded body fails JSON parse → 400.
    const res = await server.fetch(JINXXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'event_id=foo&event_type=order.completed',
    });
    expect(res.status).toBe(400);
  });

  it('POST with valid JSON but missing event_id → 200 (early return before signature check)', async () => {
    // The handler returns 200 immediately if event_id (and event_type) are
    // both absent — this happens AFTER the signature setup code but BEFORE
    // the signatureValid guard that would reject it.
    const res = await server.fetch(JINXXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ some_other_field: 'value' }),
    });
    expect(res.status).toBe(200);
  });

  it('POST with valid JSON and missing x-signature header → 403', async () => {
    // Without a stored secret AND without a signature, signatureValid=false.
    // The handler logs "no secret configured" and then rejects with 403.
    const body = jinxxyOrderPayload({ eventId: 'evt_no_sig_001' });
    const res = await server.fetch(JINXXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(403);
  });

  it('POST with valid JSON and wrong x-signature → 403 (signature rejected)', async () => {
    // Even a plausible-looking hex signature is rejected because the stored
    // secret cannot be retrieved from Convex in test mode.
    const body = jinxxyOrderPayload({ eventId: 'evt_wrong_sig_001' });
    const res = await server.fetch(JINXXY_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
      body,
    });
    expect(res.status).toBe(403);
  });

  it('POST with x-signature using sha256= prefix → 403 (prefix stripped, but still no valid secret)', async () => {
    // The handler strips the optional "sha256=" prefix before comparing.
    // Since no secret is available from Convex, signatureValid=false → 403.
    const body = jinxxyOrderPayload({ eventId: 'evt_prefix_sig_001' });
    const fakeHex = 'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
    const res = await server.fetch(JINXXY_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': `sha256=${fakeHex}`,
      },
      body,
    });
    expect(res.status).toBe(403);
  });

  it('POST with valid JSON + correct HMAC but unknown routeId → 403 (no stored secret to validate against)', async () => {
    // Without a real Convex connection, the handler cannot retrieve the stored
    // secret, so any signature — even a correctly computed one — will fail.
    // This demonstrates the test limitation: the secret must come from Convex.
    const testSecret = 'my-test-webhook-secret';
    const body = jinxxyOrderPayload({ eventId: 'evt_correct_hmac_001' });
    const sig = await signJinxxy(testSecret, body);
    const res = await server.fetch(JINXXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': sig },
      body,
    });
    // 403: no stored secret → signatureValid stays false regardless of the header
    expect(res.status).toBe(403);
  });

  it.todo(
    'POST with valid JSON + correct HMAC + known routeId → 200 and event stored — requires real Convex',
    () => {},
  );

  it.todo(
    'POST with valid JSON + correct HMAC + old created_at → 403 (replay protection) — requires real Convex (secret must match for replay check to run)',
    () => {},
  );
});

// ---------------------------------------------------------------------------
// Payhip webhooks  (/webhooks/payhip/:routeId)
//
// Security model: The signature is SHA256(apiKey) as lowercase hex, placed
// inside the JSON body as the `signature` field (NOT a header). The handler
// fetches the encrypted API key from Convex — without Convex it throws → 500.
// ---------------------------------------------------------------------------

describe('Payhip webhooks', () => {
  const PAYHIP_PATH = '/webhooks/payhip/test-route-id';

  it('GET → 405 (method check before JSON parse and Convex call)', async () => {
    const res = await server.fetch(PAYHIP_PATH, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('POST with invalid JSON body → 400 (JSON parse error before Convex call)', async () => {
    // JSON parse failure is the only path that returns 4xx without a Convex call.
    const res = await server.fetch(PAYHIP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ bad json !!',
    });
    expect(res.status).toBe(400);
  });

  it('POST with valid JSON body → not 200 (Convex API-key lookup fails without backend)', async () => {
    // The Payhip handler calls convex.query(getPayhipApiKeyByRouteId) — this is
    // NOT wrapped in a try/catch inside the handler, so a network error propagates
    // to the outer catch → 500. The signature check never runs.
    const body = await payhipPaidPayload({
      transactionId: 'txn_payhip_001',
      apiKey: 'fake-api-key',
    });
    const res = await server.fetch(PAYHIP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).not.toBe(200);
  });

  it('POST with valid JSON and wrong signature field → not 200 (Convex fails before signature check)', async () => {
    // Unlike Jinxxy, Payhip does NOT wrap its Convex query in try/catch.
    // Any Convex error → outer catch → 500. The `signature` field in the body
    // is never validated in the test environment.
    const res = await server.fetch(PAYHIP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'txn_002', type: 'paid', signature: 'wronghash' }),
    });
    expect(res.status).not.toBe(200);
  });

  it.todo(
    'POST with valid JSON + correct SHA256(apiKey) signature + known routeId → 200 — requires real Convex',
    () => {},
  );
});

// ---------------------------------------------------------------------------
// LemonSqueezy webhooks  (/v1/webhooks/lemonsqueezy/:connectionId)
//
// Security model: HMAC-SHA256 of the raw body in `x-signature` header.
// Route lives in providerPlatform.ts (not the generic webhook router).
// The handler queries Convex for the connection and secret BEFORE checking
// the signature — so without Convex any POST → 500 via the outer try/catch.
// GET requests fall through to the global 404 handler (no method guard in
// the route match condition).
// ---------------------------------------------------------------------------

describe('LemonSqueezy webhooks', () => {
  const LS_PATH = '/v1/webhooks/lemonsqueezy/test-connection-id';

  it('GET /v1/webhooks/lemonsqueezy/:id → 404 (route only matches POST; GET falls through)', async () => {
    // The providerPlatform handleRequest only calls handleProviderWebhook when
    // request.method === 'POST'. A GET returns null → createServer falls
    // through to the 404 catch-all response.
    const res = await server.fetch(LS_PATH, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('POST /v1/webhooks/unknownprovider/:id → 404 (only lemonsqueezy is implemented)', async () => {
    const res = await server.fetch('/v1/webhooks/unknownprovider/some-conn-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('POST /v1/webhooks/lemonsqueezy/:id with wrong x-signature → not 200 (Convex lookup precedes sig check)', async () => {
    // handleProviderWebhook queries Convex for the connection before verifying
    // the signature. Without a real backend, the query throws → outer catch
    // → 500. The signature is never evaluated.
    const body = lemonSqueezyOrderPayload({ orderId: 'ord_ls_001' });
    const res = await server.fetch(LS_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': 'badhex000',
      },
      body,
    });
    expect(res.status).not.toBe(200);
  });

  it('POST /v1/webhooks/lemonsqueezy/:id with missing x-signature → not 200', async () => {
    const body = lemonSqueezyOrderPayload({ orderId: 'ord_ls_002' });
    const res = await server.fetch(LS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).not.toBe(200);
  });

  it('POST /v1/webhooks/lemonsqueezy/:id with correct HMAC but unknown connectionId → not 200', async () => {
    // Even with a correctly signed body, the Convex connection lookup for an
    // unknown connectionId will fail (network error → 500, or null → 404 if
    // Convex were available). Either way, not 200.
    const testSecret = 'ls-test-webhook-secret';
    const body = lemonSqueezyOrderPayload({ orderId: 'ord_ls_003' });
    const sig = await signLemonSqueezy(testSecret, body);
    const res = await server.fetch(LS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': sig },
      body,
    });
    expect(res.status).not.toBe(200);
  });

  it.todo(
    'POST with valid body + correct HMAC + known connectionId → 202 and event stored — requires real Convex',
    () => {},
  );

  it.todo(
    'POST with valid body + wrong HMAC + known connectionId → 403 Forbidden — requires real Convex (signature check runs only after successful connection lookup)',
    () => {},
  );
});
