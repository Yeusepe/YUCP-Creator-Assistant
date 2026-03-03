/**
 * Webhook Ingestion Routes
 *
 * POST /webhooks/gumroad/:tenantId - Gumroad Ping format (x-www-form-urlencoded)
 * POST /webhooks/jinxxy/:tenantId - Jinxxy JSON format with x-signature
 *
 * Returns 200 quickly after inserting into webhook_events.
 * Normalization runs asynchronously.
 */

import { createLogger } from '@yucp/shared';
import { getConvexClientFromUrl } from '../lib/convex';
import { getStateStore } from '../lib/stateStore';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const JINXXY_TEST_PREFIX = 'jinxxy_test:';
const JINXXY_TEST_TTL_MS = 60 * 1000; // 60 seconds

export interface WebhookConfig {
  convexUrl: string;
  convexApiSecret: string;
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
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(body)
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}


/**
 * Create webhook route handlers.
 */
export function createWebhookRoutes(config: WebhookConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);
  const apiSecret = config.convexApiSecret;

  async function getJinxxyWebhookSecret(tenantId: string): Promise<string | null> {
    try {
      return await convex.query(
        'providerConnections:getJinxxyWebhookSecret' as any,
        { apiSecret, tenantId }
      );
    } catch {
      return null;
    }
  }

  async function handleGumroadWebhook(
    request: Request,
    tenantId: string
  ): Promise<Response> {
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

      const payload = Object.fromEntries(params.entries());

      const result = await convex.mutation(
        'webhookIngestion:insertWebhookEvent' as any,
        {
          apiSecret,
          tenantId,
          provider: 'gumroad',
          providerEventId,
          eventType,
          rawPayload: payload,
          signatureValid: true,
        }
      );

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

  async function handleJinxxyWebhook(
    request: Request,
    tenantId: string
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      const signature = request.headers.get('x-signature');

      const webhookSecret = await getJinxxyWebhookSecret(tenantId);
      let signatureValid = false;

      if (webhookSecret && signature) {
        const expectedSig = await hmacSha256(webhookSecret, rawBody);
        signatureValid =
          expectedSig.toLowerCase() === signature.toLowerCase();
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

      const result = await convex.mutation(
        'webhookIngestion:insertWebhookEvent' as any,
        {
          apiSecret,
          tenantId,
          provider: 'jinxxy',
          providerEventId: eventId,
          eventType,
          rawPayload: payload,
          signatureValid,
        }
      );

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

  return {
    handleGumroadWebhook,
    handleJinxxyWebhook,
  };
}

/**
 * Mount webhook routes. Returns a single handler for /webhooks/* paths.
 * Path format: /webhooks/gumroad/:tenantId, /webhooks/jinxxy/:tenantId
 */
export function createWebhookHandler(config: WebhookConfig): (request: Request) => Promise<Response> {
  const routes = createWebhookRoutes(config);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    if (pathParts.length < 3 || pathParts[0] !== 'webhooks') {
      return new Response('Not Found', { status: 404 });
    }

    const provider = pathParts[1];
    const tenantId = pathParts[2];

    if (!tenantId) {
      return new Response('Not Found', { status: 404 });
    }

    if (provider === 'gumroad') {
      return routes.handleGumroadWebhook(request, tenantId);
    }
    if (provider === 'jinxxy') {
      return routes.handleJinxxyWebhook(request, tenantId);
    }

    return new Response('Not Found', { status: 404 });
  };
}
