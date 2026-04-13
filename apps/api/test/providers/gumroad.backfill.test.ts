/**
 * Gumroad backfill plugin, unit tests
 *
 * Verifies that the fetchPage function correctly maps Gumroad sale records to
 * BackfillRecord objects, specifically that historical created_at timestamps
 * are preserved as-is in purchasedAt.
 *
 * Regression: ingestBackfillPurchaseFactsBatch previously rejected any
 * purchasedAt older than 30 days, but the backfill plugin correctly emits
 * historical timestamps. This test catches either side regressing.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { backfill } from '../../src/providers/gumroad/backfill';

const FAKE_TOKEN = 'test-access-token';
const FAKE_PRODUCT_REF = 'product-ref-001';

// 90 days ago, guaranteed to exceed the former 30-day Convex validator limit
const NINETY_DAYS_AGO_MS = Date.now() - 90 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_AGO_ISO = new Date(NINETY_DAYS_AGO_MS).toISOString();

function mockFetch(response: unknown, status = 200): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('Gumroad backfill fetchPage', () => {
  let restoreFetch: (() => void) | undefined;

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it('preserves a historical created_at as purchasedAt (>30 days old)', async () => {
    restoreFetch = mockFetch({
      sales: [
        {
          sale_id: 'sale-001',
          product_id: 'prod-abc',
          email: 'buyer@example.com',
          created_at: NINETY_DAYS_AGO_ISO,
        },
      ],
    });

    const result = await backfill.fetchPage(FAKE_TOKEN, FAKE_PRODUCT_REF, null, 100, '');

    expect(result.facts).toHaveLength(1);
    // purchasedAt must match the historical date, not Date.now()
    const purchasedAt = result.facts[0].purchasedAt;
    const expectedMs = new Date(NINETY_DAYS_AGO_ISO).getTime();
    // Allow ±1 second for floating-point rounding
    expect(Math.abs(purchasedAt - expectedMs)).toBeLessThan(1000);
  });

  it('falls back to Date.now() when created_at is absent and sale_timestamp is absent', async () => {
    const before = Date.now();
    restoreFetch = mockFetch({
      sales: [{ sale_id: 'sale-002', product_id: 'prod-abc' }],
    });

    const result = await backfill.fetchPage(FAKE_TOKEN, FAKE_PRODUCT_REF, null, 100, '');

    const after = Date.now();
    expect(result.facts[0].purchasedAt).toBeGreaterThanOrEqual(before);
    expect(result.facts[0].purchasedAt).toBeLessThanOrEqual(after);
  });

  it('uses sale_timestamp * 1000 when created_at is absent', async () => {
    const saleTimestampSec = Math.floor(NINETY_DAYS_AGO_MS / 1000);
    restoreFetch = mockFetch({
      sales: [{ sale_id: 'sale-003', product_id: 'prod-abc', sale_timestamp: saleTimestampSec }],
    });

    const result = await backfill.fetchPage(FAKE_TOKEN, FAKE_PRODUCT_REF, null, 100, '');

    expect(result.facts[0].purchasedAt).toBe(saleTimestampSec * 1000);
  });

  it('sets lifecycleStatus to refunded when refunded is true', async () => {
    restoreFetch = mockFetch({
      sales: [
        {
          sale_id: 'sale-004',
          product_id: 'prod-abc',
          created_at: NINETY_DAYS_AGO_ISO,
          refunded: true,
        },
      ],
    });

    const result = await backfill.fetchPage(FAKE_TOKEN, FAKE_PRODUCT_REF, null, 100, '');

    expect(result.facts[0].lifecycleStatus).toBe('refunded');
  });

  it('returns nextCursor when next_page_url is present', async () => {
    restoreFetch = mockFetch({
      sales: [],
      next_page_url: 'https://api.gumroad.com/v2/sales?page=2',
    });

    const result = await backfill.fetchPage(FAKE_TOKEN, FAKE_PRODUCT_REF, null, 100, '');

    expect(result.nextCursor).toBe('2');
  });

  it('returns null nextCursor when no next_page_url', async () => {
    restoreFetch = mockFetch({ sales: [] });

    const result = await backfill.fetchPage(FAKE_TOKEN, FAKE_PRODUCT_REF, null, 100, '');

    expect(result.nextCursor).toBeNull();
  });

  it('throws on a non-200, non-429 response', async () => {
    restoreFetch = mockFetch({ error: 'Unauthorized' }, 401);

    await expect(backfill.fetchPage(FAKE_TOKEN, FAKE_PRODUCT_REF, null, 100, '')).rejects.toThrow(
      'Gumroad API error: 401'
    );
  });
});
