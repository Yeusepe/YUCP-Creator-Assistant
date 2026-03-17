import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Auth } from '../auth';

const apiMock = {
  creatorProfiles: {
    getCreatorProfile: 'creatorProfiles.getCreatorProfile',
  },
  providerConnections: {
    createProviderConnection: 'providerConnections.createProviderConnection',
    putProviderCredential: 'providerConnections.putProviderCredential',
    upsertConnectionCapability: 'providerConnections.upsertConnectionCapability',
    getConnectionForBackfill: 'providerConnections.getConnectionForBackfill',
    listConnections: 'providerConnections.listConnections',
  },
  providerPlatform: {
    getProviderConnectionAdmin: 'providerPlatform.getProviderConnectionAdmin',
    updateProviderConnectionState: 'providerPlatform.updateProviderConnectionState',
    listCatalogProductsForTenant: 'providerPlatform.listCatalogProductsForTenant',
    upsertCatalogMapping: 'providerPlatform.upsertCatalogMapping',
    listCatalogMappingsForConnection: 'providerPlatform.listCatalogMappingsForConnection',
    resolveTenantSubjectByEmailHash: 'providerPlatform.resolveTenantSubjectByEmailHash',
    upsertProviderTransaction: 'providerPlatform.upsertProviderTransaction',
    upsertProviderMembership: 'providerPlatform.upsertProviderMembership',
    upsertProviderLicense: 'providerPlatform.upsertProviderLicense',
    upsertEntitlementEvidence: 'providerPlatform.upsertEntitlementEvidence',
  },
  verificationSessions: {
    createVerificationSession: 'verificationSessions.createVerificationSession',
  },
  webhookIngestion: {
    insertWebhookEvent: 'webhookIngestion.insertWebhookEvent',
  },
  entitlements: {
    grantEntitlement: 'entitlements.grantEntitlement',
  },
} as const;

let queryImpl: (ref: unknown, args: unknown) => Promise<unknown>;
let mutationImpl: (ref: unknown, args: unknown) => Promise<unknown>;
const queryMock = mock((ref: unknown, args?: unknown) => queryImpl(ref, args));
const mutationMock = mock((ref: unknown, args?: unknown) => mutationImpl(ref, args));
const actionMock = mock(async () => undefined);
const encryptMock = mock(async (value: string) => `enc:${value}`);
const decryptMock = mock(async (value: string) =>
  value.startsWith('enc:') ? value.slice(4) : value
);
const resolveSetupSessionMock = mock(async () => null);

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: queryMock,
    mutation: mutationMock,
    action: actionMock,
  }),
}));

mock.module('../lib/encrypt', () => ({
  encrypt: encryptMock,
  decrypt: decryptMock,
}));

mock.module('../lib/setupSession', () => ({
  resolveSetupSession: resolveSetupSessionMock,
}));

const { createProviderPlatformRoutes } = await import('./providerPlatform');

function makePaginatedResponse<T>(type: string, items: Array<{ id: string; attributes: T }>) {
  return {
    data: items.map((item) => ({
      id: item.id,
      type,
      attributes: item.attributes,
    })),
    meta: {
      page: {
        currentPage: 1,
        lastPage: 1,
        perPage: items.length || 1,
        total: items.length,
      },
    },
  };
}

function makeJsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
  });
}

