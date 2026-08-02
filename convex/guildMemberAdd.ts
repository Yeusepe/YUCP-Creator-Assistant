/**
 * Guild Member Add - Auto-apply roles on join
 *
 * Plan Phase 5: When a user joins a guild, resolve guild→tenant, member→subject,
 * load entitlements, and queue role_sync if autoVerifyOnJoin. No provider API calls.
 */

import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { enqueueRoleSync } from './lib/roleSyncEnqueue';

function isMembershipFailureForGuild(job: Doc<'outbox_jobs'>, discordGuildId: string): boolean {
  const error = job.lastError?.toLowerCase() ?? '';
  const isMembershipFailure =
    error.includes('member not found in guild') ||
    error.includes('unknown member') ||
    error.includes('discord api error 10007');
  if (!isMembershipFailure) {
    return false;
  }

  return (
    job.targetGuildId === discordGuildId ||
    job.targetGuildIds?.includes(discordGuildId) === true ||
    error.includes(`${discordGuildId}:`)
  );
}

function roleSyncEntitlementId(job: Doc<'outbox_jobs'>): Id<'entitlements'> | null {
  const entitlementId = (job.payload as { entitlementId?: unknown }).entitlementId;
  return typeof entitlementId === 'string' ? (entitlementId as Id<'entitlements'>) : null;
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

    const profile = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', guildLink.authUserId))
      .first();
    if (!profile) {
      return { queued: false, jobCount: 0, reason: 'Creator profile not found' };
    }

    const autoVerifyOnJoin = profile.policy?.autoVerifyOnJoin ?? false;

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
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', guildLink.authUserId).eq('subjectId', subject._id)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    if (entitlements.length === 0) {
      return { queued: false, jobCount: 0, reason: 'No active entitlements' };
    }

    let entitlementsToQueue = entitlements;
    if (!autoVerifyOnJoin) {
      const membershipFailures = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_status_job_type_target_user', (q) =>
          q
            .eq('status', 'dead_letter')
            .eq('jobType', 'role_sync')
            .eq('targetDiscordUserId', args.discordUserId)
        )
        .collect();
      const recoverableEntitlementIds = new Set(
        membershipFailures
          .filter(
            (job) =>
              job.authUserId === guildLink.authUserId &&
              isMembershipFailureForGuild(job, args.discordGuildId)
          )
          .map(roleSyncEntitlementId)
          .filter((entitlementId): entitlementId is Id<'entitlements'> => entitlementId !== null)
      );
      entitlementsToQueue = entitlements.filter((entitlement) =>
        recoverableEntitlementIds.has(entitlement._id)
      );
      if (entitlementsToQueue.length === 0) {
        return { queued: false, jobCount: 0, reason: 'autoVerifyOnJoin disabled' };
      }
    }

    let jobCount = 0;

    for (const ent of entitlementsToQueue) {
      const idempotencyKey = `guild_join_sync:${guildLink.authUserId}:${subject._id}:${ent._id}:${args.discordGuildId}`;
      const existing = await ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
        .first();
      if (existing) continue;

      await enqueueRoleSync(ctx, {
        authUserId: guildLink.authUserId,
        subjectId: subject._id,
        entitlementId: ent._id,
        discordUserId: args.discordUserId,
        targetGuildId: args.discordGuildId,
        idempotencyKey,
      });
      jobCount++;
    }

    return { queued: jobCount > 0, jobCount, reason: undefined };
  },
});
