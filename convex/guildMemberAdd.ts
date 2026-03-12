/**
 * Guild Member Add - Auto-apply roles on join
 *
 * Plan Phase 5: When a user joins a guild, resolve guild→tenant, member→subject,
 * load entitlements, and queue role_sync if autoVerifyOnJoin. No provider API calls.
 */

import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation } from './_generated/server';

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

/**
 * Handle guild member join: queue role_sync jobs if user has entitlements.
 * Called by bot on guildMemberAdd.
 */
export const handleGuildMemberJoin = mutation({
  args: {
    apiSecret: v.string(),
    discordGuildId: v.string(),
    discordUserId: v.string(),
  },
  returns: v.object({
    queued: v.boolean(),
    jobCount: v.number(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const guildLink = await ctx.db
      .query('guild_links')
      .withIndex('by_discord_guild', (q) => q.eq('discordGuildId', args.discordGuildId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (!guildLink) {
      return { queued: false, jobCount: 0, reason: 'Guild not linked' };
    }

    const tenant = await ctx.db.get(guildLink.tenantId);
    if (!tenant) {
      return { queued: false, jobCount: 0, reason: 'Tenant not found' };
    }

    const autoVerifyOnJoin = tenant.policy?.autoVerifyOnJoin ?? false;
    if (!autoVerifyOnJoin) {
      return { queued: false, jobCount: 0, reason: 'autoVerifyOnJoin disabled' };
    }

    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .first();

    if (!subject) {
      return { queued: false, jobCount: 0, reason: 'Subject not found (never verified)' };
    }

    if (
      subject.primaryDiscordUserId.startsWith('gumroad:') ||
      subject.primaryDiscordUserId.startsWith('jinxxy:')
    ) {
      return { queued: false, jobCount: 0, reason: 'Subject has no real Discord ID' };
    }

    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_tenant_subject', (q) =>
        q.eq('tenantId', guildLink.tenantId).eq('subjectId', subject._id)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    if (entitlements.length === 0) {
      return { queued: false, jobCount: 0, reason: 'No active entitlements' };
    }

    const now = Date.now();
    let jobCount = 0;

    for (const ent of entitlements) {
      const idempotencyKey = `guild_join_sync:${guildLink.tenantId}:${subject._id}:${ent._id}:${args.discordGuildId}`;
      const existing = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
        .first();
      if (existing) continue;

      await ctx.db.insert('outbox_jobs', {
        tenantId: guildLink.tenantId,
        jobType: 'role_sync',
        payload: {
          subjectId: subject._id,
          entitlementId: ent._id,
          discordUserId: args.discordUserId,
          targetGuildId: args.discordGuildId,
        },
        status: 'pending',
        idempotencyKey,
        targetGuildId: args.discordGuildId,
        targetDiscordUserId: args.discordUserId,
        retryCount: 0,
        maxRetries: 5,
        createdAt: now,
        updatedAt: now,
      });
      jobCount++;
    }

    return { queued: jobCount > 0, jobCount, reason: undefined };
  },
});
