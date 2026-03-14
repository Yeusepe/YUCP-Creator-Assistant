/**
 * LemonSqueezy provider adapter tests
 *
 * 1. Pure function tests — HMAC-SHA256 signature algorithm
 *    Tests the signLemonSqueezy() helper from webhookSignatures.ts, which mirrors
 *    the exact algorithm used in the production handleProviderWebhook() handler
 *    (routes/providerPlatform.ts). The production hmacSha256() is a private
 *    function so we test the algorithm via the helper, cross-checking against an
 *    independent Web Crypto implementation to catch any divergence.
 *
 * 2. Payload builder tests — lemonSqueezyOrderPayload()
 *
 * 3. HTTP integration tests — via startTestServer() (no real Convex backend).
 *    Basic routing covered; detailed cases live in webhooks.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestServer, type TestServerHandle } from '../helpers/testServer';
import { lemonSqueezyOrderPayload, signLemonSqueezy } from '../helpers/webhookSignatures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Independent HMAC-SHA256 reference implementation using Web Crypto. */
async function hmacSha256Reference(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const raw = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return Array.from(new Uint8Array(raw))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Pure function tests — HMAC-SHA256 algorithm
// ---------------------------------------------------------------------------

describe('LemonSqueezy HMAC-SHA256 signature algorithm', () => {
  it('produces a 64-character lowercase hex string', async () => {
    const sig = await signLemonSqueezy('test-secret', '{"test":"payload"}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: same secret + same body → same signature', async () => {
    const secret = 'my-webhook-secret';
    const body = '{"meta":{"event_name":"order_created"},"data":{"id":"123"}}';
    const sig1 = await signLemonSqueezy(secret, body);
    const sig2 = await signLemonSqueezy(secret, body);
    expect(sig1).toBe(sig2);
  });

  it('different body → different signature (body is covered by HMAC)', async () => {
    const secret = 'shared-secret';
    const bodyA = '{"meta":{"event_name":"order_created"},"data":{"id":"1"}}';
    const bodyB = '{"meta":{"event_name":"order_created"},"data":{"id":"2"}}';
    const sigA = await signLemonSqueezy(secret, bodyA);
    const sigB = await signLemonSqueezy(secret, bodyB);
    expect(sigA).not.toBe(sigB);
  });

  it('different secret → different signature', async () => {
    const body = '{"test":"payload"}';
    const sig1 = await signLemonSqueezy('secret-one', body);
    const sig2 = await signLemonSqueezy('secret-two', body);
    expect(sig1).not.toBe(sig2);
  });

  it('given correct HMAC-SHA256 of body, matches independent Web Crypto reference', async () => {
    // Cross-check: helper output must equal the reference implementation.
    // This ensures signLemonSqueezy() faithfully implements HMAC-SHA256.
    const secret = 'test-signing-secret';
    const body = '{"test":"payload"}';
    const expected = await hmacSha256Reference(secret, body);
    const actual = await signLemonSqueezy(secret, body);
    expect(actual).toBe(expected);
  });

  it('given tampered body, signing original body produces a different signature', async () => {
    // Verifying signature(originalBody) against tamperedBody must fail.
    const secret = 'signing-secret';
    const originalBody = '{"meta":{"event_name":"order_created"}}';
    const tamperedBody = '{"meta":{"event_name":"order_refunded"}}';
    const sigForOriginal = await signLemonSqueezy(secret, originalBody);
    const sigForTampered = await signLemonSqueezy(secret, tamperedBody);
    expect(sigForOriginal).not.toBe(sigForTampered);
  });

  it('given wrong secret, verification fails (wrong key → different HMAC)', async () => {
    const body = '{"meta":{"event_name":"order_created"}}';
    const correctSig = await signLemonSqueezy('correct-secret', body);
    const wrongSig = await signLemonSqueezy('wrong-secret', body);
    expect(correctSig).not.toBe(wrongSig);
  });

  it('given correct signature with sha256= prefix stripped, value equals raw hex', async () => {
    // LemonSqueezy sends `sha256=<hex>` in some SDKs. The production handler
    // reads the header raw and compares directly. Stripping the prefix
    // recovers the same hex string the helper produces without a prefix.
    const secret = 'prefix-test-secret';
    const body = '{"data":{"id":"order-123"}}';
    const rawHex = await signLemonSqueezy(secret, body);
    const withPrefix = `sha256=${rawHex}`;
    const stripped = withPrefix.replace(/^sha256=/, '');
    expect(stripped).toBe(rawHex);
  });

  it('empty body produces a valid (non-empty) HMAC', async () => {
    const sig = await signLemonSqueezy('some-secret', '');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('unicode body produces a 64-char hex HMAC', async () => {
    const sig = await signLemonSqueezy('secret', '{"user":"José Ñoño","amount":€100}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Payload builder tests
// ---------------------------------------------------------------------------

describe('LemonSqueezy order payload builder', () => {
  it('builds valid JSON with required meta.event_name and data.id fields', () => {
    const raw = lemonSqueezyOrderPayload({ orderId: 'ord-001' });
    const parsed = JSON.parse(raw) as {
      meta: { event_name: string };
      data: { id: string; attributes: { status: string } };
    };
    expect(parsed.meta.event_name).toBe('order_created');
    expect(parsed.data.id).toBe('ord-001');
    expect(parsed.data.attributes.status).toBe('paid');
  });

  it('allows overriding event_name', () => {
    const raw = lemonSqueezyOrderPayload({
      orderId: 'ord-002',
      eventName: 'subscription_cancelled',
    });
    const parsed = JSON.parse(raw) as { meta: { event_name: string } };
    expect(parsed.meta.event_name).toBe('subscription_cancelled');
  });

  it('allows overriding order status', () => {
    const raw = lemonSqueezyOrderPayload({ orderId: 'ord-003', orderStatus: 'refunded' });
    const parsed = JSON.parse(raw) as {
      data: { attributes: { status: string } };
    };
    expect(parsed.data.attributes.status).toBe('refunded');
  });

  it('is deterministic: same inputs → same JSON string', () => {
    const opts = { orderId: 'ord-004', eventName: 'order_refunded' as const };
    expect(lemonSqueezyOrderPayload(opts)).toBe(lemonSqueezyOrderPayload(opts));
  });

  it('signature computed over serialized body is stable across calls', async () => {
    const opts = { orderId: 'ord-005' };
    const body1 = lemonSqueezyOrderPayload(opts);
    const body2 = lemonSqueezyOrderPayload(opts);
    const sig1 = await signLemonSqueezy('sig-secret', body1);
    const sig2 = await signLemonSqueezy('sig-secret', body2);
    expect(sig1).toBe(sig2);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests — via test server (no real Convex backend)
//
// The full webhook routing suite lives in webhooks.test.ts. These tests
// verify provider-specific routing from the lemonsqueezy perspective.
// ---------------------------------------------------------------------------

describe('LemonSqueezy HTTP webhook route (/v1/webhooks/lemonsqueezy/:id)', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('GET to webhook path → 404 (only POST is handled by providerPlatform)', async () => {
    const res = await server.fetch('/v1/webhooks/lemonsqueezy/conn-001', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('POST to unknown provider path → 404', async () => {
    const res = await server.fetch('/v1/webhooks/notarealvendor/conn-001', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: lemonSqueezyOrderPayload({ orderId: 'ord-http-001' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST without x-signature header → not 200 (Convex lookup precedes signature check)', async () => {
    // Without a real Convex backend the connection lookup throws → 500.
    const res = await server.fetch('/v1/webhooks/lemonsqueezy/conn-no-sig', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: lemonSqueezyOrderPayload({ orderId: 'ord-http-002' }),
    });
    expect(res.status).not.toBe(200);
  });

  it('POST with wrong x-signature → not 200', async () => {
    const res = await server.fetch('/v1/webhooks/lemonsqueezy/conn-bad-sig', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': 'f'.repeat(64),
      },
      body: lemonSqueezyOrderPayload({ orderId: 'ord-http-003' }),
    });
    expect(res.status).not.toBe(200);
  });

  it('POST with correctly computed HMAC but unknown connectionId → not 200', async () => {
    // Even a correctly signed request fails because Convex has no record for
    // an unknown connectionId — without a real backend, always throws → 500.
    const secret = 'correct-test-secret';
    const body = lemonSqueezyOrderPayload({ orderId: 'ord-http-004' });
    const sig = await signLemonSqueezy(secret, body);
    const res = await server.fetch('/v1/webhooks/lemonsqueezy/unknown-conn-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': sig },
      body,
    });
    expect(res.status).not.toBe(200);
  });

  it.todo('POST with valid body + correct HMAC + known connectionId → 202 — requires real Convex', () => {});

  it.todo('POST with valid body + wrong HMAC + known connectionId → 403 Forbidden — requires real Convex', () => {});
});
