import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Auth } from '../auth';

const apiMock = {
  couplingForensics: {
    listOwnedPackageSummariesForAuthUser: 'couplingForensics.listOwnedPackageSummariesForAuthUser',
    listCouplingTraceCandidatesForAuthUser:
      'couplingForensics.listCouplingTraceCandidatesForAuthUser',
    lookupTraceMatchesForAuthUser: 'couplingForensics.lookupTraceMatchesForAuthUser',
    resolveBuyerIdentityForAuthUser: 'couplingForensics.resolveBuyerIdentityForAuthUser',
    recordLookupAudit: 'couplingForensics.recordLookupAudit',
    revealCouplingLicenseKey: 'couplingForensics.revealCouplingLicenseKey',
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

// One recorded buyer for the registered package: assetPath + licenseSubject + the sha256 of the
// token the seed-iteration decoder is expected to recover.
function defaultCandidates(tokenHash: string) {
  return [
    {
      assetPath: 'Assets/Character/body.png',
      licenseSubject: 'license-subject-1',
      tokenHash,
    },
  ];
}

const TEST_COUPLING_BEARER = ['unit', 'test', 'coupling', 'bearer'].join('-');
const TEST_CONVEX_API_TOKEN = ['unit', 'test', 'convex', 'api', 'token'].join('-');
const TEST_ENCRYPTION_KEY = ['unit', 'test', 'encryption', 'key'].join('-');

describe('forensics routes', () => {
  const originalFetch = globalThis.fetch;
  const auth = {
    getSession: async () => ({ user: { id: 'creator-user' } }),
  } as unknown as Auth;

  const routes = createForensicsRoutes(auth, {
    apiBaseUrl: 'http://localhost:3001',
    couplingServiceBaseUrl: 'https://coupling.internal',
    couplingServiceSharedSecret: TEST_COUPLING_BEARER,
    frontendBaseUrl: 'http://localhost:3000',
    convexApiSecret: TEST_CONVEX_API_TOKEN,
    convexUrl: 'http://convex.invalid',
    encryptionSecret: TEST_ENCRYPTION_KEY,
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

  it('attributes a leaked asset to its buyer via seed-iteration candidates', async () => {
    const expectedTokenHash = sha256Hex('deadbeef');

    queryMock.mockImplementation(async (ref: unknown, args: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        expect(args).toEqual({
          apiSecret: TEST_CONVEX_API_TOKEN,
          authUserId: 'creator-user',
          packageId: 'creator.package',
        });
        return {
          capabilityEnabled: true,
          packageOwned: true,
          candidates: defaultCandidates(expectedTokenHash),
        };
      }
      if (ref === apiMock.couplingForensics.lookupTraceMatchesForAuthUser) {
        expect(args).toEqual({
          apiSecret: TEST_CONVEX_API_TOKEN,
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
      expect(url).toBe('https://coupling.internal/v1/coupling/attribute');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${TEST_COUPLING_BEARER}`);
      expect(headers.get('content-type')).toBe('application/json');

      const requestBody = JSON.parse(String(init?.body)) as {
        assets: Array<{ assetPath: string; assetType: string; contentBase64: string }>;
        candidates: Array<{ assetPath: string; licenseSubject: string; tokenHash: string }>;
      };
      expect(requestBody.assets).toHaveLength(1);
      expect(requestBody.assets[0]).toMatchObject({
        assetPath: 'Assets/Character/body.png',
        assetType: 'png',
      });
      expect(requestBody.assets[0]?.contentBase64.length).toBeGreaterThan(0);
      expect(requestBody.candidates).toEqual(defaultCandidates(expectedTokenHash));

      return new Response(
        JSON.stringify({
          requestId: 'req-1',
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              matched: true,
              tokenHex: 'deadbeef',
              matchedLicenseSubject: 'license-subject-1',
              wmVersion: 2,
              attempted: 1,
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
      apiSecret: TEST_CONVEX_API_TOKEN,
      authUserId: 'creator-user',
      packageId: 'creator.package',
      status: 'attributed',
    });
  });

  it('returns a 402 when the viewer lacks the coupling traceability capability', async () => {
    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return { capabilityEnabled: false, packageOwned: false, candidates: [] };
      }
      throw new Error(`Unexpected query ${String(ref)}`);
    });
    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async () => {
      throw new Error('Coupling service should not be called without capability');
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

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: 'Creator Studio+ is required for coupling traceability',
      code: 'coupling_traceability_required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'denied',
    });
  });

  it('rejects oversized declared lookup bodies before multipart parsing', async () => {
    const response = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        method: 'POST',
        headers: {
          'Content-Length': String(100 * 1024 * 1024 + 1),
          'Content-Type': 'multipart/form-data; boundary=x',
        },
        body: '--x--',
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Upload exceeds the size limit' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(mutationMock).not.toHaveBeenCalled();
    expect(extractCouplingForensicsArchiveMock).not.toHaveBeenCalled();
  });

  it('rejects streamed lookup bodies over the cap before multipart parsing', async () => {
    const cappedRoutes = createForensicsRoutes(auth, {
      apiBaseUrl: 'http://localhost:3001',
      couplingServiceBaseUrl: 'https://coupling.internal',
      couplingServiceSharedSecret: TEST_COUPLING_BEARER,
      frontendBaseUrl: 'http://localhost:3000',
      convexApiSecret: TEST_CONVEX_API_TOKEN,
      convexUrl: 'http://convex.invalid',
      encryptionSecret: TEST_ENCRYPTION_KEY,
      maxLookupUploadBytes: 5,
    });
    const body = new FormData();
    body.set('packageId', 'creator.package');
    body.set('file', new File(['oversized'], 'package.zip', { type: 'application/zip' }));

    const response = await cappedRoutes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        method: 'POST',
        body,
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Upload exceeds the size limit' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(mutationMock).not.toHaveBeenCalled();
    expect(extractCouplingForensicsArchiveMock).not.toHaveBeenCalled();
  });

  it('returns hostile-unknown when the viewer does not own the package', async () => {
    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return { capabilityEnabled: true, packageOwned: false, candidates: [] };
      }
      throw new Error(`Unexpected query ${String(ref)}`);
    });
    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async () => {
      throw new Error('Coupling service should not be called for an unowned package');
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
      lookupStatus: 'hostile_unknown',
      candidateAssetCount: 1,
      decodedAssetCount: 0,
      results: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'denied',
    });
  });

  it('returns hostile-unknown without attribution when an owned package has no trace candidates', async () => {
    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return {
          capabilityEnabled: true,
          packageOwned: true,
          truncated: false,
          candidateLimit: 512,
          candidates: [],
        };
      }
      throw new Error(`Unexpected query ${String(ref)}`);
    });
    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async () => {
      throw new Error('Coupling service should not be called without trace candidates');
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
      lookupStatus: 'hostile_unknown',
      candidateAssetCount: 1,
      decodedAssetCount: 0,
      results: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'hostile_unknown',
      requestedTokenCount: 0,
      matchedTokenCount: 0,
    });
  });

  it('fails closed when the trace candidate scan is truncated before attribution', async () => {
    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return {
          capabilityEnabled: true,
          packageOwned: true,
          truncated: true,
          candidateLimit: 512,
          candidates: defaultCandidates(sha256Hex('deadbeef')),
        };
      }
      throw new Error(`Unexpected query ${String(ref)}`);
    });
    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async () => {
      throw new Error('Coupling service should not be called with a truncated candidate set');
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

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Trace candidate limit exceeded; narrow the package or retry after archival',
      code: 'coupling_trace_candidate_limit_exceeded',
      candidateLimit: 512,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'error',
      requestedTokenCount: 512,
      matchedTokenCount: 0,
    });
  });

  it('keeps proxied dashboard requests on the session auth path when no internal auth user header is present', async () => {
    const previousInternalRpcSecret = process.env.INTERNAL_RPC_SHARED_SECRET;
    process.env.INTERNAL_RPC_SHARED_SECRET = 'test-internal-secret';

    try {
      queryMock.mockImplementation(async (ref: unknown, args: unknown) => {
        if (ref === apiMock.couplingForensics.listOwnedPackageSummariesForAuthUser) {
          expect(args).toEqual({
            apiSecret: TEST_CONVEX_API_TOKEN,
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

  it('returns a tamper-suspected response when no candidate seed decodes the uploaded asset', async () => {
    const expectedTokenHash = sha256Hex('deadbeef');

    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return {
          capabilityEnabled: true,
          packageOwned: true,
          candidates: defaultCandidates(expectedTokenHash),
        };
      }
      throw new Error(`Trace lookup should not run without recovered tokens (${String(ref)})`);
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
              matched: false,
              attempted: 1,
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
          layerBClassification: 'no-signal-found',
          matched: false,
        },
      ],
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'tampered_suspected',
    });
  });

  it('treats empty attribution results as candidate assets with no recovered signals', async () => {
    const expectedTokenHash = sha256Hex('deadbeef');

    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return {
          capabilityEnabled: true,
          packageOwned: true,
          candidates: defaultCandidates(expectedTokenHash),
        };
      }
      throw new Error(`Trace lookup should not run without recovered tokens (${String(ref)})`);
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
    expect(queryMock).toHaveBeenCalledTimes(1);
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

  it('returns a typed lookup failure when attribution returns an object error payload', async () => {
    const expectedTokenHash = sha256Hex('deadbeef');

    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return {
          capabilityEnabled: true,
          packageOwned: true,
          candidates: defaultCandidates(expectedTokenHash),
        };
      }
      throw new Error(`Trace lookup should not run when attribution fails (${String(ref)})`);
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
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'error',
    });
  });

  it('returns a hostile-unknown response when a recovered token does not resolve to a trace record', async () => {
    const expectedTokenHash = sha256Hex('deadbeef');

    queryMock.mockImplementation(async (ref: unknown, args: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return {
          capabilityEnabled: true,
          packageOwned: true,
          candidates: defaultCandidates(expectedTokenHash),
        };
      }
      if (ref === apiMock.couplingForensics.lookupTraceMatchesForAuthUser) {
        expect(args).toEqual({
          apiSecret: TEST_CONVEX_API_TOKEN,
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
              matched: true,
              tokenHex: 'deadbeef',
              matchedLicenseSubject: 'license-subject-1',
              wmVersion: 2,
              attempted: 1,
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
      TEST_ENCRYPTION_KEY
    );
    const expectedTokenHash = sha256Hex('deadbeef');

    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return {
          capabilityEnabled: true,
          packageOwned: true,
          candidates: defaultCandidates(expectedTokenHash),
        };
      }
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
              matched: true,
              tokenHex: 'deadbeef',
              matchedLicenseSubject: 'license-subject-1',
              wmVersion: 2,
              attempted: 1,
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

  it('rejects invalid reveal package ids as a client error before Convex writes', async () => {
    mutationMock.mockImplementation(async () => {
      throw new Error('Invalid reveal package ids should not reach Convex');
    });

    const response = await routes.revealLicense(
      new Request('http://localhost:3001/api/forensics/reveal-license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'INVALID PACKAGE',
          licenseSubject: 'a'.repeat(64),
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid packageId format' });
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it('rejects oversized reveal bodies before Convex writes', async () => {
    mutationMock.mockImplementation(async () => {
      throw new Error('Oversized reveal bodies should not reach Convex');
    });

    const response = await routes.revealLicense(
      new Request('http://localhost:3001/api/forensics/reveal-license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'creator.package',
          licenseSubject: 'a'.repeat(64),
          padding: 'x'.repeat(5_000),
        }),
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Request body too large' });
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it('returns a fixed forbidden error when reveal access is denied', async () => {
    mutationMock.mockResolvedValue({
      error: 'internal authorization detail for license-subject',
    });

    const response = await routes.revealLicense(
      new Request('http://localhost:3001/api/forensics/reveal-license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: 'creator.package',
          licenseSubject: 'a'.repeat(64),
        }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
  });
});
