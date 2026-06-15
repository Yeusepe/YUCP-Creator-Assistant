import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from './_generated/dataModel';
import { enqueueRoleSync } from './lib/roleSyncEnqueue';
import { makeTestConvex } from './testHelpers';

describe('enqueueRoleSync idempotency (legacy / flag-off path)', () => {
  const original = process.env.ROLE_SYNC_VIA_WORKPOOL;
  beforeEach(() => {
    // Flag off: the helper only writes the projection row (no Workpool enqueue),
    // which the convex-test harness can exercise without the component.
    delete process.env.ROLE_SYNC_VIA_WORKPOOL;
  });
  afterEach(() => {
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
});
