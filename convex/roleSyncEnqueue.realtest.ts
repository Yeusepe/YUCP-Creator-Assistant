import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from './_generated/dataModel';
import { enqueueRoleRemoval, enqueueRoleSync } from './lib/roleSyncEnqueue';
import { makeTestConvex } from './testHelpers';
import { emitRoleRemovalJobs, emitRoleSyncJob } from './webhooks/_helpers';

describe('enqueueRoleSync idempotency (legacy / flag-off path)', () => {
  const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
  beforeEach(() => {
    // Flag off: the helper only writes the projection row (no Workpool enqueue),
    // which the convex-test harness can exercise without the component.
    delete process.env.ROLE_SYNC_VIA_WORKPOOL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
    else process.env.ROLE_SYNC_VIA_WORKPOOL = original;
  });

  it('inserts one row and dedupes a repeat enqueue with the same idempotency key', async () => {
    const t = makeTestConvex();
    const params = {
      authUserId: 'auth-enqueue',
      subjectId: 'subject-enqueue' as Id<'subjects'>,
      entitlementId: 'entitlement-enqueue' as Id<'entitlements'>,
      discordUserId: 'discord-enqueue',
      targetGuildId: 'guild-enqueue',
      idempotencyKey: 'role_sync:auth-enqueue:subject-enqueue:entitlement-enqueue',
    };

    const firstId = await t.run(async (ctx) => enqueueRoleSync(ctx, params));
    const secondId = await t.run(async (ctx) => enqueueRoleSync(ctx, params));

    expect(secondId).toBe(firstId);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', params.idempotencyKey))
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobType).toBe('role_sync');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.targetGuildId).toBe('guild-enqueue');
    expect((rows[0]?.payload as { entitlementId?: string }).entitlementId).toBe(
      'entitlement-enqueue'
    );
  });

  it('rejects blank idempotency keys before writing role sync work', async () => {
    const t = makeTestConvex();
    await expect(
      t.run(async (ctx) =>
        enqueueRoleSync(ctx, {
          authUserId: 'auth-enqueue',
          subjectId: 'subject-enqueue' as Id<'subjects'>,
          entitlementId: 'entitlement-enqueue' as Id<'entitlements'>,
          discordUserId: 'discord-enqueue',
          idempotencyKey: '   ',
        })
      )
    ).rejects.toThrow(/idempotencyKey/);
  });

  it('rejects retry budgets outside the supported range', async () => {
    const t = makeTestConvex();

    await expect(
      t.run(async (ctx) =>
        enqueueRoleSync(ctx, {
          authUserId: 'auth-enqueue',
          subjectId: 'subject-enqueue' as Id<'subjects'>,
          entitlementId: 'entitlement-enqueue' as Id<'entitlements'>,
          idempotencyKey: 'role_sync:auth-enqueue:subject-enqueue:retry-low',
          maxRetries: -1,
        })
      )
    ).rejects.toThrow(/maxRetries/);

    await expect(
      t.run(async (ctx) =>
        enqueueRoleRemoval(ctx, {
          authUserId: 'auth-enqueue',
          subjectId: 'subject-enqueue' as Id<'subjects'>,
          guildId: 'guild-enqueue',
          roleId: 'role-enqueue',
          idempotencyKey: 'role_removal:auth-enqueue:subject-enqueue:retry-high',
          maxRetries: 101,
        })
      )
    ).rejects.toThrow(/maxRetries/);
  });

  it('dedupes repeated webhook role sync emissions for the same entitlement', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-webhook-sync';
    const subjectId = 'subject-webhook-sync' as Id<'subjects'>;
    const entitlementId = 'entitlement-webhook-sync' as Id<'entitlements'>;

    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_001)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_001);

    await t.run(async (ctx) =>
      emitRoleSyncJob(ctx, authUserId, subjectId, 'discord-webhook-sync', entitlementId)
    );
    await t.run(async (ctx) =>
      emitRoleSyncJob(ctx, authUserId, subjectId, 'discord-webhook-sync', entitlementId)
    );

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) =>
          q.eq('idempotencyKey', `role_sync:${authUserId}:${subjectId}:${entitlementId}`)
        )
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobType).toBe('role_sync');
  });

  it('dedupes repeated webhook role removal emissions for the same role rule', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-webhook-removal';
    const subjectId = 'subject-webhook-removal' as Id<'subjects'>;
    const productId = 'product-webhook-removal';
    const guildId = 'guild-webhook-removal';
    const now = 1_000;

    await t.run(async (ctx) => {
      const guildLinkId = await ctx.db.insert('guild_links', {
        authUserId,
        discordGuildId: guildId,
        installedByAuthUserId: authUserId,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId,
        guildId,
        guildLinkId,
        productId,
        verifiedRoleId: 'role-webhook-removal',
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_001)
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(3_001);

    await t.run(async (ctx) =>
      emitRoleRemovalJobs(ctx, authUserId, subjectId, productId, 'discord-webhook-removal')
    );
    await t.run(async (ctx) =>
      emitRoleRemovalJobs(ctx, authUserId, subjectId, productId, 'discord-webhook-removal')
    );

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .withIndex('by_idempotency', (q) =>
          q.eq(
            'idempotencyKey',
            `role_removal:${authUserId}:${subjectId}:${guildId}:${productId}:role-webhook-removal`
          )
        )
        .collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobType).toBe('role_removal');
  });

  it('warns and skips role removal rules missing a verified role id', async () => {
    const t = makeTestConvex();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const authUserId = 'auth-webhook-misconfigured-removal';
    const subjectId = 'subject-webhook-misconfigured-removal' as Id<'subjects'>;
    const productId = 'product-webhook-misconfigured-removal';
    const guildId = 'guild-webhook-misconfigured-removal';
    const now = 1_000;

    await t.run(async (ctx) => {
      const guildLinkId = await ctx.db.insert('guild_links', {
        authUserId,
        discordGuildId: guildId,
        installedByAuthUserId: authUserId,
        botPresent: true,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('role_rules', {
        authUserId,
        guildId,
        guildLinkId,
        productId,
        verifiedRoleId: '',
        removeOnRevoke: true,
        priority: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) =>
      emitRoleRemovalJobs(ctx, authUserId, subjectId, productId, 'discord-webhook-removal')
    );

    const rows = await t.run(async (ctx) => ctx.db.query('outbox_jobs').collect());
    expect(rows).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      '[convex] Skipping role removal for misconfigured role rule',
      expect.objectContaining({
        authUserId,
        guildId,
        productId,
        reason: 'missing_verified_role_id',
      })
    );
  });
});
