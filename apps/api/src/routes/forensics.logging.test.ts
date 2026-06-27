import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Auth } from '../auth';

const apiMock = {
  couplingForensics: {
    listCouplingTraceCandidatesForAuthUser:
      'couplingForensics.listCouplingTraceCandidatesForAuthUser',
    lookupTraceMatchesForAuthUser: 'couplingForensics.lookupTraceMatchesForAuthUser',
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

class MockCouplingServiceConfigurationError extends Error {}
class MockCouplingServiceRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

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

mock.module('../lib/couplingForensicsService', () => ({
  CouplingServiceConfigurationError: MockCouplingServiceConfigurationError,
  CouplingServiceRequestError: MockCouplingServiceRequestError,
  runCouplingAttribution: async () => [
    {
      assetPath: unsafeAssetPath,
      assetType: 'png',
      decoderKind: 'png',
      preclassification: 'decoded',
      tokenHex: 'deadbeef',
      tokenLength: 8,
    },
  ],
}));

const { createForensicsRoutes } = await import('./forensics');

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('forensics route safe logging', () => {
  const routes = createForensicsRoutes(
    {
      getSession: async () => ({ user: { id: 'creator-user' } }),
    } as unknown as Auth,
    {
      apiBaseUrl: 'http://localhost:3001',
      couplingServiceBaseUrl: 'https://coupling.internal',
      couplingServiceSharedSecret: 'unit-test-coupling-bearer',
      frontendBaseUrl: 'http://localhost:3000',
      convexApiSecret: 'unit-test-convex-api-token',
      convexUrl: 'http://convex.invalid',
      encryptionSecret: 'unit-test-encryption-key',
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

  it('does not log uploaded asset paths when decoded matches are missing subjects', async () => {
    const expectedTokenHash = sha256Hex('deadbeef');
    queryMock.mockImplementation(async (ref: unknown) => {
      if (ref === apiMock.couplingForensics.listCouplingTraceCandidatesForAuthUser) {
        return {
          capabilityEnabled: true,
          packageOwned: true,
          candidates: [
            {
              assetPath: unsafeAssetPath,
              licenseSubject: 'f'.repeat(64),
              tokenHash: expectedTokenHash,
            },
          ],
        };
      }
      throw new Error(`Unexpected query ${String(ref)}`);
    });
    mutationMock.mockResolvedValue(undefined);

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

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Coupling forensics lookup failed',
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Coupling service scan failed',
      expect.objectContaining({
        error: 'Coupling attribution returned a decoded match without a license subject',
      })
    );
    const loggedMetadata = loggerErrorMock.mock.calls[0]?.[1];
    expect(JSON.stringify(loggedMetadata)).not.toContain(unsafeAssetPath);
  });
});
