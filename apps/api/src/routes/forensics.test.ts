import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { Auth } from '../auth';

const apiMock = {
  couplingForensics: {
    authorizeCouplingForensicsLookupForAuthUser:
      'couplingForensics.authorizeCouplingForensicsLookupForAuthUser',
    listOwnedPackageSummariesForAuthUser: 'couplingForensics.listOwnedPackageSummariesForAuthUser',
    recordLookupAudit: 'couplingForensics.recordLookupAudit',
  },
} as const;

const queryMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);
const mutationMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: apiMock,
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    mutation: mutationMock,
    query: queryMock,
  }),
}));

mock.module('../lib/csrf', () => ({
  rejectCrossSiteRequest: () => null,
}));

const assetFixturePath = fileURLToPath(new URL(import.meta.url));
const extractCouplingForensicsArchiveMock = mock(async () => ({
  assets: [
    {
      assetPath: 'Assets/Jammr/body.png',
      assetType: 'png' as const,
      filePath: assetFixturePath,
    },
  ],
  declaredPackageIds: ['com.yucp.jammr'],
}));

mock.module('../lib/couplingForensicsArchives', () => ({
  extractCouplingForensicsArchive: extractCouplingForensicsArchiveMock,
}));

const { createForensicsRoutes } = await import('./forensics');
const { InMemoryPublicApiRateLimitStore } = await import('../lib/publicApiRateLimit');

const TEST_COUPLING_BEARER = 'unit-test-coupling-bearer';
const TEST_CONVEX_API_TOKEN = 'unit-test-convex-api-token';
const TEST_ENCRYPTION_KEY = 'unit-test-encryption-key';
const buyerSubjectPseudonym = Buffer.alloc(32, 0x77).toString('base64url');
const candidate = {
  algorithmVersion: 'png-dct-qim-v2',
  attributionId: 'attribution-1',
  attributionTokenHash: '66'.repeat(32),
  buyerSubjectPseudonym,
  capabilityId: 'capability-1',
  createdAt: 2_000_000_000_000,
  creatorId: 'creator-user',
  jobId: 'job-1',
  keyDerivation: 'v3' as const,
  keyEpoch: 3,
  leaseGeneration: 2,
  materializerType: 'png' as const,
  normalizedPath: 'Assets/Jammr/body.png',
  outputFormat: 'zip' as const,
  pluginVersion: 'png-plugin-2',
  protectedSourceRoot: '33'.repeat(32),
  releaseRoot: '11'.repeat(32),
  sourceSha256: '44'.repeat(32),
};

const auth = {
  getSession: async () => ({ user: { id: 'creator-user' } }),
} as unknown as Auth;

function lookupRequest(
  packageId = 'com.yucp.jammr',
  fileBytes = Uint8Array.from([1, 2, 3]),
  traceparent?: string
): Request {
  const formData = new FormData();
  formData.set('packageId', packageId);
  formData.set('file', new File([fileBytes], 'jammr.zip', { type: 'application/zip' }));
  return new Request('http://localhost:3001/api/forensics/lookup', {
    body: formData,
    headers: traceparent ? { traceparent } : undefined,
    method: 'POST',
  });
}

function createRoutes(input?: {
  candidatePage?: {
    candidateLimit: number;
    candidates: (typeof candidate)[];
    nextCursor?: string;
    truncated: boolean;
  };
  maxAttributionCandidateWork?: number;
  maxLookupUploadBytes?: number;
  rateLimit?: number;
  withMaterializationControl?: boolean;
}) {
  const candidatePage = input?.candidatePage ?? {
    candidateLimit: 512,
    candidates: [candidate],
    truncated: false,
  };
  const listAttributionCandidates = mock(async (request: { candidateLimit?: number }) => ({
    ...candidatePage,
    candidateLimit: request.candidateLimit ?? candidatePage.candidateLimit,
  }));
  const routes = createForensicsRoutes(auth, {
    apiBaseUrl: 'http://localhost:3001',
    couplingServiceBaseUrl: 'https://coupling.internal',
    couplingServiceSharedSecret: TEST_COUPLING_BEARER,
    convexApiSecret: TEST_CONVEX_API_TOKEN,
    convexUrl: 'http://convex.invalid',
    encryptionSecret: TEST_ENCRYPTION_KEY,
    frontendBaseUrl: 'http://localhost:3000',
    ...(input?.maxAttributionCandidateWork
      ? { maxAttributionCandidateWork: input.maxAttributionCandidateWork }
      : {}),
    ...(input?.maxLookupUploadBytes ? { maxLookupUploadBytes: input.maxLookupUploadBytes } : {}),
    ...(input?.rateLimit
      ? {
          lookupRateLimitMaxRequests: input.rateLimit,
          lookupRateLimitStore: new InMemoryPublicApiRateLimitStore(),
        }
      : {}),
    ...(input?.withMaterializationControl === false
      ? {}
      : { materializationControl: { listAttributionCandidates } }),
  });
  return { listAttributionCandidates, routes };
}

