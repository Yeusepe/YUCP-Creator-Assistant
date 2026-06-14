import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

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
});
