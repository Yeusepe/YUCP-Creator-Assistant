/**
 * Jinxxy Connect Plugin
 *
 * Handles the Jinxxy API-key + webhook setup flow:
 *   GET/POST /api/connect/jinxxy/webhook-config  — get callback URL / save pending webhook secret
 *   GET      /api/connect/jinxxy/test-webhook    — poll for test-delivery confirmation
 *   POST     /api/connect/jinxxy-store           — store API key + pending webhook secret
 */

import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';

const JINXXY_PENDING_WEBHOOK_PREFIX = 'jinxxy_webhook_pending:';
const JINXXY_PENDING_WEBHOOK_TOKEN_PREFIX = 'jinxxy_webhook_pending_token:';
const JINXXY_PENDING_WEBHOOK_TTL_MS = 30 * 60 * 1000;

import { getConvexClientFromUrl } from '../../lib/convex';
import { encrypt } from '../../lib/encrypt';
import { getStateStore } from '../../lib/stateStore';
import type { ConnectContext, ConnectPlugin, ConnectRoute } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// HKDF purpose strings — inlined to avoid circular imports with index.ts
const CREDENTIAL_PURPOSE = 'jinxxy-api-key' as const;
const WEBHOOK_SECRET_PURPOSE = 'jinxxy-webhook-signing-secret' as const;

const JINXXY_TEST_PREFIX = 'jinxxy_test:';

// ──────────────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * GET  /api/connect/jinxxy/webhook-config?authUserId=XXX  → { callbackUrl }
 * POST /api/connect/jinxxy/webhook-config  body: { webhookSecret }
 * Stores a pending encrypted webhook secret for test delivery verification.
 */
