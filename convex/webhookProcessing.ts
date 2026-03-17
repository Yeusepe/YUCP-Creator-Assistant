/**
 * Webhook Processing - Normalization Pipeline
 *
 * Processes pending webhook events: normalize to purchase_facts,
 * link subject by email, project entitlements (respecting verificationScope),
 * emit role_sync jobs.
 *
 * Plan Phase 3: event → purchase_facts → link subject → entitlements → role_sync
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { processGumroadEvent } from './webhooks/gumroad';
import { processJinxxyEvent } from './webhooks/jinxxy';
import { processLemonEvent } from './webhooks/lemonsqueezy';
import { processPayhipEvent } from './webhooks/payhip';
import { requireApiSecret } from './lib/apiAuth';

/**
 * Get IDs of pending webhook events for processing.
 */
export const getPendingEventIds = internalQuery({
  args: {
    apiSecret: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.id('webhook_events')),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = Math.min(args.limit ?? 10, 50);
    const events = await ctx.db
      .query('webhook_events')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .order('asc')
      .take(limit);
    return events.map((e) => e._id);
  },
});

/**
 * Process a single webhook event.
 * Internal mutation - idempotent per event.
 */
export const processWebhookEvent = internalMutation({
  args: {
    apiSecret: v.string(),
    eventId: v.id('webhook_events'),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const event = await ctx.db.get(args.eventId);
    if (!event) {
      return { success: false, error: 'Event not found' };
    }
    if (event.signatureValid !== true) {
      throw new ConvexError('Cannot process unverified webhook event');
    }
    if (event.status !== 'pending') {
      return { success: true }; // Already processed
    }
    if (!event.authUserId) {
      await ctx.db.patch(args.eventId, {
        status: 'failed',
        errorMessage: 'Missing authUserId',
        processedAt: Date.now(),
      });
      return { success: false, error: 'Missing authUserId' };
    }

    const authUserId = event.authUserId;
    const provider = (event.providerKey ?? event.provider) as string;
    const rawPayload = event.rawPayload as Record<string, unknown>;

    const EVENT_PROCESSORS: Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: processor functions use any for ctx/event
      (ctx: any, authUserId: string, event: any, payload: Record<string, unknown>) => Promise<void>
    > = {
      gumroad: processGumroadEvent,
      jinxxy: processJinxxyEvent,
      lemonsqueezy: processLemonEvent,
      payhip: processPayhipEvent,
    };

    try {
      const processor = EVENT_PROCESSORS[provider];
      if (processor) {
        await processor(ctx, authUserId, event, rawPayload);
      } else {
        await ctx.db.patch(args.eventId, {
          status: 'failed',
          errorMessage: `Unsupported provider: ${provider}`,
          processedAt: Date.now(),
        });
        return { success: false, error: `Unsupported provider: ${provider}` };
      }

      await ctx.db.patch(args.eventId, {
        status: 'processed',
        processedAt: Date.now(),
      });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.db.patch(args.eventId, {
        status: 'failed',
        errorMessage: msg,
        processedAt: Date.now(),
      });
      return { success: false, error: msg };
    }
  },
});

/**
 * Process up to N pending webhook events.
 * Internal action - fetches pending events and calls processWebhookEvent for each.
 * Called by scheduled job or via public processPendingWebhookEventsAction.
 */
export const processPendingWebhookEvents = internalAction({
  args: {
    apiSecret: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
    failed: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = Math.min(args.limit ?? 10, 50);

    const events = await ctx.runQuery(internal.webhookProcessing.getPendingEventIds, {
      apiSecret: args.apiSecret,
      limit,
    });

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const eventId of events) {
      const result = await ctx.runMutation(internal.webhookProcessing.processWebhookEvent, {
        apiSecret: args.apiSecret,
        eventId,
      });
      if (result.success) {
        processed++;
      } else {
        failed++;
        if (result.error) errors.push(result.error);
      }
    }

    return { processed, failed, errors };
  },
});
