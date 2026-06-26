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

  it('lists deduped trace candidates for the package owner with the traceability capability', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-candidates-auth';
    const packageId = 'pkg.creator.candidates';
    const subjectA = 'a'.repeat(64);
    const subjectB = 'b'.repeat(64);
    const tokenHashA = '1'.repeat(64);
    const tokenHashB = '2'.repeat(64);

    await seedCertificateBillingCatalog(t, {
      productId: 'plan-coupling-traceability',
      capabilityKeys: ['coupling_traceability'],
      capabilityKey: 'coupling_traceability',
      featureFlags: { coupling_traceability: true },
      benefitMetadata: { coupling_traceability: true },
    });
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-candidates-creator',
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
        publisherId: 'publisher-candidates',
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });

      const baseRecord = {
        authUserId,
        packageId,
        tokenLength: 64,
        machineFingerprintHash: 'c'.repeat(64),
        projectIdHash: 'd'.repeat(64),
        runtimeArtifactVersion: 'sha256-b8c6ba93829b',
        runtimePlaintextSha256: 'e'.repeat(64),
        createdAt: now,
        provider: 'jinxxy',
      };
      // Two identical (assetPath, licenseSubject, tokenHash) rows must dedupe to one candidate.
      await ctx.db.insert('coupling_trace_records', {
        ...baseRecord,
        licenseSubject: subjectA,
        assetPath: 'Assets/Character/body.png',
        tokenHash: tokenHashA,
        correlationId: 'corr-candidates-1',
      });
      await ctx.db.insert('coupling_trace_records', {
        ...baseRecord,
        licenseSubject: subjectA,
        assetPath: 'Assets/Character/body.png',
        tokenHash: tokenHashA,
        correlationId: 'corr-candidates-2',
      });
      await ctx.db.insert('coupling_trace_records', {
        ...baseRecord,
        licenseSubject: subjectB,
        assetPath: 'Assets/Character/face.png',
        tokenHash: tokenHashB,
        correlationId: 'corr-candidates-3',
      });
    });

    const result = await t.query(api.couplingForensics.listCouplingTraceCandidatesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId,
      packageId,
    });

    expect(result.capabilityEnabled).toBe(true);
    expect(result.packageOwned).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates).toContainEqual({
      assetPath: 'Assets/Character/body.png',
      licenseSubject: subjectA,
      tokenHash: tokenHashA,
    });
    expect(result.candidates).toContainEqual({
      assetPath: 'Assets/Character/face.png',
      licenseSubject: subjectB,
      tokenHash: tokenHashB,
    });
  });

  it('bounds trace candidates and reports truncation instead of returning an unbounded package scan', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-candidates-bounded-auth';
    const packageId = 'pkg.creator.candidates.bounded';
    const candidateLimit = 512;

    await seedCertificateBillingCatalog(t, {
      productId: 'plan-coupling-traceability',
      capabilityKeys: ['coupling_traceability'],
      capabilityKey: 'coupling_traceability',
      featureFlags: { coupling_traceability: true },
      benefitMetadata: { coupling_traceability: true },
    });
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-candidates-bounded-creator',
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
        publisherId: 'publisher-candidates-bounded',
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });

      for (let index = 0; index < candidateLimit + 1; index += 1) {
        await ctx.db.insert('coupling_trace_records', {
          authUserId,
          packageId,
          licenseSubject: index.toString(16).padStart(64, '0'),
          assetPath: `Assets/Character/body-${index}.png`,
          tokenHash: (index + 1).toString(16).padStart(64, '0'),
          tokenLength: 64,
          machineFingerprintHash: 'c'.repeat(64),
          projectIdHash: 'd'.repeat(64),
          runtimeArtifactVersion: 'sha256-b8c6ba93829b',
          runtimePlaintextSha256: 'e'.repeat(64),
          correlationId: `corr-candidates-bounded-${index}`,
          createdAt: now + index,
          provider: 'jinxxy',
        });
      }
    });

    const result = await t.query(api.couplingForensics.listCouplingTraceCandidatesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId,
      packageId,
    });

    expect(result.candidateLimit).toBe(candidateLimit);
    expect(result.truncated).toBe(true);
    expect(result.candidates).toHaveLength(candidateLimit);
  });

  it('does not report truncation when duplicate raw trace rows dedupe under the candidate limit', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-candidates-duplicate-bound-auth';
    const packageId = 'pkg.creator.candidates.duplicate-bound';
    const candidateLimit = 512;
    const licenseSubject = 'a'.repeat(64);
    const tokenHash = '1'.repeat(64);

    await seedCertificateBillingCatalog(t, {
      productId: 'plan-coupling-traceability',
      capabilityKeys: ['coupling_traceability'],
      capabilityKey: 'coupling_traceability',
      featureFlags: { coupling_traceability: true },
      benefitMetadata: { coupling_traceability: true },
    });
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-candidates-duplicate-bound-creator',
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
        publisherId: 'publisher-candidates-duplicate-bound',
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });

      for (let index = 0; index < candidateLimit + 1; index += 1) {
        await ctx.db.insert('coupling_trace_records', {
          authUserId,
          packageId,
          licenseSubject,
          assetPath: 'Assets/Character/body.png',
          tokenHash,
          tokenLength: 64,
          machineFingerprintHash: 'c'.repeat(64),
          projectIdHash: 'd'.repeat(64),
          runtimeArtifactVersion: 'sha256-b8c6ba93829b',
          runtimePlaintextSha256: 'e'.repeat(64),
          correlationId: `corr-candidates-duplicate-bound-${index}`,
          createdAt: now + index,
          provider: 'jinxxy',
        });
      }
    });

    const result = await t.query(api.couplingForensics.listCouplingTraceCandidatesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId,
      packageId,
    });

    expect(result.candidateLimit).toBe(candidateLimit);
    expect(result.truncated).toBe(false);
    expect(result.candidates).toEqual([
      {
        assetPath: 'Assets/Character/body.png',
        licenseSubject,
        tokenHash,
      },
    ]);
  });

  it('continues scanning past duplicate raw trace rows to include later unique candidates', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-candidates-duplicate-page-auth';
    const packageId = 'pkg.creator.candidates.duplicate-page';
    const candidateLimit = 512;
    const duplicateLicenseSubject = 'a'.repeat(64);
    const duplicateTokenHash = '1'.repeat(64);
    const laterLicenseSubject = 'b'.repeat(64);
    const laterTokenHash = 'f'.repeat(64);

    await seedCertificateBillingCatalog(t, {
      productId: 'plan-coupling-traceability',
      capabilityKeys: ['coupling_traceability'],
      capabilityKey: 'coupling_traceability',
      featureFlags: { coupling_traceability: true },
      benefitMetadata: { coupling_traceability: true },
    });
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-candidates-duplicate-page-creator',
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
        publisherId: 'publisher-candidates-duplicate-page',
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });

      for (let index = 0; index < candidateLimit + 1; index += 1) {
        await ctx.db.insert('coupling_trace_records', {
          authUserId,
          packageId,
          licenseSubject: duplicateLicenseSubject,
          assetPath: 'Assets/Character/body.png',
          tokenHash: duplicateTokenHash,
          tokenLength: 64,
          machineFingerprintHash: 'c'.repeat(64),
          projectIdHash: 'd'.repeat(64),
          runtimeArtifactVersion: 'sha256-b8c6ba93829b',
          runtimePlaintextSha256: 'e'.repeat(64),
          correlationId: `corr-candidates-duplicate-page-${index}`,
          createdAt: now + index,
          provider: 'jinxxy',
        });
      }

      await ctx.db.insert('coupling_trace_records', {
        authUserId,
        packageId,
        licenseSubject: laterLicenseSubject,
        assetPath: 'Assets/Character/face.png',
        tokenHash: laterTokenHash,
        tokenLength: 64,
        machineFingerprintHash: 'c'.repeat(64),
        projectIdHash: 'd'.repeat(64),
        runtimeArtifactVersion: 'sha256-b8c6ba93829b',
        runtimePlaintextSha256: 'e'.repeat(64),
        correlationId: 'corr-candidates-duplicate-page-later',
        createdAt: now + candidateLimit + 1,
        provider: 'jinxxy',
      });
    });

    const result = await t.query(api.couplingForensics.listCouplingTraceCandidatesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId,
      packageId,
    });

    expect(result.candidateLimit).toBe(candidateLimit);
    expect(result.truncated).toBe(false);
    expect(result.candidates).toEqual([
      {
        assetPath: 'Assets/Character/body.png',
        licenseSubject: duplicateLicenseSubject,
        tokenHash: duplicateTokenHash,
      },
      {
        assetPath: 'Assets/Character/face.png',
        licenseSubject: laterLicenseSubject,
        tokenHash: laterTokenHash,
      },
    ]);
  });

  it('reports truncation when duplicate-heavy raw trace rows exceed the scan limit', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-candidates-raw-scan-bound-auth';
    const packageId = 'pkg.creator.candidates.raw-scan-bound';
    const candidateLimit = 512;
    const rawScanLimit = candidateLimit * 4;
    const duplicateLicenseSubject = 'a'.repeat(64);
    const duplicateTokenHash = '1'.repeat(64);
    const laterLicenseSubject = 'b'.repeat(64);
    const laterTokenHash = 'f'.repeat(64);

    await seedCertificateBillingCatalog(t, {
      productId: 'plan-coupling-traceability',
      capabilityKeys: ['coupling_traceability'],
      capabilityKey: 'coupling_traceability',
      featureFlags: { coupling_traceability: true },
      benefitMetadata: { coupling_traceability: true },
    });
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-candidates-raw-scan-bound-creator',
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
        publisherId: 'publisher-candidates-raw-scan-bound',
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });

      for (let index = 0; index < rawScanLimit + 1; index += 1) {
        await ctx.db.insert('coupling_trace_records', {
          authUserId,
          packageId,
          licenseSubject: duplicateLicenseSubject,
          assetPath: 'Assets/Character/body.png',
          tokenHash: duplicateTokenHash,
          tokenLength: 64,
          machineFingerprintHash: 'c'.repeat(64),
          projectIdHash: 'd'.repeat(64),
          runtimeArtifactVersion: 'sha256-b8c6ba93829b',
          runtimePlaintextSha256: 'e'.repeat(64),
          correlationId: `corr-candidates-raw-scan-bound-${index}`,
          createdAt: now + index,
          provider: 'jinxxy',
        });
      }

      await ctx.db.insert('coupling_trace_records', {
        authUserId,
        packageId,
        licenseSubject: laterLicenseSubject,
        assetPath: 'Assets/Character/face.png',
        tokenHash: laterTokenHash,
        tokenLength: 64,
        machineFingerprintHash: 'c'.repeat(64),
        projectIdHash: 'd'.repeat(64),
        runtimeArtifactVersion: 'sha256-b8c6ba93829b',
        runtimePlaintextSha256: 'e'.repeat(64),
        correlationId: 'corr-candidates-raw-scan-bound-later',
        createdAt: now + rawScanLimit + 1,
        provider: 'jinxxy',
      });
    });

    const result = await t.query(api.couplingForensics.listCouplingTraceCandidatesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId,
      packageId,
    });

    expect(result.candidateLimit).toBe(candidateLimit);
    expect(result.truncated).toBe(true);
    expect(result.candidates).toEqual([
      {
        assetPath: 'Assets/Character/body.png',
        licenseSubject: duplicateLicenseSubject,
        tokenHash: duplicateTokenHash,
      },
    ]);
  });

  it('returns no trace candidates without the traceability capability', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-nocap-auth';
    const packageId = 'pkg.creator.nocap';

    await t.run(async (ctx) => {
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Creator Bundle',
        publisherId: 'publisher-nocap',
        yucpUserId: authUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('coupling_trace_records', {
        authUserId,
        packageId,
        licenseSubject: 'b'.repeat(64),
        assetPath: 'Assets/Character/body.png',
        tokenHash: '1'.repeat(64),
        tokenLength: 64,
        machineFingerprintHash: 'c'.repeat(64),
        projectIdHash: 'd'.repeat(64),
        runtimeArtifactVersion: 'sha256-b8c6ba93829b',
        runtimePlaintextSha256: 'e'.repeat(64),
        correlationId: 'corr-nocap-1',
        createdAt: now,
        provider: 'jinxxy',
      });
    });

    const result = await t.query(api.couplingForensics.listCouplingTraceCandidatesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId,
      packageId,
    });

    expect(result).toEqual({
      capabilityEnabled: false,
      packageOwned: false,
      truncated: false,
      candidateLimit: 512,
      candidates: [],
    });
  });

  it('returns packageOwned false for a capable viewer who does not own the package', async () => {
    const t = makeTestConvex();
    const now = Date.now();
    const authUserId = 'creator-nonowner-auth';
    const packageId = 'pkg.creator.nonowner';

    await seedCertificateBillingCatalog(t, {
      productId: 'plan-coupling-traceability',
      capabilityKeys: ['coupling_traceability'],
      capabilityKey: 'coupling_traceability',
      featureFlags: { coupling_traceability: true },
      benefitMetadata: { coupling_traceability: true },
    });
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId,
      ownerDiscordUserId: 'discord-nonowner-creator',
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
      // Package belongs to a different creator.
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Someone Else Bundle',
        publisherId: 'publisher-other',
        yucpUserId: 'a-different-creator',
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
    });

    const result = await t.query(api.couplingForensics.listCouplingTraceCandidatesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId,
      packageId,
    });

    expect(result).toEqual({
      capabilityEnabled: true,
      packageOwned: false,
      truncated: false,
      candidateLimit: 512,
      candidates: [],
    });
  });
});
