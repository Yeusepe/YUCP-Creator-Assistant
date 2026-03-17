/**
 * Audit Events - Convex mutations for security and support trail
 *
 * All functions require CONVEX_API_SECRET for API-to-Convex calls.
 * Called by the bot role sync service and other internal services.
 */

import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

const AuditEventType = v.union(
  v.literal('verification.session.created'),
  v.literal('verification.session.completed'),
  v.literal('verification.provider.completed'),
  v.literal('binding.created'),
  v.literal('binding.activated'),
  v.literal('binding.revoked'),
  v.literal('binding.transferred'),
  v.literal('entitlement.granted'),
  v.literal('entitlement.revoked'),
  v.literal('discord.role.sync.requested'),
  v.literal('discord.role.sync.completed'),
  v.literal('discord.role.removal.completed'),
  v.literal('unity.assertion.issued'),
  v.literal('unity.assertion.revoked'),
  v.literal('secret.accessed'),
  v.literal('creator.policy.updated'),
  v.literal('tenant.created'),
  v.literal('tenant.updated'),
  v.literal('guild.linked'),
  v.literal('guild.unlinked'),
  v.literal('subject.status.updated'),
  v.literal('subject.suspicious.marked'),
  v.literal('subject.suspicious.cleared'),
  v.literal('collaborator.invite.created'),
  v.literal('collaborator.invite.accepted'),
  v.literal('collaborator.invite.revoked'),
  v.literal('collaborator.connection.added'),
  v.literal('collaborator.connection.removed')
);

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/**
 * Create an audit event. Called by role sync service and other internal callers.
 */
export const createAuditEvent = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.optional(v.string()),
    eventType: AuditEventType,
    actorType: v.union(v.literal('subject'), v.literal('system'), v.literal('admin')),
    actorId: v.optional(v.string()),
    subjectId: v.optional(v.id('subjects')),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    await ctx.db.insert('audit_events', {
      ...(args.authUserId && { authUserId: args.authUserId }),
      eventType: args.eventType,
      actorType: args.actorType,
      actorId: args.actorId,
      subjectId: args.subjectId,
      metadata: args.metadata,
      createdAt: Date.now(),
    });
  },
});

/**
 * List audit events by authUserId with optional type/subjectId filter and pagination.
 */
export const listByAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    type: v.optional(v.string()),
    subjectId: v.optional(v.id('subjects')),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    let all = await ctx.db
      .query('audit_events')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    if (args.type) {
      all = all.filter((e) => e.eventType === args.type);
    }
    if (args.subjectId) {
      all = all.filter((e) => e.subjectId === args.subjectId);
    }

    const limit = Math.min(args.limit ?? 50, 100);
    let startIndex = 0;
    if (args.cursor) {
      const idx = all.findIndex((item) => String(item._id) === args.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const data = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    return {
      data,
      hasMore,
      nextCursor: hasMore ? String(data[data.length - 1]._id) : null,
    };
  },
});
