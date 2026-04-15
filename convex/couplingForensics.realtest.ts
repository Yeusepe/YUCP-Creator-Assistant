import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import {
  makeTestConvex,
  seedCertificateBillingCatalog,
  seedCreatorProfile,
  seedSubject,
} from './testHelpers';

describe('coupling forensics license subject resolution', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  it('resolves provider-native buyer identity from linked accounts even when no email is available', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-forensics-auth';
    const packageId = 'pkg.creator.bundle';
    const tokenHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const licenseSubject = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    await seedCertificateBillingCatalog(t, {
      productId: 'plan-coupling-traceability',
      capabilityKeys: ['coupling_traceability'],
      capabilityKey: 'coupling_traceability',
      featureFlags: {
        coupling_traceability: true,
      },
      benefitMetadata: {
        coupling_traceability: true,
      },
    });

    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-creator-forensics',
    });
    const buyerSubjectId = await seedSubject(t, {
      authUserId: 'buyer-auth-user',
      primaryDiscordUserId: 'discord-buyer-1',
      displayName: 'Buyer One',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('creator_billing_entitlements', {
        workspaceKey: buildCreatorProfileWorkspaceKey(creatorProfileId),
        authUserId,
        creatorProfileId,
        planKey: 'creator-suite-plus',
        productId: 'plan-coupling-traceability',
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        deviceCap: 5,
        auditRetentionDays: 30,
        supportTier: 'standard',
        currentPeriodEnd: now + 86_400_000,
        graceUntil: now + 3 * 86_400_000,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Creator Bundle',
        publisherId: 'publisher-forensics',
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });

      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider: 'jinxxy',
        providerUserId: 'customer-123',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('bindings', {
        authUserId,
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Manual license verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert('coupling_trace_records', {
        authUserId,
        packageId,
        licenseSubject,
        assetPath: 'Assets/Character/body.png',
        tokenHash,
        tokenLength: 64,
        machineFingerprintHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        projectIdHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        runtimeArtifactVersion: 'sha256-b8c6ba93829b',
        runtimePlaintextSha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        correlationId: 'corr-forensics-1',
        createdAt: now,
        provider: 'jinxxy',
      });

      await ctx.db.insert('license_subject_links', {
        licenseSubject,
        authUserId,
        packageId,
        provider: 'jinxxy',
        licenseKey: '11111111-2222-3333-4444-555555555555',
        purchaserEmail: 'buyer@example.com',
        providerUserId: 'customer-123',
        externalOrderId: 'order-123',
        providerProductId: 'product-123',
        createdAt: now,
      });
    });

    const result = await t.query(api.couplingForensics.lookupTraceMatchesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId,
      packageId,
      tokenHashes: [tokenHash],
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      provider: 'jinxxy',
      buyerProviderUserId: 'customer-123',
      buyerSubjectDisplayName: 'Buyer One',
      buyerSubjectDiscordUserId: 'discord-buyer-1',
    });
    expect(result.matches[0]).not.toHaveProperty('licenseKey');
    expect(result.matches[0]).not.toHaveProperty('purchaserEmail');
  });
});
