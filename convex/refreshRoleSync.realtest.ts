import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex } from './testHelpers';

const API_SECRET = 'test-convex-api-secret';
const AUTH_USER = 'auth-refresh-test';
const DISCORD_USER = 'discord-refresh-user';
const PRODUCT_ID = 'product-refresh-test';

describe('enqueueRoleSyncsForUser (/creator refresh)', () => {
  const originalSecret = process.env.CONVEX_API_SECRET;
  const originalFlag = process.env.ROLE_SYNC_VIA_WORKPOOL;
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    // Flag off: exercise the projection-row path without the Workpool component.
    delete process.env.ROLE_SYNC_VIA_WORKPOOL;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CONVEX_API_SECRET;
    else process.env.CONVEX_API_SECRET = originalSecret;
    if (originalFlag === undefined) delete process.env.ROLE_SYNC_VIA_WORKPOOL;
    else process.env.ROLE_SYNC_VIA_WORKPOOL = originalFlag;
  });

  it('creates fresh executable work even when a prior role_sync job dead-lettered', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const { subjectId, entitlementId } = await t.run(async (ctx) => {
      const subjectId = await ctx.db.insert('subjects', {
        primaryDiscordUserId: DISCORD_USER,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const entitlementId = await ctx.db.insert('entitlements', {
        authUserId: AUTH_USER,
        subjectId,
        productId: PRODUCT_ID,
        sourceProvider: 'gumroad',
        sourceReference: 'order-refresh-test',
        status: 'active',
        grantedAt: now,
        updatedAt: now,
      });
      // The original verification's job that failed: stable key, dead_letter.
      await ctx.db.insert('outbox_jobs', {
        authUserId: AUTH_USER,
        jobType: 'role_sync',
        payload: { subjectId, entitlementId, discordUserId: DISCORD_USER },
        status: 'dead_letter',
        idempotencyKey: `role_sync:${AUTH_USER}:${subjectId}:${entitlementId}`,
        targetDiscordUserId: DISCORD_USER,
        retryCount: 4,
        maxRetries: 5,
        lastError: 'Member not found in guild',
        createdAt: now,
        updatedAt: now,
      });
      return { subjectId, entitlementId };
    });

    const result = await t.mutation(api.entitlements.enqueueRoleSyncsForUser, {
      apiSecret: API_SECRET,
      authUserId: AUTH_USER,
      discordUserId: DISCORD_USER,
    });

    expect(result.success).toBe(true);
    expect(result.jobsCreated).toBe(1);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .filter((q) => q.eq(q.field('authUserId'), AUTH_USER))
        .collect()
    );
    // The dead-letter row remains, plus a brand-new pending row from refresh.
    expect(rows).toHaveLength(2);
    const pending = rows.filter((r) => r.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotencyKey).toContain(
      `role_sync:${AUTH_USER}:${subjectId}:${entitlementId}:refresh:`
    );
    expect((pending[0]?.payload as { entitlementId?: string }).entitlementId).toBe(entitlementId);
  });
});
