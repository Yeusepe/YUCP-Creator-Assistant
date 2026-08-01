import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { Auth } from '../auth';

const apiMock = {
  couplingForensics: {
    authorizeCouplingForensicsLookupForAuthUser:
      'couplingForensics.authorizeCouplingForensicsLookupForAuthUser',
    recordLookupAudit: 'couplingForensics.recordLookupAudit',
  },
} as const;

const queryMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);
const mutationMock = mock(async (_ref: unknown, _args?: unknown): Promise<unknown> => undefined);
const loggerErrorMock = mock((_message: string, _metadata?: Record<string, unknown>) => {});
const loggerInfoMock = mock((_message: string, _metadata?: Record<string, unknown>) => {});
const loggerWarnMock = mock((_message: string, _metadata?: Record<string, unknown>) => {});
const loggerDebugMock = mock((_message: string, _metadata?: Record<string, unknown>) => {});
const unsafeAssetPath = 'Assets/Customers/buyer@example.com/private.png';

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

mock.module('../lib/logger', () => ({
  logger: {
    debug: loggerDebugMock,
    error: loggerErrorMock,
    info: loggerInfoMock,
    warn: loggerWarnMock,
  },
}));

mock.module('../lib/couplingForensicsArchives', () => ({
  extractCouplingForensicsArchive: async () => ({
    assets: [
      {
        assetPath: unsafeAssetPath,
        assetType: 'png',
        filePath: fileURLToPath(new URL(import.meta.url)),
      },
    ],
    declaredPackageIds: ['creator.package'],
  }),
}));

const { createForensicsRoutes } = await import('./forensics');

describe('forensics route safe logging', () => {
  const routes = createForensicsRoutes(
    {
      getSession: async () => ({ user: { id: 'creator-user' } }),
    } as unknown as Auth,
    {
      apiBaseUrl: 'http://localhost:3001',
      couplingServiceBaseUrl: 'ftp://coupling.internal',
      couplingServiceSharedSecret: 'unit-test-coupling-bearer',
      convexApiSecret: 'unit-test-convex-api-token',
      convexUrl: 'http://convex.invalid',
      encryptionSecret: 'unit-test-encryption-key',
      frontendBaseUrl: 'http://localhost:3000',
      materializationControl: {
        listAttributionCandidates: async (input) => ({
          candidateLimit: input.candidateLimit ?? 512,
          candidates: [
            {
              algorithmVersion: 'png-dct-qim-v2',
              attributionId: 'attribution-1',
              attributionTokenHash: '66'.repeat(32),
              buyerSubjectPseudonym: Buffer.alloc(32, 0x77).toString('base64url'),
              capabilityId: 'capability-1',
              createdAt: 2_000_000_000_000,
              creatorId: 'creator-user',
              jobId: 'job-1',
              keyDerivation: 'v3',
              keyEpoch: 3,
              leaseGeneration: 2,
              materializerType: 'png',
              normalizedPath: unsafeAssetPath,
              outputFormat: 'zip',
              pluginVersion: 'png-plugin-2',
              protectedSourceRoot: '33'.repeat(32),
              releaseRoot: '11'.repeat(32),
              sourceSha256: '44'.repeat(32),
            },
          ],
          truncated: false,
        }),
      },
    }
  );

  beforeEach(() => {
    queryMock.mockReset();
    mutationMock.mockReset();
    loggerDebugMock.mockReset();
    loggerErrorMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
  });

  test('does not log uploaded asset paths when attribution fails', async () => {
    queryMock.mockResolvedValue({
      capabilityEnabled: true,
      packageOwned: true,
    });
    mutationMock.mockResolvedValue(undefined);
    const formData = new FormData();
    formData.set('packageId', 'creator.package');
    formData.set(
      'file',
      new File([Uint8Array.from([1, 2, 3])], 'bundle.zip', {
        type: 'application/zip',
      })
    );

    const response = await routes.lookup(
      new Request('http://localhost:3001/api/forensics/lookup', {
        body: formData,
        method: 'POST',
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Coupling forensics is not configured',
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Coupling service is not configured for lookup requests',
      expect.objectContaining({
        error: 'Coupling service base URL must use http or https',
      })
    );
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(unsafeAssetPath);
  });
});
