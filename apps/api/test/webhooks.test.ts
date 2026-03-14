/**
 * Webhook security regression tests.
 *
 * Source URLs:
 *   - Gumroad Ping: https://gumroad.com/ping
 *   - Lemon Squeezy signing requests: https://docs.lemonsqueezy.com/help/webhooks/signing-requests
 *   - Lemon Squeezy webhook requests: https://docs.lemonsqueezy.com/help/webhooks/webhook-requests
 *   - Payhip webhooks: https://help.payhip.com/article/115-webhooks
 *
 * Jinxxy's signing contract is exercised against the production handler in
 * apps/api/src/providers/jinxxy/webhook.ts; no public provider doc is checked into this repo.
 */

import { describe, expect, it } from 'bun:test';
import { encrypt } from '../src/lib/encrypt';
import { type FakeConvexOptions, startFakeConvexServer } from './helpers/fakeConvex';
import { startTestServer, type TestServerHandle } from './helpers/testServer';
import {
  gumroadSalePayload,
  jinxxyOrderPayload,
  lemonSqueezyOrderPayload,
  payhipPaidPayload,
  signJinxxy,
  signLemonSqueezy,
} from './helpers/webhookSignatures';

const ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!!';
const JINXXY_WEBHOOK_SECRET_PURPOSE = 'jinxxy-webhook-signing-secret' as const;
const PAYHIP_CREDENTIAL_PURPOSE = 'payhip-api-key' as const;
const LEMONSQUEEZY_WEBHOOK_SECRET_PURPOSE = 'lemonsqueezy-webhook-secret' as const;

const refs = {
  getConnectionByWebhookRouteToken: 'providerConnections:getConnectionByWebhookRouteToken',
  getConnectionForBackfill: 'providerConnections:getConnectionForBackfill',
  getJinxxyWebhookSecretByRouteId: 'providerConnections:getJinxxyWebhookSecretByRouteId',
  getPayhipApiKeyByRouteId: 'providerConnections:getPayhipApiKeyByRouteId',
  getProviderConnectionAdmin: 'providerPlatform:getProviderConnectionAdmin',
  insertWebhookEvent: 'webhookIngestion:insertWebhookEvent',
  markPayhipWebhookConfigured: 'providerConnections:markPayhipWebhookConfigured',
  resolveWebhookTenantIds: 'webhookIngestion:resolveWebhookTenantIds',
  updateProviderConnectionState: 'providerPlatform:updateProviderConnectionState',
} as const;

interface StoredWebhookEvent {
  authUserId: string;
  provider: string;
  providerEventId: string;
  eventType: string;
}

function createWebhookStore() {
  const events = new Map<string, StoredWebhookEvent>();

  return {
    size() {
      return events.size;
    },
    insert(args: Record<string, unknown>) {
      const record: StoredWebhookEvent = {
        authUserId: String(args.authUserId ?? ''),
        provider: String(args.provider ?? ''),
        providerEventId: String(args.providerEventId ?? ''),
        eventType: String(args.eventType ?? ''),
      };
      const key = `${record.authUserId}:${record.provider}:${record.providerEventId}`;
      const duplicate = events.has(key);
      if (!duplicate) {
        events.set(key, record);
      }
      return {
        success: true,
        duplicate,
        ...(duplicate ? {} : { eventId: `event_${events.size}` }),
      };
    },
  };
}

