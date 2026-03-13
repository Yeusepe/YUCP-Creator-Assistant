/**
 * Webhook Ingestion Routes
 *
 * POST /webhooks/gumroad/:routeId - Gumroad Ping format (x-www-form-urlencoded)
 * POST /webhooks/jinxxy/:routeId - Jinxxy JSON format with x-signature
 *
 * routeId is an authUserId (Better Auth user ID, user-scoped connections).
 *
 * Returns 200 quickly after inserting into webhook_events.
 * Normalization runs asynchronously.
 *
 * Gumroad verification: resource_subscriptions webhooks have no secret.
 * We verify by calling Gumroad API GET /sales?id={saleId} with the creator's OAuth token.
 */

import { GumroadAdapter } from '@yucp/providers';
import { createLogger, timingSafeStringEqual } from '@yucp/shared';
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
const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — replay protection window

export interface WebhookConfig {
  convexUrl: string;
  convexApiSecret: string;
  /** Required for Gumroad API verification (decrypt stored OAuth token) */
  encryptionSecret: string;
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

  async function getJinxxyWebhookSecretByRouteId(routeId: string): Promise<string | null> {
    try {
      return await convex.query(api.providerConnections.getJinxxyWebhookSecretByRouteId, {
        apiSecret,
        routeId,
      });
    } catch {
      return null;
    }
  }

