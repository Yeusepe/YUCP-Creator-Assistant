import { beforeEach, describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import { makeTestConvex } from './testHelpers';

describe('certificateBilling capability gate', () => {
  const authUserId = 'auth-user-capability-projection';
  const planKey = 'creator-cert';

  beforeEach(() => {
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';
    process.env.POLAR_WEBHOOK_SECRET = 'test-polar-webhook-secret';
    process.env.POLAR_CERT_PRODUCTS_JSON = JSON.stringify([
      {
        planKey,
        productId: 'cd93ea04-eccf-4cec-a72e-aecf7d8f8f47',
        slug: 'creator-cert',
        displayName: 'Creator Suite+',
        description: 'Test plan',
        highlights: ['Test'],
        priority: 1,
        deviceCap: 3,
        capabilities: ['protected_exports', 'coupling_traceability'],
        signQuotaPerPeriod: null,
        auditRetentionDays: 30,
        supportTier: 'standard',
        billingGraceDays: 3,
      },
    ]);
  });

  it('uses projected plan capabilities when stored capability rows are missing', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const creatorProfileId = await t.run(async (ctx) => {
      return await ctx.db.insert('creator_profiles', {
        authUserId,
        name: 'Capability Projection Creator',
        ownerDiscordUserId: 'discord-capability-projection',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('creator_billing_entitlements', {
        workspaceKey: buildCreatorProfileWorkspaceKey(creatorProfileId),
        authUserId,
        creatorProfileId,
        planKey,
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        deviceCap: 3,
        auditRetentionDays: 30,
        supportTier: 'standard',
        currentPeriodEnd: now + 86_400_000,
        graceUntil: now + 3 * 86_400_000,
        createdAt: now,
        updatedAt: now,
      });
    });

    const hasCapability = await t.query(internal.certificateBilling.hasCapabilityForAuthUser, {
      authUserId,
      capabilityKey: 'coupling_traceability',
    });

    expect(hasCapability).toBe(true);
  });
});
