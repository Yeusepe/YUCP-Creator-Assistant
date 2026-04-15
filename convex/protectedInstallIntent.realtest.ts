import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPinnedYucpRootsForTests } from '@yucp/shared/yucpTrust';
import { internal } from './_generated/api';
import { buildPublicAuthIssuer } from './lib/publicAuthIssuer';
import {
  getPublicKeyFromPrivate,
  signLicenseJwt,
  verifyProtectedInstallIntentJwt,
} from './lib/yucpCrypto';
import { makeTestConvex } from './testHelpers';

describe('protected install intent issuance', () => {
  const issuerBaseUrl = 'https://public-api.test.example';
  const packageId = 'pkg-protected-install-intent';
  const protectedAssetId = '1234567890abcdef1234567890abcdef';
  const machineFingerprint = 'a604eb0948054b9acb9f40da80a6a4c8e711b98c59e54a11089fea3a2b77dc1c';
  const projectId = '0123456789abcdef0123456789abcdef';
  const creatorAuthUserId = 'auth-protected-install-intent';
  const outerPackageHash = 'a'.repeat(64);
  const blobHash = 'b'.repeat(64);
  const manifestBindingSha256 = 'c'.repeat(64);

  let rootPrivateKey = '';

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
        publisherId: 'publisher-protected-install-intent',
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
      publisherId: 'publisher-protected-install-intent',
      yucpUserId: creatorAuthUserId,
      certNonce: 'cert-nonce-protected-install-intent',
      protectedAssets: [
        {
          protectedAssetId,
          unlockMode: 'content_key_b64',
          contentKeyBase64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
          contentHash: blobHash,
          manifestBindingSha256,
          displayName: 'Protected Payload',
        },
      ],
    });
  }

  async function mintLicenseToken() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return await signLicenseJwt(
      {
        iss: buildPublicAuthIssuer(issuerBaseUrl),
        aud: 'yucp-license-gate',
        sub: 'license-subject-protected-install-intent',
        jti: 'nonce-protected-install-intent',
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

  it('issues install intents bound to the manifest-bound protected payload descriptor', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedProtectedAsset(t);
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueProtectedInstallIntent, {
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      manifestBindingSha256,
      licenseToken,
      issuerBaseUrl,
    });

    expect(result).toMatchObject({ success: true });
    expect(result.installIntentToken).toBeTruthy();

    const claims = await verifyProtectedInstallIntentJwt(
      result.installIntentToken!,
      process.env.YUCP_ROOT_PUBLIC_KEY!,
      buildPublicAuthIssuer(issuerBaseUrl)
    );

    expect(claims).toMatchObject({
      package_id: packageId,
      protected_asset_id: protectedAssetId,
      machine_fingerprint: machineFingerprint,
      project_id: projectId,
      manifest_binding_sha256: manifestBindingSha256,
    });
    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBeLessThanOrEqual(10 * 60);
  });
});
