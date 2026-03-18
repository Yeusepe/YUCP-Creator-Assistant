/**
 * LemonSqueezy Connect Plugin
 *
 * Handles the LemonSqueezy API-key setup flow:
 *   POST /api/connect/lemonsqueezy-finish  — validate key, auto-create webhook, store credentials
 */

import { LemonSqueezyApiClient } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { encrypt } from '../../lib/encrypt';
import type { ConnectContext, ConnectPlugin, ConnectRoute } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// HKDF purpose strings — inlined to avoid circular imports with index.ts
const CREDENTIAL_PURPOSE = 'lemonsqueezy-api-token' as const;
const WEBHOOK_SECRET_PURPOSE = 'lemonsqueezy-webhook-secret' as const;

const LS_WEBHOOK_EVENTS = [
  'order_created',
  'order_refunded',
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
  'subscription_payment_success',
  'subscription_payment_failed',
  'license_key_created',
  'license_key_updated',
] as const;

// ──────────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/connect/lemonsqueezy-finish
 * Body: { authUserId?, apiKey }
 * Validates the API key, automatically creates the webhook, and stores all credentials.
 */
async function lemonsqueezyFinish(request: Request, ctx: ConnectContext): Promise<Response> {
  const { config } = ctx;
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const setupBinding = await ctx.requireBoundSetupSession(request);
  if (!setupBinding.ok && ctx.getSetupSessionTokenFromRequest(request)) {
    return setupBinding.response;
  }
  const setupSession = setupBinding.ok ? setupBinding.setupSession : null;
  const authSession = setupSession ? null : await ctx.auth.getSession(request);
  if (!authSession && !setupSession) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  let body: { authUserId?: string; apiKey: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const authUserId = setupSession?.authUserId ?? body.authUserId ?? authSession?.user?.id ?? null;
  const { apiKey } = body;
  if (!apiKey) {
    return Response.json({ error: 'apiKey is required' }, { status: 400 });
  }

  if (!authUserId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (body.authUserId && !setupSession) {
    if (!authSession) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    const tenantOwned = await ctx.isTenantOwnedBySessionUser(authSession.user.id, body.authUserId);
    if (!tenantOwned) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  try {
    const client = new LemonSqueezyApiClient({ apiToken: apiKey });
    const storesResult = await client.getStores(1, 100);
    const selectedStore = storesResult.stores[0];
    if (!selectedStore) {
      return Response.json(
        { error: 'No Lemon Squeezy stores found for this API key' },
        { status: 422 }
      );
    }

    const convex = getConvexClientFromUrl(config.convexUrl);
    const connectionId = await convex.mutation(api.providerConnections.createProviderConnection, {
      apiSecret: config.convexApiSecret,
      authUserId: authUserId ?? undefined,
      providerKey: 'lemonsqueezy',
    });

    // Delete any previously registered webhook to avoid duplicate-signing issues.
    const existingConnection = await convex.query(api.providerPlatform.getProviderConnectionAdmin, {
      apiSecret: config.convexApiSecret,
      providerConnectionId: connectionId,
    });
    if (existingConnection?.remoteWebhookId) {
      try {
        await client.deleteWebhook(existingConnection.remoteWebhookId);
      } catch (err) {
        logger.warn('Could not delete old LS webhook (ignoring)', {
          webhookId: existingConnection.remoteWebhookId,
          err: String(err),
        });
      }
    }

    const callbackUrl = `${config.apiBaseUrl.replace(/\/$/, '')}/v1/webhooks/lemonsqueezy/${connectionId}`;
    const webhookSecretPlain = crypto.randomUUID().replace(/-/g, '');
    const webhook = await client.createWebhook({
      storeId: selectedStore.id,
      url: callbackUrl,
      events: [...LS_WEBHOOK_EVENTS],
      secret: webhookSecretPlain,
      testMode: Boolean(selectedStore.testMode ?? false),
    });

    const encryptedApiToken = await encrypt(apiKey, config.encryptionSecret, CREDENTIAL_PURPOSE);
    const encryptedWebhookSecret = await encrypt(
      webhookSecretPlain,
      config.encryptionSecret,
      WEBHOOK_SECRET_PURPOSE
    );

    try {
      for (const credential of [
        {
          credentialKey: 'api_token',
          kind: 'api_token',
          encryptedValue: encryptedApiToken,
          metadata: { storeId: selectedStore.id },
        },
        {
          credentialKey: 'webhook_secret',
          kind: 'webhook_secret',
          encryptedValue: encryptedWebhookSecret,
          metadata: { webhookId: webhook.id },
        },
        {
          credentialKey: 'store_selector',
          kind: 'store_selector',
          encryptedValue: undefined,
          metadata: {
            storeId: selectedStore.id,
            storeName: selectedStore.name,
            slug: selectedStore.slug,
          },
        },
        {
          credentialKey: 'remote_webhook',
          kind: 'remote_webhook',
          encryptedValue: undefined,
          metadata: { webhookId: webhook.id, events: webhook.events, url: webhook.url },
        },
      ] as const) {
        await convex.mutation(api.providerConnections.putProviderCredential, {
          apiSecret: config.convexApiSecret,
          authUserId: authUserId ?? undefined,
          providerConnectionId: connectionId,
          credentialKey: credential.credentialKey,
          kind: credential.kind,
          encryptedValue: credential.encryptedValue,
          metadata: credential.metadata,
        });
      }

      await convex.mutation(api.providerPlatform.updateProviderConnectionState, {
        apiSecret: config.convexApiSecret,
        providerConnectionId: connectionId,
        status: 'active',
        authMode: 'api_token',
        externalShopId: selectedStore.id,
        externalShopName: selectedStore.name,
        webhookConfigured: true,
        webhookEndpoint: callbackUrl,
        remoteWebhookId: webhook.id,
        remoteWebhookSecretRef: encryptedWebhookSecret,
        lastHealthcheckAt: Date.now(),
        testMode: Boolean(selectedStore.testMode ?? false),
        metadata: { store: selectedStore, webhookId: webhook.id },
      });

      for (const capabilityKey of [
        'catalog_sync',
        'managed_webhooks',
        'webhooks',
        'reconciliation',
        'license_verification',
        'orders',
        'refunds',
        'subscriptions',
      ]) {
        await convex.mutation(api.providerConnections.upsertConnectionCapability, {
          apiSecret: config.convexApiSecret,
          authUserId: authUserId ?? undefined,
          providerConnectionId: connectionId,
          capabilityKey,
          status: 'active',
        });
      }

      return Response.json({ success: true });
    } catch (convexErr) {
      logger.warn('LemonSqueezy finish: Convex writes failed, rolling back webhook', {
        webhookId: webhook.id,
        error: convexErr instanceof Error ? convexErr.message : String(convexErr),
      });
      try {
        await client.deleteWebhook(webhook.id);
      } catch (deleteErr) {
        logger.warn('LemonSqueezy finish: webhook rollback also failed', {
          webhookId: webhook.id,
          err: String(deleteErr),
        });
      }
      throw convexErr;
    }
  } catch (err) {
    logger.error('LemonSqueezy finish failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    const msg = err instanceof Error ? err.message : String(err);
    const isApiKeyError =
      msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('401');
    return Response.json(
      {
        error: isApiKeyError
          ? 'Invalid API key. Please double-check and try again.'
          : 'Failed to complete Lemon Squeezy setup.',
      },
      { status: isApiKeyError ? 401 : 500 }
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Plugin declaration
// ──────────────────────────────────────────────────────────────────────────────

const routes: ReadonlyArray<ConnectRoute> = [
  { method: 'POST', path: '/api/connect/lemonsqueezy-finish', handler: lemonsqueezyFinish },
];

export const connect: ConnectPlugin = {
  providerId: 'lemonsqueezy',
  routes,
};
