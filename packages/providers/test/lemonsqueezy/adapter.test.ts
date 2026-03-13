import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
  LemonSqueezyLicenseKey,
  LemonSqueezyOrder,
  LemonSqueezySubscription,
} from '../../src/lemonsqueezy';
import {
  isLicenseKeyValid,
  isOrderValid,
  isSubscriptionActive,
  LemonSqueezyAdapter,
  LemonSqueezyApiClient,
  LemonSqueezyApiError,
  LemonSqueezyRateLimitError,
  normalizeLicenseKeyToEvidence,
  normalizeOrderToEvidence,
  normalizeSubscriptionToEvidence,
} from '../../src/lemonsqueezy';

const testConfig = {
  apiToken: 'ls_test_token_123',
  apiBaseUrl: 'https://test-api.lemonsqueezy.com/v1',
  licenseApiBaseUrl: 'https://test-api.lemonsqueezy.com/v1/licenses',
  timeout: 5000,
  maxRetries: 1,
};

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

describe('LemonSqueezyApiClient', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates client from environment', () => {
    const originalEnv = process.env.LEMONSQUEEZY_API_TOKEN;
    process.env.LEMONSQUEEZY_API_TOKEN = 'env-token';
    expect(LemonSqueezyApiClient.fromEnv()).toBeDefined();
    process.env.LEMONSQUEEZY_API_TOKEN = originalEnv;
  });

  it('throws when env token is missing', () => {
    const originalEnv = process.env.LEMONSQUEEZY_API_TOKEN;
    process.env.LEMONSQUEEZY_API_TOKEN = '';
    expect(() => LemonSqueezyApiClient.fromEnv()).toThrow('LEMONSQUEEZY_API_TOKEN');
    process.env.LEMONSQUEEZY_API_TOKEN = originalEnv;
  });

  it('lists stores with bearer auth and JSON:API headers', async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/stores');
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${testConfig.apiToken}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      });

      return jsonResponse({
        data: [
          {
            id: '1',
            type: 'stores',
            attributes: {
              name: 'Main Store',
              slug: 'main-store',
              test_mode: true,
            },
          },
        ],
        meta: {
          page: {
            currentPage: 1,
            lastPage: 1,
            perPage: 50,
            total: 1,
          },
        },
      });
    }) as unknown as typeof fetch;

    const client = new LemonSqueezyApiClient(testConfig);
    const result = await client.getStores();
    expect(result.stores[0]).toMatchObject({
      id: '1',
      name: 'Main Store',
      slug: 'main-store',
      testMode: true,
    });
  });

  it('sends store filter when listing products', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('filter[store_id]')).toBe('42');
      return jsonResponse({
        data: [],
        meta: {
          page: {
            currentPage: 1,
            lastPage: 1,
            perPage: 50,
            total: 0,
          },
        },
      });
    }) as unknown as typeof fetch;

    const client = new LemonSqueezyApiClient(testConfig);
    const result = await client.getProducts({ storeId: '42' });
    expect(result.products).toEqual([]);
  });

  it('creates webhook with JSON:API relationship payload', async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.data.type).toBe('webhooks');
      expect(body.data.relationships.store.data.id).toBe('88');
      expect(body.data.attributes.events).toEqual(['order_created']);
      expect(body.data.attributes.secret).toBe('whsec_123');

      return jsonResponse({
        data: {
          id: '501',
          type: 'webhooks',
          attributes: {
            url: 'https://example.com/webhook',
            events: ['order_created'],
            secret: 'whsec_123',
            test_mode: false,
          },
        },
      });
    }) as unknown as typeof fetch;

    const client = new LemonSqueezyApiClient(testConfig);
    const webhook = await client.createWebhook({
      storeId: '88',
      url: 'https://example.com/webhook',
      events: ['order_created'],
      secret: 'whsec_123',
    });

    expect(webhook.id).toBe('501');
    expect(webhook.events).toEqual(['order_created']);
  });

  it('validates license key through the license endpoint', async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${testConfig.licenseApiBaseUrl}/validate`);
      expect(init?.headers).toMatchObject({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });

      return jsonResponse({
        valid: true,
        license_key: {
          id: 99,
          key: 'lic_123',
          status: 'active',
        },
        meta: {
          user_email: 'buyer@example.com',
          variant_id: 444,
        },
      });
    }) as unknown as typeof fetch;

    const client = new LemonSqueezyApiClient(testConfig);
    const result = await client.validateLicenseKey('lic_123');
    expect(result.valid).toBe(true);
    expect(result.meta?.user_email).toBe('buyer@example.com');
  });

  it('throws rate limit error after retries are exhausted', async () => {
    globalThis.fetch = (async () => {
      return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
    }) as unknown as typeof fetch;

    const client = new LemonSqueezyApiClient(testConfig);
    await expect(client.getStores()).rejects.toBeInstanceOf(LemonSqueezyRateLimitError);
  });
});

describe('LemonSqueezyAdapter', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('requires an API token', () => {
    expect(() => new LemonSqueezyAdapter({ ...testConfig, apiToken: '' })).toThrow(
      'API token is required'
    );
  });

  it('verifies purchases by email using active orders', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/orders')) {
        return jsonResponse({
          data: [
            {
              id: '777',
              type: 'orders',
              attributes: {
                user_email: 'buyer@example.com',
                refunded: false,
                status: 'paid',
                created_at: '2025-01-01T00:00:00Z',
                first_order_item: {
                  variantId: 12,
                },
              },
            },
          ],
          meta: {
            page: {
              currentPage: 1,
              lastPage: 1,
              perPage: 25,
              total: 1,
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const adapter = new LemonSqueezyAdapter(testConfig);
    const result = await adapter.verifyPurchase('buyer@example.com');
    expect(result?.provider).toBe('lemonsqueezy');
    expect(result?.id).toBe('lemonsqueezy-777');
  });

  it('returns null for non-email purchase lookups', async () => {
    const adapter = new LemonSqueezyAdapter(testConfig);
    expect(await adapter.verifyPurchase('not-an-email')).toBeNull();
  });

  it('maps validated licenses into adapter-level results', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/validate')) {
        return jsonResponse({
          valid: true,
          license_key: {
            id: 100,
            key: 'lic_abc',
            status: 'active',
            activation_limit: 3,
            instances_count: 1,
          },
          meta: {
            user_email: 'buyer@example.com',
            user_name: 'Buyer',
            variant_id: 55,
            subscription_id: 12,
            test_mode: true,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const adapter = new LemonSqueezyAdapter(testConfig);
    const result = await adapter.validateLicense('lic_abc');
    expect(result.valid).toBe(true);
    expect(result.license?.variantId).toBe(55);
    expect(result.customerEmail).toBe('buyer@example.com');
    expect(result.subscriptionId).toBe('12');
  });
});

describe('Lemon normalization helpers', () => {
  const order: LemonSqueezyOrder = {
    id: 'ord_1',
    customerId: 'cust_1',
    userEmail: 'buyer@example.com',
    refunded: false,
    status: 'paid',
    createdAt: '2025-01-01T00:00:00Z',
    firstOrderItem: {
      variantId: 11,
    },
  };

  const subscription: LemonSqueezySubscription = {
    id: 'sub_1',
    customerId: 'cust_1',
    userEmail: 'buyer@example.com',
    status: 'active',
    variantId: 22,
    createdAt: '2025-01-01T00:00:00Z',
  };

  const license: LemonSqueezyLicenseKey = {
    id: 'lic_1',
    customerId: 'cust_1',
    userEmail: 'buyer@example.com',
    key: 'lic_key',
    status: 'active',
    variantId: 33,
    disabled: false,
    createdAt: '2025-01-01T00:00:00Z',
  };

  it('normalizes orders, subscriptions, and licenses to evidence', () => {
    expect(normalizeOrderToEvidence(order)).toMatchObject({
      provider: 'lemonsqueezy',
      evidenceType: 'purchase',
      providerAccountRef: 'cust_1',
    });
    expect(normalizeSubscriptionToEvidence(subscription)).toMatchObject({
      provider: 'lemonsqueezy',
      evidenceType: 'subscription',
    });
    expect(normalizeLicenseKeyToEvidence(license)).toMatchObject({
      provider: 'lemonsqueezy',
      evidenceType: 'license',
      licenseKey: 'lic_key',
    });
  });

  it('evaluates validity helpers correctly', () => {
    expect(isOrderValid(order)).toBe(true);
    expect(isSubscriptionActive(subscription)).toBe(true);
    expect(isLicenseKeyValid(license)).toBe(true);

    expect(isOrderValid({ ...order, refunded: true })).toBe(false);
    expect(isSubscriptionActive({ ...subscription, status: 'expired' })).toBe(false);
    expect(isLicenseKeyValid({ ...license, disabled: true })).toBe(false);
  });

  it('preserves structured error types', () => {
    const error = new LemonSqueezyApiError('Nope', 404, { reason: 'missing' });
    expect(error.statusCode).toBe(404);
    expect(error.details).toEqual({ reason: 'missing' });
  });
});