async function signBody(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('provider platform routes', () => {
  const originalFetch = globalThis.fetch;
  const auth = {
    getSession: async () => ({ user: { id: 'owner-user' } }),
    getDiscordUserId: async () => 'discord-owner',
  } as unknown as Auth;

  const routes = createProviderPlatformRoutes(auth, {
    apiBaseUrl: 'http://localhost:3001',
    frontendBaseUrl: 'http://localhost:3001',
    convexApiSecret: 'convex-secret',
    convexUrl: 'http://convex.invalid',
    encryptionSecret: 'encrypt-secret',
  });

  beforeEach(() => {
    queryMock.mockClear();
    mutationMock.mockClear();
    actionMock.mockClear();
    encryptMock.mockClear();
    decryptMock.mockClear();
    resolveSetupSessionMock.mockClear();

    queryImpl = async (ref, args) => {
      if (ref === apiMock.creatorProfiles.getCreatorProfile) {
        return { authUserId: 'owner-user', ownerDiscordUserId: 'discord_owner' };
      }
      if (ref === apiMock.providerPlatform.getProviderConnectionAdmin) {
        return {
          connectionId: 'conn_1',
          authUserId: 'user_abc1',
          providerKey: 'lemonsqueezy',
          provider: 'lemonsqueezy',
          webhookConfigured: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      if (ref === apiMock.providerPlatform.listCatalogProductsForTenant) {
        return [
          {
            _id: 'catalog_1',
            productId: 'local_product_1',
            provider: 'lemonsqueezy',
            providerProductRef: 'variant_1',
            status: 'active',
          },
        ];
      }
      if (ref === apiMock.providerPlatform.listCatalogMappingsForConnection) {
        return [
          {
            catalogProductId: 'catalog_1',
            localProductId: 'local_product_1',
            externalVariantId: 'variant_1',
            externalProductId: 'product_1',
          },
        ];
      }
      if (ref === apiMock.providerConnections.getConnectionForBackfill) {
        return {
          credentials: { api_token: 'enc:api-token' },
          webhookSecretRef: 'enc:webhook-secret',
        };
      }
      if (ref === apiMock.providerConnections.listConnections) {
        return {
          connections: [
            {
              id: 'conn_1',
              provider: 'lemonsqueezy',
              providerKey: 'lemonsqueezy',
            },
          ],
        };
      }
      if (ref === apiMock.providerPlatform.resolveTenantSubjectByEmailHash) {
        return 'subject_1';
      }
      throw new Error(`Unhandled query ${String(ref)} ${JSON.stringify(args)}`);
    };

    mutationImpl = async (ref) => {
      switch (ref) {
        case apiMock.providerConnections.createProviderConnection:
          return 'conn_1';
        case apiMock.providerConnections.putProviderCredential:
          return 'credential_1';
        case apiMock.providerConnections.upsertConnectionCapability:
          return 'capability_1';
        case apiMock.providerPlatform.updateProviderConnectionState:
          return 'conn_1';
        case apiMock.providerPlatform.upsertCatalogMapping:
          return 'mapping_1';
        case apiMock.providerPlatform.upsertProviderTransaction:
          return 'transaction_1';
        case apiMock.providerPlatform.upsertProviderMembership:
          return 'membership_1';
        case apiMock.providerPlatform.upsertProviderLicense:
          return 'license_1';
        case apiMock.providerPlatform.upsertEntitlementEvidence:
          return 'evidence_1';
        case apiMock.verificationSessions.createVerificationSession:
          return { sessionId: 'verification_1', expiresAt: 1_700_000_000_000 };
        case apiMock.webhookIngestion.insertWebhookEvent:
          return { duplicate: false };
        case apiMock.entitlements.grantEntitlement:
          return { success: true, entitlementId: 'entitlement_1' };
        default:
          throw new Error(`Unhandled mutation ${String(ref)}`);
      }
    };

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/stores?')) {
        return makeJsonResponse(
          makePaginatedResponse('stores', [
            {
              id: 'store_1',
              attributes: { name: 'Primary Store', slug: 'primary-store', test_mode: true },
            },
          ])
        );
      }
      if (url.includes('/products?')) {
        return makeJsonResponse(
          makePaginatedResponse('products', [
            {
              id: 'product_1',
              attributes: { store_id: 1, name: 'Starter Pack' },
            },
          ])
        );
      }
      if (url.includes('/variants?')) {
        return makeJsonResponse(
          makePaginatedResponse('variants', [
            {
              id: 'variant_1',
              attributes: { product_id: 1, name: 'Default', has_license_keys: true },
            },
          ])
        );
      }
      if (url.includes('/orders?')) {
        return makeJsonResponse(
          makePaginatedResponse('orders', [
            {
              id: 'order_1',
              attributes: {
                store_id: 1,
                customer_id: 2,
                user_email: 'buyer@example.com',
                currency: 'USD',
                subtotal: 1000,
                total: 1200,
                status: 'paid',
                created_at: '2026-03-11T00:00:00.000Z',
                updated_at: '2026-03-11T00:00:00.000Z',
                first_order_item: { id: 10, productId: 1, variantId: 1 },
              },
            },
          ])
        );
      }
      if (url.includes('/subscriptions?')) {
        return makeJsonResponse(
          makePaginatedResponse('subscriptions', [
            {
              id: 'subscription_1',
              attributes: {
                order_id: 100,
                customer_id: 2,
                product_id: 1,
                variant_id: 1,
                status: 'active',
                user_email: 'buyer@example.com',
                created_at: '2026-03-11T00:00:00.000Z',
                updated_at: '2026-03-11T00:00:00.000Z',
              },
            },
          ])
        );
      }
      if (url.includes('/license-keys?')) {
        return makeJsonResponse(
          makePaginatedResponse('license-keys', [
            {
              id: 'license_1',
              attributes: {
                order_id: 100,
                customer_id: 2,
                product_id: 1,
                variant_id: 1,
                user_email: 'buyer@example.com',
                key: 'LIC-123',
                key_short: '123',
                created_at: '2026-03-11T00:00:00.000Z',
              },
            },
          ])
        );
      }
      if (url.endsWith('/webhooks') && init?.method === 'POST') {
        return makeJsonResponse({
          data: {
            id: 'webhook_1',
            type: 'webhooks',
            attributes: {
              store_id: 1,
              url: 'http://localhost:3001/v1/webhooks/lemonsqueezy/conn_1',
              events: ['order_created'],
              secret: 'webhook-secret',
              test_mode: true,
            },
          },
        });
      }
      throw new Error(`Unhandled fetch ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates provider connections and replays idempotent requests', async () => {
    const request = new Request('http://localhost:3001/v1/tenants/tenant_1/provider-connections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-create-1',
      },
      body: JSON.stringify({
        providerKey: 'lemonsqueezy',
        authMode: 'api_token',
      }),
    });

    const first = await routes.handleRequest(request);
    const second = await routes.handleRequest(request);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.status).toBe(201);
    expect(second?.headers.get('Idempotency-Replayed')).toBe('true');

    const payload = (await first?.json()) as { connectionId: string };
    expect(payload.connectionId).toBe('conn_1');
    expect(
      mutationMock.mock.calls.filter(
        (call) => call[0] === apiMock.providerConnections.createProviderConnection
      )
    ).toHaveLength(1);
  });

  it('submits Lemon Squeezy credentials, creates a managed webhook, and syncs catalog data', async () => {
    const response = await routes.handleRequest(
      new Request('http://localhost:3001/v1/provider-connections/conn_1/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: 'live-token' }),
      })
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    const payload = (await response?.json()) as {
      success: boolean;
      store: { id: string; name: string };
      sync: { productsSynced: number; variantsSynced: number };
    };
    expect(payload.success).toBe(true);
    expect(payload.store.id).toBe('store_1');
    expect(payload.sync).toEqual({ productsSynced: 1, variantsSynced: 1 });
    expect(encryptMock.mock.calls).not.toHaveLength(0);
    expect(
      mutationMock.mock.calls.some(
        (call) => call[0] === apiMock.providerPlatform.upsertCatalogMapping
      )
    ).toBe(true);
    expect(
      mutationMock.mock.calls.some(
        (call) => call[0] === apiMock.providerPlatform.updateProviderConnectionState
      )
    ).toBe(true);
  });

  it('creates verification sessions for the canonical /v1 flow', async () => {
    const response = await routes.handleRequest(
      new Request('http://localhost:3001/v1/verification-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authUserId: 'user_abc1',
          providerKey: 'lemonsqueezy',
          verificationMethod: 'license_key',
        }),
      })
    );

    expect(response?.status).toBe(201);
    const payload = (await response?.json()) as { sessionId: string; state: string };
    expect(payload.sessionId).toBe('verification_1');
    expect(payload.state).toBeString();
    expect(
      mutationMock.mock.calls.some(
        (call) => call[0] === apiMock.verificationSessions.createVerificationSession
      )
    ).toBe(true);
  });

  it('runs reconciliation jobs and persists canonical Lemon records', async () => {
    queryImpl = async (ref, args) => {
      if (ref === apiMock.creatorProfiles.getCreatorProfile)
        return { authUserId: 'owner-user', ownerDiscordUserId: 'discord_owner' };
      if (ref === apiMock.providerPlatform.getProviderConnectionAdmin) {
        return {
          connectionId: 'conn_1',
          authUserId: 'user_abc1',
          providerKey: 'lemonsqueezy',
          provider: 'lemonsqueezy',
          externalShopId: 'store_1',
          webhookConfigured: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      if (ref === apiMock.providerConnections.getConnectionForBackfill)
        return { credentials: { api_token: 'enc:api-token' } };
      if (ref === apiMock.providerPlatform.listCatalogMappingsForConnection) {
        return [
          {
            catalogProductId: 'catalog_1',
            localProductId: 'local_product_1',
            externalVariantId: '1',
            externalProductId: '1',
          },
        ];
      }
      if (ref === apiMock.providerPlatform.listCatalogProductsForTenant) {
        return [
          {
            _id: 'catalog_1',
            productId: 'local_product_1',
            provider: 'lemonsqueezy',
            providerProductRef: '1',
            status: 'active',
          },
        ];
      }
      if (ref === apiMock.providerPlatform.resolveTenantSubjectByEmailHash) return 'subject_1';
      throw new Error(`Unhandled query ${String(ref)} ${JSON.stringify(args)}`);
    };

    const response = await routes.handleRequest(
      new Request('http://localhost:3001/v1/provider-connections/conn_1/reconciliation-jobs', {
        method: 'POST',
      })
    );

    expect(response?.status).toBe(202);
    const payload = (await response?.json()) as {
      success: boolean;
      stats: { orders: number; subscriptions: number; licenseKeys: number };
    };
    expect(payload.success).toBe(true);
    expect(payload.stats).toEqual({ orders: 1, subscriptions: 1, licenseKeys: 1 });
    expect(
      mutationMock.mock.calls.some(
        (call) => call[0] === apiMock.providerPlatform.upsertProviderTransaction
      )
    ).toBe(true);
    expect(
      mutationMock.mock.calls.some(
        (call) => call[0] === apiMock.providerPlatform.upsertProviderMembership
      )
    ).toBe(true);
    expect(
      mutationMock.mock.calls.some(
        (call) => call[0] === apiMock.providerPlatform.upsertProviderLicense
      )
    ).toBe(true);
    expect(
      mutationMock.mock.calls.some((call) => call[0] === apiMock.entitlements.grantEntitlement)
    ).toBe(true);
  });

  it('accepts signed Lemon webhooks through the canonical endpoint', async () => {
    queryImpl = async (ref) => {
      if (ref === apiMock.providerPlatform.getProviderConnectionAdmin) {
        return {
          connectionId: 'conn_1',
          authUserId: 'user_abc1',
          providerKey: 'lemonsqueezy',
          provider: 'lemonsqueezy',
          remoteWebhookSecretRef: 'enc:webhook-secret',
          webhookConfigured: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      if (ref === apiMock.providerConnections.getConnectionForBackfill) {
        return { webhookSecretEncrypted: 'enc:webhook-secret' };
      }
      throw new Error(`Unhandled query ${String(ref)}`);
    };

    const body = JSON.stringify({
      meta: { event_name: 'order_created' },
      data: { id: 'order_123', type: 'orders', attributes: { user_email: 'buyer@example.com' } },
    });
    const signature = await signBody('webhook-secret', body);
    const response = await routes.handleRequest(
      new Request('http://localhost:3001/v1/webhooks/lemonsqueezy/conn_1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body,
      })
    );

    expect(response?.status).toBe(202);
    const payload = (await response?.json()) as { success: boolean; duplicate: boolean };
    expect(payload).toEqual({ success: true, duplicate: false });
    expect(
      mutationMock.mock.calls.some(
        (call) => call[0] === apiMock.webhookIngestion.insertWebhookEvent
      )
    ).toBe(true);
  });

  describe('GET /api/providers', () => {
    it('returns 200 with a JSON array', async () => {
      const response = await routes.handleRequest(
        new Request('http://localhost:3001/api/providers', { method: 'GET' })
      );
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as unknown[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
    });

    it('includes every provider that has a dashboardConnectPath', async () => {
      const { ALL_PROVIDERS } = await import('../providers/index');
      const expected = ALL_PROVIDERS.filter((p) => p.displayMeta?.dashboardConnectPath).map(
        (p) => p.id
      );

      const response = await routes.handleRequest(
        new Request('http://localhost:3001/api/providers', { method: 'GET' })
      );
      const body = (await response?.json()) as Array<{ key: string }>;
      const returned = body.map((p) => p.key);

      expect(returned.sort()).toEqual(expected.sort());
    });

    it('each provider entry has the required dashboard fields', async () => {
      const response = await routes.handleRequest(
        new Request('http://localhost:3001/api/providers', { method: 'GET' })
      );
      const body = (await response?.json()) as Array<Record<string, unknown>>;

      const REQUIRED = [
        'key',
        'label',
        'icon',
        'iconBg',
        'quickStartBg',
        'quickStartBorder',
        'serverTileHint',
        'connectPath',
        'connectParamStyle',
      ] as const;

      for (const provider of body) {
        for (const field of REQUIRED) {
          expect(provider[field], `${provider.key}.${field} must be present`).toBeTruthy();
        }
      }
    });
  });
});