  async function getPendingJinxxyWebhookSecret(routeId: string): Promise<string | null> {
    try {
      const store = getStateStore();
      const raw = await store.get(`${JINXXY_PENDING_WEBHOOK_PREFIX}${routeId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { signingSecretEncrypted: string };
      return await decrypt(parsed.signingSecretEncrypted, encryptionSecret);
    } catch {
      return null;
    }
  }

  async function getGumroadWebhookSecretByRouteId(routeId: string): Promise<string | null> {
    try {
      return await convex.query(api.providerConnections.getGumroadWebhookSecretByRouteId, {
        apiSecret,
        routeId,
      });
    } catch {
      return null;
    }
  }

  /**
   * Get the encrypted Payhip API key for a tenant.
   * Payhip signature = SHA256(apiKey), so we need the raw API key to verify.
   */
  async function _getPayhipApiKey(authUserId: string): Promise<string | null> {
    try {
      const encryptedKey = await convex.query(api.providerConnections.getPayhipApiKey, {
        apiSecret,
        authUserId,
      });
      if (!encryptedKey) return null;
      return await decrypt(encryptedKey, encryptionSecret);
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
    ownerAuthUserId: string,
    inviteId: string
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      logger.info('Webhook received', {
        provider: 'jinxxy-collab',
        ownerAuthUserId,
        inviteId,
        payloadBytes: rawBody.length,
      });
      const signature = request.headers.get('x-signature');

      const webhookSecret = await getCollabWebhookSecret(inviteId);
      let signatureValid = false;

      if (webhookSecret && signature) {
        const expectedSig = await hmacSha256(webhookSecret, rawBody);
        signatureValid = timingSafeStringEqual(expectedSig, signature);
      } else if (!webhookSecret) {
        logger.warn('Collab webhook: no secret configured', { ownerAuthUserId, inviteId });
        signatureValid = false;
      }

      let payload: { event_id?: string; event_type?: string };
      try {
        payload = JSON.parse(rawBody) as { event_id?: string; event_type?: string };
      } catch {
        logger.warn('Collab webhook: invalid JSON', { ownerAuthUserId, inviteId });
        return new Response('Bad Request', { status: 400 });
      }

      const eventId = payload.event_id ?? payload.event_type ?? '';
      const eventType = payload.event_type ?? 'unknown';

      if (!eventId) {
        logger.warn('Collab webhook: missing event_id', { ownerAuthUserId, inviteId });
        return new Response('OK', { status: 200 });
      }

      if (!signatureValid) {
        logger.warn('Collab webhook: rejected (unverified)', {
          ownerAuthUserId,
          inviteId,
          eventId,
        });
        return new Response('Forbidden', { status: 403 });
      }

      const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
        apiSecret,
        authUserId: ownerAuthUserId,
        provider: 'jinxxy',
        providerEventId: eventId,
        eventType,
        rawPayload: payload,
        signatureValid,
      });

      if (result.duplicate) {
        logger.debug('Collab webhook: duplicate event', { eventId, ownerAuthUserId, inviteId });
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
        ownerAuthUserId,
        inviteId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async function handleGumroadWebhook(request: Request, routeId: string): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      logger.info('Webhook received', {
        provider: 'gumroad',
        routeId,
        payloadBytes: rawBody.length,
      });

      const incomingSig = request.headers.get('x-gumroad-signature');
      // Look up secret by routeId — works for authUserId (user-scoped).
      const webhookSecret = await getGumroadWebhookSecretByRouteId(routeId);
      let signatureValid = false;

      if (webhookSecret && incomingSig) {
        const expectedSig = await hmacSha256(webhookSecret, rawBody);
        signatureValid = timingSafeStringEqual(expectedSig, incomingSig);
      } else if (!webhookSecret) {
        logger.warn('Gumroad webhook: no secret configured', { routeId });
      }

      const params = new URLSearchParams(rawBody);
      const saleId = params.get('sale_id') ?? params.get('order_number') ?? '';
      const refunded = params.get('refunded') === 'true';
      const eventType = refunded ? 'refund' : 'sale';
      const providerEventId = `${saleId}:${eventType}`;

      if (!saleId) {
        logger.warn('Gumroad webhook: missing sale_id/order_number', { routeId });
        return new Response('OK', { status: 200 });
      }

      // Resolve routeId → authUserIds (supports authUserId routing)
      let authUserIds: string[];
      try {
        authUserIds = await convex.query(api.webhookIngestion.resolveWebhookTenantIds, {
          apiSecret,
          authUserId: routeId,
        });
      } catch {
        authUserIds = [routeId];
      }

      // API verification: resource_subscriptions webhooks have no secret.
      // Verify sale exists via Gumroad API when signature is not valid.
      if (!signatureValid && encryptionSecret && authUserIds.length > 0) {
        for (const candidateUserId of authUserIds) {
          if (signatureValid) break;
          try {
            const conn = await convex.query(api.providerConnections.getConnectionForBackfill, {
              apiSecret,
              authUserId: candidateUserId,
              provider: 'gumroad',
            });
            if (conn?.gumroadAccessTokenEncrypted) {
              const accessToken = await decrypt(conn.gumroadAccessTokenEncrypted, encryptionSecret);
              const sale = await gumroadAdapter.getSale(accessToken, saleId);
              if (sale) {
                const apiRefunded = sale.refunded === true;
                if (apiRefunded === refunded) {
                  signatureValid = true;
                } else {
                  logger.warn('Gumroad webhook: refunded mismatch', {
                    routeId,
                    saleId,
                    webhookRefunded: refunded,
                    apiRefunded,
                  });
                }
              }
            }
          } catch (err) {
            logger.warn('Gumroad webhook: API verification failed', {
              routeId,
              saleId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (!signatureValid) {
        logger.warn('Gumroad webhook: rejected (unverified)', { routeId, saleId });
        return new Response('Forbidden', { status: 403 });
      }

      const saleTimestamp = params.get('sale_timestamp');
      if (saleTimestamp) {
        const ts = Date.parse(saleTimestamp);
        if (Number.isFinite(ts) && Date.now() - ts > WEBHOOK_MAX_AGE_MS) {
          logger.warn('Gumroad webhook: rejected (event too old)', { routeId });
          return new Response('Forbidden', { status: 403 });
        }
      }

      const payload = Object.fromEntries(params.entries());

      if (authUserIds.length > 0) {
        let anySuccess = false;
        for (const authUserId of authUserIds) {
          try {
            const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
              apiSecret,
              authUserId,
              provider: 'gumroad',
              providerEventId,
              eventType,
              rawPayload: payload,
              signatureValid,
            });
            if (result.duplicate) {
              logger.debug('Gumroad webhook: duplicate event', { saleId, authUserId });
            }
            anySuccess = true;
          } catch (err) {
            logger.warn('Gumroad webhook: failed to insert event for user', {
              authUserId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (!anySuccess) {
          logger.error('Gumroad webhook: all insert attempts failed', { routeId, saleId });
          return new Response('Internal Server Error', { status: 500 });
        }
      } else {
        // User-scoped: no Discord servers yet — store under authUserId
        try {
          const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
            apiSecret,
            authUserId: routeId,
            provider: 'gumroad',
            providerEventId,
            eventType,
            rawPayload: payload,
            signatureValid,
          });
          if (result.duplicate) {
            logger.debug('Gumroad webhook: duplicate event (user-scoped)', {
              saleId,
              routeId,
            });
          }
        } catch (err) {
          logger.warn('Gumroad webhook: failed to insert user-scoped event', {
            routeId,
            error: err instanceof Error ? err.message : String(err),
          });
          return new Response('Internal Server Error', { status: 500 });
        }
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      logger.error('Gumroad webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        routeId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async function handleJinxxyWebhook(request: Request, routeId: string): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      logger.info('Webhook received', {
        provider: 'jinxxy',
        routeId,
        payloadBytes: rawBody.length,
      });

      const signature = request.headers.get('x-signature');
      // Look up secret by routeId — works for authUserId (user-scoped).
      const secretRef = await getJinxxyWebhookSecretByRouteId(routeId);
      const convexSecret = secretRef ? await decrypt(secretRef, encryptionSecret) : null;
      const pendingSecret = await getPendingJinxxyWebhookSecret(routeId);
      const webhookSecret = convexSecret ?? pendingSecret;
      let signatureValid = false;

      if (webhookSecret && signature) {
        const expectedSig = await hmacSha256(webhookSecret, rawBody);
        let incomingSig = signature.trim();
        if (incomingSig.startsWith('sha256=')) {
          incomingSig = incomingSig.slice(7);
        }
        signatureValid = timingSafeStringEqual(expectedSig, incomingSig);
      } else if (!webhookSecret) {
        logger.warn('Jinxxy webhook: no secret configured', { routeId });
      }

      let payload: { event_id?: string; event_type?: string; created_at?: string };
      try {
        payload = JSON.parse(rawBody) as typeof payload;
      } catch {
        logger.warn('Jinxxy webhook: invalid JSON', { routeId });
        return new Response('Bad Request', { status: 400 });
      }

      const eventId = payload.event_id ?? payload.event_type ?? '';
      const eventType = payload.event_type ?? 'unknown';

      if (!eventId) {
        logger.warn('Jinxxy webhook: missing event_id', { routeId });
        return new Response('OK', { status: 200 });
      }

      if (!signatureValid) {
        logger.warn('Jinxxy webhook: rejected (unverified)', {
          routeId,
          eventId,
          hasConvexSecret: !!convexSecret,
          hasPendingSecret: !!pendingSecret,
          hasSignature: !!signature,
          signatureLen: signature?.length ?? 0,
        });
        return new Response('Forbidden', { status: 403 });
      }

      if (payload.created_at) {
        const ts = Date.parse(payload.created_at);
        if (Number.isFinite(ts) && Date.now() - ts > WEBHOOK_MAX_AGE_MS) {
          logger.warn('Jinxxy webhook: rejected (event too old)', { routeId, eventId });
          return new Response('Forbidden', { status: 403 });
        }
      }

      // Resolve routeId → authUserIds (supports authUserId routing)
      let authUserIds: string[];
      try {
        authUserIds = await convex.query(api.webhookIngestion.resolveWebhookTenantIds, {
          apiSecret,
          authUserId: routeId,
        });
      } catch {
        authUserIds = [routeId];
      }

      if (authUserIds.length > 0) {
        let anySuccess = false;
        for (const authUserId of authUserIds) {
          try {
            const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
              apiSecret,
              authUserId,
              provider: 'jinxxy',
              providerEventId: eventId,
              eventType,
              rawPayload: payload,
              signatureValid,
            });
            if (result.duplicate) {
              logger.debug('Jinxxy webhook: duplicate event', { eventId, authUserId });
            }
            anySuccess = true;
          } catch (err) {
            logger.warn('Jinxxy webhook: failed to insert event for user', {
              authUserId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (!anySuccess) {
          logger.error('Jinxxy webhook: all insert attempts failed', { routeId, eventId });
          return new Response('Internal Server Error', { status: 500 });
        }
      } else {
        // User-scoped: no Discord servers yet — store under authUserId
        try {
          const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
            apiSecret,
            authUserId: routeId,
            provider: 'jinxxy',
            providerEventId: eventId,
            eventType,
            rawPayload: payload,
            signatureValid,
          });
          if (result.duplicate) {
            logger.debug('Jinxxy webhook: duplicate event (user-scoped)', { eventId, routeId });
          }
        } catch (err) {
          logger.warn('Jinxxy webhook: failed to insert user-scoped event', {
            routeId,
            error: err instanceof Error ? err.message : String(err),
          });
          return new Response('Internal Server Error', { status: 500 });
        }
      }

      // Set test webhook flag for connect flow polling (keyed by routeId)
      try {
        const store = getStateStore();
        await store.set(`${JINXXY_TEST_PREFIX}${routeId}`, '1', JINXXY_TEST_TTL_MS);
      } catch {
        // Non-fatal
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      logger.error('Jinxxy webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        routeId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async function handlePayhipWebhook(request: Request, routeId: string): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const rawBody = await request.text();
      logger.info('Webhook received', {
        provider: 'payhip',
        routeId,
        payloadBytes: rawBody.length,
      });

      let payload: {
        id?: string;
        email?: string;
        type?: string;
        signature?: string;
        created_at?: string;
      };
      try {
        payload = JSON.parse(rawBody) as typeof payload;
      } catch {
        logger.warn('Payhip webhook: invalid JSON', { routeId });
        return new Response('Bad Request', { status: 400 });
      }

      // Payhip signature = SHA256(apiKey) — static, not HMAC of the body.
      // The signature field is inside the JSON payload itself.
      // routeId is an authUserId (user-scoped).
      const encryptedKey = await convex.query(api.providerConnections.getPayhipApiKeyByRouteId, {
        apiSecret,
        routeId,
      });
      const apiKey = encryptedKey ? await decrypt(encryptedKey, encryptionSecret) : null;
      let signatureValid = false;

      if (apiKey && payload.signature) {
        const expectedSig = await sha256Hex(apiKey);
        signatureValid = timingSafeStringEqual(expectedSig, payload.signature);
      } else if (!apiKey) {
        logger.warn('Payhip webhook: no API key configured', { routeId });
      }

      const eventId = payload.id ?? '';
      const eventType = payload.type ?? 'unknown';

      if (!eventId) {
        logger.warn('Payhip webhook: missing id', { routeId });
        return new Response('OK', { status: 200 });
      }

      if (!signatureValid) {
        logger.warn('Payhip webhook: rejected (invalid signature)', {
          routeId,
          eventId,
          hasApiKey: !!apiKey,
          hasSignature: !!payload.signature,
        });
        return new Response('Forbidden', { status: 403 });
      }

      if (payload.created_at) {
        const ts = Date.parse(payload.created_at);
        if (Number.isFinite(ts) && Date.now() - ts > WEBHOOK_MAX_AGE_MS) {
          logger.warn('Payhip webhook: rejected (event too old)', { routeId, eventId });
          return new Response('Forbidden', { status: 403 });
        }
      }

      // Resolve routeId → authUserIds (supports authUserId routing)
      let authUserIds: string[];
      try {
        authUserIds = await convex.query(api.webhookIngestion.resolveWebhookTenantIds, {
          apiSecret,
          authUserId: routeId,
        });
      } catch {
        authUserIds = [routeId];
      }

      if (authUserIds.length > 0) {
        let anySuccess = false;
        for (const authUserId of authUserIds) {
          try {
            const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
              apiSecret,
              authUserId,
              provider: 'payhip',
              providerEventId: eventId,
              eventType,
              rawPayload: payload,
              signatureValid,
            });
            if (result.duplicate) {
              logger.debug('Payhip webhook: duplicate event', { eventId, authUserId });
            }
            anySuccess = true;
          } catch (err) {
            logger.warn('Payhip webhook: failed to insert event for user', {
              authUserId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (!anySuccess) {
          logger.error('Payhip webhook: all insert attempts failed', { routeId, eventId });
          return new Response('Internal Server Error', { status: 500 });
        }
      } else {
        // User-scoped: no Discord servers yet — store under authUserId
        try {
          const result = await convex.mutation(api.webhookIngestion.insertWebhookEvent, {
            apiSecret,
            authUserId: routeId,
            provider: 'payhip',
            providerEventId: eventId,
            eventType,
            rawPayload: payload,
            signatureValid,
          });
          if (result.duplicate) {
            logger.debug('Payhip webhook: duplicate event (user-scoped)', { eventId, routeId });
          }
        } catch (err) {
          logger.warn('Payhip webhook: failed to insert user-scoped event', {
            routeId,
            error: err instanceof Error ? err.message : String(err),
          });
          return new Response('Internal Server Error', { status: 500 });
        }
      }

      // Mark webhook configured on the user-scoped connection (routeId = authUserId)
      try {
        await convex.mutation(api.providerConnections.markPayhipWebhookConfigured, {
          apiSecret,
          authUserId: routeId,
        });
      } catch {
        // Non-fatal
      }

      // Set test webhook flag for connect flow polling
      try {
        const store = getStateStore();
        await store.set(`${PAYHIP_TEST_PREFIX}${routeId}`, '1', PAYHIP_TEST_TTL_MS);
      } catch {
        // Non-fatal
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      logger.error('Payhip webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        routeId,
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
 * where routeId is an authUserId (Better Auth user ID, user-scoped connections).
 */
export function createWebhookHandler(
  config: WebhookConfig
): (request: Request) => Promise<Response> {
  const routes = createWebhookRoutes(config);

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

    // /webhooks/jinxxy-collab/:ownerAuthUserId/:inviteId
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

    // All providers use routeId-based routing with internal fan-out (user-scoped).
    if (provider === 'payhip') {
      return routes.handlePayhipWebhook(request, routeId);
    }
    if (provider === 'jinxxy') {
      return routes.handleJinxxyWebhook(request, routeId);
    }
    if (provider === 'gumroad') {
      return routes.handleGumroadWebhook(request, routeId);
    }

    logger.warn('Webhook unknown provider', { provider, routeId });
    return new Response('Not Found', { status: 404 });
  };
}
