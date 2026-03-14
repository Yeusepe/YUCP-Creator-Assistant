/**
 * Real integration tests for Convex entitlement functions.
 * Uses convex-test to run mutations/queries against an in-memory Convex backend.
 *
 * Run with:
 *   npx vitest run --config convex/vitest.config.ts convex/entitlements.realtest.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import {
  makeTestConvex,
  seedCreatorProfile,
  seedEntitlement,
  seedGuildLink,
  seedSubject,
} from './testHelpers';

// ============================================================================
// GRANT ENTITLEMENT LIFECYCLE
// ============================================================================

describe('grantEntitlement lifecycle', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.CONVEX_API_SECRET;
  });

  it('given no entitlement, when grantEntitlement called, then isNew=true and status=active', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-grant-lifecycle-1';

    const subjectId = await seedSubject(t, { primaryDiscordUserId: 'discord-grant-1' });
    await seedCreatorProfile(t, { authUserId });

    const result = await t.mutation(api.entitlements.grantEntitlement, {
      apiSecret: 'test-secret',
      authUserId,
      subjectId,
      productId: 'gumroad:prod_xyz',
      evidence: {
        provider: 'gumroad',
        sourceReference: 'order_abc',
        purchasedAt: Date.now(),
      },
    });

    expect(result.isNew).toBe(true);
    expect(result.success).toBe(true);
    expect(result.entitlementId).toBeTruthy();

    // Verify DB: active entitlement now exists
    const activeResult = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: 'test-secret',
      authUserId,
      subjectId,
      productId: 'gumroad:prod_xyz',
    });

    expect(activeResult.found).toBe(true);
    expect(activeResult.entitlement?.status).toBe('active');
  });

  it('given same sourceReference, when granted twice, then isNew=false on second call', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-grant-idempotent-2';

    const subjectId = await seedSubject(t, { primaryDiscordUserId: 'discord-grant-2' });
    await seedCreatorProfile(t, { authUserId });

    // Identical evidence for both calls — same sourceReference = idempotent
    const args = {
      apiSecret: 'test-secret',
      authUserId,
      subjectId,
      productId: 'gumroad:prod_xyz',
      evidence: {
        provider: 'gumroad' as const,
        sourceReference: 'order_idempotent_ref',
      },
    };

    const first = await t.mutation(api.entitlements.grantEntitlement, args);
    expect(first.isNew).toBe(true);

    const second = await t.mutation(api.entitlements.grantEntitlement, args);
    expect(second.isNew).toBe(false);
    expect(second.entitlementId).toBe(first.entitlementId);

    // Verify exactly 1 record in DB
    const count = await t.run(async (ctx) => {
      const ents = await ctx.db
        .query('entitlements')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', authUserId).eq('subjectId', subjectId)
        )
        .collect();
      return ents.length;
    });

    expect(count).toBe(1);
  });

  it('given wrong apiSecret, when grantEntitlement called, then throws', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-grant-auth-fail-3';
    const subjectId = await seedSubject(t, { primaryDiscordUserId: 'discord-grant-3' });

    // No creator profile seeded — the auth check should fail before that lookup
    await expect(
      t.mutation(api.entitlements.grantEntitlement, {
        apiSecret: 'wrong-secret',
        authUserId,
        subjectId,
        productId: 'gumroad:prod_xyz',
        evidence: {
          provider: 'gumroad',
          sourceReference: 'order_should_fail',
        },
      })
    ).rejects.toThrow();
  });
});

// ============================================================================
// REVOKE ENTITLEMENT LIFECYCLE
// ============================================================================

describe('revokeEntitlement lifecycle', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.CONVEX_API_SECRET;
  });

  it('given active entitlement, when revoked, then status becomes refunded', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-revoke-lifecycle-4';

    const subjectId = await seedSubject(t, { primaryDiscordUserId: 'discord-revoke-1' });
    await seedCreatorProfile(t, { authUserId });

    const grantResult = await t.mutation(api.entitlements.grantEntitlement, {
      apiSecret: 'test-secret',
      authUserId,
      subjectId,
      productId: 'gumroad:prod_revoke',
      evidence: {
        provider: 'gumroad',
        sourceReference: 'order_to_revoke',
        purchasedAt: Date.now(),
      },
    });

    const revokeResult = await t.mutation(api.entitlements.revokeEntitlement, {
      apiSecret: 'test-secret',
      authUserId,
      entitlementId: grantResult.entitlementId,
      reason: 'refund',
    });

    expect(revokeResult.success).toBe(true);
    expect(revokeResult.previousStatus).toBe('active');

    // Verify DB: status changed to 'refunded' (refund reason → refunded status)
    const entitlement = await t.run((ctx) => ctx.db.get(grantResult.entitlementId));
    expect(entitlement?.status).toBe('refunded');
    expect(entitlement?.revokedAt).toBeDefined();
  });

  it('given entitlement for subject A, when queried for subject B, then found=false', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-isolation-5';

    const subjectA = await seedSubject(t, { primaryDiscordUserId: 'discord-isolation-a' });
    const subjectB = await seedSubject(t, { primaryDiscordUserId: 'discord-isolation-b' });
    await seedCreatorProfile(t, { authUserId });

    // Grant only to subjectA
    await t.mutation(api.entitlements.grantEntitlement, {
      apiSecret: 'test-secret',
      authUserId,
      subjectId: subjectA,
      productId: 'gumroad:prod_isolation',
      evidence: {
        provider: 'gumroad',
        sourceReference: 'order_isolation_a',
        purchasedAt: Date.now(),
      },
    });

    // Query for subjectB — should not find anything
    const resultForB = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: 'test-secret',
      authUserId,
      subjectId: subjectB,
      productId: 'gumroad:prod_isolation',
    });

    expect(resultForB.found).toBe(false);
    expect(resultForB.entitlement).toBeNull();
  });
});

// ============================================================================
// STATISTICS AND PAGINATION
// ============================================================================

describe('statistics and pagination', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.CONVEX_API_SECRET;
  });

  it('given 0 entitlements, when stats queried, then counts are 0 (not undefined)', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-stats-empty-6';

    // getStatsOverview doesn't require a creator_profile — just queries entitlements
    const stats = await t.query(api.entitlements.getStatsOverview, {
      apiSecret: 'test-secret',
      authUserId,
    });

    expect(stats.totalVerified).toBe(0);
    expect(stats.totalProducts).toBe(0);
    expect(stats.recentGrantsCount).toBe(0);
  });

  it('given 3 active entitlements, when stats queried, then totalVerified=3', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-stats-three-7';

    // Seed 3 subjects each with one active entitlement (same authUserId = same tenant)
    for (let i = 0; i < 3; i++) {
      const subjectId = await seedSubject(t, {
        primaryDiscordUserId: `discord-stats-three-${i}`,
      });
      await seedEntitlement(t, subjectId, {
        authUserId,
        productId: `product-stats-${i}`,
        sourceReference: `ref-stats-three-${i}`,
        status: 'active',
      });
    }

    const stats = await t.query(api.entitlements.getStatsOverview, {
      apiSecret: 'test-secret',
      authUserId,
    });

    // totalVerified = unique subject count across active entitlements
    expect(stats.totalVerified).toBe(3);
  });

  it('given 26 subjects with entitlements, cursor-based paging returns correct pages', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-pagination-8';

    // Seed 26 subjects each with one entitlement
    for (let i = 0; i < 26; i++) {
      const subjectId = await seedSubject(t, {
        // Zero-pad to ensure deterministic lexicographic ordering in assertions
        primaryDiscordUserId: `discord-page-${String(i).padStart(3, '0')}`,
      });
      await seedEntitlement(t, subjectId, {
        authUserId,
        productId: 'product-pagination-shared',
        sourceReference: `ref-page-${i}`,
        status: 'active',
      });
    }

    // Page 1: request 25 of 26 → should return 25 items + cursor
    const page1 = await t.query(api.entitlements.getVerifiedUsersPaginated, {
      apiSecret: 'test-secret',
      authUserId,
      limit: 25,
    });

    expect(page1.totalCount).toBe(26);
    expect(page1.users.length).toBe(25);
    expect(page1.nextCursor).toBeDefined();

    // Page 2: use cursor from page 1 → should return 1 item, no further cursor
    const page2 = await t.query(api.entitlements.getVerifiedUsersPaginated, {
      apiSecret: 'test-secret',
      authUserId,
      limit: 25,
      cursor: page1.nextCursor,
    });

    expect(page2.users.length).toBe(1);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('enqueueRoleSyncsForUser populates outbox_jobs', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-enqueue-9';
    const discordUserId = 'discord-enqueue-001';

    // Seed subject that enqueueRoleSyncsForUser will look up by discordUserId
    const subjectId = await seedSubject(t, { primaryDiscordUserId: discordUserId });
    await seedCreatorProfile(t, { authUserId });

    // Seed an active entitlement so enqueueRoleSyncsForUser has something to enqueue
    await seedEntitlement(t, subjectId, {
      authUserId,
      productId: 'product-enqueue-1',
      sourceReference: 'ref-enqueue-1',
      status: 'active',
    });

    const result = await t.mutation(api.entitlements.enqueueRoleSyncsForUser, {
      apiSecret: 'test-secret',
      authUserId,
      discordUserId,
    });

    expect(result.success).toBe(true);
    expect(result.jobsCreated).toBe(1);

    // Verify outbox_jobs table has the role_sync entry
    const jobs = await t.run(async (ctx) =>
      ctx.db
        .query('outbox_jobs')
        .filter((q) => q.eq(q.field('authUserId'), authUserId))
        .collect()
    );

    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.some((j) => j.jobType === 'role_sync')).toBe(true);
  });
});
