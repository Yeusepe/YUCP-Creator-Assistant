import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Auth } from '../auth';

const apiMock = {
  couplingForensics: {
    listOwnedPackageSummariesForAuthUser: 'couplingForensics.listOwnedPackageSummariesForAuthUser',
    lookupTraceMatchesForAuthUser: 'couplingForensics.lookupTraceMatchesForAuthUser',
    resolveBuyerIdentityForAuthUser: 'couplingForensics.resolveBuyerIdentityForAuthUser',
    recordLookupAudit: 'couplingForensics.recordLookupAudit',
  },
} as const;

const queryMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);
const mutationMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  internal: apiMock,
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: queryMock,
    mutation: mutationMock,
  }),
}));

mock.module('../lib/csrf', () => ({
  rejectCrossSiteRequest: () => null,
}));

const verificationMock = mock<
  () => Promise<{
    valid: boolean;
    providerUserId?: string;
    externalOrderId?: string;
    providerProductId?: string;
  }>
>(async () => ({ valid: false }));

mock.module('../providers/index', () => ({
  getProviderRuntime: () => ({
    verification: {
      verifyLicense: verificationMock,
    },
  }),
}));

const assetFixturePath = fileURLToPath(new URL(import.meta.url));
const extractCouplingForensicsArchiveMock = mock(
  async (_uploadPath?: string, _uploadName?: string, _workspaceDir?: string) => ({
    assets: [
      {
        assetPath: 'Assets/Character/body.png',
        assetType: 'png',
        filePath: assetFixturePath,
      },
    ],
    declaredPackageIds: ['creator.package'],
  })
);

mock.module('../lib/couplingForensicsArchives', () => ({
  extractCouplingForensicsArchive: extractCouplingForensicsArchiveMock,
}));

