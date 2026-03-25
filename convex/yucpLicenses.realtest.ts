import { beforeEach, describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import { RELEASE_ARTIFACT_KEYS, RELEASE_CHANNELS, RELEASE_PLATFORMS } from './lib/releaseArtifactKeys';
import { buildPublicAuthIssuer } from './lib/publicAuthIssuer';
import { getPublicKeyFromPrivate, signLicenseJwt } from './lib/yucpCrypto';
import { makeTestConvex } from './testHelpers';

describe('coupling job capability gating', () => {
  const issuerBaseUrl = 'https://dsktp.tailc472f7.ts.net';
  const packageId = 'pkg-coupling-capability';
  const machineFingerprint =
    'a604eb0948054b9acb9f40da80a6a4c8e711b98c59e54a11089fea3a2b77dc1c';
  const projectId = '0123456789abcdef0123456789abcdef';
  const creatorAuthUserId = 'auth-coupling-capability';

  let rootPrivateKey = '';

  beforeEach(async () => {
    rootPrivateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
    process.env.YUCP_ROOT_PUBLIC_KEY = await getPublicKeyFromPrivate(rootPrivateKey);
    process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';
    process.env.POLAR_WEBHOOK_SECRET = 'test-polar-webhook-secret';
    process.env.POLAR_CERT_PRODUCTS_JSON = JSON.stringify([
      {
        planKey: 'creator-cert',
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

  async function publishActiveRuntimeArtifact(t: ReturnType<typeof makeTestConvex>) {
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' })
      );
    });

    await t.mutation(internal.releaseArtifacts.publishArtifact, {
      artifactKey: RELEASE_ARTIFACT_KEYS.couplingRuntime,
      channel: RELEASE_CHANNELS.stable,
      platform: RELEASE_PLATFORMS.winX64,
      version: '1.0.0',
      metadataVersion: 1,
      storageId,
      contentType: 'application/octet-stream',
      deliveryName: 'yucp-coupling.dll',
      envelopeCipher: 'aes-256-gcm',
      envelopeIvBase64: 'ZmFrZS1pdi1iYXNlNjQ=',
      ciphertextSha256: 'a'.repeat(64),
      ciphertextSize: 3,
      plaintextSha256: 'b'.repeat(64),
      plaintextSize: 3,
    });
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
    await publishActiveRuntimeArtifact(t);
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
