import { beforeEach, describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import {
  makeTestConvex,
  seedCertificateBillingCatalog,
  seedCreatorProfile,
} from './testHelpers';

async function seedTraceablePackage(
  t: ReturnType<typeof makeTestConvex>,
  input: {
    authUserId: string;
    packageId: string;
    status?: 'active' | 'archived';
  }
): Promise<void> {
  const now = Date.now();
  await seedCertificateBillingCatalog(t, {
    benefitMetadata: { coupling_traceability: true },
    capabilityKey: 'coupling_traceability',
    capabilityKeys: ['coupling_traceability'],
    featureFlags: { coupling_traceability: true },
    productId: 'plan-coupling-traceability',
  });
  const creatorProfileId = await seedCreatorProfile(t, {
    authUserId: input.authUserId,
    ownerDiscordUserId: `${input.authUserId}-discord`,
  });
  await t.run(async (ctx) => {
    await ctx.db.insert('creator_billing_entitlements', {
      allowEnrollment: true,
      allowSigning: true,
      auditRetentionDays: 30,
      authUserId: input.authUserId,
      createdAt: now,
      creatorProfileId,
      currentPeriodEnd: now + 86_400_000,
      deviceCap: 5,
      graceUntil: now + 3 * 86_400_000,
      planKey: 'creator-suite-plus',
      productId: 'plan-coupling-traceability',
      status: 'active',
      supportTier: 'standard',
      updatedAt: now,
      workspaceKey: buildCreatorProfileWorkspaceKey(creatorProfileId),
    });
    await ctx.db.insert('package_registry', {
      ...(input.status === 'archived' ? { archivedAt: now } : {}),
      packageId: input.packageId,
      packageName: 'Traceable Package',
      publisherId: `${input.packageId}.publisher`,
      registeredAt: now,
      status: input.status ?? 'active',
      updatedAt: now,
      yucpUserId: input.authUserId,
    });
  });
}

describe('coupling forensics authorization and audit projection', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  test('authorizes an active paid creator for an owned package', async () => {
    const t = makeTestConvex();
    await seedTraceablePackage(t, {
      authUserId: 'creator-1',
      packageId: 'com.yucp.jammr',
    });

    await expect(
      t.query(api.couplingForensics.authorizeCouplingForensicsLookupForAuthUser, {
        apiSecret: 'test-secret',
        authUserId: 'creator-1',
        packageId: 'com.yucp.jammr',
      })
    ).resolves.toEqual({
      capabilityEnabled: true,
      packageOwned: true,
    });
  });

  test('denies another creator and excludes archived packages', async () => {
    const t = makeTestConvex();
    await seedTraceablePackage(t, {
      authUserId: 'creator-1',
      packageId: 'com.yucp.archived',
      status: 'archived',
    });

    await expect(
      t.query(api.couplingForensics.authorizeCouplingForensicsLookupForAuthUser, {
        apiSecret: 'test-secret',
        authUserId: 'creator-1',
        packageId: 'com.yucp.archived',
      })
    ).resolves.toEqual({
      capabilityEnabled: true,
      packageOwned: false,
    });
    await expect(
      t.query(api.couplingForensics.listOwnedPackageSummariesForAuthUser, {
        apiSecret: 'test-secret',
        authUserId: 'creator-1',
      })
    ).resolves.toEqual({ packages: [] });
  });

  test('reports the capability gate before package ownership', async () => {
    const t = makeTestConvex();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('package_registry', {
        packageId: 'com.yucp.unpaid',
        packageName: 'Unpaid Package',
        publisherId: 'unpaid.publisher',
        registeredAt: now,
        status: 'active',
        updatedAt: now,
        yucpUserId: 'creator-unpaid',
      });
    });

    await expect(
      t.query(api.couplingForensics.authorizeCouplingForensicsLookupForAuthUser, {
        apiSecret: 'test-secret',
        authUserId: 'creator-unpaid',
        packageId: 'com.yucp.unpaid',
      })
    ).resolves.toEqual({
      capabilityEnabled: false,
      packageOwned: false,
    });
  });

  test('records bounded attribution counts without payload data', async () => {
    const t = makeTestConvex();
    await t.mutation(api.couplingForensics.recordLookupAudit, {
      apiSecret: 'test-secret',
      authUserId: 'creator-1',
      matchedAttributionCount: 1,
      packageId: 'com.yucp.jammr',
      requestedCandidateCount: 3,
      source: 'dashboard',
      status: 'attributed',
      uploadSha256: '11'.repeat(32),
    });

    const events = await t.run(async (ctx) =>
      ctx.db.query('audit_events').collect()
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({
      matchedAttributionCount: 1,
      packageId: 'com.yucp.jammr',
      requestedCandidateCount: 3,
      source: 'dashboard',
      status: 'attributed',
      uploadSha256: '11'.repeat(32),
    });
    expect(JSON.stringify(events[0])).not.toContain('package payload');

    await expect(
      t.mutation(api.couplingForensics.recordLookupAudit, {
        apiSecret: 'test-secret',
        authUserId: 'creator-1',
        matchedAttributionCount: 2,
        packageId: 'com.yucp.jammr',
        requestedCandidateCount: 1,
        source: 'dashboard',
        status: 'attributed',
      })
    ).rejects.toThrow('Attribution audit counts are invalid');
  });
});
