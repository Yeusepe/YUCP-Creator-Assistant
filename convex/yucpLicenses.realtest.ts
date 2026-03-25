import { beforeEach, describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
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
});