async function jinxxyWebhookConfig(request: Request, ctx: ConnectContext): Promise<Response> {
  const { config } = ctx;
  const url = new URL(request.url);
  let routeId: string | null = null;

  const setupBinding = await ctx.requireBoundSetupSession(request);
  if (setupBinding.ok) {
    routeId = setupBinding.setupSession.authUserId;
  } else {
    const session = await ctx.auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    const requestedAuthUserId = url.searchParams.get('authUserId');
    if (requestedAuthUserId) {
      const tenantOwned = await ctx.isTenantOwnedBySessionUser(
        session.user.id,
        requestedAuthUserId
      );
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
      routeId = requestedAuthUserId;
    } else {
      routeId = session.user.id;
    }
  }

  try {
    // Determine the opaque webhook route token for this connection.
    // For existing connections, reuse the stored token. For new connections,
    // generate a pending random token stored in Redis until the API key is saved.
    const convex = getConvexClientFromUrl(config.convexUrl);
    let callbackRouteToken: string | null = null;
    if (routeId) {
      callbackRouteToken = await convex.query(
        api.providerConnections.getProviderConnectionWebhookRouteToken,
        { apiSecret: config.convexApiSecret, authUserId: routeId, providerKey: 'jinxxy' }
      );
    }

    // If no existing token, generate a pending one stored alongside the webhook secret.
    if (!callbackRouteToken) {
      const pendingRaw = await getStateStore().get(`${JINXXY_PENDING_WEBHOOK_PREFIX}${routeId}`);
      if (pendingRaw) {
        const existing = JSON.parse(pendingRaw) as { routeToken?: string };
        callbackRouteToken = existing.routeToken ?? null;
      }
    }
    if (!callbackRouteToken) {
      const tokenBytes = new Uint8Array(32);
      crypto.getRandomValues(tokenBytes);
      callbackRouteToken = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    const callbackUrl = `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/jinxxy/${callbackRouteToken}`;
    if (request.method === 'GET') {
      return Response.json({ callbackUrl });
    }
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    let body: { webhookSecret?: string };
    try {
      body = (await request.json()) as { webhookSecret?: string };
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const webhookSecret = body.webhookSecret?.trim();
    if (!webhookSecret || webhookSecret.length < 16) {
      return Response.json(
        { error: 'Webhook secret must be at least 16 characters' },
        { status: 400 }
      );
    }
    if (webhookSecret.length > 40) {
      return Response.json(
        { error: 'Jinxxy limits the signing secret to 40 characters' },
        { status: 400 }
      );
    }

    const store = getStateStore();
    const signingSecretEncrypted = await encrypt(
      webhookSecret,
      config.encryptionSecret,
      WEBHOOK_SECRET_PURPOSE
    );
    const pendingPayload = JSON.stringify({
      callbackUrl,
      routeToken: callbackRouteToken,
      signingSecretEncrypted,
    });
    // Store under authUserId (for jinxxyStore to retrieve) and also under
    // the opaque route token (for the webhook handler to look up during test delivery).
    await store.set(
      `${JINXXY_PENDING_WEBHOOK_PREFIX}${routeId}`,
      pendingPayload,
      JINXXY_PENDING_WEBHOOK_TTL_MS
    );
    await store.set(
      `${JINXXY_PENDING_WEBHOOK_TOKEN_PREFIX}${callbackRouteToken}`,
      pendingPayload,
      JINXXY_PENDING_WEBHOOK_TTL_MS
    );
    return Response.json({ success: true });
  } catch (err) {
    logger.error('Jinxxy webhook config failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: 'Failed to get webhook config' }, { status: 500 });
  }
}

/**
 * GET /api/connect/jinxxy/test-webhook?authUserId=XXX
 * Returns { received: boolean } — the webhook handler sets a short-lived flag
 * when it receives a valid test delivery so this endpoint can confirm it.
 */
async function jinxxyTestWebhook(request: Request, ctx: ConnectContext): Promise<Response> {
  const url = new URL(request.url);
  let routeId = url.searchParams.get('authUserId');

  const setupBinding = await ctx.requireBoundSetupSession(request);
  if (setupBinding.ok) {
    routeId = setupBinding.setupSession.authUserId;
  } else {
    const session = await ctx.auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (routeId) {
      const tenantOwned = await ctx.isTenantOwnedBySessionUser(session.user.id, routeId);
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    } else {
      routeId = session.user.id;
    }
  }

  if (!routeId) {
    return Response.json({ error: 'authUserId or setup token is required' }, { status: 400 });
  }

  // Resolve the opaque route token — the webhook handler sets the test flag
  // using the token, not the authUserId. Fall back to any pending token in Redis.
  const { config } = ctx;
  const convex = getConvexClientFromUrl(config.convexUrl);
  let flagKey: string = routeId;
  const existingToken = await convex.query(
    api.providerConnections.getProviderConnectionWebhookRouteToken,
    { apiSecret: config.convexApiSecret, authUserId: routeId, providerKey: 'jinxxy' }
  );
  if (existingToken) {
    flagKey = existingToken;
  } else {
    const pendingRaw = await getStateStore().get(`${JINXXY_PENDING_WEBHOOK_PREFIX}${routeId}`);
    if (pendingRaw) {
      const parsed = JSON.parse(pendingRaw) as { routeToken?: string };
      if (parsed.routeToken) flagKey = parsed.routeToken;
    }
  }

  const store = getStateStore();
  const raw = await store.get(`${JINXXY_TEST_PREFIX}${flagKey}`);
  return Response.json({ received: !!raw });
}

/**
 * POST /api/connect/jinxxy-store
 * Body: { authUserId?, apiKey, webhookSecret? }
 * Stores the Jinxxy API key and (pending or inline) webhook secret in Convex.
 */
async function jinxxyStore(request: Request, ctx: ConnectContext): Promise<Response> {
  const { config } = ctx;
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const setupBinding = await ctx.requireBoundSetupSession(request);
  const setupSession = setupBinding.ok ? setupBinding.setupSession : null;
  if (!setupBinding.ok && ctx.getSetupSessionTokenFromRequest(request)) {
    return setupBinding.response;
  }
  const authSession = setupSession ? null : await ctx.auth.getSession(request);
  if (!authSession && !setupSession) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  let body: { authUserId?: string; apiKey: string; webhookSecret?: string };
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

  if (body.authUserId && !setupSession) {
    if (!authSession) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    const tenantOwned = await ctx.isTenantOwnedBySessionUser(authSession.user.id, body.authUserId);
    if (!tenantOwned) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  if (!authUserId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const webhookTarget = authUserId;

  try {
    const apiKeyEncrypted = await encrypt(apiKey, config.encryptionSecret, CREDENTIAL_PURPOSE);
    const store = getStateStore();
    const pendingWebhookRaw = await store.get(`${JINXXY_PENDING_WEBHOOK_PREFIX}${webhookTarget}`);
    let webhookSecretRef: string | undefined;
    let webhookEndpoint: string | undefined;
    let webhookRouteToken: string | undefined;
    if (pendingWebhookRaw) {
      const pendingWebhook = JSON.parse(pendingWebhookRaw) as {
        callbackUrl: string;
        routeToken?: string;
        signingSecretEncrypted: string;
      };
      webhookSecretRef = pendingWebhook.signingSecretEncrypted;
      webhookEndpoint = pendingWebhook.callbackUrl;
      webhookRouteToken = pendingWebhook.routeToken;
    } else {
      const webhookSecret = body.webhookSecret?.trim();
      if (!webhookSecret || webhookSecret.length < 16 || webhookSecret.length > 40) {
        return Response.json(
          { error: 'Webhook secret must be between 16 and 40 characters' },
          { status: 400 }
        );
      }
      webhookSecretRef = await encrypt(
        webhookSecret,
        config.encryptionSecret,
        WEBHOOK_SECRET_PURPOSE
      );
      // Generate a fresh route token when saving directly (no pending webhook-config step).
      const tokenBytes = new Uint8Array(32);
      crypto.getRandomValues(tokenBytes);
      webhookRouteToken = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, '0')).join('');
      webhookEndpoint = `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/jinxxy/${webhookRouteToken}`;
    }
    const convex = getConvexClientFromUrl(config.convexUrl);
    await convex.mutation(api.providerConnections.upsertProviderConnection, {
      apiSecret: config.convexApiSecret,
      authUserId: authUserId ?? undefined,
      providerKey: 'jinxxy',
      authMode: 'api_key',
      webhookSecretRef,
      webhookEndpoint,
      webhookConfigured: !!(webhookSecretRef && webhookEndpoint),
      webhookRouteToken,
      credentials: [
        { credentialKey: 'api_key', kind: 'api_key', encryptedValue: apiKeyEncrypted },
        ...(webhookSecretRef
          ? [
              {
                credentialKey: 'webhook_secret',
                kind: 'webhook_secret' as const,
                encryptedValue: webhookSecretRef,
              },
            ]
          : []),
      ],
      capabilities: [
        {
          capabilityKey: 'catalog_sync',
          status: 'configured',
          requiredCredentialKeys: ['api_key'],
        },
        {
          capabilityKey: 'webhooks',
          status: webhookSecretRef ? 'configured' : 'pending',
          requiredCredentialKeys: ['webhook_secret'],
        },
      ],
    });
    if (pendingWebhookRaw) {
      const pendingWebhook = JSON.parse(pendingWebhookRaw) as { routeToken?: string };
      await store.delete(`${JINXXY_PENDING_WEBHOOK_PREFIX}${webhookTarget}`);
      if (pendingWebhook.routeToken) {
        await store.delete(`${JINXXY_PENDING_WEBHOOK_TOKEN_PREFIX}${pendingWebhook.routeToken}`);
      }
    }
    return Response.json({ success: true });
  } catch (err) {
    logger.error('Jinxxy store failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: 'Failed to store Jinxxy connection' }, { status: 500 });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Plugin declaration
// ──────────────────────────────────────────────────────────────────────────────

const routes: ReadonlyArray<ConnectRoute> = [
  { method: 'GET', path: '/api/connect/jinxxy/webhook-config', handler: jinxxyWebhookConfig },
  { method: 'POST', path: '/api/connect/jinxxy/webhook-config', handler: jinxxyWebhookConfig },
  { method: 'GET', path: '/api/connect/jinxxy/test-webhook', handler: jinxxyTestWebhook },
  { method: 'POST', path: '/api/connect/jinxxy-store', handler: jinxxyStore },
];

export const connect: ConnectPlugin = {
  providerId: 'jinxxy',
  routes,
};
