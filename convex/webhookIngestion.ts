/**
 * Webhook Ingestion
 *
 * Inserts raw webhook events from Gumroad and Jinxxy.
 * Normalization to purchase_facts and entitlements is handled by separate pipeline.
 */

import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { ProviderV, WebhookProviderV } from './lib/providers';
import { requireApiSecret } from './lib/apiAuth';

/**
 * Determines whether a webhook event is considered authenticated and may enter
 * the processing pipeline.
 *
 * Three verification models are supported:
 *   - 'hmac': the event carries a body-bound HMAC that was verified (Jinxxy, LemonSqueezy).
 *             signatureValid must also be true.
 *   - 'static-key': authenticated by comparing a static key-derived value (Payhip). The
 *             "signature" is SHA256(apiKey) — constant per connection, not body-bound.
 *             signatureValid must also be true.
 *   - 'route-token': the event was authenticated by a private random URL token (Gumroad Ping).
 *             No body signature exists by design; the token IS the authenticator.
 *
 * Legacy events with no verificationMethod fall back to the original signatureValid flag.
 */
export function isAuthenticatedEvent(event: {
  signatureValid: boolean;
  verificationMethod?: 'hmac' | 'static-key' | 'route-token';
}): boolean {
  if (event.verificationMethod === 'route-token') return true;
  if (event.verificationMethod === 'hmac') return event.signatureValid === true;
  if (event.verificationMethod === 'static-key') return event.signatureValid === true;
  // Legacy path: no verificationMethod stored — trust signatureValid directly.
  return event.signatureValid === true;
}

const VerificationMethodV = v.optional(
  v.union(v.literal('hmac'), v.literal('static-key'), v.literal('route-token'))
);

/**
 * Insert a webhook event from any provider.
 * Idempotent: deduplication by (authUserId, provider, providerEventId).
 */
export const insertWebhookEvent = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: WebhookProviderV,
    providerKey: v.optional(ProviderV),
    providerConnectionId: v.optional(v.id('provider_connections')),
    providerEventId: v.string(),
    eventType: v.string(),
    rawPayload: v.any(),
    signatureValid: v.boolean(),
    verificationMethod: VerificationMethodV,
  },
  returns: v.object({
    success: v.boolean(),
    eventId: v.optional(v.id('webhook_events')),
    duplicate: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const authUserId = args.authUserId;
    const now = Date.now();

    const existing = await ctx.db
      .query('webhook_events')
      .withIndex('by_auth_user_provider_event', (q) =>
        q
          .eq('authUserId', authUserId)
          .eq('provider', args.provider)
          .eq('providerEventId', args.providerEventId)
      )
      .first();

    if (existing) {
      return { success: true, duplicate: true };
    }

    const eventId = await ctx.db.insert('webhook_events', {
      provider: args.provider,
      providerKey: args.providerKey ?? args.provider,
      providerConnectionId: args.providerConnectionId,
      providerEventId: args.providerEventId,
      eventType: args.eventType,
      rawPayload: args.rawPayload,
      signatureValid: args.signatureValid,
      verificationMethod: args.verificationMethod,
      status: 'pending',
      authUserId: args.authUserId,
      receivedAt: now,
    });

    return { success: true, eventId, duplicate: false };
  },
});

/**
 * Reset a processed webhook event to pending for reprocessing.
 * Use when processing logic was fixed and you need to re-run (e.g. Jinxxy subject lookup).
 * Call via: npx convex run webhookIngestion:resetWebhookForReprocessing '{"apiSecret":"...","eventId":"m577vcj9b8vpqa56n6fq8zywn5829sf4"}'
 */
export const resetWebhookForReprocessing = mutation({
  args: {
    apiSecret: v.string(),
    eventId: v.id('webhook_events'),
  },
  returns: v.object({ success: v.boolean(), message: v.string() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const event = await ctx.db.get(args.eventId);
    if (!event) {
      return { success: false, message: 'Event not found' };
    }
    if (!isAuthenticatedEvent(event)) {
      throw new ConvexError('Cannot requeue an unverified webhook event');
    }
    if (event.status !== 'processed') {
      return { success: false, message: `Event status is ${event.status}, expected processed` };
    }
    await ctx.db.patch(args.eventId, { status: 'pending' });
    return { success: true, message: 'Reset to pending; cron will reprocess within ~1 min' };
  },
});

/**
 * Get pending webhook events for processing (used by normalization pipeline).
 */
export const getPendingWebhookEvents = query({
  args: {
    apiSecret: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id('webhook_events'),
      authUserId: v.optional(v.string()),
      provider: ProviderV,
      providerKey: v.optional(ProviderV),
      providerConnectionId: v.optional(v.id('provider_connections')),
      providerEventId: v.string(),
      eventType: v.string(),
      rawPayload: v.any(),
      signatureValid: v.boolean(),
      verificationMethod: VerificationMethodV,
      status: v.string(),
      receivedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = Math.min(args.limit ?? 50, 100);
    // Over-fetch then filter: only process events that are authenticated (HMAC or route-token)
    // so the pipeline never acts on tampered or unverifiable payloads.
    const events = await ctx.db
      .query('webhook_events')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .order('asc')
      .take(limit * 2);
    return events.filter(isAuthenticatedEvent).slice(0, limit);
  },
});

/**
 * Resolves a webhook authUserId to one or more creator authUserIds.
 * Returns an empty array if the authUserId doesn't match any creator profile.
 */
export const resolveWebhookAuthUserIds = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (profile) return [args.authUserId];

    return [];
  },
});

// Backward-compatible alias for existing callers
export { resolveWebhookAuthUserIds as resolveWebhookTenantIds };
