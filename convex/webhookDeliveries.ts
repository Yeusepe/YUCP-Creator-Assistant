/**
 * Webhook Deliveries — per-event delivery attempt tracking with retry state.
 *
 * Delivery lifecycle: pending → in_progress → delivered | failed → dead_letter
 * Exponential backoff schedule: 30s, 5min, 30min, 2h, 8h.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';

// Exponential backoff in milliseconds: 30s, 5min, 30min, 2h, 8h
const BACKOFF_MS = [30_000, 300_000, 1_800_000, 7_200_000, 28_800_000];

// ---------------------------------------------------------------------------
// Internal queries & mutations
// ---------------------------------------------------------------------------

/**
 * List deliveries with status='pending' that are ready for processing now.
 * A delivery is ready if nextRetryAt is absent (immediate) or in the past.
 * Used by the delivery worker cron.
 */
export const listPending = internalQuery({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    const now = Date.now();
    const pending = await ctx.db
      .query('webhook_deliveries')
      .withIndex('by_status_retry', q => q.eq('status', 'pending'))
      .collect();
    return pending
      .filter(d => d.nextRetryAt === undefined || d.nextRetryAt <= now)
      .slice(0, 20);
  },
});

/** Mark a delivery as in_progress at the start of a delivery attempt. */
export const markInProgress = internalMutation({
  args: {
    deliveryId: v.id('webhook_deliveries'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.deliveryId, {
      status: 'in_progress',
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Mark a delivery as successfully delivered. Also updates subscription.lastDeliveryAt. */
export const markDelivered = internalMutation({
  args: {
    deliveryId: v.id('webhook_deliveries'),
    lastHttpStatus: v.number(),
    requestDurationMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery) throw new Error(`Delivery not found: ${args.deliveryId}`);

    const now = Date.now();
    await ctx.db.patch(args.deliveryId, {
      status: 'delivered',
      deliveredAt: now,
      lastHttpStatus: args.lastHttpStatus,
      requestDurationMs: args.requestDurationMs,
      updatedAt: now,
    });

    await ctx.db.patch(delivery.subscriptionId, {
      lastDeliveryAt: now,
      updatedAt: now,
    });

    return null;
  },
});

/**
 * Mark a delivery as failed and schedule a retry using exponential backoff.
 * If attemptCount reaches maxAttempts the delivery moves to dead_letter.
 */
export const markFailed = internalMutation({
  args: {
    deliveryId: v.id('webhook_deliveries'),
    lastHttpStatus: v.optional(v.number()),
    lastError: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery) throw new Error(`Delivery not found: ${args.deliveryId}`);

    const newAttemptCount = delivery.attemptCount + 1;
    const isDead = newAttemptCount >= delivery.maxAttempts;
    const backoffIdx = Math.min(newAttemptCount - 1, BACKOFF_MS.length - 1);

    const patch: {
      status: 'failed' | 'dead_letter';
      attemptCount: number;
      updatedAt: number;
      nextRetryAt?: number;
      lastHttpStatus?: number;
      lastError?: string;
    } = {
      status: isDead ? 'dead_letter' : 'failed',
      attemptCount: newAttemptCount,
      updatedAt: Date.now(),
    };

    if (!isDead) patch.nextRetryAt = Date.now() + BACKOFF_MS[backoffIdx];
    if (args.lastHttpStatus !== undefined) patch.lastHttpStatus = args.lastHttpStatus;
    if (args.lastError !== undefined) patch.lastError = args.lastError;

    await ctx.db.patch(args.deliveryId, patch);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

/**
 * List deliveries for a subscription with optional status filter and
 * cursor-based pagination. Verifies subscription ownership via authUserId.
 */
export const listBySubscription = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    subscriptionId: v.id('webhook_subscriptions'),
    status: v.optional(
      v.union(
        v.literal('pending'),
        v.literal('in_progress'),
        v.literal('delivered'),
        v.literal('failed'),
        v.literal('dead_letter')
      )
    ),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    deliveries: v.array(v.any()),
    hasMore: v.boolean(),
    nextCursor: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const subscription = await ctx.db.get(args.subscriptionId);
    if (!subscription || subscription.authUserId !== args.authUserId) {
      throw new Error('Subscription not found or access denied');
    }

    let deliveries = await ctx.db
      .query('webhook_deliveries')
      .withIndex('by_subscription', q => q.eq('subscriptionId', args.subscriptionId))
      .order('desc')
      .collect();

    if (args.status !== undefined) {
      deliveries = deliveries.filter(d => d.status === args.status);
    }

    const pageSize = Math.min(args.limit ?? 50, 100);
    let startIdx = 0;
    if (args.cursor) {
      const idx = deliveries.findIndex(d => d._id === args.cursor);
      if (idx !== -1) startIdx = idx + 1;
    }

    const page = deliveries.slice(startIdx, startIdx + pageSize);
    const hasMore = deliveries.length > startIdx + pageSize;
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]._id : undefined;

    return { deliveries: page, hasMore, nextCursor };
  },
});
