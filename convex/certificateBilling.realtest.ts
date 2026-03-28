import { beforeEach, describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import { makeTestConvex, seedCertificateBillingCatalog } from './testHelpers';

describe('certificateBilling capability gate', () => {
  const authUserId = 'auth-user-capability-projection';
  const planKey = 'creator-cert';

  beforeEach(() => {
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';
    process.env.POLAR_WEBHOOK_SECRET = 'test-polar-webhook-secret';
  });

  it('uses projected plan capabilities when stored capability rows are missing', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    await seedCertificateBillingCatalog(t, {
      productId: 'cd93ea04-eccf-4cec-a72e-aecf7d8f8f47',
      slug: planKey,
      displayName: 'Creator Suite+',
      description: 'Test plan',
      highlights: ['Test'],
      benefitMetadata: {
        coupling_traceability: true,
        protected_exports: true,
        device_cap: 3,
        audit_retention_days: 30,
        support_tier: 'standard',
        tier_rank: 1,
      },
      featureFlags: {
        coupling_traceability: true,
        protected_exports: true,
      },
      capabilityKeys: ['coupling_traceability', 'protected_exports'],
      capabilityKey: 'coupling_traceability',
      deviceCap: 3,
      auditRetentionDays: 30,
      supportTier: 'standard',
      tierRank: 1,
    });
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
