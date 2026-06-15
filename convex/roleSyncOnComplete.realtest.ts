import type { WorkId } from '@convex-dev/workpool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-convex-api-secret';

let seedCounter = 0;

async function seedRoleSyncJob(
  t: ReturnType<typeof makeTestConvex>,
  overrides?: {
    status?: 'pending' | 'completed' | 'dead_letter';
    jobType?: 'role_sync' | 'role_removal';
  }
) {
  const now = Date.now();
  seedCounter += 1;
  return t.run(async (ctx) => {
    const subjectId = await ctx.db.insert('subjects', {
      primaryDiscordUserId: 'discord-oncomplete',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert('outbox_jobs', {
      authUserId: 'auth-oncomplete',
      jobType: overrides?.jobType ?? 'role_sync',
      payload: {
        subjectId,
        entitlementId: 'entitlement-oncomplete',
        discordUserId: 'discord-oncomplete',
      },
      status: overrides?.status ?? 'pending',
      idempotencyKey: `oncomplete-${now}-${seedCounter}`,
      targetDiscordUserId: 'discord-oncomplete',
      retryCount: 0,
      maxRetries: 10,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe('roleSyncOnComplete.roleSyncCompleted', () => {
  const original = process.env.CONVEX_API_SECRET;
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CONVEX_API_SECRET;
    else process.env.CONVEX_API_SECRET = original;
  });

  it('marks the row completed, writes an audit event and a dashboard notification on success', async () => {
    const t = makeTestConvex();
    const jobId = await seedRoleSyncJob(t);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.roleSyncOnComplete.roleSyncCompleted, {
        workId: 'work-1' as WorkId,
        context: { outboxJobId: jobId },
        result: {
          kind: 'success',
          returnValue: {
            success: true,
            guildId: 'guild-1',
            targetGuildIds: ['guild-1'],
            discordUserId: 'discord-oncomplete',
            rolesAdded: ['role-1'],
            rolesRemoved: [],
          },
        },
      })
    );

    const stored = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(stored?.status).toBe('completed');
    expect(stored?.completedAt).toBeTypeOf('number');
    expect(stored?.targetGuildIds).toEqual(['guild-1']);

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query('audit_events')
        .filter((q) => q.eq(q.field('eventType'), 'discord.role.sync.completed'))
        .collect()
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe('role-sync-workpool');

    const notifications = await t.run(async (ctx) => ctx.db.query('admin_notifications').collect());
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe('Roles synced');
  });

  it('dead-letters a structured permanent failure with lastError + targetGuildIds, surfaced by the verify banner', async () => {
    const t = makeTestConvex();
    const jobId = await seedRoleSyncJob(t);
    const failure =
      'guild-1: Bot lacks permission: Grant "Manage Roles" to the bot and ensure the bot\'s role is above the verified role.';

    await t.run(async (ctx) =>
      ctx.runMutation(internal.roleSyncOnComplete.roleSyncCompleted, {
        workId: 'work-2' as WorkId,
        context: { outboxJobId: jobId },
        result: {
          kind: 'success',
          returnValue: {
            success: false,
            guildId: 'guild-1',
            targetGuildIds: ['guild-1'],
            discordUserId: 'discord-oncomplete',
            rolesAdded: [],
            rolesRemoved: [],
            error: failure,
          },
        },
      })
    );

    const stored = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(stored?.status).toBe('dead_letter');
    expect(stored?.lastError).toBe(failure);
    expect(stored?.targetGuildIds).toEqual(['guild-1']);

    const banner = await t.query(api.outbox_jobs.getFailedRoleSyncForUser, {
      apiSecret: API_SECRET,
      authUserId: 'auth-oncomplete',
      discordUserId: 'discord-oncomplete',
      guildId: 'guild-1',
    });
    expect(banner).toEqual([{ lastError: failure }]);
  });

  it('dead-letters a thrown failure (retries exhausted) with the error text', async () => {
    const t = makeTestConvex();
    const jobId = await seedRoleSyncJob(t);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.roleSyncOnComplete.roleSyncCompleted, {
        workId: 'work-3' as WorkId,
        context: { outboxJobId: jobId },
        result: { kind: 'failed', error: 'Member not found in guild' },
      })
    );

    const stored = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(stored?.status).toBe('dead_letter');
    expect(stored?.lastError).toBe('Member not found in guild');
  });
});
