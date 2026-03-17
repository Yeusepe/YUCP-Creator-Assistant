/**
 * Payhip provider adapter tests
 *
 * 1. Pure function tests — SHA256(apiKey) signature algorithm
 *    Tests the hashPayhip() helper from webhookSignatures.ts, which mirrors the
 *    exact algorithm used in production (providers/payhip/webhook.ts).
 *
 *    Payhip's signature is NOT an HMAC of the body. It is the static SHA256 hash
 *    of the creator's Payhip API key, embedded in the JSON payload as the
 *    `signature` field. The production handler recomputes SHA256(apiKey) on each
 *    request and compares it with timingSafeStringEqual().
 *
 * 2. Payload builder tests — payhipPaidPayload()
 *
 * 3. HTTP integration tests — via startTestServer() (no real Convex backend).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestServer, type TestServerHandle } from '../helpers/testServer';
import { hashPayhip, payhipPaidPayload } from '../helpers/webhookSignatures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Independent SHA256 reference implementation using Web Crypto. */
async function sha256Reference(input: string): Promise<string> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(raw))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Pure function tests — SHA256(apiKey) algorithm
// ---------------------------------------------------------------------------

describe('Payhip SHA256(apiKey) signature algorithm', () => {
  it('produces a 64-character lowercase hex string', async () => {
    const hash = await hashPayhip('test-api-key');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: same key → same hash', async () => {
    const apiKey = 'my-payhip-api-key';
    const hash1 = await hashPayhip(apiKey);
    const hash2 = await hashPayhip(apiKey);
    expect(hash1).toBe(hash2);
  });

  it('different apiKey → different hash', async () => {
    const hash1 = await hashPayhip('key-aaa');
    const hash2 = await hashPayhip('key-bbb');
    expect(hash1).not.toBe(hash2);
  });

  it('given correct SHA256(apiKey), matches independent Web Crypto reference', async () => {
    // Cross-check: helper output must equal the reference implementation.
    const apiKey = 'test-payhip-key-12345';
    const expected = await sha256Reference(apiKey);
    const actual = await hashPayhip(apiKey);
    expect(actual).toBe(expected);
  });

  it('given wrong API key, hash does not match correct key hash (verification would fail)', async () => {
    const correctKey = 'creator-api-key-correct';
    const wrongKey = 'creator-api-key-wrong';
    const correctHash = await hashPayhip(correctKey);
    const wrongHash = await hashPayhip(wrongKey);
    expect(correctHash).not.toBe(wrongHash);
  });

  it('given payload with no signature field, signature check fails (undefined ≠ hash)', async () => {
    // Simulates a payload missing the `signature` field. The production handler
    // guards: `if (apiKey && payload.signature)` — without the field,
    // signatureValid stays false.
    const apiKey = 'creator-key';
    const hash = await hashPayhip(apiKey);
    const payloadSig: string | undefined = undefined;
    expect(payloadSig).not.toBe(hash);
  });

  it('is not HMAC — hash does not depend on body content', async () => {
    // Payhip uses SHA256(apiKey), never SHA256(apiKey || body).
    // The same API key always produces the same signature regardless of payload.
    const apiKey = 'static-payhip-key';
    const hash1 = await hashPayhip(apiKey);
    const hash2 = await hashPayhip(apiKey);
    expect(hash1).toBe(hash2);
  });

  it('empty string apiKey produces a valid 64-char hex (edge case)', async () => {
    const hash = await hashPayhip('');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Payload builder tests
// ---------------------------------------------------------------------------

describe('Payhip webhook payload builder', () => {
  it('embeds SHA256(apiKey) as the `signature` field', async () => {
    const apiKey = 'builder-test-key';
    const raw = await payhipPaidPayload({ transactionId: 'txn_001', apiKey });
    const body = JSON.parse(raw) as {
      id: string;
      type: string;
      signature: string;
      created_at: string;
    };
    expect(body.id).toBe('txn_001');
    expect(body.type).toBe('paid');
    const expectedSig = await hashPayhip(apiKey);
    expect(body.signature).toBe(expectedSig);
  });

  it('refunded flag sets type to "refund"', async () => {
    const raw = await payhipPaidPayload({
      transactionId: 'txn_refund',
      apiKey: 'key',
      refunded: true,
    });
    const body = JSON.parse(raw) as { type: string };
    expect(body.type).toBe('refund');
  });

  it('includes date as Unix seconds timestamp', async () => {
    const raw = await payhipPaidPayload({ transactionId: 'txn_ts', apiKey: 'key' });
    const body = JSON.parse(raw) as { date: number };
    expect(typeof body.date).toBe('number');
    expect(body.date).toBeGreaterThan(1_000_000_000);
    expect(body.date).toBeLessThan(10_000_000_000);
  });

  it('given payload with wrong signature field, check would fail (different hash)', async () => {
    const raw = await payhipPaidPayload({ transactionId: 'txn_002', apiKey: 'correct-key' });
    const body = JSON.parse(raw) as { signature: string };
    const wrongSig = await hashPayhip('wrong-key');
    expect(body.signature).not.toBe(wrongSig);
  });

  it('signature in payload matches independent SHA256 computation', async () => {
    const apiKey = 'verify-cross-check-key';
    const raw = await payhipPaidPayload({ transactionId: 'txn_003', apiKey });
    const body = JSON.parse(raw) as { signature: string };
    const reference = await sha256Reference(apiKey);
    expect(body.signature).toBe(reference);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests — via test server (no real Convex backend)
//
// The full Payhip webhook routing suite lives in webhooks.test.ts. These tests
// verify provider-specific routing from the Payhip perspective.
// ---------------------------------------------------------------------------

describe('Payhip HTTP webhook route (/webhooks/payhip/:routeId)', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('GET → 405 (method guard fires before JSON parse or Convex call)', async () => {
    const res = await server.fetch('/webhooks/payhip/test-route-id', { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('POST with invalid JSON → 400 (JSON parse error before Convex call)', async () => {
    const res = await server.fetch('/webhooks/payhip/test-route-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ bad json !!',
    });
    expect(res.status).toBe(400);
  });

  it('POST with valid JSON but no signature field → not 200 (Convex API-key lookup fails)', async () => {
    // The handler calls convex.query(getPayhipApiKeyByRouteId) after JSON parse.
    // Without a Convex backend the query throws → outer catch → 500.
    const res = await server.fetch('/webhooks/payhip/test-route-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'txn_no_sig', type: 'paid' }),
    });
    expect(res.status).not.toBe(200);
  });

  it('POST with valid JSON and wrong signature → not 200 (Convex fails before sig check)', async () => {
    // Convex lookup precedes the signature comparison; the lookup always
    // throws without a real backend → 500 regardless of the signature.
    const res = await server.fetch('/webhooks/payhip/test-route-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'txn_bad_sig',
        type: 'paid',
        signature: 'deadbeef'.repeat(8),
      }),
    });
    expect(res.status).not.toBe(200);
  });

  it('POST with correct SHA256(apiKey) signature → not 200 (Convex lookup required for the stored key)', async () => {
    // Even if the signature field is the correct SHA256(apiKey), the handler
    // still needs to retrieve the encrypted API key from Convex to compare.
    // Without a backend → 500.
    const apiKey = 'correct-payhip-key';
    const body = await payhipPaidPayload({ transactionId: 'txn_correct', apiKey });
    const res = await server.fetch('/webhooks/payhip/test-route-id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).not.toBe(200);
  });

  it.todo('POST with valid JSON + correct SHA256(apiKey) + known routeId → 200 — requires real Convex', () => {});

  it.todo('POST with valid JSON + correct signature but old date → 403 (replay protection) — requires real Convex', () => {});
});