const { createForensicsRoutes } = await import('./forensics');
const { encryptForensicsLicenseKey } = await import('../verification/forensicsLicenseKey');

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('forensics routes', () => {
  const originalFetch = globalThis.fetch;
  const auth = {
    getSession: async () => ({ user: { id: 'creator-user' } }),
  } as unknown as Auth;

  const routes = createForensicsRoutes(auth, {
    apiBaseUrl: 'http://localhost:3001',
    couplingServiceBaseUrl: 'https://coupling.internal',
    couplingServiceSharedSecret: 'coupling-secret',
    frontendBaseUrl: 'http://localhost:3000',
    convexApiSecret: 'convex-secret',
    convexUrl: 'http://convex.invalid',
    encryptionSecret: 'encryption-secret',
  });

  beforeEach(() => {
    queryMock.mockReset();
    mutationMock.mockReset();
    verificationMock.mockReset();
    verificationMock.mockResolvedValue({ valid: false });
    extractCouplingForensicsArchiveMock.mockReset();
    extractCouplingForensicsArchiveMock.mockResolvedValue({
      assets: [
        {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          filePath: assetFixturePath,
        },
      ],
      declaredPackageIds: ['creator.package'],
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends extracted candidate assets to the coupling service before looking up trace matches', async () => {
    const expectedTokenHash = sha256Hex('deadbeef');

    queryMock.mockImplementation(async (ref: unknown, args: unknown) => {
      if (ref === apiMock.couplingForensics.lookupTraceMatchesForAuthUser) {
        expect(args).toEqual({
          apiSecret: 'convex-secret',
          authUserId: 'creator-user',
          packageId: 'creator.package',
          tokenHashes: [expectedTokenHash],
        });
        return {
          capabilityEnabled: true,
          packageOwned: true,
          matches: [
            {
              tokenHash: expectedTokenHash,
              licenseSubject: 'license-subject-1',
              assetPath: 'Assets/Character/body.png',
              correlationId: 'corr_1',
              createdAt: 1_739_999_999_000,
              runtimeArtifactVersion: '2026.03.25.153000',
              runtimePlaintextSha256: 'runtime-sha',
            },
          ],
          unmatchedTokenHashes: [],
        };
      }
      throw new Error(`Unexpected query ${String(ref)}`);
    });

    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('https://coupling.internal/v1/coupling/forensic-score');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer coupling-secret');
      expect(headers.get('content-type')).toBe('application/json');

      const requestBody = JSON.parse(String(init?.body)) as {
        mode: string;
        assets: Array<{ assetPath: string; assetType: string; contentBase64: string }>;
      };
      expect(requestBody.mode).toBe('scan');
      expect(requestBody.assets).toHaveLength(1);
      expect(requestBody.assets[0]).toMatchObject({
        assetPath: 'Assets/Character/body.png',
        assetType: 'png',
      });
      expect(requestBody.assets[0]?.contentBase64.length).toBeGreaterThan(0);

      return new Response(
        JSON.stringify({
          requestId: 'req-1',
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              decoderKind: 'png',
              preclassification: 'decoded',
              tokenHex: 'deadbeef',
              tokenLength: 8,
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const formData = new FormData();
    formData.set('packageId', 'creator.package');
    formData.set(
      'file',
      new File([Uint8Array.from([1, 2, 3])], 'bundle.zip', { type: 'application/zip' })
    );

    const response = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      packageId: 'creator.package',
      lookupStatus: 'attributed',
      candidateAssetCount: 1,
      decodedAssetCount: 1,
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          matched: true,
          layerBClassification: 'trace-recovered',
          matches: [
            {
              licenseSubject: 'license-subject-1',
              runtimeArtifactVersion: '2026.03.25.153000',
            },
          ],
        },
      ],
    });
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      apiSecret: 'convex-secret',
      authUserId: 'creator-user',
      packageId: 'creator.package',
      status: 'attributed',
    });
  });

  it('keeps proxied dashboard requests on the session auth path when no internal auth user header is present', async () => {
    const previousInternalRpcSecret = process.env.INTERNAL_RPC_SHARED_SECRET;
    process.env.INTERNAL_RPC_SHARED_SECRET = 'test-internal-secret';

    try {
      queryMock.mockImplementation(async (ref: unknown, args: unknown) => {
        if (ref === apiMock.couplingForensics.listOwnedPackageSummariesForAuthUser) {
          expect(args).toEqual({
            apiSecret: 'convex-secret',
            authUserId: 'creator-user',
          });
          return {
            packages: [
              {
                packageId: 'creator.package',
                packageName: 'Creator Suite+',
                registeredAt: 1_739_000_000_000,
                updatedAt: 1_739_500_000_000,
              },
            ],
          };
        }
        throw new Error(`Unexpected query ${String(ref)}`);
      });

      const response = await routes.listPackages(
        new Request('http://localhost:3001/api/forensics/packages', {
          method: 'GET',
          headers: {
            'x-internal-service-secret': 'test-internal-secret',
            cookie: 'yucp.session_token=session-cookie; yucp.session_data=session-data',
          },
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        packages: [
          {
            packageId: 'creator.package',
            packageName: 'Creator Suite+',
            registeredAt: 1_739_000_000_000,
            updatedAt: 1_739_500_000_000,
          },
        ],
      });
    } finally {
      if (previousInternalRpcSecret === undefined) {
        delete process.env.INTERNAL_RPC_SHARED_SECRET;
      } else {
        process.env.INTERNAL_RPC_SHARED_SECRET = previousInternalRpcSecret;
      }
    }
  });

  it('returns a tamper-suspected response when candidate assets have no decodable coupling signals', async () => {
    queryMock.mockImplementation(async () => {
      throw new Error('Trace lookup should not run without coupling findings');
    });
    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          requestId: 'req-2',
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              decoderKind: 'png',
              preclassification: 'likely-stripped',
              nativeCode: -10,
              decodeError: 'quorum not reached',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const formData = new FormData();
    formData.set('packageId', 'creator.package');
    formData.set(
      'file',
      new File([Uint8Array.from([4, 5, 6])], 'bundle.zip', { type: 'application/zip' })
    );

    const response = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      packageId: 'creator.package',
      lookupStatus: 'tampered_suspected',
      candidateAssetCount: 1,
      decodedAssetCount: 0,
      message: 'Candidate assets were found, but no valid coupling signals could be decoded',
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          layerBClassification: 'trace-likely-stripped',
          matched: false,
        },
      ],
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'tampered_suspected',
    });
  });

  it('treats empty forensic-score results as candidate assets with no recovered signals', async () => {
    queryMock.mockImplementation(async () => {
      throw new Error('Trace lookup should not run without decoded coupling findings');
    });
    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          requestId: 'req-empty',
          results: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const formData = new FormData();
    formData.set('packageId', 'creator.package');
    formData.set(
      'file',
      new File([Uint8Array.from([10, 11, 12])], 'bundle.zip', { type: 'application/zip' })
    );

    const response = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      packageId: 'creator.package',
      lookupStatus: 'tampered_suspected',
      candidateAssetCount: 1,
      decodedAssetCount: 0,
      message: 'Candidate assets were found, but no valid coupling signals could be decoded',
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          layerBClassification: 'no-signal-found',
          matched: false,
        },
      ],
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'tampered_suspected',
    });
  });

  it('sanitizes uploaded archive filenames before writing them into the extraction workspace', async () => {
    mutationMock.mockResolvedValue(undefined);
    extractCouplingForensicsArchiveMock.mockImplementation(
      async (uploadPath = '', uploadName = '', workspaceDir = '') => {
        expect(uploadName).toBe('evil.zip');
        expect(path.basename(uploadPath)).toBe('evil.zip');
        expect(uploadPath.startsWith(workspaceDir)).toBe(true);
        expect(uploadPath).not.toContain('..');
        return {
          assets: [],
          declaredPackageIds: ['creator.package'],
        };
      }
    );

    const formData = new FormData();
    formData.set('packageId', 'creator.package');
    formData.set(
      'file',
      new File([Uint8Array.from([20, 21, 22])], '../nested/evil.zip', {
        type: 'application/zip',
      })
    );

    const response = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      packageId: 'creator.package',
      lookupStatus: 'no_candidate_assets',
    });
  });

  it('returns a typed lookup failure when forensic-score returns an object error payload', async () => {
    queryMock.mockImplementation(async () => {
      throw new Error('Trace lookup should not run when the coupling service rejects the request');
    });
    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 'native_runtime_unavailable',
            message: 'Native runtime is unavailable',
          },
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const formData = new FormData();
    formData.set('packageId', 'creator.package');
    formData.set(
      'file',
      new File([Uint8Array.from([13, 14, 15])], 'bundle.zip', { type: 'application/zip' })
    );

    const response = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Coupling forensics lookup failed',
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'error',
    });
  });

  it('returns a hostile-unknown response when decoded coupling signals do not match an authorized trace record', async () => {
    const expectedTokenHash = sha256Hex('deadbeef');

    queryMock.mockImplementation(async (ref: unknown, args: unknown) => {
      if (ref === apiMock.couplingForensics.lookupTraceMatchesForAuthUser) {
        expect(args).toEqual({
          apiSecret: 'convex-secret',
          authUserId: 'creator-user',
          packageId: 'creator.package',
          tokenHashes: [expectedTokenHash],
        });
        return {
          capabilityEnabled: true,
          packageOwned: true,
          matches: [],
          unmatchedTokenHashes: [expectedTokenHash],
        };
      }
      throw new Error(`Unexpected query ${String(ref)}`);
    });

    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          requestId: 'req-3',
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              decoderKind: 'png',
              preclassification: 'decoded',
              tokenHex: 'deadbeef',
              tokenLength: 8,
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const formData = new FormData();
    formData.set('packageId', 'creator.package');
    formData.set(
      'file',
      new File([Uint8Array.from([7, 8, 9])], 'bundle.zip', { type: 'application/zip' })
    );

    const response = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      packageId: 'creator.package',
      lookupStatus: 'hostile_unknown',
      candidateAssetCount: 1,
      decodedAssetCount: 1,
      message: 'The uploaded archive did not resolve to an authorized trace record',
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          matched: false,
          layerBClassification: 'tamper-suspected',
          matches: [],
        },
      ],
    });
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'hostile_unknown',
    });
  });

  it('rehydrates buyer identity from the encrypted stored license instead of redundant stored buyer columns', async () => {
    const encryptedLicenseKey = await encryptForensicsLicenseKey(
      '11111111-2222-3333-4444-555555555555',
      'encryption-secret'
    );
    const expectedTokenHash = sha256Hex('deadbeef');

    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.lookupTraceMatchesForAuthUser) {
        return {
          capabilityEnabled: true,
          packageOwned: true,
          matches: [
            {
              tokenHash: expectedTokenHash,
              licenseSubject: 'license-subject-1',
              assetPath: 'Assets/Character/body.png',
              correlationId: 'corr_1',
              createdAt: 1_739_999_999_000,
              runtimeArtifactVersion: '2026.03.25.153000',
              runtimePlaintextSha256: 'runtime-sha',
              provider: 'jinxxy',
              purchaserEmail: 'buyer@example.com',
              licenseKeyEncrypted: encryptedLicenseKey,
              providerProductId: 'product-123',
            },
          ],
          unmatchedTokenHashes: [],
        };
      }
      if (ref === apiMock.couplingForensics.resolveBuyerIdentityForAuthUser) {
        return {
          buyerProviderUserId: 'customer-123',
          buyerProviderUsername: 'BuyerAccount',
          buyerSubjectDisplayName: 'Buyer One',
          buyerSubjectDiscordUserId: 'discord-buyer-1',
        };
      }
      throw new Error(`Unexpected query ${String(ref)}`);
    });

    mutationMock.mockResolvedValue(undefined);
    verificationMock.mockResolvedValue({
      valid: true,
      providerUserId: 'customer-123',
      externalOrderId: 'order-123',
      providerProductId: 'product-123',
    });

    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          requestId: 'req-4',
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              decoderKind: 'png',
              preclassification: 'decoded',
              tokenHex: 'deadbeef',
              tokenLength: 8,
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const formData = new FormData();
    formData.set('packageId', 'creator.package');
    formData.set(
      'file',
      new File([Uint8Array.from([16, 17, 18])], 'bundle.zip', { type: 'application/zip' })
    );

    const response = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        method: 'POST',
        body: formData,
      })
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      results: Array<{ matches: Array<Record<string, unknown>> }>;
    };
    expect(json).toMatchObject({
      lookupStatus: 'attributed',
      results: [
        {
          matches: [
            {
              buyerProviderUserId: 'customer-123',
              buyerProviderUsername: 'BuyerAccount',
              buyerSubjectDisplayName: 'Buyer One',
              buyerSubjectDiscordUserId: 'discord-buyer-1',
            },
          ],
        },
      ],
    });
    const match = json.results[0]?.matches[0];
    expect(match).not.toHaveProperty('licenseKey');
    expect(match).not.toHaveProperty('purchaserEmail');
  });
});
