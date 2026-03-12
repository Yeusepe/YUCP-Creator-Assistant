/**
 * Webhook Ingestion Routes
 *
 * POST /webhooks/gumroad/:routeId - Gumroad Ping format (x-www-form-urlencoded)
 * POST /webhooks/jinxxy/:routeId - Jinxxy JSON format with x-signature
 *
 * routeId is either a tenantId (legacy) or a Better Auth user ID (user-scoped connections).
 *
 * Returns 200 quickly after inserting into webhook_events.
 * Normalization runs asynchronously.
 *
 * Gumroad verification: resource_subscriptions webhooks have no secret.
 * We verify by calling Gumroad API GET /sales?id={saleId} with the creator's OAuth token.
 */

import { GumroadAdapter } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { JINXXY_PENDING_WEBHOOK_PREFIX } from '../lib/browserSessions';
import { getConvexClientFromUrl } from '../lib/convex';
import { decrypt } from '../lib/encrypt';
import { getStateStore } from '../lib/stateStore';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const JINXXY_TEST_PREFIX = 'jinxxy_test:';
const JINXXY_TEST_TTL_MS = 60 * 1000; // 60 seconds
const COLLAB_TEST_PREFIX = 'collab_test:';
const COLLAB_TEST_TTL_MS = 60 * 1000; // 60 seconds
const PAYHIP_TEST_PREFIX = 'payhip_test:';
const PAYHIP_TEST_TTL_MS = 60 * 1000; // 60 seconds

export interface WebhookConfig {
  convexUrl: string;
  convexApiSecret: string;
  /** Required for Gumroad API verification (decrypt stored OAuth token) */
  encryptionSecret: string;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a.toLowerCase());
  const bBytes = new TextEncoder().encode(b.toLowerCase());
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

/**
 * Compute HMAC-SHA256 of body with secret.
 */
