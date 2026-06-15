import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { roleSyncPool } from './roleSyncWorkpool';
import { makeTestConvex } from './testHelpers';

const TEST_WORK_ID = 'test-outbox-work' as WorkId;

describe('outbox_jobs schema compatibility', () => {
  const originalConvexApiSecret = process.env.CONVEX_API_SECRET;

  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-convex-api-secret';
  });

  afterEach(() => {
    if (originalConvexApiSecret === undefined) {
      delete process.env.CONVEX_API_SECRET;
    } else {
      process.env.CONVEX_API_SECRET = originalConvexApiSecret;
    }
  });

  it('accepts legacy verify_prompt_refresh jobs until migration removes them', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const id = await t.run(async (ctx) =>
      ctx.db.insert('outbox_jobs', {
        authUserId: 'auth-outbox-legacy',
        jobType: 'verify_prompt_refresh',
        payload: {
          guildId: 'guild-legacy',
          messageId: 'message-legacy',
        },
        status: 'pending',
        idempotencyKey: 'legacy-verify-prompt-refresh',
        retryCount: 0,
        maxRetries: 5,
        createdAt: now,
        updatedAt: now,
      })
    );

    const stored = await t.run(async (ctx) => ctx.db.get(id));

    expect(stored?.jobType).toBe('verify_prompt_refresh');
  });

  it('removes legacy verify_prompt_refresh jobs via migration', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const id = await t.run(async (ctx) =>
      ctx.db.insert('outbox_jobs', {
        authUserId: 'auth-outbox-migration',
        jobType: 'verify_prompt_refresh',
        payload: {
          guildId: 'guild-migration',
          messageId: 'message-migration',
        },
        status: 'pending',
        idempotencyKey: 'migration-verify-prompt-refresh',
        retryCount: 0,
        maxRetries: 5,
        createdAt: now,
        updatedAt: now,
      })
    );

    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.migrations.purgeLegacyOutboxVerifyPromptRefreshJobs, {})
    );
    const stored = await t.run(async (ctx) => ctx.db.get(id));

    expect(result).toEqual({ deleted: 1 });
    expect(stored).toBeNull();
  });

  it('returns failed role_sync jobs after the worker persists discovered target guilds', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const jobId = await t.run(async (ctx) =>
      ctx.db.insert('outbox_jobs', {
        authUserId: 'auth-role-sync-failed-banner',
        jobType: 'role_sync',
        payload: {
          subjectId: 'subject-role-sync',
          entitlementId: 'entitlement-role-sync',
          discordUserId: 'discord-role-sync-user',
        },
        status: 'dead_letter',
        idempotencyKey: 'role-sync-missing-target-guild',
        targetDiscordUserId: 'discord-role-sync-user',
        retryCount: 3,
        maxRetries: 5,
        createdAt: now,
        updatedAt: now,
      })
    );

    await t.mutation(api.outbox_jobs.updateJobStatus, {
      apiSecret: 'test-convex-api-secret',
      jobId,
      status: 'dead_letter',
      error: 'guild-role-sync: Bot lacks permission to manage roles',
      targetGuildIds: ['guild-role-sync'],
    });

    const jobs = await t.query(api.outbox_jobs.getFailedRoleSyncForUser, {
      apiSecret: 'test-convex-api-secret',
      authUserId: 'auth-role-sync-failed-banner',
      discordUserId: 'discord-role-sync-user',
      guildId: 'guild-role-sync',
    });

    expect(jobs).toEqual([{ lastError: 'guild-role-sync: Bot lacks permission to manage roles' }]);

    const stored = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(stored?.targetGuildIds).toEqual(['guild-role-sync']);
  });

  it('fetches requested pending job types without being front-blocked by Workpool-owned role rows', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const ids = await t.run(async (ctx) => {
      const insertedWorkpoolIds: Id<'outbox_jobs'>[] = [];
      for (let index = 0; index < 1000; index++) {
        insertedWorkpoolIds.push(
          await ctx.db.insert('outbox_jobs', {
            authUserId: 'auth-outbox-front-blocked',
            jobType: 'role_sync',
            payload: {
              subjectId: `subject-workpool-${index}`,
              entitlementId: `entitlement-workpool-${index}`,
              discordUserId: `discord-workpool-${index}`,
            },
            status: 'pending',
            idempotencyKey: `front-blocked-workpool-role-${index}`,
            targetDiscordUserId: `discord-workpool-${index}`,
            workpoolEnqueuedAt: now,
            retryCount: 0,
            maxRetries: 10,
            createdAt: now + index,
            updatedAt: now + index,
          })
        );
      }

      const legacyRoleJobId = await ctx.db.insert('outbox_jobs', {
        authUserId: 'auth-outbox-front-blocked',
        jobType: 'role_sync',
        payload: {
          subjectId: 'subject-legacy-role',
          entitlementId: 'entitlement-legacy-role',
          discordUserId: 'discord-legacy-role',
        },
        status: 'pending',
        idempotencyKey: 'front-blocked-legacy-role',
        targetDiscordUserId: 'discord-legacy-role',
        retryCount: 0,
        maxRetries: 10,
        createdAt: now + 1001,
        updatedAt: now + 1001,
      });

      const creatorAlertJobId = await ctx.db.insert('outbox_jobs', {
        authUserId: 'auth-outbox-front-blocked',
        jobType: 'creator_alert',
        payload: { message: 'bot-owned job must not starve' },
        status: 'pending',
        idempotencyKey: 'front-blocked-creator-alert',
        retryCount: 0,
        maxRetries: 3,
        createdAt: now + 1002,
        updatedAt: now + 1002,
      });

      return { insertedWorkpoolIds, legacyRoleJobId, creatorAlertJobId };
    });

    const jobs = await t.query(api.outbox_jobs.getPendingJobs, {
      apiSecret: 'test-convex-api-secret',
      jobTypes: ['role_sync', 'creator_alert'],
      excludeWorkpoolRoleJobs: true,
      limit: 10,
    } as never);

    const returnedIds = jobs.map((job) => job._id);
    expect(returnedIds).toContain(ids.legacyRoleJobId);
    expect(returnedIds).toContain(ids.creatorAlertJobId);
    expect(returnedIds).not.toContain(ids.insertedWorkpoolIds[0]);
  });

  it('routes role dead-letter retries through Workpool when the rollout flag is enabled', async () => {
    const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
    process.env.ROLE_SYNC_VIA_WORKPOOL = 'true';
    const enqueueSpy = vi.spyOn(roleSyncPool, 'enqueueAction').mockResolvedValue(TEST_WORK_ID);
    try {
      const t = makeTestConvex();
      const now = Date.now();
      const jobId = await t.run(async (ctx) =>
        ctx.db.insert('outbox_jobs', {
          authUserId: 'auth-outbox-retry-workpool',
          jobType: 'role_sync',
          payload: {
            subjectId: 'subject-outbox-retry-workpool',
            entitlementId: 'entitlement-outbox-retry-workpool',
            discordUserId: 'discord-outbox-retry-workpool',
          },
          status: 'dead_letter',
          idempotencyKey: 'retry-workpool-role-sync',
          targetDiscordUserId: 'discord-outbox-retry-workpool',
          retryCount: 10,
          maxRetries: 10,
          lastError: 'legacy worker failed',
          createdAt: now,
          updatedAt: now,
        })
      );

      const result = await t.mutation(api.outbox_jobs.retryDeadLetterJob, {
        apiSecret: 'test-convex-api-secret',
        jobId,
      });
      const stored = await t.run(async (ctx) => ctx.db.get(jobId));

      expect(result).toEqual({ success: true });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(stored?.status).toBe('pending');
      expect(
        (stored as { workpoolEnqueuedAt?: number } | null)?.workpoolEnqueuedAt
      ).toBeGreaterThanOrEqual(now);
    } finally {
      enqueueSpy.mockRestore();
      if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
      else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
    }
  });
});
