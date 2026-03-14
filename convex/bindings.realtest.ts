/**
 * Integration tests for Binding Lifecycle Functions
 *
 * Run with: npx vitest run --config convex/vitest.config.ts convex/bindings.realtest.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { makeTestConvex, seedEntitlement, seedSubject } from './testHelpers';

const API_SECRET = 'test-secret';

// ---------------------------------------------------------------------------
// Seed helper for external_accounts (not in testHelpers.ts)
// ---------------------------------------------------------------------------

async function seedExternalAccount(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    provider?: string;
    providerUserId?: string;
    emailHash?: string;
  } = {}
): Promise<Id<'external_accounts'>> {
  return t.run(async (ctx) =>
    ctx.db.insert('external_accounts', {
      provider: overrides.provider ?? 'discord',
      providerUserId: overrides.providerUserId ?? `provider-user-${Date.now()}`,
      emailHash: overrides.emailHash,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
}

// ---------------------------------------------------------------------------
// activateBinding lifecycle
// ---------------------------------------------------------------------------

describe('activateBinding lifecycle', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
  });

  it('given new subject + external account, when binding activated, then status=active', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-bind-1';

    const subjectId = await seedSubject(t, { authUserId });
    const externalAccountId = await seedExternalAccount(t, { providerUserId: 'discord-user-1' });

    const result = await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId,
      externalAccountId,
      bindingType: 'ownership',
    });

    expect(result.success).toBe(true);
    expect(result.isNew).toBe(true);
    expect(result.conflict).toBeUndefined();

    const binding = await t.run(async (ctx) => ctx.db.get(result.bindingId));
    expect(binding?.status).toBe('active');
    expect(binding?.bindingType).toBe('ownership');
  });

  it('given existing binding for account E on subject A, when subject B tries to bind same E, then conflict returned', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-bind-2';

    const subjectA = await seedSubject(t);
    const subjectB = await seedSubject(t);
    const externalAccountId = await seedExternalAccount(t, { providerUserId: 'discord-shared' });

    // Bind subject A
    await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId: subjectA,
      externalAccountId,
      bindingType: 'ownership',
    });

    // Subject B tries to bind the same external account
    const conflictResult = await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId: subjectB,
      externalAccountId,
      bindingType: 'ownership',
    });

    expect(conflictResult.success).toBe(false);
    expect(conflictResult.conflict).toBeDefined();
    expect(conflictResult.conflict?.message).toContain('active ownership binding');
  });

  it('given active binding + active entitlement, when binding revoked, then entitlement cascades to revoked', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-bind-3';

    const subjectId = await seedSubject(t);
    const externalAccountId = await seedExternalAccount(t);

    const activateResult = await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId,
      externalAccountId,
      bindingType: 'ownership',
    });

    // Seed active entitlement on the same authUserId + subjectId
    const entitlementId = await seedEntitlement(t, subjectId, {
      authUserId,
      status: 'active',
    });

    const revokeResult = await t.mutation(api.bindings.revokeBinding, {
      apiSecret: API_SECRET,
      authUserId,
      bindingId: activateResult.bindingId,
      reason: 'integration test revocation',
      cascadeToEntitlements: true,
    });

    expect(revokeResult.success).toBe(true);
    expect(revokeResult.entitlementsRevoked).toBeGreaterThan(0);

    const binding = await t.run(async (ctx) => ctx.db.get(activateResult.bindingId));
    expect(binding?.status).toBe('revoked');

    const entitlement = await t.run(async (ctx) => ctx.db.get(entitlementId));
    expect(entitlement?.status).toBe('revoked');
  });

  it('given active binding, when quarantined, then status=quarantined', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-bind-4';

    const subjectId = await seedSubject(t);
    const externalAccountId = await seedExternalAccount(t);

    const activateResult = await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId,
      externalAccountId,
      bindingType: 'ownership',
    });

    const quarantineResult = await t.mutation(api.bindings.quarantineBinding, {
      apiSecret: API_SECRET,
      authUserId,
      bindingId: activateResult.bindingId,
      reason: 'suspicious activity detected',
    });

    expect(quarantineResult.success).toBe(true);
    expect(quarantineResult.previousStatus).toBe('active');

    const binding = await t.run(async (ctx) => ctx.db.get(activateResult.bindingId));
    expect(binding?.status).toBe('quarantined');
  });

  it('given quarantined binding, when released, then status=active', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-bind-5';

    const subjectId = await seedSubject(t);
    const externalAccountId = await seedExternalAccount(t);

    // Create and quarantine
    const activateResult = await t.mutation(api.bindings.activateBinding, {
      apiSecret: API_SECRET,
      authUserId,
      subjectId,
      externalAccountId,
      bindingType: 'ownership',
    });

    await t.mutation(api.bindings.quarantineBinding, {
      apiSecret: API_SECRET,
      authUserId,
      bindingId: activateResult.bindingId,
      reason: 'suspicious activity',
    });

    // Release from quarantine
    const releaseResult = await t.mutation(api.bindings.releaseFromQuarantine, {
      apiSecret: API_SECRET,
      authUserId,
      bindingId: activateResult.bindingId,
      notes: 'Reviewed and cleared',
    });

    expect(releaseResult.success).toBe(true);

    const binding = await t.run(async (ctx) => ctx.db.get(activateResult.bindingId));
    expect(binding?.status).toBe('active');
  });

  it('given wrong apiSecret, when activating binding, then throws', async () => {
    const t = makeTestConvex();
    const authUserId = 'auth-bind-6';

    const subjectId = await seedSubject(t);
    const externalAccountId = await seedExternalAccount(t);

    await expect(
      t.mutation(api.bindings.activateBinding, {
        apiSecret: 'completely-wrong-secret',
        authUserId,
        subjectId,
        externalAccountId,
        bindingType: 'ownership',
      })
    ).rejects.toThrow('Unauthorized');
  });
});
