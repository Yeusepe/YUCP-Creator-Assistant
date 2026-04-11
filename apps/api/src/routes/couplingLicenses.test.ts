import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { buildPublicAuthIssuer } from '@yucp/shared/publicAuthority';
import type { RuntimeArtifactManifestSuccess } from '../lib/couplingRuntimeArtifacts';
import { getPublicKeyFromPrivate, type LicenseClaims } from '../lib/yucpRuntimeCrypto';

const apiMock = {
  yucpLicenses: {
    issueCouplingJobForApi: 'yucpLicenses.issueCouplingJobForApi',
    issueProtectedInstallIntentForApi: 'yucpLicenses.issueProtectedInstallIntentForApi',
    issueProtectedMaterializationGrantForApi:
      'yucpLicenses.issueProtectedMaterializationGrantForApi',
  },
} as const;

const actionMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);
const manifestMock = mock(
  async (
    _baseUrl: string,
    _sharedSecret: string,
    _artifactKey: 'coupling-runtime' | 'coupling-runtime-package'
  ): Promise<RuntimeArtifactManifestSuccess> => ({
    success: true,
    artifactKey: 'coupling-runtime',
    channel: 'stable',
    platform: 'win-x64',
    version: '2026.04.09',
    metadataVersion: 1,
    deliveryName: 'yucp_coupling.dll',
    contentType: 'application/octet-stream',
    envelopeCipher: 'none',
    envelopeIvBase64: '',
    ciphertextSha256: 'c'.repeat(64),
    ciphertextSize: 42,
    plaintextSha256: 'p'.repeat(64),
    plaintextSize: 42,
    downloadUrl: 'https://coupling.example/v1/licenses/coupling-runtime',
  })
);

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  internal: apiMock,
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    action: actionMock,
  }),
  getConvexClient: () => ({
    query: actionMock,
    mutation: actionMock,
    action: actionMock,
  }),
  getConvexApiSecret: () => 'test-convex-secret',
}));

mock.module('../lib/couplingRuntimeArtifacts', () => ({
  fetchRuntimeArtifactManifest: manifestMock,
  buildRuntimeArtifactDownloadUrl: (manifest: RuntimeArtifactManifestSuccess, token: string) => {
    const url = new URL(manifest.downloadUrl);
    url.searchParams.set('token', token);
    return url.toString();
  },
}));

