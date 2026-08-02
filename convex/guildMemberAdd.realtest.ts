import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'guild-member-recovery-test-secret';

describe('guild member role-sync recovery', () => {
  const originalApiSecret = process.env.CONVEX_API_SECRET;
  const originalWorkpoolFlag = process.env.ROLE_SYNC_VIA_WORKPOOL;

  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    delete process.env.ROLE_SYNC_VIA_WORKPOOL;
  });

  afterEach(() => {
    if (originalApiSecret === undefined) delete process.env.CONVEX_API_SECRET;
    else process.env.CONVEX_API_SECRET = originalApiSecret;
    if (originalWorkpoolFlag === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
    else process.env.ROLE_SYNC_VIA_WORKPOOL = originalWorkpoolFlag;
  });

  it('recovers a membership-failed entitlement on join when auto verification is disabled', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-guild-join-recovery';
    const discordGuildId = 'guild-join-recovery';
    const discordUserId = 'discord-user-join-recovery';
    const { entitlementId, failedJobId } = await t.run(async (ctx) => {
      await ctx.db.insert('creator_profiles', {
        authUserId,
        name: 'Guild Join Recovery Creator',
        ownerDiscordUserId: 'discord-owner-join-recovery',
        status: 'active',
        policy: { autoVerifyOnJoin: false },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('guild_links', {
        authUserId,
        discordGuildId,
        installedByAuthUserId: authUserId,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-guild-join-recovery',
        primaryDiscordUserId: discordUserId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const entitlementId = await ctx.db.insert('entitlements', {
        authUserId,
        subjectId,
        productId: 'product-guild-join-recovery',
        sourceProvider: 'jinxxy',
        sourceReference: 'jinxxy:guild-join-recovery',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      const failedJobId = await ctx.db.insert('outbox_jobs', {
        authUserId,
        jobType: 'role_sync',
        payload: { subjectId, entitlementId, discordUserId },
        status: 'dead_letter',
        idempotencyKey: `role_sync:${authUserId}:${subjectId}:${entitlementId}:grant:${now}`,
        targetGuildIds: [discordGuildId],
        targetDiscordUserId: discordUserId,
        retryCount: 0,
        maxRetries: 10,
        lastError: `${discordGuildId}: Member not found in guild`,
        createdAt: now,
        updatedAt: now,
      });
      return { entitlementId, failedJobId };
    });

    const result = await t.mutation(api.guildMemberAdd.handleGuildMemberJoin, {
      apiSecret: API_SECRET,
      discordGuildId,
      discordUserId,
    });
    const rows = await t.run(async (ctx) => ctx.db.query('outbox_jobs').collect());
    const recoveryJobs = rows.filter((row) => row._id !== failedJobId);

    expect(result).toEqual({ queued: true, jobCount: 1, reason: undefined });
    expect(recoveryJobs).toEqual([
      expect.objectContaining({
        authUserId,
        jobType: 'role_sync',
        status: 'pending',
        targetGuildId: discordGuildId,
        targetDiscordUserId: discordUserId,
        payload: expect.objectContaining({ entitlementId }),
      }),
    ]);

    const firstTimeDiscordUserId = 'discord-user-first-time-auto-disabled';
    await t.run(async (ctx) => {
      const subjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-first-time-auto-disabled',
        primaryDiscordUserId: firstTimeDiscordUserId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('entitlements', {
        authUserId,
        subjectId,
        productId: 'product-first-time-auto-disabled',
        sourceProvider: 'jinxxy',
        sourceReference: 'jinxxy:first-time-auto-disabled',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
    });

    const firstTimeResult = await t.mutation(api.guildMemberAdd.handleGuildMemberJoin, {
      apiSecret: API_SECRET,
      discordGuildId,
      discordUserId: firstTimeDiscordUserId,
    });
    expect(firstTimeResult).toEqual({
      queued: false,
      jobCount: 0,
      reason: 'autoVerifyOnJoin disabled',
    });
  });
});
