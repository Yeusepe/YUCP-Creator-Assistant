/**
 * Payhip Connect Plugin
 *
 * Handles the Payhip API-key setup flow:
 *   POST /api/connect/payhip-finish        — store API key, return webhook URL
 *   GET  /api/connect/payhip/test-webhook  — poll for test-delivery confirmation
 *
 * Note: The legacy POST /api/connect/payhip/product-key and the generic
 * POST /api/connect/:provider/product-credential routes remain in connect.ts
 * because they are shared infrastructure, not provider-specific flows.
 */

import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { encrypt } from '../../lib/encrypt';
import { getStateStore } from '../../lib/stateStore';
import type { ConnectContext, ConnectPlugin, ConnectRoute } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// HKDF purpose strings — inlined to avoid circular imports with index.ts
const CREDENTIAL_PURPOSE = 'payhip-api-key' as const;

const PAYHIP_TEST_PREFIX = 'payhip_test:';

// ──────────────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/connect/payhip-finish
 * Body: { authUserId?, apiKey }
 *
 * Stores the Payhip API key and returns the webhook URL the creator should
 * paste into Payhip's Settings → Developer page.
 * Payhip webhook signature = SHA256(apiKey) — static per creator.
 */
async function payhipFinish(request: Request, ctx: ConnectContext): Promise<Response> {
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
    const apiKeyEncrypted = await encrypt(apiKey, config.encryptionSecret, CREDENTIAL_PURPOSE);
    const convex = getConvexClientFromUrl(config.convexUrl);
    const result = await convex.mutation(api.providerConnections.upsertPayhipConnection, {
      apiSecret: config.convexApiSecret,
      authUserId: authUserId ?? undefined,
      encryptedApiKey: apiKeyEncrypted,
    });

    const webhookUrl = `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/payhip/${result.webhookRouteToken}`;
    return Response.json({ success: true, webhookUrl });
  } catch (err) {
    logger.error('Payhip finish failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: 'Failed to save Payhip API key' }, { status: 500 });
  }
}

/**
 * GET /api/connect/payhip/test-webhook?authUserId=XXX
 * Returns { received: boolean }.
 * The webhook handler sets a short-lived flag when it processes a valid Payhip
 * webhook; the setup page polls here to confirm the URL was correctly configured.
 */
async function payhipTestWebhook(request: Request, ctx: ConnectContext): Promise<Response> {
  const url = new URL(request.url);
  let routeId: string | null = url.searchParams.get('authUserId');

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

  // Resolve the opaque webhook route token for this authUserId — the webhook
  // handler sets the test flag using the token, not the authUserId.
  const { config } = ctx;
  const convex = getConvexClientFromUrl(config.convexUrl);
  const webhookRouteToken = await convex.query(
    api.providerConnections.getProviderConnectionWebhookRouteToken,
    { apiSecret: config.convexApiSecret, authUserId: routeId, providerKey: 'payhip' }
  );
  const flagKey = webhookRouteToken ?? routeId;

  const store = getStateStore();
  const raw = await store.get(`${PAYHIP_TEST_PREFIX}${flagKey}`);
  return Response.json({ received: !!raw });
}

// ──────────────────────────────────────────────────────────────────────────────
// Plugin declaration
// ──────────────────────────────────────────────────────────────────────────────

const routes: ReadonlyArray<ConnectRoute> = [
  { method: 'POST', path: '/api/connect/payhip-finish', handler: payhipFinish },
  { method: 'GET', path: '/api/connect/payhip/test-webhook', handler: payhipTestWebhook },
];

export const connect: ConnectPlugin = {
  providerId: 'payhip',
  routes,
};