const { createCouplingLicenseRoutes } = await import('./couplingLicenses');
const { signJwt } = await import('../lib/yucpRuntimeCrypto.test-helpers');

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  const payload = parts[1];
  if (!payload) {
    throw new Error('JWT payload is missing');
  }

  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('coupling license routes', () => {
  const rootPrivateKey = Buffer.alloc(32, 7).toString('base64');
  const apiBaseUrl = 'https://api.creators.yucp.club';
  const routes = createCouplingLicenseRoutes({
    apiBaseUrl,
    couplingServiceBaseUrl: 'https://coupling.internal',
    couplingServiceSharedSecret: 'coupling-secret',
    convexApiSecret: 'convex-secret',
    convexUrl: 'https://convex.invalid',
  });

  beforeEach(() => {
    actionMock.mockReset();
    manifestMock.mockReset();
    manifestMock.mockImplementation(
      async (
        _baseUrl: string,
        _sharedSecret: string,
        artifactKey: 'coupling-runtime' | 'coupling-runtime-package'
      ): Promise<RuntimeArtifactManifestSuccess> => ({
        success: true,
        artifactKey,
        channel: 'stable',
        platform: 'win-x64',
        version: artifactKey === 'coupling-runtime' ? '2026.04.09' : '2026.04.09-package',
        metadataVersion: 1,
        deliveryName:
          artifactKey === 'coupling-runtime'
            ? 'yucp_coupling.dll'
            : 'yucp-coupling-runtime-package.zip',
        contentType:
          artifactKey === 'coupling-runtime' ? 'application/octet-stream' : 'application/zip',
        envelopeCipher: 'none',
        envelopeIvBase64: '',
        ciphertextSha256: 'c'.repeat(64),
        ciphertextSize: 42,
        plaintextSha256: artifactKey === 'coupling-runtime' ? 'a'.repeat(64) : 'b'.repeat(64),
        plaintextSize: 42,
        downloadUrl: `https://coupling.example/v1/licenses/${
          artifactKey === 'coupling-runtime' ? 'coupling-runtime' : 'runtime-package'
        }`,
      })
    );
    process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
    delete process.env.YUCP_ROOT_PUBLIC_KEY;
    process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
  });

  it('issues runtime package tokens from coupling manifest metadata', async () => {
    const publicKey = await getPublicKeyFromPrivate(rootPrivateKey);
    const licenseClaims: LicenseClaims = {
      iss: buildPublicAuthIssuer(apiBaseUrl),
      aud: 'yucp-license-gate',
      sub: 'buyer-subject',
      jti: 'license-jti',
      package_id: 'pkg.creator.bundle',
      machine_fingerprint: 'machine-fingerprint-1234',
      provider: 'gumroad',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const licenseToken = await signJwt(licenseClaims, rootPrivateKey, 'yucp-root');

    const response = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/licenses/runtime-package-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'pkg.creator.bundle',
          projectId: '0123456789abcdef0123456789abcdef',
          machineFingerprint: 'machine-fingerprint-1234',
          licenseToken,
        }),
      })
    );

    expect(response?.status).toBe(200);
    const json = await response?.json();
    expect(json.success).toBe(true);
    expect(json.runtimePackageSha256).toBe('b'.repeat(64));
    expect(String(json.runtimePackageUrl)).toContain(
      'https://coupling.example/v1/licenses/runtime-package?token='
    );
    expect(publicKey).toHaveLength(44);
  });

  it('issues coupling jobs with runtime metadata sourced from coupling', async () => {
    actionMock.mockImplementation(async (ref: unknown, args: unknown) => {
      expect(ref).toBe(apiMock.yucpLicenses.issueCouplingJobForApi);
      expect(args).toEqual({
        apiSecret: 'convex-secret',
        packageId: 'pkg.creator.bundle',
        projectId: '0123456789abcdef0123456789abcdef',
        machineFingerprint: 'machine-fingerprint-1234',
        licenseToken: 'license-token',
        assetPaths: ['Assets/Protected.prefab'],
        issuerBaseUrl: 'https://api.creators.yucp.club',
        runtimeArtifactVersion: '2026.04.09',
        runtimePlaintextSha256: 'a'.repeat(64),
      });
      return {
        success: true,
        subject: 'buyer-subject',
        jobs: [
          {
            assetPath: 'Assets/Protected.prefab',
            tokenHex: 'deadbeef',
            materializationNonce: '11223344',
          },
        ],
      };
    });

    const response = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/licenses/coupling-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'pkg.creator.bundle',
          projectId: '0123456789abcdef0123456789abcdef',
          machineFingerprint: 'machine-fingerprint-1234',
          licenseToken: 'license-token',
          assetPaths: ['Assets/Protected.prefab'],
        }),
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      success: true,
      runtimeSha256: 'a'.repeat(64),
      files: [
        {
          assetPath: 'Assets/Protected.prefab',
          tokenHex: 'deadbeef',
          materializationNonce: '11223344',
        },
      ],
    });
  });

  it('redirects legacy runtime download routes through the coupling manifest URL', async () => {
    const response = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/licenses/coupling-runtime?token=abc123`, {
        method: 'GET',
      })
    );

    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toBe(
      'https://coupling.example/v1/licenses/coupling-runtime?token=abc123'
    );
  });

  it('serves runtime manifests from the API surface with API download URLs', async () => {
    const response = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/runtime-artifacts/manifest?artifactKey=coupling-runtime`, {
        method: 'GET',
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      success: true,
      artifactKey: 'coupling-runtime',
      channel: 'stable',
      platform: 'win-x64',
      version: '2026.04.09',
      metadataVersion: 1,
      deliveryName: 'yucp_coupling.dll',
      contentType: 'application/octet-stream',
      envelopeCipher: 'none',
      envelopeIvBase64: '',
      ciphertextSha256: 'c'.repeat(64),
      ciphertextSize: 42,
      plaintextSha256: 'a'.repeat(64),
      plaintextSize: 42,
      downloadUrl: 'https://api.creators.yucp.club/v1/licenses/coupling-runtime',
    });
  });

  it('issues protected materialization grants with runtime metadata sourced from coupling', async () => {
    actionMock.mockImplementation(async (ref: unknown, args: unknown) => {
      expect(ref).toBe(apiMock.yucpLicenses.issueProtectedMaterializationGrantForApi);
      expect(args).toEqual({
        apiSecret: 'convex-secret',
        packageId: 'pkg.creator.bundle',
        protectedAssetId: '0123456789abcdef0123456789abcdef',
        projectId: '0123456789abcdef0123456789abcdef',
        machineFingerprint: 'machine-fingerprint-1234',
        licenseToken: 'license-token',
        assetPaths: ['Assets/Protected.prefab'],
        issuerBaseUrl: 'https://api.creators.yucp.club',
        runtimeArtifactVersion: '2026.04.09',
        runtimePlaintextSha256: 'a'.repeat(64),
      });
      return {
        success: true,
        grant: 'sealed-grant',
        expiresAt: 1234567890,
      };
    });

    const response = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/licenses/protected-materialization-grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'pkg.creator.bundle',
          protectedAssetId: '0123456789abcdef0123456789abcdef',
          projectId: '0123456789abcdef0123456789abcdef',
          machineFingerprint: 'machine-fingerprint-1234',
          licenseToken: 'license-token',
          assetPaths: ['Assets/Protected.prefab'],
        }),
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      success: true,
      grant: 'sealed-grant',
      expiresAt: 1234567890,
    });
  });

  it('issues protected install intents through the public API surface', async () => {
    actionMock.mockImplementation(async (ref: unknown, args: unknown) => {
      expect(ref).toBe(apiMock.yucpLicenses.issueProtectedInstallIntentForApi);
      expect(args).toEqual({
        apiSecret: 'convex-secret',
        packageId: 'pkg.creator.bundle',
        protectedAssetId: '0123456789abcdef0123456789abcdef',
        projectId: '0123456789abcdef0123456789abcdef',
        machineFingerprint: 'machine-fingerprint-1234',
        manifestBindingSha256: 'f'.repeat(64),
        licenseToken: 'license-token',
        issuerBaseUrl: 'https://api.creators.yucp.club',
      });
      return {
        success: true,
        installIntentToken: 'install-intent-token',
        expiresAt: 1234567890,
      };
    });

    const response = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/licenses/protected-install-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'pkg.creator.bundle',
          protectedAssetId: '0123456789abcdef0123456789abcdef',
          projectId: '0123456789abcdef0123456789abcdef',
          machineFingerprint: 'machine-fingerprint-1234',
          manifestBindingSha256: 'f'.repeat(64),
          licenseToken: 'license-token',
        }),
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      success: true,
      installIntentToken: 'install-intent-token',
      expiresAt: 1234567890,
    });
  });

  it('models the full public runtime flow end-to-end across manifest, token, job, grant, and download routes', async () => {
    const licenseClaims: LicenseClaims = {
      iss: buildPublicAuthIssuer(apiBaseUrl),
      aud: 'yucp-license-gate',
      sub: 'buyer-subject',
      jti: 'license-jti',
      package_id: 'pkg.creator.bundle',
      machine_fingerprint: 'machine-fingerprint-1234',
      provider: 'gumroad',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const licenseToken = await signJwt(licenseClaims, rootPrivateKey, 'yucp-root');

    actionMock.mockImplementation(async (ref: unknown, args: unknown) => {
      if (ref === apiMock.yucpLicenses.issueCouplingJobForApi) {
        expect(args).toEqual({
          apiSecret: 'convex-secret',
          packageId: 'pkg.creator.bundle',
          projectId: '0123456789abcdef0123456789abcdef',
          machineFingerprint: 'machine-fingerprint-1234',
          licenseToken,
          assetPaths: ['Assets/Protected.prefab'],
          issuerBaseUrl: 'https://api.creators.yucp.club',
          runtimeArtifactVersion: '2026.04.09',
          runtimePlaintextSha256: 'a'.repeat(64),
        });
        return {
          success: true,
          subject: 'buyer-subject',
          jobs: [
            {
              assetPath: 'Assets/Protected.prefab',
              tokenHex: 'deadbeef',
              materializationNonce: '11223344',
            },
          ],
        };
      }

      if (ref === apiMock.yucpLicenses.issueProtectedMaterializationGrantForApi) {
        expect(args).toEqual({
          apiSecret: 'convex-secret',
          packageId: 'pkg.creator.bundle',
          protectedAssetId: '0123456789abcdef0123456789abcdef',
          projectId: '0123456789abcdef0123456789abcdef',
          machineFingerprint: 'machine-fingerprint-1234',
          licenseToken,
          assetPaths: ['Assets/Protected.prefab'],
          issuerBaseUrl: 'https://api.creators.yucp.club',
          runtimeArtifactVersion: '2026.04.09',
          runtimePlaintextSha256: 'a'.repeat(64),
        });
        return {
          success: true,
          grant: 'sealed-grant',
          expiresAt: 1234567890,
        };
      }

      throw new Error(`Unexpected action ${String(ref)}`);
    });

    const manifestResponse = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/runtime-artifacts/manifest?artifactKey=coupling-runtime`, {
        method: 'GET',
      })
    );
    expect(manifestResponse?.status).toBe(200);
    const manifestJson = (await manifestResponse?.json()) as Record<string, unknown>;
    expect(manifestJson.downloadUrl).toBe(
      'https://api.creators.yucp.club/v1/licenses/coupling-runtime'
    );

    const runtimePackageResponse = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/licenses/runtime-package-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'pkg.creator.bundle',
          projectId: '0123456789abcdef0123456789abcdef',
          machineFingerprint: 'machine-fingerprint-1234',
          licenseToken,
        }),
      })
    );
    expect(runtimePackageResponse?.status).toBe(200);
    const runtimePackageJson = (await runtimePackageResponse?.json()) as Record<string, unknown>;
    expect(runtimePackageJson.runtimePackageSha256).toBe('b'.repeat(64));
    expect(runtimePackageJson.runtimePackageUrl).toBe(
      'https://coupling.example/v1/licenses/runtime-package?token=' +
        String(runtimePackageJson.runtimePackageToken)
    );
    expect(decodeJwtPayload(String(runtimePackageJson.runtimePackageToken))).toMatchObject({
      aud: 'yucp-runtime-package',
      package_id: 'pkg.creator.bundle',
      machine_fingerprint: 'machine-fingerprint-1234',
      project_id: '0123456789abcdef0123456789abcdef',
      artifact_version: '2026.04.09-package',
      plaintext_sha256: 'b'.repeat(64),
    });

    const couplingJobResponse = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/licenses/coupling-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'pkg.creator.bundle',
          projectId: '0123456789abcdef0123456789abcdef',
          machineFingerprint: 'machine-fingerprint-1234',
          licenseToken,
          assetPaths: ['Assets/Protected.prefab'],
        }),
      })
    );
    expect(couplingJobResponse?.status).toBe(200);
    const couplingJobJson = (await couplingJobResponse?.json()) as Record<string, unknown>;
    expect(couplingJobJson.runtimeSha256).toBe('a'.repeat(64));
    expect(decodeJwtPayload(String(couplingJobJson.runtimeToken))).toMatchObject({
      aud: 'yucp-coupling-runtime',
      package_id: 'pkg.creator.bundle',
      machine_fingerprint: 'machine-fingerprint-1234',
      project_id: '0123456789abcdef0123456789abcdef',
      artifact_version: '2026.04.09',
      plaintext_sha256: 'a'.repeat(64),
    });
    expect(couplingJobJson.files).toEqual([
      {
        assetPath: 'Assets/Protected.prefab',
        tokenHex: 'deadbeef',
        materializationNonce: '11223344',
      },
    ]);

    const protectedGrantResponse = await routes.handleRequest(
      new Request(`${apiBaseUrl}/v1/licenses/protected-materialization-grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'pkg.creator.bundle',
          protectedAssetId: '0123456789abcdef0123456789abcdef',
          projectId: '0123456789abcdef0123456789abcdef',
          machineFingerprint: 'machine-fingerprint-1234',
          licenseToken,
          assetPaths: ['Assets/Protected.prefab'],
        }),
      })
    );
    expect(protectedGrantResponse?.status).toBe(200);
    await expect(protectedGrantResponse?.json()).resolves.toEqual({
      success: true,
      grant: 'sealed-grant',
      expiresAt: 1234567890,
    });

    const runtimeRedirectResponse = await routes.handleRequest(
      new Request(
        `${apiBaseUrl}/v1/licenses/coupling-runtime?token=${String(couplingJobJson.runtimeToken)}`,
        {
          method: 'GET',
        }
      )
    );
    expect(runtimeRedirectResponse?.status).toBe(307);
    expect(runtimeRedirectResponse?.headers.get('location')).toBe(
      `https://coupling.example/v1/licenses/coupling-runtime?token=${String(couplingJobJson.runtimeToken)}`
    );

    expect(manifestMock).toHaveBeenCalledTimes(5);
    expect(actionMock).toHaveBeenCalledTimes(2);
  });
});
