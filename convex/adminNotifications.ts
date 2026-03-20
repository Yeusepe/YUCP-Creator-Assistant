/**
 * Admin Notifications — Bot-to-dashboard real-time event channel.
 *
 * Lifecycle:
 *  1. Discord bot fires POST /api/internal/notify → API validates secret →
 *     calls internal mutation `create`
 *  2. Dashboard subscribes to `listUnseen` via Convex React hook (live updates)
 *  3. Dashboard calls `markSeen` mutation when toasts are shown
 *  4. Cron job calls `cleanupExpired` every minute to purge stale records
 *
 * Security:
 *  - `create` is internalMutation: only callable from Convex actions/mutations
 *    or via the API secret-authenticated HTTP route
 *  - `listUnseen` and `markSeen` use `authComponent.getAuthUser` to ensure
 *    the caller can only access their own notifications
 */

import { ConvexError, v } from 'convex/values';
import { authComponent } from './auth';
import { internalMutation, mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';

const NOTIFICATION_TTL_MS = 60_000; // 60 seconds

// ─────────────────────────────────────────────────────────────────────────────
// Internal Mutation — create (called by API route)
// ─────────────────────────────────────────────────────────────────────────────

export const create = internalMutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    guildId: v.string(),
    type: v.union(
      v.literal('success'),
      v.literal('error'),
      v.literal('warning'),
      v.literal('info')
    ),
    title: v.string(),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    await ctx.db.insert('admin_notifications', {
      authUserId: args.authUserId,
      guildId: args.guildId,
      type: args.type,
      title: args.title,
      message: args.message,
      expiresAt: now + NOTIFICATION_TTL_MS,
      createdAt: now,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Query — listUnseen (dashboard live subscription)
// ─────────────────────────────────────────────────────────────────────────────

export const listUnseen = query({
  args: {},
  handler: async (ctx) => {
    // biome-ignore lint/suspicious/noExplicitAny: Convex auth generic
    const authUser = (await authComponent.getAuthUser(ctx)) as { id?: string } | null;
    if (!authUser?.id) {
      return [];
    }

    const now = Date.now();
    return await ctx.db
      .query('admin_notifications')
      .withIndex('by_auth_user_unseen', (q) => q.eq('authUserId', authUser.id as string).eq('seenAt', undefined))
      .filter((q) => q.gt(q.field('expiresAt'), now))
      .order('asc')
      .collect();
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation — markSeen (dashboard marks notifications as shown)
// ─────────────────────────────────────────────────────────────────────────────

export const markSeen = mutation({
  args: {
    ids: v.array(v.id('admin_notifications')),
  },
  handler: async (ctx, args) => {
    // biome-ignore lint/suspicious/noExplicitAny: Convex auth generic
    const authUser = (await authComponent.getAuthUser(ctx)) as { id?: string } | null;
    if (!authUser?.id) {
      throw new ConvexError('Unauthenticated');
    }

    const now = Date.now();
    await Promise.all(
      args.ids.map(async (id) => {
        const doc = await ctx.db.get(id);
        // Only mark notifications belonging to this user
        if (doc && doc.authUserId === authUser.id) {
          await ctx.db.patch(id, { seenAt: now });
        }
      })
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal Mutation — cleanupExpired (called by cron)
// ─────────────────────────────────────────────────────────────────────────────

export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query('admin_notifications')
      .withIndex('by_expires', (q) => q.lt('expiresAt', now))
      .take(100);

    await Promise.all(expired.map((doc) => ctx.db.delete(doc._id)));
    return { deleted: expired.length };
  },
});
