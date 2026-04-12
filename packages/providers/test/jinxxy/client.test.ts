import { afterEach, describe, expect, it, mock } from 'bun:test';
import { JinxxyApiClient } from '../../src/jinxxy/client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockJsonSequence(bodies: unknown[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: href, init });
    const body = bodies.shift();
    if (body === undefined) {
      throw new Error(`Unexpected fetch call for ${href}`);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe('JinxxyApiClient.verifyLicenseWithBuyerByKey', () => {
  const client = new JinxxyApiClient({
    apiKey: 'test-api-key',
    apiBaseUrl: 'https://api.creators.jinxxy.com/v1',
  });

  it('returns the purchaser email from the linked order when the license is valid', async () => {
    const calls = mockJsonSequence([
      {
        results: [{ id: 'license-1' }],
        page: 1,
        page_count: 1,
        cursor_count: 1,
      },
      {
        id: 'license-1',
        key: '11111111-2222-3333-4444-555555555555',
        short_key: 'ABCD-1234567890ab',
        user: { id: 'customer-1' },
        inventory_item: {
          target_id: 'product-1',
          order: { id: 'order-1', payment_status: 'completed' },
        },
        activations: { total_count: 0 },
      },
      {
        success: true,
        order: {
          id: 'order-1',
          customer_id: 'customer-1',
          product_id: 'product-1',
          status: 'completed',
          total: 1500,
          currency: 'USD',
          created_at: '2026-04-10T12:00:00Z',
          email: 'buyer@example.com',
          quantity: 1,
        },
      },
    ]);

    const result = await client.verifyLicenseWithBuyerByKey('11111111-2222-3333-4444-555555555555');

    expect(result).toMatchObject({
      valid: true,
      purchaserEmail: 'buyer@example.com',
      license: {
        id: 'license-1',
        order_id: 'order-1',
        customer_id: 'customer-1',
        product_id: 'product-1',
      },
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain('/licenses?key=11111111-2222-3333-4444-555555555555');
    expect(calls[1]?.url).toContain('/licenses/license-1');
    expect(calls[2]?.url).toContain('/orders/order-1');
  });

  it('falls back to the linked customer record when the order has no email', async () => {
    const calls = mockJsonSequence([
      {
        results: [{ id: 'license-2' }],
        page: 1,
        page_count: 1,
        cursor_count: 1,
      },
      {
        id: 'license-2',
        key: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        short_key: 'WXYZ-abcdef123456',
        user: { id: 'customer-2' },
        inventory_item: {
          target_id: 'product-2',
          order: { id: 'order-2', payment_status: 'completed' },
        },
        activations: { total_count: 1 },
      },
      {
        success: true,
        order: {
          id: 'order-2',
          customer_id: 'customer-2',
          product_id: 'product-2',
          status: 'completed',
          total: 2500,
          currency: 'USD',
          created_at: '2026-04-10T12:00:00Z',
          quantity: 1,
        },
      },
      {
        success: true,
        customer: {
          id: 'customer-2',
          email: 'customer@example.com',
          created_at: '2026-04-01T12:00:00Z',
        },
      },
    ]);

    const result = await client.verifyLicenseWithBuyerByKey('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    expect(result).toMatchObject({
      valid: true,
      purchaserEmail: 'customer@example.com',
      license: {
        id: 'license-2',
        order_id: 'order-2',
        customer_id: 'customer-2',
        product_id: 'product-2',
      },
    });
    expect(calls).toHaveLength(4);
    expect(calls[2]?.url).toContain('/orders/order-2');
    expect(calls[3]?.url).toContain('/customers/customer-2');
  });
});
