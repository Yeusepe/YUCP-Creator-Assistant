/**
 * Audit Events - Convex mutations for security and support trail
 *
 * All functions require CONVEX_API_SECRET for API-to-Convex calls.
 * Called by the bot role sync service and other internal services.
 */

import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation } from './_generated/server';

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
  v.literal('subject.suspicious.cleared')
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
    tenantId: v.optional(v.id('tenants')),
    eventType: AuditEventType,
    actorType: v.union(v.literal('subject'), v.literal('system'), v.literal('admin')),
    actorId: v.optional(v.string()),
    subjectId: v.optional(v.id('subjects')),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    await ctx.db.insert('audit_events', {
      ...(args.tenantId && { tenantId: args.tenantId }),
      eventType: args.eventType,
      actorType: args.actorType,
      actorId: args.actorId,
      subjectId: args.subjectId,
      metadata: args.metadata,
      createdAt: Date.now(),
    });
  },
});
