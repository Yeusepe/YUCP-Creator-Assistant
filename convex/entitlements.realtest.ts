/**
 * Real integration tests for Convex entitlement functions.
 * Uses convex-test to run mutations/queries against an in-memory Convex backend.
 *
 * Run with:
 *   npx vitest run --config convex/vitest.config.ts convex/entitlements.realtest.ts
 *
 * Security refs from plan.md:
 * - https://docs.convex.dev/testing/convex-test
 * - https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex, seedCreatorProfile, seedEntitlement, seedSubject } from './testHelpers';

async function getEntitlementState(t: ReturnType<typeof makeTestConvex>, entitlementId: string) {
  return t.run(async (ctx) => ctx.db.get(entitlementId as never));
}

async function getSecurityCounts(t: ReturnType<typeof makeTestConvex>) {
  return t.run(async (ctx) => ({
    entitlements: (await ctx.db.query('entitlements').collect()).length,
    outboxJobs: (await ctx.db.query('outbox_jobs').collect()).length,
    auditEvents: (await ctx.db.query('audit_events').collect()).length,
  }));
}

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
    const before = await getSecurityCounts(t);

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
    ).rejects.toThrow('Unauthorized');

    expect(await getSecurityCounts(t)).toEqual(before);
  });

  it('given quarantined subject, when grantEntitlement called, then rejects and writes nothing', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-grant-quarantine-4';
    const subjectId = await seedSubject(t, {
      primaryDiscordUserId: 'discord-grant-quarantine-1',
      status: 'quarantined',
    });
    await seedCreatorProfile(t, { authUserId });
    const before = await getSecurityCounts(t);

    await expect(
      t.mutation(api.entitlements.grantEntitlement, {
        apiSecret: 'test-secret',
        authUserId,
        subjectId,
        productId: 'gumroad:prod_quarantine',
        evidence: {
          provider: 'gumroad',
          sourceReference: 'order_quarantine_should_fail',
        },
      })
    ).rejects.toThrow('Subject is not active: quarantined');

    expect(await getSecurityCounts(t)).toEqual(before);
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

  it('given tenant B tries to revoke tenant A entitlement, then rejects and leaves entitlement active', async () => {
    const t = makeTestConvex();
    const subjectId = await seedSubject(t, { primaryDiscordUserId: 'discord-revoke-isolation-1' });
    const entitlementId = await seedEntitlement(t, subjectId, {
      authUserId: 'auth-tenant-a',
      productId: 'gumroad:prod_revoke_isolation',
      sourceReference: 'order-tenant-a',
      status: 'active',
    });
    const before = await getSecurityCounts(t);

    await expect(
      t.mutation(api.entitlements.revokeEntitlement, {
        apiSecret: 'test-secret',
        authUserId: 'auth-tenant-b',
        entitlementId,
        reason: 'manual',
      })
    ).rejects.toThrow('Unauthorized: not the owner');

    expect(await getEntitlementState(t, entitlementId)).toMatchObject({ status: 'active' });
    expect(await getSecurityCounts(t)).toEqual(before);
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

  it('given suspended subject has active entitlement, then active entitlement lookups fail closed', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-suspended-lookup-10';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: 'discord-suspended-lookup-1',
      status: 'suspended',
    });
    await seedEntitlement(t, subjectId, {
      authUserId,
      productId: 'gumroad:prod_suspended_lookup',
      sourceReference: 'ref-suspended-lookup',
      status: 'active',
    });

    const activeEntitlement = await t.query(api.entitlements.getActiveEntitlement, {
      apiSecret: 'test-secret',
      authUserId,
      subjectId,
      productId: 'gumroad:prod_suspended_lookup',
    });
    const hasActiveEntitlement = await t.query(api.entitlements.hasActiveEntitlement, {
      apiSecret: 'test-secret',
      authUserId,
      subjectId,
      productId: 'gumroad:prod_suspended_lookup',
    });

    expect(activeEntitlement).toEqual({ found: false, entitlement: null });
    expect(hasActiveEntitlement).toBe(false);
  });

  it('given suspended subject, when enqueueRoleSyncsForUser called, then rejects and writes no jobs', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-enqueue-suspended-11';
    const discordUserId = 'discord-enqueue-suspended-1';
    const subjectId = await seedSubject(t, {
      authUserId,
      primaryDiscordUserId: discordUserId,
      status: 'suspended',
    });
    await seedEntitlement(t, subjectId, {
      authUserId,
      productId: 'gumroad:prod_enqueue_suspended',
      sourceReference: 'ref-enqueue-suspended',
      status: 'active',
    });
    const before = await getSecurityCounts(t);

    await expect(
      t.mutation(api.entitlements.enqueueRoleSyncsForUser, {
        apiSecret: 'test-secret',
        authUserId,
        discordUserId,
      })
    ).rejects.toThrow('Subject is not active: suspended');

    expect(await getSecurityCounts(t)).toEqual(before);
  });
});
