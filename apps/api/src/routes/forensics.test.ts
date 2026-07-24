import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
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
  fileBytes = Uint8Array.from([1, 2, 3])
): Request {
  const formData = new FormData();
  formData.set('packageId', packageId);
  formData.set('file', new File([fileBytes], 'jammr.zip', { type: 'application/zip' }));
  return new Request('http://localhost:3001/api/forensics/lookup', {
    body: formData,
    method: 'POST',
  });
}

function createRoutes(input?: {
  candidatePage?: {
    candidateLimit: number;
    candidates: (typeof candidate)[];
    truncated: boolean;
  };
  maxLookupUploadBytes?: number;
  rateLimit?: number;
  withMaterializationControl?: boolean;
}) {
  const candidatePage = input?.candidatePage ?? {
    candidateLimit: 512,
    candidates: [candidate],
    truncated: false,
  };
  const listAttributionCandidates = mock(async () => candidatePage);
  const routes = createForensicsRoutes(auth, {
    apiBaseUrl: 'http://localhost:3001',
    couplingServiceBaseUrl: 'https://coupling.internal',
    couplingServiceSharedSecret: TEST_COUPLING_BEARER,
    convexApiSecret: TEST_CONVEX_API_TOKEN,
    convexUrl: 'http://convex.invalid',
    encryptionSecret: TEST_ENCRYPTION_KEY,
    frontendBaseUrl: 'http://localhost:3000',
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

    const response = await routes.lookup(lookupRequest());

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
      creatorId: 'creator-user',
      productId: 'com.yucp.jammr',
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

  test('returns a tamper verdict when no authorized candidate decodes', async () => {
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
      lookupStatus: 'tampered_suspected',
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

  test('fails closed on missing control configuration and candidate truncation', async () => {
    installAuthorization();
    const unconfigured = createRoutes({ withMaterializationControl: false });
    expect((await unconfigured.routes.lookup(lookupRequest())).status).toBe(503);

    installAuthorization();
    const truncated = createRoutes({
      candidatePage: {
        candidateLimit: 512,
        candidates: [candidate],
        truncated: true,
      },
    });
    const response = await truncated.routes.lookup(lookupRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      candidateLimit: 512,
      code: 'coupling_trace_candidate_limit_exceeded',
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
      lookupStatus: 'hostile_unknown',
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
