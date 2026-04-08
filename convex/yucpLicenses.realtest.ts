import { beforeEach, describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import { buildPublicAuthIssuer } from './lib/publicAuthIssuer';
import { getPublicKeyFromPrivate, signLicenseJwt } from './lib/yucpCrypto';
import { makeTestConvex, seedCertificateBillingCatalog } from './testHelpers';

describe('coupling job capability gating', () => {
  const issuerBaseUrl = 'https://dsktp.tailc472f7.ts.net';
  const packageId = 'pkg-coupling-capability';
  const machineFingerprint =
    'a604eb0948054b9acb9f40da80a6a4c8e711b98c59e54a11089fea3a2b77dc1c';
  const projectId = '0123456789abcdef0123456789abcdef';
  const creatorAuthUserId = 'auth-coupling-capability';

  let rootPrivateKey = '';
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    rootPrivateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
    process.env.YUCP_ROOT_PUBLIC_KEY = await getPublicKeyFromPrivate(rootPrivateKey);
    process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
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
        publisherId: 'publisher-coupling-capability',
        yucpUserId: creatorAuthUserId,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  async function mintLicenseToken() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return await signLicenseJwt(
      {
        iss: buildPublicAuthIssuer(issuerBaseUrl),
        aud: 'yucp-license-gate',
        sub: 'license-subject-coupling-capability',
        jti: 'nonce-coupling-capability',
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
        name: 'Coupling Capability Creator',
        ownerDiscordUserId: 'discord-coupling-capability',
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

  function mockActiveRuntimeArtifact() {
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
            version: '1.0.0',
            metadataVersion: 1,
            deliveryName: 'yucp-coupling.dll',
            contentType: 'application/octet-stream',
            envelopeCipher: 'none',
            envelopeIvBase64: '',
            ciphertextSha256: 'b'.repeat(64),
            ciphertextSize: 3,
            plaintextSha256: 'b'.repeat(64),
            plaintextSize: 3,
            downloadUrl: 'https://coupling.internal/v1/licenses/coupling-runtime',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  it('returns a no-op when creator plan does not include coupling traceability', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      machineFingerprint,
      projectId,
      licenseToken,
      assetPaths: ['Assets/Novaspil_Kitbash/Novaspil.fbx'],
      issuerBaseUrl,
    });

    expect(result).toEqual({
      success: true,
      subject: 'license-subject-coupling-capability',
      jobs: [],
      skipReason: 'capability_disabled',
    });
  });

  it('returns coupling jobs when the creator plan includes coupling traceability and a runtime artifact is configured', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedActiveCouplingBilling(t);
    mockActiveRuntimeArtifact();
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      machineFingerprint,
      projectId,
      licenseToken,
      assetPaths: ['Assets/Novaspil_Kitbash/Novaspil.fbx'],
      issuerBaseUrl,
    });

    expect(result).toMatchObject({
      success: true,
      subject: 'license-subject-coupling-capability',
      jobs: [{ assetPath: 'Assets/Novaspil_Kitbash/Novaspil.fbx' }],
    });
    const jobs = result.jobs ?? [];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.tokenHex).toMatch(/^[0-9a-f]+$/);
  });
});