function installAuthorization(
  input: { capabilityEnabled?: boolean; packageOwned?: boolean } = {}
): void {
  queryMock.mockImplementation(async (ref: unknown, args: unknown) => {
    if (ref === apiMock.couplingForensics.authorizeCouplingForensicsLookupForAuthUser) {
      expect(args).toEqual({
        apiSecret: TEST_CONVEX_API_TOKEN,
        authUserId: 'creator-user',
        packageId: 'com.yucp.jammr',
      });
      return {
        capabilityEnabled: input.capabilityEnabled ?? true,
        packageOwned: input.packageOwned ?? true,
      };
    }
    throw new Error(`Unexpected query ${String(ref)}`);
  });
}

describe('forensics routes', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    queryMock.mockReset();
    mutationMock.mockReset();
    mutationMock.mockResolvedValue(undefined);
    extractCouplingForensicsArchiveMock.mockReset();
    extractCouplingForensicsArchiveMock.mockResolvedValue({
      assets: [
        {
          assetPath: 'Assets/Jammr/body.png',
          assetType: 'png',
          filePath: assetFixturePath,
        },
      ],
      declaredPackageIds: ['com.yucp.jammr'],
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
  });

  test('attributes a leaked asset through durable materialization records', async () => {
    installAuthorization();
    const { listAttributionCandidates, routes } = createRoutes();
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('https://coupling.internal/v2/internal/coupling/attribution/evaluate');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${TEST_COUPLING_BEARER}`
      );
      const body = JSON.parse(String(init?.body)) as {
        candidates: Array<Record<string, unknown>>;
        schemaVersion: number;
      };
      expect(body.schemaVersion).toBe(2);
      expect(body.candidates).toHaveLength(1);
      expect(body.candidates[0]).not.toHaveProperty('createdAt');
      return Response.json({
        results: [
          {
            assetPath: 'Assets/Jammr/body.png',
            assetType: 'png',
            attributionId: candidate.attributionId,
            buyerSubjectPseudonym,
            matched: true,
          },
        ],
        schemaVersion: 2,
      });
    }) as unknown as typeof fetch;

    const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';
    const response = await routes.lookup(
      lookupRequest('com.yucp.jammr', Uint8Array.from([1, 2, 3]), traceparent)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      candidateAssetCount: 1,
      decodedAssetCount: 1,
      lookupStatus: 'attributed',
      packageId: 'com.yucp.jammr',
      results: [
        {
          assetPath: 'Assets/Jammr/body.png',
          layerBClassification: 'trace-recovered',
          matched: true,
          matches: [
            {
              assetPath: 'Assets/Jammr/body.png',
              attributionId: 'attribution-1',
              buyerSubjectPseudonym,
              createdAt: candidate.createdAt,
              runtimeArtifactVersion: 'png-plugin-2',
            },
          ],
        },
      ],
    });
    expect(listAttributionCandidates).toHaveBeenCalledWith({
      candidateLimit: 256,
      creatorId: 'creator-user',
      productId: 'com.yucp.jammr',
      traceparent,
    });
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.couplingForensics.recordLookupAudit,
      expect.objectContaining({
        matchedAttributionCount: 1,
        requestedCandidateCount: 1,
        status: 'attributed',
      })
    );
  });

  test('attributes a relocated archive asset through its durable candidate identifier', async () => {
    const relocatedAssetPath = 'Recovered/Textures/body.png';
    installAuthorization();
    extractCouplingForensicsArchiveMock.mockResolvedValue({
      assets: [
        {
          assetPath: relocatedAssetPath,
          assetType: 'png',
          filePath: assetFixturePath,
        },
      ],
      declaredPackageIds: ['com.yucp.jammr'],
    });
    const { routes } = createRoutes();
    globalThis.fetch = mock(async () =>
      Response.json({
        results: [
          {
            assetPath: relocatedAssetPath,
            assetType: 'png',
            attributionId: candidate.attributionId,
            buyerSubjectPseudonym,
            matched: true,
          },
        ],
        schemaVersion: 2,
      })
    ) as unknown as typeof fetch;

    const response = await routes.lookup(lookupRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      decodedAssetCount: 1,
      lookupStatus: 'attributed',
      results: [
        {
          assetPath: relocatedAssetPath,
          layerBClassification: 'trace-recovered',
          matched: true,
          matches: [
            {
              assetPath: candidate.normalizedPath,
              attributionId: candidate.attributionId,
              buyerSubjectPseudonym,
            },
          ],
        },
      ],
    });
  });

  test('does not report tampering when no authorized candidate decodes', async () => {
    installAuthorization();
    const { routes } = createRoutes();
    globalThis.fetch = mock(async () =>
      Response.json({
        results: [
          {
            assetPath: 'Assets/Jammr/body.png',
            assetType: 'png',
            matched: false,
          },
        ],
        schemaVersion: 2,
      })
    ) as unknown as typeof fetch;

    const response = await routes.lookup(lookupRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      decodedAssetCount: 0,
      lookupStatus: 'no_signal_found',
      results: [
        {
          layerBClassification: 'no-signal-found',
          matched: false,
          matches: [],
        },
      ],
    });
  });

  test('enforces capability and package ownership before candidate reads', async () => {
    installAuthorization({ capabilityEnabled: false });
    const first = createRoutes();
    const capabilityResponse = await first.routes.lookup(lookupRequest());
    expect(capabilityResponse.status).toBe(402);
    expect(first.listAttributionCandidates).not.toHaveBeenCalled();

    installAuthorization({ packageOwned: false });
    const second = createRoutes();
    const ownershipResponse = await second.routes.lookup(lookupRequest());
    expect(ownershipResponse.status).toBe(200);
    expect(await ownershipResponse.json()).toMatchObject({
      lookupStatus: 'hostile_unknown',
    });
    expect(second.listAttributionCandidates).not.toHaveBeenCalled();
  });

  test('fails closed on missing control configuration', async () => {
    installAuthorization();
    const unconfigured = createRoutes({ withMaterializationControl: false });
    expect((await unconfigured.routes.lookup(lookupRequest())).status).toBe(503);
  });

  test('scans attribution pages until every asset is decoded', async () => {
    installAuthorization();
    const laterCandidate = {
      ...candidate,
      attributionId: 'attribution-2',
      jobId: 'job-2',
      normalizedPath: 'Assets/Jammr/body-v2.png',
    };
    const firstPageCandidates = Array.from({ length: 256 }, (_, index) => ({
      ...candidate,
      attributionId: `attribution-page-1-${index}`,
      jobId: `job-page-1-${index}`,
    }));
    const listAttributionCandidates = mock(async (input: { cursor?: string }) => {
      if (!input.cursor) {
        return {
          candidateLimit: 256,
          candidates: firstPageCandidates,
          nextCursor: 'cursor-1',
          truncated: true,
        };
      }
      expect(input.cursor).toBe('cursor-1');
      return {
        candidateLimit: 256,
        candidates: Array.from({ length: 256 }, (_, index) =>
          index === 0
            ? laterCandidate
            : {
                ...candidate,
                attributionId: `attribution-page-2-${index}`,
                jobId: `job-page-2-${index}`,
              }
        ),
        nextCursor: 'cursor-2',
        truncated: true,
      };
    });
    const routes = createForensicsRoutes(auth, {
      apiBaseUrl: 'http://localhost:3001',
      couplingServiceBaseUrl: 'https://coupling.internal',
      couplingServiceSharedSecret: TEST_COUPLING_BEARER,
      convexApiSecret: TEST_CONVEX_API_TOKEN,
      convexUrl: 'http://convex.invalid',
      encryptionSecret: TEST_ENCRYPTION_KEY,
      frontendBaseUrl: 'http://localhost:3000',
      materializationControl: { listAttributionCandidates },
    });
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        candidates: Array<{ attributionId: string }>;
      };
      const matched = body.candidates.some(
        (entry) => entry.attributionId === laterCandidate.attributionId
      );
      return Response.json({
        results: [
          matched
            ? {
                assetPath: 'Assets/Jammr/body.png',
                assetType: 'png',
                attributionId: laterCandidate.attributionId,
                buyerSubjectPseudonym,
                matched: true,
              }
            : {
                assetPath: 'Assets/Jammr/body.png',
                assetType: 'png',
                matched: false,
              },
        ],
        schemaVersion: 2,
      });
    }) as unknown as typeof fetch;

    const response = await routes.lookup(lookupRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      decodedAssetCount: 1,
      lookupStatus: 'attributed',
      results: [
        {
          matched: true,
          matches: [{ attributionId: laterCandidate.attributionId }],
        },
      ],
    });
    expect(listAttributionCandidates).toHaveBeenNthCalledWith(1, {
      candidateLimit: 256,
      creatorId: 'creator-user',
      productId: 'com.yucp.jammr',
    });
    expect(listAttributionCandidates).toHaveBeenNthCalledWith(2, {
      candidateLimit: 256,
      creatorId: 'creator-user',
      cursor: 'cursor-1',
      productId: 'com.yucp.jammr',
    });
    expect(listAttributionCandidates).toHaveBeenCalledTimes(2);
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.couplingForensics.recordLookupAudit,
      expect.objectContaining({
        requestedCandidateCount: 512,
        status: 'attributed',
      })
    );
  });

  test('returns the partial verdict when the scan time budget runs out', async () => {
    installAuthorization();
    const startedAt = Date.now();
    setSystemTime(new Date(startedAt));
    const pageCandidates = Array.from({ length: 256 }, (_, index) => ({
      ...candidate,
      attributionId: `attribution-slow-${index}`,
      jobId: `job-slow-${index}`,
    }));
    const listAttributionCandidates = mock(async () => ({
      candidateLimit: 256,
      candidates: pageCandidates,
      nextCursor: 'cursor-next',
      truncated: true,
    }));
    const routes = createForensicsRoutes(auth, {
      apiBaseUrl: 'http://localhost:3001',
      couplingServiceBaseUrl: 'https://coupling.internal',
      couplingServiceSharedSecret: TEST_COUPLING_BEARER,
      convexApiSecret: TEST_CONVEX_API_TOKEN,
      convexUrl: 'http://convex.invalid',
      encryptionSecret: TEST_ENCRYPTION_KEY,
      frontendBaseUrl: 'http://localhost:3000',
      materializationControl: { listAttributionCandidates },
    });
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      // The first batch alone consumes the whole scan budget, as when every
      // 64-candidate evaluation takes its full share of a saturated container.
      setSystemTime(new Date(startedAt + 120_000));
      const body = JSON.parse(String(init?.body)) as {
        assets: Array<{ assetPath: string; assetType: string }>;
      };
      return Response.json({
        results: body.assets.map((asset) => ({
          assetPath: asset.assetPath,
          assetType: asset.assetType,
          matched: false,
        })),
        schemaVersion: 2,
      });
    }) as unknown as typeof fetch;

    const response = await routes.lookup(lookupRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lookupStatus: 'no_signal_found',
      scan: {
        candidateEvaluationCount: 64,
        complete: false,
        pagesScanned: 1,
        requestedCandidateCount: 256,
      },
    });
    // The deadline must end the scan after the page in flight: more paging
    // would spin against a service that refuses to start batches, and can
    // spuriously trip the 409 candidate work limit.
    expect(listAttributionCandidates).toHaveBeenCalledTimes(1);
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.couplingForensics.recordLookupAudit,
      expect.objectContaining({
        status: 'no_signal_found',
      })
    );
  });

  test('returns no partial result when attribution work reaches its strict limit', async () => {
    installAuthorization();
    const listAttributionCandidates = mock(async () => ({
      candidateLimit: 1,
      candidates: [candidate],
      nextCursor: 'cursor-1',
      truncated: true,
    }));
    const routes = createForensicsRoutes(auth, {
      apiBaseUrl: 'http://localhost:3001',
      couplingServiceBaseUrl: 'https://coupling.internal',
      couplingServiceSharedSecret: TEST_COUPLING_BEARER,
      convexApiSecret: TEST_CONVEX_API_TOKEN,
      convexUrl: 'http://convex.invalid',
      encryptionSecret: TEST_ENCRYPTION_KEY,
      frontendBaseUrl: 'http://localhost:3000',
      materializationControl: { listAttributionCandidates },
      maxAttributionCandidateWork: 1,
    });
    globalThis.fetch = mock(async () =>
      Response.json({
        results: [
          {
            assetPath: 'Assets/Jammr/body.png',
            assetType: 'png',
            matched: false,
          },
        ],
        schemaVersion: 2,
      })
    ) as unknown as typeof fetch;

    const response = await routes.lookup(lookupRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      candidateLimit: 1,
      code: 'coupling_trace_candidate_limit_exceeded',
      requestedCandidateCount: 1,
    });
    expect(listAttributionCandidates).toHaveBeenCalledTimes(1);
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.couplingForensics.recordLookupAudit,
      expect.objectContaining({
        requestedCandidateCount: 1,
        status: 'error',
      })
    );
  });

  test('bounds total candidate and asset evaluation work', async () => {
    installAuthorization();
    extractCouplingForensicsArchiveMock.mockResolvedValue({
      assets: [
        {
          assetPath: 'Assets/Jammr/body.png',
          assetType: 'png',
          filePath: assetFixturePath,
        },
        {
          assetPath: 'Assets/Jammr/detail.png',
          assetType: 'png',
          filePath: assetFixturePath,
        },
      ],
      declaredPackageIds: ['com.yucp.jammr'],
    });
    const listAttributionCandidates = mock(async (input: { candidateLimit?: number }) => ({
      candidateLimit: input.candidateLimit ?? 512,
      candidates: [candidate],
      nextCursor: 'cursor-1',
      truncated: true,
    }));
    const routes = createForensicsRoutes(auth, {
      apiBaseUrl: 'http://localhost:3001',
      couplingServiceBaseUrl: 'https://coupling.internal',
      couplingServiceSharedSecret: TEST_COUPLING_BEARER,
      convexApiSecret: TEST_CONVEX_API_TOKEN,
      convexUrl: 'http://convex.invalid',
      encryptionSecret: TEST_ENCRYPTION_KEY,
      frontendBaseUrl: 'http://localhost:3000',
      materializationControl: { listAttributionCandidates },
      maxAttributionEvaluationWork: 2,
    });
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        assets: Array<{ assetPath: string; assetType: string }>;
      };
      return Response.json({
        results: body.assets.map((asset) => ({
          assetPath: asset.assetPath,
          assetType: asset.assetType,
          matched: false,
        })),
        schemaVersion: 2,
      });
    }) as unknown as typeof fetch;

    const response = await routes.lookup(lookupRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      candidateEvaluationCount: 2,
      code: 'coupling_trace_candidate_limit_exceeded',
      requestedCandidateCount: 1,
    });
    expect(listAttributionCandidates).toHaveBeenCalledWith({
      candidateLimit: 1,
      creatorId: 'creator-user',
      productId: 'com.yucp.jammr',
    });
  });

  test('does not call the Linux service when no durable candidates exist', async () => {
    installAuthorization();
    const { routes } = createRoutes({
      candidatePage: {
        candidateLimit: 512,
        candidates: [],
        truncated: false,
      },
    });
    const fetchMock = mock(async () => {
      throw new Error('must not run');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await routes.lookup(lookupRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lookupStatus: 'no_signal_found',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects declared and streamed bodies above the configured limit', async () => {
    const { routes } = createRoutes({ maxLookupUploadBytes: 3 });
    const declared = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        body: new Uint8Array(1024 * 1024 + 4),
        headers: { 'content-length': String(1024 * 1024 + 4) },
        method: 'POST',
      })
    );
    expect(declared.status).toBe(413);

    const streamed = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 4));
            controller.close();
          },
        }),
        duplex: 'half',
        method: 'POST',
      } as RequestInit & { duplex: 'half' })
    );
    expect(streamed.status).toBe(413);
  });

  test('rate limits before it reads a second request body', async () => {
    installAuthorization();
    const { routes } = createRoutes({
      candidatePage: {
        candidateLimit: 512,
        candidates: [],
        truncated: false,
      },
      rateLimit: 1,
    });
    const first = await routes.lookup(lookupRequest());
    expect(first.status).toBe(200);
    const extractionCalls = extractCouplingForensicsArchiveMock.mock.calls.length;
    const blocked = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        body: Uint8Array.from([1, 2, 3]),
        method: 'POST',
      })
    );
    expect(blocked.status).toBe(429);
    expect(extractCouplingForensicsArchiveMock.mock.calls.length).toBe(extractionCalls);
  });

  test('rejects an attribution result outside the authorized set', async () => {
    installAuthorization();
    const { routes } = createRoutes();
    globalThis.fetch = mock(async () =>
      Response.json({
        results: [
          {
            assetPath: 'Assets/Jammr/body.png',
            assetType: 'png',
            attributionId: 'forged-attribution',
            buyerSubjectPseudonym,
            matched: true,
          },
        ],
        schemaVersion: 2,
      })
    ) as unknown as typeof fetch;

    const response = await routes.lookup(lookupRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Coupling forensics lookup failed',
    });
  });

  test('does not expose a browser license reveal handler', () => {
    const { routes } = createRoutes();
    expect((routes as Record<string, unknown>).revealLicense).toBeUndefined();
  });
});
