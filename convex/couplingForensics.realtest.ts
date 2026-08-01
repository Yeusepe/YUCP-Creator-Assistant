import { sha256Hex } from '@yucp/shared/crypto';
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

describe('trace buyer identity resolution', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'test-secret';
  });

  test('resolves the licence through the package catalog binding', async () => {
    const t = makeTestConvex();
    await seedTraceablePackage(t, {
      authUserId: 'creator-1',
      packageId: 'com.yucp.songthing',
    });
    const licenseSubject = 'ab'.repeat(32);
    await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: 'creator-1',
        createdAt: now,
        // The catalog's logical product id, which is what entitlements carry.
        // It deliberately differs from the package id: the resolver must join
        // through package_catalog_bindings, not compare the two directly.
        productId: 'song-thing',
        provider: 'gumroad',
        providerProductRef: 'gum-song-thing',
        status: 'active',
        supportsAutoDiscovery: false,
        updatedAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId,
        createdAt: now,
        creatorAuthUserId: 'creator-1',
        packageId: 'com.yucp.songthing',
        status: 'active',
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-1',
        createdAt: now,
        displayName: 'shapes',
        primaryDiscordUserId: 'discord-buyer-1',
        status: 'active',
        updatedAt: now,
      });
      await ctx.db.insert('entitlements', {
        authUserId: 'creator-1',
        catalogProductId,
        grantedAt: now,
        licenseSubject,
        productId: 'song-thing',
        sourceProvider: 'gumroad',
        sourceReference: 'gumroad:order-1',
        status: 'active',
        subjectId,
        updatedAt: now,
      });
      await ctx.db.insert('license_subject_links', {
        authUserId: 'buyer-1',
        createdAt: now,
        licenseKeyEncrypted: 'encrypted-license-key',
        licenseSubject,
        provider: 'gumroad',
        providerUserId: 'gum-user-1',
      });
      await ctx.db.insert('external_accounts', {
        createdAt: now,
        provider: 'gumroad',
        providerUserId: 'gum-user-1',
        providerUsername: 'gumbuyer',
        status: 'active',
        updatedAt: now,
      });
    });

    const result = await t.query(
      api.couplingForensics.resolveTraceBuyerIdentitiesForAuthUser,
      {
        apiSecret: 'test-secret',
        authUserId: 'creator-1',
        buyerIds: ['buyer-1'],
        packageId: 'com.yucp.songthing',
      }
    );

    expect(result.packageOwned).toBe(true);
    expect(result.identities).toEqual([
      {
        buyerId: 'buyer-1',
        buyerProviderUserId: 'gum-user-1',
        buyerProviderUsername: 'gumbuyer',
        buyerSubjectDiscordUserId: 'discord-buyer-1',
        buyerSubjectDisplayName: 'shapes',
        hasEntitlement: true,
        hasLicenseLink: true,
        hasLicenseSubject: true,
        licenseFingerprint: `gumroad · ${licenseSubject.slice(0, 10)}`,
        licenseKeyEncrypted: 'encrypted-license-key',
        provider: 'gumroad',
        subjectsMatched: 1,
      },
    ]);
  });

  test('recovers the licence fingerprint for a manual redemption without licenseSubject', async () => {
    const t = makeTestConvex();
    await seedTraceablePackage(t, {
      authUserId: 'creator-1',
      packageId: 'com.yucp.songthing',
    });
    const licenseKeyHash = 'ef'.repeat(32);
    await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: 'creator-1',
        createdAt: now,
        productId: 'song-thing',
        provider: 'gumroad',
        providerProductRef: 'gum-song-thing',
        status: 'active',
        supportsAutoDiscovery: false,
        updatedAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId,
        createdAt: now,
        creatorAuthUserId: 'creator-1',
        packageId: 'com.yucp.songthing',
        status: 'active',
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-1',
        createdAt: now,
        displayName: 'shapes',
        primaryDiscordUserId: 'discord-buyer-1',
        status: 'active',
        updatedAt: now,
      });
      const manualLicenseId = await ctx.db.insert('manual_licenses', {
        authUserId: 'creator-1',
        createdAt: now,
        currentUses: 1,
        licenseKeyHash,
        productId: 'song-thing',
        status: 'active',
        updatedAt: now,
      });
      // Granted by completeManualLicenseIntent before it stamped
      // licenseSubject: only the redemption reference ties it to the licence.
      await ctx.db.insert('entitlements', {
        authUserId: 'creator-1',
        catalogProductId,
        grantedAt: now,
        productId: 'song-thing',
        sourceProvider: 'manual',
        sourceReference: `manual:${await sha256Hex(String(manualLicenseId))}`,
        status: 'active',
        subjectId,
        updatedAt: now,
      });
    });

    const result = await t.query(
      api.couplingForensics.resolveTraceBuyerIdentitiesForAuthUser,
      {
        apiSecret: 'test-secret',
        authUserId: 'creator-1',
        buyerIds: ['buyer-1'],
        packageId: 'com.yucp.songthing',
      }
    );

    expect(result.packageOwned).toBe(true);
    expect(result.identities).toEqual([
      {
        buyerId: 'buyer-1',
        buyerSubjectDiscordUserId: 'discord-buyer-1',
        buyerSubjectDisplayName: 'shapes',
        hasEntitlement: true,
        hasLicenseLink: false,
        hasLicenseSubject: true,
        licenseFingerprint: `manual · ${licenseKeyHash.slice(0, 10)}`,
        provider: 'manual',
        subjectsMatched: 1,
      },
    ]);
  });

  test('finds a legacy entitlement on an older subject row', async () => {
    const t = makeTestConvex();
    await seedTraceablePackage(t, {
      authUserId: 'creator-1',
      packageId: 'com.yucp.songthing',
    });
    const licenseSubject = 'cd'.repeat(32);
    await t.run(async (ctx) => {
      const now = Date.now();
      const catalogProductId = await ctx.db.insert('product_catalog', {
        authUserId: 'creator-1',
        createdAt: now,
        productId: 'song-thing',
        provider: 'gumroad',
        providerProductRef: 'gum-song-thing',
        status: 'active',
        supportsAutoDiscovery: false,
        updatedAt: now,
      });
      await ctx.db.insert('package_catalog_bindings', {
        catalogProductId,
        createdAt: now,
        creatorAuthUserId: 'creator-1',
        packageId: 'com.yucp.songthing',
        status: 'active',
        updatedAt: now,
      });
      // The buyer re-linked Discord: the entitlement lives on the retired
      // subject row, while the active row is the one shown to the creator.
      const retiredSubjectId = await ctx.db.insert('subjects', {
        authUserId: 'buyer-1',
        createdAt: now - 1000,
        primaryDiscordUserId: 'discord-old',
        status: 'suspended',
        updatedAt: now - 1000,
      });
      await ctx.db.insert('subjects', {
        authUserId: 'buyer-1',
        createdAt: now,
        displayName: 'shapes',
        primaryDiscordUserId: 'discord-new',
        status: 'active',
        updatedAt: now,
      });
      // Written before catalogProductId existed: only the catalog's logical
      // product id connects it to the package.
      await ctx.db.insert('entitlements', {
        authUserId: 'creator-1',
        grantedAt: now,
        licenseSubject,
        productId: 'song-thing',
        sourceProvider: 'gumroad',
        sourceReference: 'gumroad:order-2',
        status: 'active',
        subjectId: retiredSubjectId,
        updatedAt: now,
      });
      await ctx.db.insert('license_subject_links', {
        authUserId: 'buyer-1',
        createdAt: now,
        licenseKeyEncrypted: 'encrypted-license-key-2',
        licenseSubject,
        provider: 'gumroad',
      });
    });

    const result = await t.query(
      api.couplingForensics.resolveTraceBuyerIdentitiesForAuthUser,
      {
        apiSecret: 'test-secret',
        authUserId: 'creator-1',
        buyerIds: ['buyer-1'],
        packageId: 'com.yucp.songthing',
      }
    );

    expect(result.packageOwned).toBe(true);
    expect(result.identities).toEqual([
      {
        buyerId: 'buyer-1',
        buyerSubjectDiscordUserId: 'discord-new',
        buyerSubjectDisplayName: 'shapes',
        hasEntitlement: true,
        hasLicenseLink: true,
        hasLicenseSubject: true,
        licenseFingerprint: `gumroad · ${licenseSubject.slice(0, 10)}`,
        licenseKeyEncrypted: 'encrypted-license-key-2',
        provider: 'gumroad',
        subjectsMatched: 2,
      },
    ]);
  });
});