async function withWebhookHarness(
  convexOptions: FakeConvexOptions,
  run: (ctx: {
    convex: ReturnType<typeof startFakeConvexServer>;
    server: TestServerHandle;
  }) => Promise<void>
): Promise<void> {
  const convex = startFakeConvexServer(convexOptions);
  const server = await startTestServer({
    convexUrl: convex.url,
    encryptionSecret: ENCRYPTION_SECRET,
  });

  try {
    await run({ convex, server });
  } finally {
    server.stop();
    convex.stop();
  }
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function oversizedJsonBody(bytes = 270_000): string {
  return JSON.stringify({
    event_id: 'evt_boundary_001',
    event_type: 'order.completed',
    padding: 'x'.repeat(bytes),
  });
}

describe('Webhook routing', () => {
  it('returns 404 for unknown webhook providers', async () => {
    await withWebhookHarness({}, async ({ server }) => {
      const res = await server.fetch('/webhooks/unknownprovider/some-route-id', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for incomplete jinxxy-collab webhook paths', async () => {
    await withWebhookHarness({}, async ({ server }) => {
      const res = await server.fetch('/webhooks/jinxxy-collab/owner-only', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(404);
    });
  });
});

describe('Gumroad webhook security', () => {
  it('rejects stale sale timestamps before any Convex call or event write', async () => {
    const store = createWebhookStore();

    await withWebhookHarness(
      {
        query: {
          [refs.getConnectionForBackfill]: () => ({ webhookSecretEncrypted: null }),
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const body = gumroadSalePayload({
          saleId: 'sale_replay_test',
          saleTimestamp: minutesAgo(10),
        });

        const res = await server.fetch('/webhooks/gumroad/creator-route', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        expect(res.status).toBe(403);
        expect(store.size()).toBe(0);
        expect(convex.getCalls()).toHaveLength(0);
      }
    );
  });

  it('treats an unknown routeId as unauthentic and does not insert an event', async () => {
    const store = createWebhookStore();

    await withWebhookHarness(
      {
        query: {
          [refs.getConnectionByWebhookRouteToken]: () => null,
          [refs.getConnectionForBackfill]: () => null,
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const body = gumroadSalePayload({ saleId: 'sale_auth_fail_001' });

        const res = await server.fetch('/webhooks/gumroad/unknown-route', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        expect(res.status).toBe(403);
        expect(store.size()).toBe(0);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(0);
      }
    );
  });

  it('deduplicates replayed valid events without creating a second stored event', async () => {
    const store = createWebhookStore();

    await withWebhookHarness(
      {
        query: {
          [refs.getConnectionByWebhookRouteToken]: () => null,
          [refs.getConnectionForBackfill]: () => ({ gumroadAccessTokenEncrypted: null }),
          [refs.resolveWebhookTenantIds]: () => [],
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const body = gumroadSalePayload({ saleId: 'sale_duplicate_001' }).toString();
        const init: RequestInit = {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        };

        const first = await server.fetch('/webhooks/gumroad/creator-route', init);
        const second = await server.fetch('/webhooks/gumroad/creator-route', init);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(store.size()).toBe(1);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(2);
      }
    );
  });
});

describe('Jinxxy webhook security', () => {
  it('rejects invalid signatures without storing events', async () => {
    const store = createWebhookStore();
    const secretRef = await encrypt(
      'jinxxy-secret',
      ENCRYPTION_SECRET,
      JINXXY_WEBHOOK_SECRET_PURPOSE
    );

    await withWebhookHarness(
      {
        query: {
          [refs.getJinxxyWebhookSecretByRouteId]: () => secretRef,
          [refs.resolveWebhookTenantIds]: () => ['creator_jinxxy'],
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const body = jinxxyOrderPayload({ eventId: 'evt_bad_sig_001' });

        const res = await server.fetch('/webhooks/jinxxy/creator-route', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': 'deadbeef'.repeat(8),
          },
          body,
        });

        expect(res.status).toBe(403);
        expect(store.size()).toBe(0);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(0);
      }
    );
  });

  it('rejects authenticated malformed JSON without DB writes', async () => {
    const store = createWebhookStore();
    const secret = 'jinxxy-secret';
    const secretRef = await encrypt(secret, ENCRYPTION_SECRET, JINXXY_WEBHOOK_SECRET_PURPOSE);
    const body = '{"event_id":"evt_malformed_001"';
    const signature = await signJinxxy(secret, body);

    await withWebhookHarness(
      {
        query: {
          [refs.getJinxxyWebhookSecretByRouteId]: () => secretRef,
          [refs.resolveWebhookTenantIds]: () => ['creator_jinxxy'],
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const res = await server.fetch('/webhooks/jinxxy/creator-route', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': signature,
          },
          body,
        });

        expect(res.status).toBe(400);
        expect(store.size()).toBe(0);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(0);
      }
    );
  });

  it('rejects replayed stale signed events before webhook ingestion', async () => {
    const store = createWebhookStore();
    const secret = 'jinxxy-secret';
    const secretRef = await encrypt(secret, ENCRYPTION_SECRET, JINXXY_WEBHOOK_SECRET_PURPOSE);
    const body = jinxxyOrderPayload({
      eventId: 'evt_stale_001',
      createdAt: minutesAgo(10),
    });
    const signature = await signJinxxy(secret, body);

    await withWebhookHarness(
      {
        query: {
          [refs.getJinxxyWebhookSecretByRouteId]: () => secretRef,
          [refs.resolveWebhookTenantIds]: () => ['creator_jinxxy'],
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const res = await server.fetch('/webhooks/jinxxy/creator-route', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': signature,
          },
          body,
        });

        expect(res.status).toBe(403);
        expect(store.size()).toBe(0);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(0);
      }
    );
  });

  it('deduplicates concurrent valid deliveries', async () => {
    const store = createWebhookStore();
    const secret = 'jinxxy-secret';
    const secretRef = await encrypt(secret, ENCRYPTION_SECRET, JINXXY_WEBHOOK_SECRET_PURPOSE);
    const body = jinxxyOrderPayload({ eventId: 'evt_duplicate_001' });
    const signature = await signJinxxy(secret, body);

    await withWebhookHarness(
      {
        query: {
          [refs.getJinxxyWebhookSecretByRouteId]: () => secretRef,
          [refs.resolveWebhookTenantIds]: () => ['creator_jinxxy'],
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const init: RequestInit = {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': signature,
          },
          body,
        };

        const [first, second] = await Promise.all([
          server.fetch('/webhooks/jinxxy/creator-route', init),
          server.fetch('/webhooks/jinxxy/creator-route', init),
        ]);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(store.size()).toBe(1);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(2);
      }
    );
  });

  it('rejects oversized webhook bodies before any secret lookup or write', async () => {
    const store = createWebhookStore();
    const secret = 'jinxxy-secret';
    const body = oversizedJsonBody();
    const signature = await signJinxxy(secret, body);

    await withWebhookHarness(
      {
        query: {
          [refs.getJinxxyWebhookSecretByRouteId]: async () => {
            throw new Error('should not be called');
          },
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const res = await server.fetch('/webhooks/jinxxy/creator-route', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': signature,
          },
          body,
        });

        expect(res.status).toBe(413);
        expect(store.size()).toBe(0);
        expect(convex.getCalls()).toHaveLength(0);
      }
    );
  });
});

describe('Payhip webhook security', () => {
  it('rejects invalid signatures without event writes or webhook side effects', async () => {
    const store = createWebhookStore();
    const apiKeyRef = await encrypt(
      'real-payhip-api-key',
      ENCRYPTION_SECRET,
      PAYHIP_CREDENTIAL_PURPOSE
    );

    await withWebhookHarness(
      {
        query: {
          [refs.getPayhipApiKeyByRouteId]: () => apiKeyRef,
          [refs.resolveWebhookTenantIds]: () => ['creator_payhip'],
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
          [refs.markPayhipWebhookConfigured]: () => 'ok',
        },
      },
      async ({ convex, server }) => {
        const res = await server.fetch('/webhooks/payhip/creator-route', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'txn_bad_sig_001',
            type: 'paid',
            signature: 'deadbeef'.repeat(8),
            created_at: new Date().toISOString(),
          }),
        });

        expect(res.status).toBe(403);
        expect(store.size()).toBe(0);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(0);
        expect(convex.getCalls(refs.markPayhipWebhookConfigured)).toHaveLength(0);
      }
    );
  });

  it('rejects malformed JSON before any Convex lookup', async () => {
    const store = createWebhookStore();

    await withWebhookHarness(
      {
        query: {
          [refs.getPayhipApiKeyByRouteId]: async () => {
            throw new Error('should not be called');
          },
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const res = await server.fetch('/webhooks/payhip/creator-route', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{ not json',
        });

        expect(res.status).toBe(400);
        expect(store.size()).toBe(0);
        expect(convex.getCalls()).toHaveLength(0);
      }
    );
  });

  it('rejects stale signed webhooks without storing an event', async () => {
    const store = createWebhookStore();
    const apiKey = 'payhip-api-key';
    const apiKeyRef = await encrypt(apiKey, ENCRYPTION_SECRET, PAYHIP_CREDENTIAL_PURPOSE);
    const body = await payhipPaidPayload({
      transactionId: 'txn_stale_001',
      apiKey,
      createdAt: minutesAgo(10),
    });

    await withWebhookHarness(
      {
        query: {
          [refs.getPayhipApiKeyByRouteId]: () => apiKeyRef,
          [refs.resolveWebhookTenantIds]: () => ['creator_payhip'],
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
          [refs.markPayhipWebhookConfigured]: () => 'ok',
        },
      },
      async ({ convex, server }) => {
        const res = await server.fetch('/webhooks/payhip/creator-route', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });

        expect(res.status).toBe(403);
        expect(store.size()).toBe(0);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(0);
        expect(convex.getCalls(refs.markPayhipWebhookConfigured)).toHaveLength(0);
      }
    );
  });
});

describe('LemonSqueezy webhook security', () => {
  it('rejects invalid signatures without ingestion or connection-state updates', async () => {
    const store = createWebhookStore();
    const secretRef = await encrypt(
      'lemon-secret',
      ENCRYPTION_SECRET,
      LEMONSQUEEZY_WEBHOOK_SECRET_PURPOSE
    );

    await withWebhookHarness(
      {
        query: {
          [refs.getProviderConnectionAdmin]: () => ({
            connectionId: 'conn_1',
            authUserId: 'creator_lemon',
            providerKey: 'lemonsqueezy',
            provider: 'lemonsqueezy',
            remoteWebhookSecretRef: secretRef,
            webhookConfigured: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
          [refs.getConnectionForBackfill]: () => ({ webhookSecretEncrypted: secretRef }),
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
          [refs.updateProviderConnectionState]: () => 'conn_1',
        },
      },
      async ({ convex, server }) => {
        const body = lemonSqueezyOrderPayload({ orderId: 'order_bad_sig_001' });

        const res = await server.fetch('/v1/webhooks/lemonsqueezy/conn_1', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': 'deadbeef'.repeat(8),
          },
          body,
        });

        expect(res.status).toBe(403);
        expect(store.size()).toBe(0);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(0);
        expect(convex.getCalls(refs.updateProviderConnectionState)).toHaveLength(0);
      }
    );
  });

  it('rejects authenticated malformed JSON with 400 and no side effects', async () => {
    const store = createWebhookStore();
    const secret = 'lemon-secret';
    const secretRef = await encrypt(secret, ENCRYPTION_SECRET, LEMONSQUEEZY_WEBHOOK_SECRET_PURPOSE);
    const body = '{"meta":{"event_name":"order_created"}';
    const signature = await signLemonSqueezy(secret, body);

    await withWebhookHarness(
      {
        query: {
          [refs.getProviderConnectionAdmin]: () => ({
            connectionId: 'conn_1',
            authUserId: 'creator_lemon',
            providerKey: 'lemonsqueezy',
            provider: 'lemonsqueezy',
            remoteWebhookSecretRef: secretRef,
            webhookConfigured: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
          [refs.getConnectionForBackfill]: () => ({ webhookSecretEncrypted: secretRef }),
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
          [refs.updateProviderConnectionState]: () => 'conn_1',
        },
      },
      async ({ convex, server }) => {
        const res = await server.fetch('/v1/webhooks/lemonsqueezy/conn_1', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': signature,
          },
          body,
        });

        expect(res.status).toBe(400);
        expect(store.size()).toBe(0);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(0);
        expect(convex.getCalls(refs.updateProviderConnectionState)).toHaveLength(0);
      }
    );
  });

  it('returns duplicate=true on replayed valid deliveries while storing only one event', async () => {
    const store = createWebhookStore();
    const secret = 'lemon-secret';
    const secretRef = await encrypt(secret, ENCRYPTION_SECRET, LEMONSQUEEZY_WEBHOOK_SECRET_PURPOSE);
    const body = lemonSqueezyOrderPayload({ orderId: 'order_duplicate_001' });
    const signature = await signLemonSqueezy(secret, body);

    await withWebhookHarness(
      {
        query: {
          [refs.getProviderConnectionAdmin]: () => ({
            connectionId: 'conn_1',
            authUserId: 'creator_lemon',
            providerKey: 'lemonsqueezy',
            provider: 'lemonsqueezy',
            remoteWebhookSecretRef: secretRef,
            webhookConfigured: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
          [refs.getConnectionForBackfill]: () => ({ webhookSecretEncrypted: secretRef }),
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
          [refs.updateProviderConnectionState]: () => 'conn_1',
        },
      },
      async ({ convex, server }) => {
        const init: RequestInit = {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': signature,
          },
          body,
        };

        const first = await server.fetch('/v1/webhooks/lemonsqueezy/conn_1', init);
        const second = await server.fetch('/v1/webhooks/lemonsqueezy/conn_1', init);

        expect(first.status).toBe(202);
        expect(second.status).toBe(202);
        expect(await first.json()).toEqual({ success: true, duplicate: false });
        expect(await second.json()).toEqual({ success: true, duplicate: true });
        expect(store.size()).toBe(1);
        expect(convex.getCalls(refs.insertWebhookEvent)).toHaveLength(2);
      }
    );
  });

  it('rejects oversized canonical webhook bodies before any Convex lookup', async () => {
    const store = createWebhookStore();
    const secret = 'lemon-secret';
    const body = JSON.stringify({
      meta: { event_name: 'order_created' },
      data: { id: 'order_boundary_001', attributes: { padding: 'x'.repeat(270_000) } },
    });
    const signature = await signLemonSqueezy(secret, body);

    await withWebhookHarness(
      {
        query: {
          [refs.getProviderConnectionAdmin]: async () => {
            throw new Error('should not be called');
          },
        },
        mutation: {
          [refs.insertWebhookEvent]: (args) => store.insert(args),
        },
      },
      async ({ convex, server }) => {
        const res = await server.fetch('/v1/webhooks/lemonsqueezy/conn_1', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-signature': signature,
          },
          body,
        });

        expect(res.status).toBe(413);
        expect(store.size()).toBe(0);
        expect(convex.getCalls()).toHaveLength(0);
      }
    );
  });
});
