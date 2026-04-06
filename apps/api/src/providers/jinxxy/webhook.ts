import { timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';

import type { getConvexClientFromUrl } from '../../lib/convex';
import { decrypt } from '../../lib/encrypt';
import { getStateStore } from '../../lib/stateStore';
import {
  isWebhookContentLengthTooLarge,
  PayloadTooLargeError,
  readWebhookTextBody,
} from '../../lib/webhookBody';
import type { WebhookPlugin } from '../types';
import {
  getJinxxyWebhookTestStoreKey,
  getPendingJinxxyWebhookTokenStoreKey,
  JINXXY_TEST_TTL_MS,
} from './pendingWebhookState';

type ConvexClient = ReturnType<typeof getConvexClientFromUrl>;

import { logger } from '../../lib/logger';

// HKDF purpose strings — inlined to avoid circular imports with index.ts
const WEBHOOK_SECRET_PURPOSE = 'jinxxy-webhook-signing-secret' as const;
const COLLAB_WEBHOOK_SECRET_PURPOSE = 'collab-webhook-signing-secret' as const;

const COLLAB_TEST_PREFIX = 'collab_test:';
const COLLAB_TEST_TTL_MS = 60 * 1000;
const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

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

async function getJinxxyWebhookSecretByRouteId(
  convex: ConvexClient,
  apiSecret: string,
  routeId: string
): Promise<string | null> {
  return await convex.query(api.providerConnections.getWebhookCredentialByRouteId, {
    apiSecret,
    routeId,
    provider: 'jinxxy',
    credentialKey: 'webhook_secret',
  });
}

async function getPendingJinxxyWebhookSecret(
  encryptionSecret: string,
  routeId: string
): Promise<string | null> {
  const store = getStateStore();
  // During test delivery, routeId is the opaque route token — look up under the token prefix.
  const raw = await store.get(getPendingJinxxyWebhookTokenStoreKey(routeId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { signingSecretEncrypted: string };
    // Allow decrypt failures to propagate so the caller can return 5xx.
    return await decrypt(parsed.signingSecretEncrypted, encryptionSecret, WEBHOOK_SECRET_PURPOSE);
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Corrupted state-store entry — treat as no pending secret.
      logger.warn('Jinxxy pending webhook: failed to parse stored secret', { routeId });
      return null;
    }
    throw err;
  }
}

async function getCollabWebhookSecret(
  convex: ConvexClient,
  apiSecret: string,
  encryptionSecret: string,
  inviteId: string
): Promise<string | null> {
  try {
    const encryptedSecret = await convex.query(api.collaboratorInvites.getCollabWebhookSecret, {
      apiSecret,
      inviteId,
    });
    if (!encryptedSecret) return null;
    return await decrypt(encryptedSecret, encryptionSecret, COLLAB_WEBHOOK_SECRET_PURPOSE);
  } catch {
    return null;
  }
}

async function handleJinxxyCollabWebhook(
  request: Request,
  ownerAuthUserId: string,
  inviteId: string,
  convex: ConvexClient,
  apiSecret: string,
  encryptionSecret: string
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (isWebhookContentLengthTooLarge(request)) {
    logger.warn('Collab webhook: rejected oversized payload', { ownerAuthUserId, inviteId });
    return new Response('Payload too large', { status: 413 });
  }

  try {
    const rawBody = await readWebhookTextBody(request);
    logger.info('Webhook received', {
      provider: 'jinxxy-collab',
      ownerAuthUserId,
      inviteId,
      payloadBytes: rawBody.length,
    });
    const signature = request.headers.get('x-signature');

    const webhookSecret = await getCollabWebhookSecret(
      convex,
      apiSecret,
      encryptionSecret,
      inviteId
    );
    let signatureValid = false;

    if (webhookSecret && signature) {
      const expectedSig = await hmacSha256(webhookSecret, rawBody);
      let incomingSig = signature.trim();
      if (incomingSig.startsWith('sha256=')) {
        incomingSig = incomingSig.slice(7);
      }
      signatureValid = timingSafeStringEqual(expectedSig, incomingSig);
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
      verificationMethod: 'hmac',
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

    if (process.env.NODE_ENV !== 'production') {
      logger.info('Webhook accepted', {
        provider: 'jinxxy-collab',
        ownerAuthUserId,
        inviteId,
        eventId,
        eventType,
      });
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      logger.warn('Collab webhook: rejected oversized payload', { ownerAuthUserId, inviteId });
      return new Response('Payload too large', { status: 413 });
    }
    logger.error('Collab webhook failed', {
      error: err instanceof Error ? err.message : String(err),
      ownerAuthUserId,
      inviteId,
    });
    return new Response('Internal Server Error', { status: 500 });
  }
}

export const webhook: WebhookPlugin = {
  extraProviders: ['jinxxy-collab'],

  async handle(request, routeId, urlProviderId, ctx) {
    const { convex, apiSecret, encryptionSecret } = ctx;

    if (urlProviderId === 'jinxxy-collab') {
      // Path: /webhooks/jinxxy-collab/:ownerAuthUserId/:inviteId
      const url = new URL(request.url);
      const pathParts = url.pathname.split('/').filter(Boolean);
      const inviteId = pathParts[3];
      if (!inviteId) {
        return new Response('Not Found', { status: 404 });
      }
      return handleJinxxyCollabWebhook(
        request,
        routeId,
        inviteId,
        convex,
        apiSecret,
        encryptionSecret
      );
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (isWebhookContentLengthTooLarge(request)) {
      logger.warn('Jinxxy webhook: rejected oversized payload', { routeId });
      return new Response('Payload too large', { status: 413 });
    }

    try {
      const rawBody = await readWebhookTextBody(request);
      logger.info('Webhook received', {
        provider: 'jinxxy',
        routeId,
        payloadBytes: rawBody.length,
      });

      const signature = request.headers.get('x-signature');
      const secretRef = await getJinxxyWebhookSecretByRouteId(convex, apiSecret, routeId);
      const convexSecret = secretRef
        ? await decrypt(secretRef, encryptionSecret, WEBHOOK_SECRET_PURPOSE)
        : null;
      const pendingSecret = await getPendingJinxxyWebhookSecret(encryptionSecret, routeId);
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

      // Replay protection: if the payload includes a timestamp, validate it.
      // Real Jinxxy webhooks may not include top-level created_at; in that case
      // we rely on HMAC signature verification + event_id deduplication.
      if (payload.created_at) {
        const ts = Date.parse(payload.created_at);
        if (!Number.isFinite(ts) || Date.now() - ts > WEBHOOK_MAX_AGE_MS) {
          logger.warn('Jinxxy webhook: rejected (event too old)', { routeId, eventId });
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
              provider: 'jinxxy',
              providerEventId: eventId,
              eventType,
              rawPayload: payload,
              signatureValid,
              verificationMethod: 'hmac',
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
            verificationMethod: 'hmac',
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
        await store.set(getJinxxyWebhookTestStoreKey(routeId), '1', JINXXY_TEST_TTL_MS);
      } catch {
        // Non-fatal
      }

      if (process.env.NODE_ENV !== 'production') {
        logger.info('Webhook accepted', {
          provider: 'jinxxy',
          routeId,
          eventId,
          eventType,
        });
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        logger.warn('Jinxxy webhook: rejected oversized payload', { routeId });
        return new Response('Payload too large', { status: 413 });
      }
      logger.error('Jinxxy webhook failed', {
        error: err instanceof Error ? err.message : String(err),
        routeId,
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
