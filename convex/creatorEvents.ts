/**
 * Creator Events — internal event stream for the Public API v2 webhook system.
 *
 * Stores platform-emitted events (purchases, entitlement grants, etc.) and
 * fans them out to matching webhook subscriptions.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { internal } from './_generated/api';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

// ---------------------------------------------------------------------------
// Internal mutations & queries
// ---------------------------------------------------------------------------

/** Insert a creator_events record. No fan-out — call fanOutToSubscriptions separately. */
export const emitEvent = internalMutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    eventType: v.string(),
    resourceType: v.string(),
    resourceId: v.string(),
    data: v.any(),
  },
  returns: v.id('creator_events'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await ctx.db.insert('creator_events', {
      authUserId: args.authUserId,
      eventType: args.eventType,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      data: args.data,
      createdAt: Date.now(),
    });
  },
});

/**
 * Fan out a creator event to all matching enabled webhook subscriptions.
 * For each matching subscription, inserts a webhook_deliveries record with
 * status='pending' ready for immediate processing.
 *
 * Matching rule: subscription.events is empty (subscribe to all), or it
 * explicitly includes the eventType.
 */
export const fanOutToSubscriptions = internalMutation({
  args: {
    eventId: v.id('creator_events'),
    authUserId: v.string(),
    eventType: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const subscriptions = await ctx.db
      .query('webhook_subscriptions')
      .withIndex('by_auth_user_enabled', q =>
        q.eq('authUserId', args.authUserId).eq('enabled', true)
      )
      .collect();

    const matching = subscriptions.filter(
      sub => sub.events.length === 0 || sub.events.includes(args.eventType)
    );

    const now = Date.now();
    for (const sub of matching) {
      await ctx.db.insert('webhook_deliveries', {
        authUserId: args.authUserId,
        subscriptionId: sub._id,
        eventId: args.eventId,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 5,
        createdAt: now,
        updatedAt: now,
      });
    }

    return matching.length;
  },
});

/** Get event by ID without authUserId check — for the delivery worker only. */
export const getByIdInternal = internalQuery({
  args: {
    eventId: v.id('creator_events'),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.eventId);
  },
});

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

/**
 * List events for a creator with optional filters and cursor-based pagination.
 * Cursor is the _id of the last document seen; pass it as `cursor` on the
 * next request to continue from where you left off.
 */
export const listByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    eventType: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    events: v.array(v.any()),
    hasMore: v.boolean(),
    nextCursor: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let events;
    if (args.eventType !== undefined) {
      events = await ctx.db
        .query('creator_events')
        .withIndex('by_auth_user_type', q =>
          q.eq('authUserId', args.authUserId).eq('eventType', args.eventType!)
        )
        .order('desc')
        .collect();
      if (args.resourceId !== undefined) {
        events = events.filter(e => e.resourceId === args.resourceId);
      }
    } else if (args.resourceId !== undefined) {
      events = await ctx.db
        .query('creator_events')
        .withIndex('by_auth_user_resource', q =>
          q.eq('authUserId', args.authUserId).eq('resourceId', args.resourceId!)
        )
        .order('desc')
        .collect();
    } else {
      events = await ctx.db
        .query('creator_events')
        .withIndex('by_auth_user', q => q.eq('authUserId', args.authUserId))
        .order('desc')
        .collect();
    }

    const pageSize = Math.min(args.limit ?? 50, 100);
    let startIdx = 0;
    if (args.cursor) {
      const idx = events.findIndex(e => e._id === args.cursor);
      if (idx !== -1) startIdx = idx + 1;
    }

    const page = events.slice(startIdx, startIdx + pageSize);
    const hasMore = events.length > startIdx + pageSize;
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]._id : undefined;

    return { events: page, hasMore, nextCursor };
  },
});

/** Get a single event by ID. Returns null if not found or authUserId does not match. */
export const getById = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    eventId: v.id('creator_events'),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const event = await ctx.db.get(args.eventId);
    if (!event || event.authUserId !== args.authUserId) return null;
    return event;
  },
});

/**
 * Emit a test `ping` event for a creator, fanning it out to all enabled webhook
 * subscriptions. Called by the public API's `POST /webhooks/:id/test` route.
 */
export const emitPingEvent = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.id('creator_events'),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const eventId = await ctx.db.insert('creator_events', {
      authUserId: args.authUserId,
      eventType: 'ping',
      resourceType: 'ping',
      resourceId: 'test',
      data: { message: 'Webhook test from Public API' },
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.creatorEvents.fanOutToSubscriptions, {
      eventId,
      authUserId: args.authUserId,
      eventType: 'ping',
    });
    return eventId;
  },
});
