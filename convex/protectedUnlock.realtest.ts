import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPinnedYucpRootsForTests } from '@yucp/shared/yucpTrust';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { buildPublicAuthIssuer } from './lib/publicAuthIssuer';
import {
  getPublicKeyFromPrivate,
  signLicenseJwt,
  verifyProtectedUnlockJwt,
} from './lib/yucpCrypto';
import { makeTestConvex } from './testHelpers';

describe('protected unlock issuance', () => {
  const issuerBaseUrl = 'https://public-api.test.example';
  const packageId = 'pkg-protected-unlock';
  const protectedAssetId = '1234567890abcdef1234567890abcdef';
  const machineFingerprint = 'a604eb0948054b9acb9f40da80a6a4c8e711b98c59e54a11089fea3a2b77dc1c';
  const projectId = '0123456789abcdef0123456789abcdef';
  const creatorAuthUserId = 'auth-protected-unlock';
  const licenseSubject = 'license-subject-protected-unlock';
  const outerPackageHash = 'a'.repeat(64);
  const blobHash = 'b'.repeat(64);

  let rootPrivateKey = '';

  async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Buffer.from(new Uint8Array(digest)).toString('hex');
  }

  beforeEach(async () => {
    rootPrivateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
    const rootPublicKey = await getPublicKeyFromPrivate(rootPrivateKey);
    process.env.YUCP_ROOT_PUBLIC_KEY = rootPublicKey;
    process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
    setPinnedYucpRootsForTests([
      {
        keyId: 'yucp-root',
        algorithm: 'Ed25519',
        publicKeyBase64: rootPublicKey,
      },
    ]);
  });

  afterEach(() => {
    setPinnedYucpRootsForTests(null);
  });

  async function seedPackageRegistration(t: ReturnType<typeof makeTestConvex>) {
    await t.run(async (ctx) => {
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId: 'publisher-protected-unlock',
        yucpUserId: creatorAuthUserId,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  async function seedProtectedAsset(t: ReturnType<typeof makeTestConvex>) {
    await t.mutation(internal.yucpLicenses.upsertProtectedAssets, {
      packageId,
      contentHash: outerPackageHash,
      packageVersion: '1.0.0',
      publisherId: 'publisher-protected-unlock',
      yucpUserId: creatorAuthUserId,
      certNonce: 'cert-nonce-protected-unlock',
      protectedAssets: [
        {
          protectedAssetId,
          unlockMode: 'content_key_b64',
          contentKeyBase64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
          contentHash: blobHash,
          displayName: 'Protected Payload',
        },
      ],
    });
  }

  async function mintLicenseToken(overrides?: Partial<{ machine_fingerprint: string }>) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return await signLicenseJwt(
      {
        iss: buildPublicAuthIssuer(issuerBaseUrl),
        aud: 'yucp-license-gate',
        sub: licenseSubject,
        jti: 'nonce-protected-unlock',
        package_id: packageId,
        machine_fingerprint: overrides?.machine_fingerprint ?? machineFingerprint,
        provider: 'gumroad',
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      },
      rootPrivateKey,
      'yucp-root'
    );
  }

  async function attestLicenseSubject(t: ReturnType<typeof makeTestConvex>) {
    await t.mutation(internal.attestation.recordResolution, {
      anchors: [{ anchorType: 'tpm_ek', anchorHash: 'ek-protected-unlock-clean' }],
      attestation: {
        tpmVerified: true,
        flags: [],
        fingerprintVector: [],
        osAnchorHashes: [],
        correlationId: 'corr-protected-unlock-clean',
        licenseSubject,
        machineFingerprintHash: await sha256Hex(machineFingerprint),
      },
    });
  }

  async function blockLicenseSubject(
    t: ReturnType<typeof makeTestConvex>,
    overrides?: Partial<{
      machineFingerprint: string;
      anchorHash: string;
      paymentAnchorHash: string;
      correlationId: string;
    }>
  ) {
    const paymentAnchorHash = overrides?.paymentAnchorHash ?? 'payment-protected-unlock-block';
    const resolved = await t.mutation(internal.attestation.recordResolution, {
      anchors: [
        { anchorType: 'tpm_ek', anchorHash: overrides?.anchorHash ?? 'ek-protected-unlock-block' },
        { anchorType: 'payment', anchorHash: paymentAnchorHash },
      ],
      attestation: {
        tpmVerified: true,
        flags: [],
        fingerprintVector: [],
        osAnchorHashes: [],
        correlationId: overrides?.correlationId ?? 'corr-protected-unlock-block',
        licenseSubject,
        paymentFingerprintHash: paymentAnchorHash,
        machineFingerprintHash: await sha256Hex(overrides?.machineFingerprint ?? machineFingerprint),
      },
    });
    await t.mutation(internal.attestation.flagIdentityForReview, {
      identityNodeId: resolved.nodeId,
      reason: 'confirmed coupling trace',
      evidenceRef: 'trace-protected-unlock-block',
    });
    const blockId = await t.run(async (ctx) => {
      const block = await ctx.db
        .query('blocked_identities')
        .withIndex('by_identity_node', (q) => q.eq('identityNodeId', resolved.nodeId))
        .first();
      return block?._id as Id<'blocked_identities'>;
    });
    await t.mutation(internal.attestation.reviewIdentityBlock, {
      blockId,
      decision: 'active',
      reviewedByUserId: 'reviewer-protected-unlock',
    });
  }

  it('refuses protected unlock tickets until the license subject has an attestation', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
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
      error: 'Attestation is required before protected unlock',
    });
  });

  it('requires attestation for the same machine as the protected unlock token', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedProtectedAsset(t);
    await attestLicenseSubject(t);
    const otherMachineFingerprint = 'c'.repeat(64);
    const licenseToken = await mintLicenseToken({ machine_fingerprint: otherMachineFingerprint });

    const result = await t.action(internal.yucpLicenses.issueProtectedUnlock, {
      packageId,
      protectedAssetId,
      machineFingerprint: otherMachineFingerprint,
      projectId,
      licenseToken,
      issuerBaseUrl,
    });

    expect(result).toEqual({
      success: false,
      error: 'Attestation is required before protected unlock',
    });
  });

  it('binds protected unlock tokens to the protected asset hash with a short ttl', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedProtectedAsset(t);
    await attestLicenseSubject(t);
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueProtectedUnlock, {
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      licenseToken,
      issuerBaseUrl,
    });

    expect(result).toMatchObject({ success: true });
    expect(result.unlockToken).toBeTruthy();

    const storedAsset = await t.query(internal.yucpLicenses.getProtectedAsset, {
      packageId,
      protectedAssetId,
    });
    expect(storedAsset?.contentHash).toBe(blobHash);

    const claims = await verifyProtectedUnlockJwt(
      result.unlockToken!,
      process.env.YUCP_ROOT_PUBLIC_KEY!,
      buildPublicAuthIssuer(issuerBaseUrl)
    );

    expect(claims).toMatchObject({
      package_id: packageId,
      protected_asset_id: protectedAssetId,
      machine_fingerprint: machineFingerprint,
      project_id: projectId,
      unlock_mode: 'content_key_b64',
      content_hash: blobHash,
    });
    expect(claims?.content_key_b64).toBeTruthy();
    expect(claims?.wrapped_content_key).toBeUndefined();
    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBeLessThanOrEqual(10 * 60);
  });

  it('refuses protected unlock tickets for an actively blocked identity', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedProtectedAsset(t);
    await blockLicenseSubject(t);
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
      error: 'This purchase is not eligible for unlock on this account',
    });
  });

  it('does not inherit a block from a different attested machine on the same license', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedProtectedAsset(t);
    await attestLicenseSubject(t);
    await blockLicenseSubject(t, {
      machineFingerprint: 'd'.repeat(64),
      anchorHash: 'ek-protected-unlock-other-machine-block',
      paymentAnchorHash: 'payment-protected-unlock-other-machine-block',
      correlationId: 'corr-protected-unlock-other-machine-block',
    });
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueProtectedUnlock, {
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      licenseToken,
      issuerBaseUrl,
    });

    expect(result).toMatchObject({ success: true });
    expect(result.unlockToken).toBeTruthy();
  });
});
