/**
 * TDD tests for two bugs:
 *
 * Bug A: addProductFromPayhip and addProductFromVrchat do not schedule a
 *        projection job, so existing purchase_facts are never projected to
 *        entitlements when a product is first added.
 *
 * Bug B: grantEntitlement rejects purchasedAt values older than 30 days,
 *        which blocks all historical data from being projected.
 *
 * Run with: npx vitest run --config convex/vitest.config.ts convex/productAddScheduler.realtest.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex, seedSubject } from './testHelpers';

async function seedCreatorProfile(t: ReturnType<typeof makeTestConvex>, authUserId: string) {
  return t.run(async (ctx) => {
    return ctx.db.insert('creator_profiles', {
      authUserId,
      name: 'Test Creator',
      ownerDiscordUserId: `discord-${authUserId}`,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

// ---------------------------------------------------------------------------
// Bug B: grantEntitlement should not reject historical purchases
// ---------------------------------------------------------------------------

describe('grantEntitlement - no time-based past purchase block', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  it('grants entitlement for a purchase made 90 days ago', async () => {
    const t = makeTestConvex();
    const subjectId = await seedSubject(t, { authUserId: 'auth-owner-1' });
    await seedCreatorProfile(t, 'auth-owner-1');

    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

    // Bug B: Currently throws "purchasedAt cannot be more than 30 days in the past".
    // After the fix, this should resolve successfully.
    await expect(
      t.mutation(api.entitlements.grantEntitlement, {
        apiSecret: 'test-secret',
        authUserId: 'auth-owner-1',
        subjectId,
        productId: 'payhip:test-product',
        evidence: {
          provider: 'payhip',
          sourceReference: 'webhook:payhip:order-001',
          purchasedAt: ninetyDaysAgo,
        },
      })
    ).resolves.toMatchObject({ isNew: true });
  });

  it('grants entitlement for a purchase made 400 days ago', async () => {
    const t = makeTestConvex();
    const subjectId = await seedSubject(t, { authUserId: 'auth-owner-2' });
    await seedCreatorProfile(t, 'auth-owner-2');

    const fourHundredDaysAgo = Date.now() - 400 * 24 * 60 * 60 * 1000;

    await expect(
      t.mutation(api.entitlements.grantEntitlement, {
        apiSecret: 'test-secret',
        authUserId: 'auth-owner-2',
        subjectId,
        productId: 'jinxxy:old-product',
        evidence: {
          provider: 'jinxxy',
          sourceReference: 'webhook:jinxxy:order-002',
          purchasedAt: fourHundredDaysAgo,
        },
      })
    ).resolves.toMatchObject({ isNew: true });
  });

  it('still rejects a purchase from 5 minutes in the future', async () => {
    const t = makeTestConvex();
    const subjectId = await seedSubject(t, { authUserId: 'auth-owner-3' });
    await seedCreatorProfile(t, 'auth-owner-3');

    const fiveMinsFromNow = Date.now() + 6 * 60 * 1000;

    await expect(
      t.mutation(api.entitlements.grantEntitlement, {
        apiSecret: 'test-secret',
        authUserId: 'auth-owner-3',
        subjectId,
        productId: 'gumroad:some-product',
        evidence: {
          provider: 'gumroad',
          sourceReference: 'webhook:gumroad:order-003',
          purchasedAt: fiveMinsFromNow,
        },
      })
    ).rejects.toThrow('purchasedAt cannot be more than 5 minutes in the future');
  });
});

// ---------------------------------------------------------------------------
// Bug A: addProductFromPayhip must schedule a projection job
// ---------------------------------------------------------------------------

describe('addProductFromPayhip - schedules projection of existing purchase facts', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('projects an existing purchase_fact into an entitlement when a Payhip product is added', async () => {
    const t = makeTestConvex();
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-payhip-creator',
      primaryDiscordUserId: 'discord-buyer-1',
    });
    await seedCreatorProfile(t, 'auth-payhip-creator');

    // Simulate a purchase_fact already in DB from a prior webhook event
    await t.run(async (ctx) => {
      await ctx.db.insert('purchase_facts', {
        authUserId: 'auth-payhip-creator',
        provider: 'payhip',
        externalOrderId: 'payhip-order-abc',
        providerProductId: 'RGsF', // same as permalink
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 days ago
        subjectId, // already resolved to subject
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    // Add the Payhip product
    await t.mutation(api.role_rules.addProductFromPayhip, {
      apiSecret: 'test-secret',
      authUserId: 'auth-payhip-creator',
      permalink: 'RGsF',
      displayName: 'My Payhip Product',
    });

    // Bug A: addProductFromPayhip currently schedules NO job.
    // finishAllScheduledFunctions is a no-op → no entitlement is created.
    // After the fix (adds scheduler.runAfter → projectBackfilledPurchasesForProduct),
    // the purchase_fact is projected and an entitlement IS created.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const entitlements = await t.run(async (ctx) => ctx.db.query('entitlements').collect());

    // Currently FAILS: entitlements is [] because no projection job was scheduled.
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].productId).toBe('RGsF');
    expect(entitlements[0].sourceProvider).toBe('payhip');
  });

  it('re-running addProductFromPayhip for an existing product still projects unfulfilled facts', async () => {
    const t = makeTestConvex();
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-payhip-creator-2',
      primaryDiscordUserId: 'discord-buyer-2',
    });
    await seedCreatorProfile(t, 'auth-payhip-creator-2');

    // Product already exists in catalog
    await t.run(async (ctx) => {
      const catalogId = await ctx.db.insert('product_catalog', {
        authUserId: 'auth-payhip-creator-2',
        productId: 'ABCD',
        provider: 'payhip',
        providerProductRef: 'ABCD',
        displayName: 'Existing Product',
        status: 'active',
        supportsAutoDiscovery: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // A purchase fact that was never projected
      await ctx.db.insert('purchase_facts', {
        authUserId: 'auth-payhip-creator-2',
        provider: 'payhip',
        externalOrderId: 'payhip-order-xyz',
        providerProductId: 'ABCD',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
        subjectId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return catalogId;
    });

    // Re-add the same product — should still schedule projection
    await t.mutation(api.role_rules.addProductFromPayhip, {
      apiSecret: 'test-secret',
      authUserId: 'auth-payhip-creator-2',
      permalink: 'ABCD',
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const entitlements = await t.run(async (ctx) => ctx.db.query('entitlements').collect());

    // Currently FAILS for the same reason (no scheduler call in either branch)
    expect(entitlements).toHaveLength(1);
  });
});
