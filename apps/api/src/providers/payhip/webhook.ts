import { createLogger, timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { decrypt } from '../../lib/encrypt';
import { getStateStore } from '../../lib/stateStore';
import {
  isWebhookContentLengthTooLarge,
  PayloadTooLargeError,
  readWebhookTextBody,
} from '../../lib/webhookBody';
import type { WebhookPlugin } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// HKDF purpose string — inlined to avoid circular imports with index.ts
const CREDENTIAL_PURPOSE = 'payhip-api-key' as const;

const PAYHIP_TEST_PREFIX = 'payhip_test:';
const PAYHIP_TEST_TTL_MS = 60 * 1000;
const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const webhook: WebhookPlugin = {
  async handle(request, routeId, _urlProviderId, ctx) {
    const { convex, apiSecret, encryptionSecret } = ctx;

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (isWebhookContentLengthTooLarge(request)) {
      logger.warn('Payhip webhook: rejected oversized payload', { routeId });
      return new Response('Payload too large', { status: 413 });
    }

    try {
      const rawBody = await readWebhookTextBody(request);
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
        /** Unix timestamp in seconds (present on "paid" events) */
        date?: number;
        /** Unix timestamp in seconds (present on "refunded" events) */
        date_created?: number;
        /** Unix timestamp in seconds (present on "refunded" events) */
        date_refunded?: number;
      };
      try {
        payload = JSON.parse(rawBody) as typeof payload;
      } catch {
        logger.warn('Payhip webhook: invalid JSON', { routeId });
        return new Response('Bad Request', { status: 400 });
      }

      // Payhip signature = SHA256(apiKey) — static, not HMAC of the body.
      const encryptedKey = await convex.query(api.providerConnections.getWebhookCredentialByRouteId, {
        apiSecret,
        routeId,
        provider: 'payhip',
        credentialKey: 'api_key',
      });
      const apiKey = encryptedKey
        ? await decrypt(encryptedKey, encryptionSecret, CREDENTIAL_PURPOSE)
        : null;
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

      // Replay protection: Payhip sends Unix-seconds timestamps.
      // "paid" events use `date`; "refunded" events use `date_refunded`.
      // If a recognized timestamp field is present, reject events older than WEBHOOK_MAX_AGE_MS.
      const rawTs =
        typeof payload.date === 'number'
          ? payload.date
          : typeof payload.date_refunded === 'number'
            ? payload.date_refunded
            : undefined;
      if (rawTs !== undefined) {
        const tsMs = rawTs * 1000;
        if (!Number.isFinite(tsMs) || Date.now() - tsMs > WEBHOOK_MAX_AGE_MS) {
          logger.warn('Payhip webhook: rejected (event too old)', { routeId, eventId });
          return new Response('Forbidden', { status: 403 });
        }
      }

      let authUserIds: string[];
      try {
        const connOwner = await convex.query(
          api.providerConnections.getConnectionByWebhookRouteToken,
          { apiSecret, webhookRouteToken: routeId }
        );
        const resolvedAuthUserId = connOwner?.authUserId ?? routeId;
        authUserIds = await convex.query(api.webhookIngestion.resolveWebhookTenantIds, {
          apiSecret,
          authUserId: resolvedAuthUserId,
        });
        if (authUserIds.length === 0) authUserIds = [resolvedAuthUserId];
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
              // Payhip's "signature" is SHA256(apiKey) — a static value per connection,
              // not a body-bound HMAC. Use 'static-key' to correctly model this trust level.
              verificationMethod: 'static-key',
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
            // Payhip's "signature" is SHA256(apiKey) — a static value per connection,
            // not a body-bound HMAC. Use 'static-key' to correctly model this trust level.
            verificationMethod: 'static-key',
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

      // Mark webhook configured on the connection using the opaque route token
      try {
        await convex.mutation(api.providerConnections.markWebhookConfigured, {
          apiSecret,
          provider: 'payhip',
          webhookRouteToken: routeId,
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

      if (process.env.NODE_ENV !== 'production') {
        logger.info('Webhook accepted', {
          provider: 'payhip',
          routeId,
          eventId,
          eventType,
        });
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        logger.warn('Payhip webhook: rejected oversized payload', { routeId });
        return new Response('Payload too large', { status: 413 });
      }
      logger.error('Payhip webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        routeId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
