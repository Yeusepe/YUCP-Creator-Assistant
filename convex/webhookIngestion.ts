/**
 * Webhook Ingestion
 *
 * Inserts raw webhook events from Gumroad and Jinxxy.
 * Normalization to purchase_facts and entitlements is handled by separate pipeline.
 */

import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { ProviderV, WebhookProviderV } from './lib/providers';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/**
 * Insert a webhook event from any provider.
 * Idempotent: deduplication by (authUserId, provider, providerEventId).
 */
export const insertWebhookEvent = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.optional(v.string()),
    provider: WebhookProviderV,
    providerKey: v.optional(ProviderV),
    providerConnectionId: v.optional(v.id('provider_connections')),
    providerEventId: v.string(),
    eventType: v.string(),
    rawPayload: v.any(),
    signatureValid: v.boolean(),
  },
  returns: v.object({
    success: v.boolean(),
    eventId: v.optional(v.id('webhook_events')),
    duplicate: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    if (!args.authUserId) {
      throw new Error('authUserId must be provided');
    }

    const now = Date.now();

    const existing = await ctx.db
      .query('webhook_events')
      .withIndex('by_auth_user_provider_event', (q) =>
        q
          .eq('authUserId', args.authUserId)
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
      status: v.string(),
      receivedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = Math.min(args.limit ?? 50, 100);
    const events = await ctx.db
      .query('webhook_events')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .order('asc')
      .take(limit);
    return events;
  },
});

/**
 * Resolves a webhook route ID to one or more creator authUserIds.
 * Returns an empty array if the routeId doesn't match any creator profile.
 */
export const resolveWebhookTenantIds = query({
  args: {
    apiSecret: v.string(),
    routeId: v.string(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.routeId))
      .first();
    if (profile) return [args.routeId];

    return [];
  },
});
