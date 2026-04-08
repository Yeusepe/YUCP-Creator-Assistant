import { beforeEach, describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import { buildPublicAuthIssuer } from './lib/publicAuthIssuer';
import * as yucpCrypto from './lib/yucpCrypto';
import { makeTestConvex, seedCertificateBillingCatalog } from './testHelpers';

const issuerBaseUrl = 'https://protected-blob.test.example';
const packageId = 'pkg-protected-ticket';
const packageVersion = '1.0.0';
const contentHash = 'c'.repeat(64);
const protectedAssetId = '46c90a22a12b44fe88fcd9be626bdedb';
const machineFingerprint =
  'a604eb0948054b9acb9f40da80a6a4c8e711b98c59e54a11089fea3a2b77dc1c';
const projectId = '0123456789abcdef0123456789abcdef';
const creatorAuthUserId = 'auth-protected-ticket';
const publisherId = 'publisher-protected-ticket';
const certNonce = 'cert-protected-ticket';
const couplingRuntimeVersion = '2026.03.26.1';
const couplingRuntimePlaintextSha256 = 'b'.repeat(64);
const contentKeyBase64 = Buffer.from('protected-blob-content-key').toString('base64');

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(new Uint8Array(digest)).toString('hex');
}

describe('protected blob package-first architecture', () => {
  let rootPrivateKey = '';
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    rootPrivateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
    process.env.YUCP_ROOT_PUBLIC_KEY = await yucpCrypto.getPublicKeyFromPrivate(rootPrivateKey);
    process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-for-protected-blob-flow';
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';
    process.env.POLAR_WEBHOOK_SECRET = 'test-polar-webhook-secret';
    process.env.YUCP_COUPLING_SERVICE_BASE_URL = 'https://coupling.internal';
    process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET = 'coupling-secret';
    globalThis.fetch = originalFetch;
  });

  async function seedPackageRegistration(t: ReturnType<typeof makeTestConvex>) {
    await t.run(async (ctx) => {
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId,
        yucpUserId: creatorAuthUserId,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  async function seedActiveCouplingBilling(t: ReturnType<typeof makeTestConvex>) {
    const now = Date.now();
    await seedCertificateBillingCatalog(t, {
      productId: 'cd93ea04-eccf-4cec-a72e-aecf7d8f8f47',
      slug: 'creator-cert',
      displayName: 'Creator Suite+',
      description: 'Test plan',
      highlights: ['Test'],
      benefitMetadata: {
        protected_exports: true,
        coupling_traceability: true,
        device_cap: 3,
        audit_retention_days: 30,
        support_tier: 'standard',
        tier_rank: 1,
      },
      featureFlags: {
        protected_exports: true,
        coupling_traceability: true,
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
        authUserId: creatorAuthUserId,
        name: 'Protected Blob Creator',
        ownerDiscordUserId: 'discord-protected-ticket',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('creator_billing_entitlements', {
        workspaceKey: buildCreatorProfileWorkspaceKey(creatorProfileId),
        authUserId: creatorAuthUserId,
        creatorProfileId,
        planKey: 'creator-cert',
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
  }

  async function mintLicenseToken() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return await yucpCrypto.signLicenseJwt(
      {
        iss: buildPublicAuthIssuer(issuerBaseUrl),
        aud: 'yucp-license-gate',
        sub: 'license-subject-protected-ticket',
        jti: 'nonce-protected-ticket',
        package_id: packageId,
        machine_fingerprint: machineFingerprint,
        provider: 'gumroad',
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      },
      rootPrivateKey,
      'yucp-root'
    );
  }

  async function seedProtectedAsset(t: ReturnType<typeof makeTestConvex>) {
    await t.mutation(internal.yucpLicenses.upsertProtectedAssets, {
      packageId,
      contentHash,
      packageVersion,
      publisherId,
      yucpUserId: creatorAuthUserId,
      certNonce,
      protectedAssets: [
        {
          protectedAssetId,
          unlockMode: 'content_key_b64',
          contentKeyBase64,
          displayName: 'Protected Blob',
        },
      ],
    });
  }

  function mockRuntimeArtifact() {
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (
        url ===
        'https://coupling.internal/v1/runtime-artifacts/manifest?artifactKey=coupling-runtime'
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            artifactKey: 'coupling-runtime',
            channel: 'stable',
            platform: 'win-x64',
            version: couplingRuntimeVersion,
            metadataVersion: 1,
            deliveryName: 'yucp-coupling.dll',
            contentType: 'application/octet-stream',
            envelopeCipher: 'none',
            envelopeIvBase64: '',
            ciphertextSha256: couplingRuntimePlaintextSha256,
            ciphertextSize: 4,
            plaintextSha256: couplingRuntimePlaintextSha256,
            plaintextSize: 4,
            downloadUrl: 'https://coupling.internal/v1/licenses/coupling-runtime',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  it('requires a matching package registration before issuing protected unlock tickets', async () => {
    const t = makeTestConvex();
    await seedProtectedAsset(t);
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueProtectedUnlock, {
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      licenseToken,
      issuerBaseUrl,
    });

    expect(result).toEqual({
      success: false,
      error: 'Protected asset owner mismatch',
    });
  });

  it('issues protected unlock tickets and reuses a single unlock record per machine/project', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedProtectedAsset(t);
    const licenseToken = await mintLicenseToken();

    const firstIssue = await t.action(internal.yucpLicenses.issueProtectedUnlock, {
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      licenseToken,
      issuerBaseUrl,
    });

    expect(firstIssue).toMatchObject({ success: true });
    const claims = await yucpCrypto.verifyProtectedUnlockJwt(
      firstIssue.unlockToken ?? '',
      process.env.YUCP_ROOT_PUBLIC_KEY!,
      buildPublicAuthIssuer(issuerBaseUrl)
    );
    expect(claims).toMatchObject({
      package_id: packageId,
      protected_asset_id: protectedAssetId,
      machine_fingerprint: machineFingerprint,
      project_id: projectId,
      unlock_mode: 'content_key_b64',
      content_hash: contentHash,
    });
    expect(claims?.content_key_b64).toBe(contentKeyBase64);
    expect(claims?.wrapped_content_key).toBeUndefined();

    const secondIssue = await t.action(internal.yucpLicenses.issueProtectedUnlock, {
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      licenseToken,
      issuerBaseUrl,
    });
    expect(secondIssue).toMatchObject({ success: true });

    const storedUnlocks = await t.run(async (ctx) => {
      return await (ctx.db as any).query('protected_asset_unlocks').collect();
    });
    expect(storedUnlocks).toHaveLength(1);
    expect(storedUnlocks[0]).toMatchObject({
      packageId,
      protectedAssetId,
      licenseSubject: 'license-subject-protected-ticket',
      machineFingerprint,
      projectId,
      issueCount: 2,
    });
    expect((storedUnlocks[0]?.lastIssuedAt ?? 0) >= (storedUnlocks[0]?.firstUnlockedAt ?? 0)).toBe(true);
  });

  it('records coupling trace records for package-owned protected blobs', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedProtectedAsset(t);
    await seedActiveCouplingBilling(t);
    mockRuntimeArtifact();
    const licenseToken = await mintLicenseToken();

    const couplingResult = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      machineFingerprint,
      projectId,
      licenseToken,
      assetPaths: ['Assets/Protected/Model.fbx'],
      issuerBaseUrl,
    });

    expect(couplingResult).toMatchObject({
      success: true,
      subject: 'license-subject-protected-ticket',
      jobs: [{ assetPath: 'Assets/Protected/Model.fbx' }],
    });
    const issuedJobs = couplingResult.jobs ?? [];
    expect(issuedJobs).toHaveLength(1);
    const issuedJob = issuedJobs[0];
    expect(issuedJob?.tokenHex).toMatch(/^[0-9a-f]+$/);

    const stored = await t.run(async (ctx) => {
      return {
        traces: await (ctx.db as any).query('coupling_trace_records').collect(),
        auditEvents: await (ctx.db as any).query('audit_events').collect(),
      };
    });

    expect(stored.traces).toHaveLength(1);
    expect(stored.traces[0]).toMatchObject({
      authUserId: creatorAuthUserId,
      packageId,
      licenseSubject: 'license-subject-protected-ticket',
      assetPath: 'Assets/Protected/Model.fbx',
      tokenHash: await sha256Hex(issuedJob?.tokenHex ?? ''),
      tokenLength: issuedJob?.tokenHex.length,
      machineFingerprintHash: await sha256Hex(machineFingerprint),
      projectIdHash: await sha256Hex(projectId),
      runtimeArtifactVersion: couplingRuntimeVersion,
      runtimePlaintextSha256: couplingRuntimePlaintextSha256,
      correlationId: expect.any(String),
    });

    const traceRecordedEvents = stored.auditEvents.filter(
      (event: { eventType?: string }) => event.eventType === 'coupling.trace.recorded'
    );
    const unlockIssuedEvents = stored.auditEvents.filter(
      (event: { eventType?: string }) => event.eventType === 'coupling.unlock.issued'
    );
    expect(traceRecordedEvents).toHaveLength(1);
    expect(unlockIssuedEvents).toHaveLength(1);
    expect(traceRecordedEvents[0]).toMatchObject({
      authUserId: creatorAuthUserId,
      correlationId: stored.traces[0]?.correlationId,
    });
    expect(couplingResult).toMatchObject({
      jobs: [
        {
          assetPath: 'Assets/Protected/Model.fbx',
          tokenHex: issuedJob?.tokenHex,
        },
      ],
    });
  });
});