async function hmacSha256(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute SHA-256 hash of a string and return hex-encoded result.
 * Used for Payhip webhook signature verification (signature = SHA256(apiKey)).
 */
async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Create webhook route handlers.
 */
export function createWebhookRoutes(config: WebhookConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);
  const apiSecret = config.convexApiSecret;
  const encryptionSecret = config.encryptionSecret;
  const gumroadAdapter = new GumroadAdapter({
    clientId: '',
    clientSecret: '',
    redirectUri: '',
  });

  async function getJinxxyWebhookSecret(tenantId: string): Promise<string | null> {
    try {
      const secretRef = await convex.query(api.providerConnections.getJinxxyWebhookSecret, {
        apiSecret,
        tenantId,
      });
      if (!secretRef) return null;
      try {
        return await decrypt(secretRef, encryptionSecret);
      } catch {
        return secretRef;
      }
    } catch {
      return null;
    }
  }

  async function getPendingJinxxyWebhookSecret(tenantId: string): Promise<string | null> {
    try {
      const store = getStateStore();
      const raw = await store.get(`${JINXXY_PENDING_WEBHOOK_PREFIX}${tenantId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { signingSecretEncrypted: string };
      return await decrypt(parsed.signingSecretEncrypted, encryptionSecret);
    } catch {
      return null;
    }
  }

  async function getGumroadWebhookSecret(tenantId: string): Promise<string | null> {
    try {
      return await convex.query(api.providerConnections.getGumroadWebhookSecret, {
        apiSecret,
        tenantId,
      });
    } catch {
      return null;
    }
  }

  /**
   * Get the encrypted Payhip API key for a tenant.
   * Payhip signature = SHA256(apiKey), so we need the raw API key to verify.
   */
  async function getPayhipApiKey(tenantId: string): Promise<string | null> {
    try {
      const encryptedKey = await convex.query(api.providerConnections.getPayhipApiKey, {
        apiSecret,
        tenantId,
      });
      if (!encryptedKey) return null;
      try {
        return await decrypt(encryptedKey, encryptionSecret);
      } catch {
        return encryptedKey;
      }
    } catch {
      return null;
    }
  }

  async function getCollabWebhookSecret(inviteId: string): Promise<string | null> {
    try {
      const encryptedSecret = await convex.query(api.collaboratorInvites.getCollabWebhookSecret, {
        apiSecret,
        inviteId,
      });
      if (!encryptedSecret) return null;
      return await decrypt(encryptedSecret, encryptionSecret);
    } catch {
      return null;
    }
  }

  async function handleJinxxyCollabWebhook(
    request: Request,
    ownerTenantId: string,
    inviteId: string
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      logger.info('Webhook received', {
        provider: 'jinxxy-collab',
        ownerTenantId,
        inviteId,
        payloadBytes: rawBody.length,
      });
      const signature = request.headers.get('x-signature');

      const webhookSecret = await getCollabWebhookSecret(inviteId);
      let signatureValid = false;

      if (webhookSecret && signature) {
        const expectedSig = await hmacSha256(webhookSecret, rawBody);
        signatureValid = timingSafeEqual(expectedSig, signature);
      } else if (!webhookSecret) {
        logger.warn('Collab webhook: no secret configured', { ownerTenantId, inviteId });
        signatureValid = false;
      }

      let payload: { event_id?: string; event_type?: string };
      try {
        payload = JSON.parse(rawBody) as { event_id?: string; event_type?: string };
      } catch {
        logger.warn('Collab webhook: invalid JSON', { ownerTenantId, inviteId });
        return new Response('Bad Request', { status: 400 });
      }

      const eventId = payload.event_id ?? payload.event_type ?? '';
      const eventType = payload.event_type ?? 'unknown';

      if (!eventId) {
        logger.warn('Collab webhook: missing event_id', { ownerTenantId, inviteId });
        return new Response('OK', { status: 200 });
      }

      if (!signatureValid) {
        logger.warn('Collab webhook: rejected (unverified)', { ownerTenantId, inviteId, eventId });
        return new Response('Forbidden', { status: 403 });
      }

      const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
        apiSecret,
        tenantId: ownerTenantId,
        provider: 'jinxxy',
        providerEventId: eventId,
        eventType,
        rawPayload: payload,
        signatureValid,
      });

      if (result.duplicate) {
        logger.debug('Collab webhook: duplicate event', { eventId, ownerTenantId, inviteId });
      }

      // Set test webhook flag for collab invite polling
      try {
        const store = getStateStore();
        await store.set(`${COLLAB_TEST_PREFIX}${inviteId}`, '1', COLLAB_TEST_TTL_MS);
      } catch {
        // Non-fatal
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      logger.error('Collab webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        ownerTenantId,
        inviteId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async function handleGumroadWebhook(request: Request, tenantId: string): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const contentType = request.headers.get('content-type') ?? '';
      if (!contentType.includes('application/x-www-form-urlencoded')) {
        const body = await request.text();
        if (body && contentType.includes('application/x-www-form-urlencoded')) {
          // Some clients send without proper header
        } else {
          logger.warn('Gumroad webhook: unexpected content-type', {
            contentType,
            tenantId,
          });
        }
      }

      const rawBody = await request.text();
      logger.info('Webhook received', {
        provider: 'gumroad',
        tenantId,
        payloadBytes: rawBody.length,
      });
      const incomingSig = request.headers.get('x-gumroad-signature');
      const webhookSecret = await getGumroadWebhookSecret(tenantId);
      let signatureValid = false;

      if (webhookSecret && incomingSig) {
        const expectedSig = await hmacSha256(webhookSecret, rawBody);
        signatureValid = timingSafeEqual(expectedSig, incomingSig);
      } else if (!webhookSecret) {
        logger.warn('Gumroad webhook: no secret configured', { tenantId });
        signatureValid = false;
      }

      const params = new URLSearchParams(rawBody);
      const saleId = params.get('sale_id') ?? params.get('order_number') ?? '';
      const refunded = params.get('refunded') === 'true';
      const eventType = refunded ? 'refund' : 'sale';
      const providerEventId = `${saleId}:${eventType}`;

      if (!saleId) {
        logger.warn('Gumroad webhook: missing sale_id/order_number', {
          tenantId,
        });
        return new Response('OK', { status: 200 });
      }

      // API verification: resource_subscriptions webhooks have no secret.
      // Verify sale exists via Gumroad API when signature is not valid.
      if (!signatureValid && encryptionSecret) {
        try {
          const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
            apiSecret,
            tenantId,
            provider: 'gumroad',
          });
          if (conn?.gumroadAccessTokenEncrypted) {
            const accessToken = await decrypt(conn.gumroadAccessTokenEncrypted, encryptionSecret);
            const sale = await gumroadAdapter.getSale(accessToken, saleId);
            if (sale) {
              // Sanity check: refunded status should match
              const apiRefunded = sale.refunded === true;
              if (apiRefunded === refunded) {
                signatureValid = true;
              } else {
                logger.warn('Gumroad webhook: refunded mismatch', {
                  tenantId,
                  saleId,
                  webhookRefunded: refunded,
                  apiRefunded,
                });
              }
            }
          }
        } catch (err) {
          logger.warn('Gumroad webhook: API verification failed', {
            tenantId,
            saleId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Reject unverified webhooks (no signature and API verification failed)
      if (!signatureValid) {
        logger.warn('Gumroad webhook: rejected (unverified)', { tenantId, saleId });
        return new Response('Forbidden', { status: 403 });
      }

      const payload = Object.fromEntries(params.entries());

      const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
        apiSecret,
        tenantId,
        provider: 'gumroad',
        providerEventId,
        eventType,
        rawPayload: payload,
        signatureValid,
      });

      if (result.duplicate) {
        logger.debug('Gumroad webhook: duplicate event', { saleId, tenantId });
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      logger.error('Gumroad webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async function handleJinxxyWebhook(request: Request, tenantId: string): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      logger.info('Webhook received', {
        provider: 'jinxxy',
        tenantId,
        payloadBytes: rawBody.length,
      });
      const signature = request.headers.get('x-signature');
      const convexSecret = await getJinxxyWebhookSecret(tenantId);
      const pendingSecret = await getPendingJinxxyWebhookSecret(tenantId);
      const webhookSecret = convexSecret ?? pendingSecret;
      let signatureValid = false;

      if (webhookSecret && signature) {
        const expectedSig = await hmacSha256(webhookSecret, rawBody);
        let incomingSig = signature.trim();
        if (incomingSig.startsWith('sha256=')) {
          incomingSig = incomingSig.slice(7);
        }
        signatureValid = timingSafeEqual(expectedSig, incomingSig);
      } else if (!webhookSecret) {
        logger.warn('Jinxxy webhook: no secret configured', { tenantId });
        signatureValid = false;
      }

      let payload: { event_id?: string; event_type?: string };
      try {
        payload = JSON.parse(rawBody) as { event_id?: string; event_type?: string };
      } catch {
        logger.warn('Jinxxy webhook: invalid JSON', { tenantId });
        return new Response('Bad Request', { status: 400 });
      }

      const eventId = payload.event_id ?? payload.event_type ?? '';
      const eventType = payload.event_type ?? 'unknown';

      if (!eventId) {
        logger.warn('Jinxxy webhook: missing event_id', { tenantId });
        return new Response('OK', { status: 200 });
      }

      // Reject unverified webhooks before ingestion.
      if (!signatureValid) {
        logger.warn('Jinxxy webhook: rejected (unverified)', {
          tenantId,
          eventId,
          hasConvexSecret: !!convexSecret,
          hasPendingSecret: !!pendingSecret,
          hasSignature: !!signature,
          signatureLen: signature?.length ?? 0,
        });
        return new Response('Forbidden', { status: 403 });
      }

      const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
        apiSecret,
        tenantId,
        provider: 'jinxxy',
        providerEventId: eventId,
        eventType,
        rawPayload: payload,
        signatureValid,
      });

      if (result.duplicate) {
        logger.debug('Jinxxy webhook: duplicate event', {
          eventId,
          tenantId,
        });
      }

      // Set test webhook flag for connect flow polling
      try {
        const store = getStateStore();
        await store.set(`${JINXXY_TEST_PREFIX}${tenantId}`, '1', JINXXY_TEST_TTL_MS);
      } catch {
        // Non-fatal
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      logger.error('Jinxxy webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async function handlePayhipWebhook(request: Request, tenantId: string): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      logger.info('Webhook received', {
        provider: 'payhip',
        tenantId,
        payloadBytes: rawBody.length,
      });

      let payload: { id?: string; email?: string; type?: string; signature?: string };
      try {
        payload = JSON.parse(rawBody) as typeof payload;
      } catch {
        logger.warn('Payhip webhook: invalid JSON', { tenantId });
        return new Response('Bad Request', { status: 400 });
      }

      // Payhip signature = SHA256(apiKey) — static, not HMAC of the body.
      // The signature field is inside the JSON payload itself.
      const apiKey = await getPayhipApiKey(tenantId);
      let signatureValid = false;

      if (apiKey && payload.signature) {
        const expectedSig = await sha256Hex(apiKey);
        signatureValid = timingSafeEqual(expectedSig, payload.signature);
      } else if (!apiKey) {
        logger.warn('Payhip webhook: no API key configured', { tenantId });
      }

      const eventId = payload.id ?? '';
      const eventType = payload.type ?? 'unknown';

      if (!eventId) {
        logger.warn('Payhip webhook: missing id', { tenantId });
        return new Response('OK', { status: 200 });
      }

      if (!signatureValid) {
        logger.warn('Payhip webhook: rejected (invalid signature)', {
          tenantId,
          eventId,
          hasApiKey: !!apiKey,
          hasSignature: !!payload.signature,
        });
        return new Response('Forbidden', { status: 403 });
      }

      const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
        apiSecret,
        tenantId,
        provider: 'payhip',
        providerEventId: eventId,
        eventType,
        rawPayload: payload,
        signatureValid,
      });

      if (result.duplicate) {
        logger.debug('Payhip webhook: duplicate event', { eventId, tenantId });
      }

      // Mark webhook as configured on first successful delivery
      try {
        await convex.mutation(api.providerConnections.markPayhipWebhookConfigured, {
          apiSecret,
          tenantId,
        });
      } catch {
        // Non-fatal
      }

      // Set test webhook flag for connect flow polling
      try {
        const store = getStateStore();
        await store.set(`${PAYHIP_TEST_PREFIX}${tenantId}`, '1', PAYHIP_TEST_TTL_MS);
      } catch {
        // Non-fatal
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      logger.error('Payhip webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  return {
    handleGumroadWebhook,
    handleJinxxyWebhook,
    handleJinxxyCollabWebhook,
    handlePayhipWebhook,
  };
}

/**
 * Mount webhook routes. Returns a single handler for /webhooks/* paths.
 * Path format: /webhooks/gumroad/:routeId, /webhooks/jinxxy/:routeId, /webhooks/payhip/:routeId
 * where routeId is either a tenantId (legacy) or an authUserId (user-scoped connections).
 */
export function createWebhookHandler(
  config: WebhookConfig
): (request: Request) => Promise<Response> {
  const routes = createWebhookRoutes(config);
  const convex = getConvexClientFromUrl(config.convexUrl);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    if (pathParts.length < 3 || pathParts[0] !== 'webhooks') {
      return new Response('Not Found', { status: 404 });
    }

    const provider = pathParts[1];
    const routeId = pathParts[2];

    logger.info('Webhook request', {
      method: request.method,
      path: url.pathname,
      provider,
      routeId: routeId || undefined,
    });

    // /webhooks/jinxxy-collab/:ownerTenantId/:inviteId
    if (provider === 'jinxxy-collab') {
      const inviteId = pathParts[3];
      if (!routeId || !inviteId) {
        return new Response('Not Found', { status: 404 });
      }
      return routes.handleJinxxyCollabWebhook(request, routeId, inviteId);
    }

    if (!routeId) {
      return new Response('Not Found', { status: 404 });
    }

    // Payhip uses direct tenantId routing (no fan-out needed)
    if (provider === 'payhip') {
      return routes.handlePayhipWebhook(request, routeId);
    }

    if (provider !== 'gumroad' && provider !== 'jinxxy') {
      logger.warn('Webhook unknown provider', { provider, routeId });
      return new Response('Not Found', { status: 404 });
    }

    // Resolve routeId → one or more tenantIds (supports both direct tenantId and authUserId)
    let tenantIds: string[];
    try {
      tenantIds = await convex.query(api.webhookIngestion.resolveWebhookTenantIds, {
        apiSecret: config.convexApiSecret,
        routeId,
      });
    } catch (err) {
      logger.warn('Failed to resolve webhook tenantIds', {
        routeId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall back to treating routeId as a direct tenantId (for backward compat)
      tenantIds = [routeId];
    }

    if (tenantIds.length === 0) {
      logger.warn('Webhook: no tenants resolved for routeId', { routeId, provider });
      return new Response('Not Found', { status: 404 });
    }

    if (tenantIds.length === 1) {
      // Fast path: single tenant (most common)
      if (provider === 'gumroad') return routes.handleGumroadWebhook(request, tenantIds[0]);
      return routes.handleJinxxyWebhook(request, tenantIds[0]);
    }

    // Fan-out: clone the request body once, then dispatch to all tenants
    const body = await request.text();
    const headers = Object.fromEntries(request.headers.entries());
    const results = await Promise.allSettled(
      tenantIds.map((tenantId) => {
        const clonedRequest = new Request(request.url, {
          method: request.method,
          headers,
          body: body || undefined,
        });
        if (provider === 'gumroad') return routes.handleGumroadWebhook(clonedRequest, tenantId);
        return routes.handleJinxxyWebhook(clonedRequest, tenantId);
      })
    );

    // If any succeeded, return 200; otherwise return the first error
    const anySuccess = results.some((r) => r.status === 'fulfilled' && r.value.ok);
    if (anySuccess) return new Response('OK', { status: 200 });

    const firstFailed = results.find((r) => r.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    if (firstFailed) {
      logger.error('Webhook fan-out error', { routeId, error: String(firstFailed.reason) });
    }
    return new Response('Internal Server Error', { status: 500 });
  };
}
