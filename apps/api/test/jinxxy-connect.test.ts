/**
 * Jinxxy connect flow, webhook token consistency tests
 *
 * Covers the bug where GET /webhook-config and POST /webhook-config
 * each generate independent random tokens, causing the webhook handler
 * to look up the wrong state store key during test delivery.
 */

import { describe, expect, it } from 'bun:test';
import { createSetupSession } from '../src/lib/setupSession';
import { getStateStore } from '../src/lib/stateStore';
import { startFakeConvexServer } from './helpers/fakeConvex';
import { startTestServer } from './helpers/testServer';

const ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!!';

const refs = {
  getProviderConnectionWebhookRouteToken:
    'providerConnections:getProviderConnectionWebhookRouteToken',
  upsertProviderConnection: 'providerConnections:upsertProviderConnection',
} as const;

describe('Jinxxy connect, webhook token consistency', () => {
  it('GET and POST /webhook-config use the same callback route token', async () => {
    const convex = startFakeConvexServer({
      query: {
        [refs.getProviderConnectionWebhookRouteToken]: () => null,
      },
      mutation: {
        [refs.upsertProviderConnection]: () => null,
      },
    });
    const server = await startTestServer({
      convexUrl: convex.url,
      encryptionSecret: ENCRYPTION_SECRET,
    });

    try {
      const authUserId = 'test-user-webhook-token';
      const setupToken = await createSetupSession(
        authUserId,
        'guild-123',
        'discord-123',
        ENCRYPTION_SECRET
      );
      const authHeader = { Authorization: `Bearer ${setupToken}` };

      // Step 1: GET /webhook-config, returns callbackUrl with token A
      const getRes = await server.fetch('/api/connect/jinxxy/webhook-config', {
        headers: authHeader,
      });
      expect(getRes.status).toBe(200);
      const { callbackUrl } = (await getRes.json()) as { callbackUrl: string };
      const tokenA = callbackUrl.split('/').at(-1) ?? '';
      expect(tokenA).toBeTruthy();
      expect(tokenA.length).toBe(64);

      // Step 2: POST /webhook-config, stores pending secret (and may generate token B)
      const postRes = await server.fetch('/api/connect/jinxxy/webhook-config', {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookSecret: 'a-valid-signing-secret-1234' }),
      });
      expect(postRes.status).toBe(200);

      // Verify the pending secret is stored under token A (the one in the callbackUrl)
      const store = getStateStore();
      const pendingByTokenA = await store.get(`jinxxy_webhook_pending_token:${tokenA}`);

      expect(pendingByTokenA).not.toBeNull();

      if (pendingByTokenA) {
        const parsed = JSON.parse(pendingByTokenA) as {
          routeToken: string;
          callbackUrl: string;
          signingSecretEncrypted: string;
        };
        expect(parsed.routeToken).toBe(tokenA);
      }
    } finally {
      server.stop();
      convex.stop();
    }
  });

  it('second GET /webhook-config reuses the same token as the first GET', async () => {
    const convex = startFakeConvexServer({
      query: {
        [refs.getProviderConnectionWebhookRouteToken]: () => null,
      },
    });
    const server = await startTestServer({
      convexUrl: convex.url,
      encryptionSecret: ENCRYPTION_SECRET,
    });

    try {
      const authUserId = 'test-user-token-reuse';
      const setupToken = await createSetupSession(
        authUserId,
        'guild-123',
        'discord-123',
        ENCRYPTION_SECRET
      );
      const authHeader = { Authorization: `Bearer ${setupToken}` };

      const res1 = await server.fetch('/api/connect/jinxxy/webhook-config', {
        headers: authHeader,
      });
      const { callbackUrl: url1 } = (await res1.json()) as { callbackUrl: string };

      const res2 = await server.fetch('/api/connect/jinxxy/webhook-config', {
        headers: authHeader,
      });
      const { callbackUrl: url2 } = (await res2.json()) as { callbackUrl: string };

      expect(url1).toBe(url2);
    } finally {
      server.stop();
      convex.stop();
    }
  });
});
