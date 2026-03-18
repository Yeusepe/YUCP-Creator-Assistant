/**
 * Webhook Delivery Worker — processes pending webhook deliveries.
 *
 * For each pending delivery the worker:
 *   1. Marks the delivery in_progress
 *   2. Fetches the subscription (with encrypted signing secret) and the event
 *   3. Decrypts the signing secret using HKDF-AES-256-GCM
 *   4. Builds the canonical event payload
 *   5. Signs the payload with HMAC-SHA256
 *   6. HTTP POSTs to the subscription URL with a 10-second timeout
 *   7. Marks delivered on 2xx or failed (with backoff) otherwise
 */

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

async function decryptSecret(
  ciphertextB64: string,
  secret: string,
  purpose: string
): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'HKDF',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(purpose) },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const combined = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

async function computeHmacSha256(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Worker action
// ---------------------------------------------------------------------------

export const processWebhookDeliveries = internalAction({
  args: {},
  returns: v.object({
    processed: v.number(),
    failed: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx): Promise<{ processed: number; failed: number; errors: string[] }> => {
    const encryptionSecret = process.env.ENCRYPTION_SECRET;
    if (!encryptionSecret) {
      throw new Error('ENCRYPTION_SECRET is required for delivery worker');
    }

    const deliveries = (await ctx.runQuery(
      internal.webhookDeliveries.listPending,
      {}
    )) as Array<{
      _id: string;
      subscriptionId: string;
      eventId: string;
      authUserId: string;
    }>;

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const delivery of deliveries) {
      try {
        await ctx.runMutation(internal.webhookDeliveries.markInProgress, {
          deliveryId: delivery._id as any,
        });

        const subscription = (await ctx.runQuery(
          internal.webhookSubscriptions.getByIdInternal,
          { subscriptionId: delivery.subscriptionId as any }
        )) as {
          url: string;
          signingSecretEnc: string;
          enabled: boolean;
        } | null;

        if (!subscription) {
          await ctx.runMutation(internal.webhookDeliveries.markFailed, {
            deliveryId: delivery._id as any,
            lastError: 'Subscription not found',
          });
          failed++;
          errors.push(`Delivery ${delivery._id}: subscription not found`);
          continue;
        }

        if (!subscription.enabled) {
          // Subscription was disabled after this delivery was queued — drop it so the
          // creator's disable action takes effect even for already-queued jobs.
          await ctx.runMutation(internal.webhookDeliveries.markFailed, {
            deliveryId: delivery._id as any,
            lastError: 'Subscription disabled',
          });
          failed++;
          continue;
        }

        const event = (await ctx.runQuery(internal.creatorEvents.getByIdInternal, {
          eventId: delivery.eventId as any,
        })) as {
          _id: string;
          eventType: string;
          data: unknown;
          createdAt: number;
        } | null;

        if (!event) {
          await ctx.runMutation(internal.webhookDeliveries.markFailed, {
            deliveryId: delivery._id as any,
            lastError: 'Event not found',
          });
          failed++;
          errors.push(`Delivery ${delivery._id}: event not found`);
          continue;
        }

        let signingSecret: string;
        try {
          signingSecret = await decryptSecret(
            subscription.signingSecretEnc,
            encryptionSecret,
            'yucp-webhook-signing-secret'
          );
        } catch {
          await ctx.runMutation(internal.webhookDeliveries.markFailed, {
            deliveryId: delivery._id as any,
            lastError: 'Failed to decrypt signing secret',
          });
          failed++;
          errors.push(`Delivery ${delivery._id}: decryption failed`);
          continue;
        }

        const payload = {
          id: event._id,
          object: 'event',
          type: event.eventType,
          apiVersion: '2025-03-01',
          created: event.createdAt,
          data: { object: event.data },
        };

        const body = JSON.stringify(payload);
        const hmacHex = await computeHmacSha256(body, signingSecret);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        const requestStart = Date.now();

        try {
          const response = await fetch(subscription.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Yucp-Signature': `sha256=${hmacHex}`,
              'X-Yucp-Delivery': delivery._id,
              'User-Agent': 'Yucp-Webhook/1.0',
            },
            body,
            signal: controller.signal,
          });

          const duration = Date.now() - requestStart;
          const status = response.status;

          if (status >= 200 && status < 300) {
            await ctx.runMutation(internal.webhookDeliveries.markDelivered, {
              deliveryId: delivery._id as any,
              lastHttpStatus: status,
              requestDurationMs: duration,
            });
            processed++;
          } else {
            await ctx.runMutation(internal.webhookDeliveries.markFailed, {
              deliveryId: delivery._id as any,
              lastHttpStatus: status,
              lastError: `HTTP ${status}`,
            });
            failed++;
            errors.push(`Delivery ${delivery._id}: HTTP ${status}`);
          }
        } catch (fetchErr) {
          const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          await ctx.runMutation(internal.webhookDeliveries.markFailed, {
            deliveryId: delivery._id as any,
            lastError: errMsg,
          });
          failed++;
          errors.push(`Delivery ${delivery._id}: ${errMsg}`);
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failed++;
        errors.push(`Delivery ${delivery._id}: unexpected error — ${errMsg}`);
      }
    }

    return { processed, failed, errors };
  },
});
