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

  it('returns the purchaser email and tier ref from documented license and order responses', async () => {
    const calls = mockJsonSequence([
      {
        results: [
          {
            id: 'license-1',
            object: 'UserLicense',
            user: { id: 'customer-1' },
            short_key: 'ABCD-1234567890ab',
          },
        ],
        page: 1,
        page_count: 1,
        cursor_count: 1,
      },
      {
        id: 'license-1',
        object: 'UserLicense',
        key: '11111111-2222-3333-4444-555555555555',
        short_key: 'ABCD-1234567890ab',
        user: {
          id: 'customer-1',
          object: 'User',
          name: 'Buyer Example',
          username: 'buyer-example',
          profile_image: null,
          updated_at: '2026-04-09T12:00:00Z',
        },
        inventory_item: {
          id: 'inventory-1',
          object: 'InventoryItem',
          target_id: 'product-1',
          target_version_id: 'version-advanced',
          target_type: 'DIGITAL_PRODUCT',
          grant_id: 'order-item-1',
          grant_type: 'ORDER_ITEM',
          item: {
            id: 'product-1',
            object: 'PurchasedProduct',
            name: 'Creator Pack',
            version: {
              id: 'version-advanced',
              object: 'Version',
              name: 'Advanced',
            },
          },
          order: { id: 'order-1', object: 'Order', payment_status: 'PAID' },
        },
        activations: { total_count: 0 },
      },
      {
        id: 'order-1',
        object: 'Order',
        email: 'buyer@example.com',
        paid_at: '2026-04-10T12:00:00Z',
        user: {
          id: 'customer-1',
          object: 'User',
          name: 'Buyer Example',
          username: 'buyer-example',
          profile_image: null,
          updated_at: '2026-04-09T12:00:00Z',
        },
        payment_status: 'PAID',
        payout_total: 1500,
        checkout_fields: [],
        order_items: [
          {
            id: 'order-item-1',
            object: 'OrderItem',
            name: 'Creator Pack',
            target_id: 'product-1',
            target_type: 'DIGITAL_PRODUCT',
            target_version_id: 'version-advanced',
            seller: {
              id: 'seller-1',
              object: 'User',
              name: 'Creator',
              username: 'creator',
              profile_image: null,
              updated_at: '2026-04-09T12:00:00Z',
            },
            license_id: 'license-1',
            license: {
              id: 'license-1',
              object: 'UserLicense',
              key: '11111111-2222-3333-4444-555555555555',
              short_key: 'ABCD-1234567890ab',
            },
          },
        ],
      },
    ]);

    const result = await client.verifyLicenseWithBuyerByKey('11111111-2222-3333-4444-555555555555');

    expect(result).toMatchObject({
      valid: true,
      purchaserEmail: 'buyer@example.com',
      externalLicenseId: 'license-1',
      providerTierRef: 'version-advanced',
      license: {
        id: 'license-1',
        order_id: 'order-1',
        customer_id: 'customer-1',
        product_id: 'product-1',
        product_version_id: 'version-advanced',
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

describe('JinxxyApiClient.getOrders', () => {
  const client = new JinxxyApiClient({
    apiKey: 'test-api-key',
    apiBaseUrl: 'https://api.creators.jinxxy.com/v1',
  });

  it('normalizes the documented paginated orders response', async () => {
    const calls = mockJsonSequence([
      {
        page: 1,
        cursor_count: 1,
        page_count: 1,
        results: [
          {
            id: 'order-1',
            object: 'Order',
            email: 'buyer@example.com',
            paid_at: '2026-04-10T12:00:00Z',
            user: {
              id: 'customer-1',
              object: 'User',
              name: 'Buyer Example',
              username: 'buyer-example',
              profile_image: null,
              updated_at: '2026-04-09T12:00:00Z',
            },
            payment_status: 'PAID',
            payout_total: 1500,
          },
        ],
      },
    ]);

    const { orders, pagination } = await client.getOrders({ page: 1, per_page: 5 });

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: 'order-1',
      email: 'buyer@example.com',
      user: { id: 'customer-1' },
      payment_status: 'PAID',
      payout_total: 1500,
    });
    expect(pagination).toMatchObject({
      page: 1,
      total: 1,
      total_pages: 1,
      has_next: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/orders?page=1&limit=5');
  });
});
