import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Auth } from '../auth';

const apiMock = {
  couplingForensics: {
    listOwnedPackagesForAuthUser: 'couplingForensics.listOwnedPackagesForAuthUser',
    lookupTraceMatchesForAuthUser: 'couplingForensics.lookupTraceMatchesForAuthUser',
    recordLookupAudit: 'couplingForensics.recordLookupAudit',
  },
} as const;

const queryMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);
const mutationMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
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

const assetFixturePath = fileURLToPath(new URL(import.meta.url));

mock.module('../lib/couplingForensicsArchives', () => ({
  extractCouplingForensicsArchive: mock(async () => ({
    assets: [
      {
        assetPath: 'Assets/Character/body.png',
        assetType: 'png',
        filePath: assetFixturePath,
      },
    ],
    declaredPackageIds: ['creator.package'],
  })),
}));

const { createForensicsRoutes } = await import('./forensics');

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
  });

  beforeEach(() => {
    queryMock.mockReset();
    mutationMock.mockReset();
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
      expect(url).toBe('https://coupling.internal/v1/coupling/scan');
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
          results: [
            {
              assetPath: 'Assets/Character/body.png',
              assetType: 'png',
              decoderKind: 'png',
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
      candidateAssetCount: 1,
      decodedAssetCount: 1,
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          matched: true,
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
      status: 'matched',
    });
  });

  it('returns a clean no-match response when the coupling service finds no trace tokens', async () => {
    queryMock.mockImplementation(async () => {
      throw new Error('Trace lookup should not run without coupling findings');
    });
    mutationMock.mockResolvedValue(undefined);

    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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
      candidateAssetCount: 1,
      decodedAssetCount: 0,
      message: 'No authorized match found',
      results: [],
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(mutationMock.mock.calls[0]?.[1]).toMatchObject({
      packageId: 'creator.package',
      status: 'no_match',
    });
  });
});
