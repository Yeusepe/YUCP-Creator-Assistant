import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { verifyDeliveryUrl } from '../../../../ops/storage-core/deliverySigning';
import { signVpmRepoToken, verifyVpmRepoToken } from '../../../../ops/storage-core/vpmToken';
import { createTestLogger } from '../testSupport/loggerMock';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const loggerErrorMock = mock(() => undefined);

const apiMock = {
  entitlements: {
    listByAuthUser: 'entitlements.listByAuthUser',
  },
  packageVersions: {
    resolveDownloadableVersion: 'packageVersions.resolveDownloadableVersion',
  },
} as const;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: {},
}));

mock.module('../lib/apiActor', () => ({
  createApiServiceActorBinding: async () => 'buyer-vpm-actor',
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: (_url: string, actor?: unknown) => ({
    query: (reference: unknown, args?: unknown) =>
      convexQueryMock(
        reference,
        args && typeof args === 'object' && 'apiSecret' in args
          ? { ...(args as Record<string, unknown>), actor }
          : args
      ),
  }),
}));

mock.module('../lib/logger', () => ({
  logger: createTestLogger({
    error: loggerErrorMock,
    info: mock(() => undefined),
    warn: mock(() => undefined),
  }),
}));

const { createVpmRoutes } = await import('./vpm');

const deliveryHmacKey = 'vpm-route-delivery-hmac-key-32-bytes';
const config = {
  apiBaseUrl: 'https://api.test',
  frontendBaseUrl: 'https://app.test',
  convexApiSecret: 'test-convex-secret',
  convexUrl: 'https://convex.test',
  deliveryBaseUrl: 'https://delivery.test/',
  deliveryHmacKey,
  vpmBaseUrl: 'https://vpm.test/',
};

function createRoutes(userId: string | null, configOverrides: Partial<typeof config> = {}) {
  return createVpmRoutes({
    auth: {
      getSession: async () => (userId ? { user: { id: userId } } : null),
    } as never,
    config: { ...config, ...configOverrides },
  });
}

function mintRequest(): Request {
  return new Request('https://api.test/api/vpm/repo-token', {
    method: 'POST',
    headers: { origin: 'https://app.test' },
  });
}

async function validBuyerToken(expiresAt = Date.now() + 30 * 24 * 60 * 60_000): Promise<string> {
  return (
    await signVpmRepoToken({
      authUserId: 'buyer-auth-user',
      expiresAt,
      key: deliveryHmacKey,
    })
  ).token;
}

describe('per-buyer VPM routes', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    convexQueryMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('requires a Better Auth session to mint a repository token', async () => {
    const response = await createRoutes(null).mintRepoToken(mintRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required' });
  });

  it('returns 503 from both routes when optional VPM delivery config is unavailable', async () => {
    const mintResponse = await createRoutes('buyer-auth-user', {
      deliveryBaseUrl: undefined,
      deliveryHmacKey: undefined,
      vpmBaseUrl: undefined,
    }).mintRepoToken(mintRequest());
    expect(mintResponse.status).toBe(503);

    const token = await validBuyerToken();
    const indexResponse = await createRoutes(null, {
      deliveryBaseUrl: undefined,
    }).serveIndex(new Request(`https://api.test/api/vpm/${token}/index.json`), token);
    expect(indexResponse.status).toBe(503);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('requires HTTPS for remote delivery URLs while allowing loopback HTTP', async () => {
    const remoteHttpResponse = await createRoutes('buyer-auth-user', {
      deliveryBaseUrl: 'http://delivery.test/',
    }).mintRepoToken(mintRequest());
    expect(remoteHttpResponse.status).toBe(503);
    await expect(remoteHttpResponse.json()).resolves.toEqual({
      error: 'VPM delivery is not configured',
    });

    const httpsResponse = await createRoutes('buyer-auth-user', {
      deliveryBaseUrl: 'https://delivery.test/',
    }).mintRepoToken(mintRequest());
    expect(httpsResponse.status).toBe(200);

    const loopbackResponse = await createRoutes('buyer-auth-user', {
      deliveryBaseUrl: 'http://localhost:8787/',
    }).mintRepoToken(mintRequest());
    expect(loopbackResponse.status).toBe(200);
  });

  it('mints a stateless buyer token and the VCC addRepo URL shape', async () => {
    const beforeRequest = Date.now();
    const response = await createRoutes('buyer-auth-user').mintRepoToken(mintRequest());
    const afterRequest = Date.now();
    const body = (await response.json()) as {
      addRepoUrl: string;
      expiresAt: number;
      indexUrl: string;
      token: string;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body.indexUrl).toBe(`https://vpm.test/api/vpm/${body.token}/index.json`);
    expect(body.addRepoUrl).toBe(`vcc://vpm/addRepo?url=${encodeURIComponent(body.indexUrl)}`);
    expect(body.expiresAt).toBeGreaterThanOrEqual(beforeRequest + 30 * 24 * 60 * 60_000 - 1_000);
    expect(body.expiresAt).toBeLessThanOrEqual(afterRequest + 30 * 24 * 60 * 60_000);
    await expect(verifyVpmRepoToken({ key: deliveryHmacKey, token: body.token })).resolves.toEqual({
      authUserId: 'buyer-auth-user',
      expiresAt: body.expiresAt,
    });
  });

  it('rejects invalid and expired repository tokens without querying Convex', async () => {
    const invalidResponse = await createRoutes(null).serveIndex(
      new Request('https://api.test/api/vpm/invalid/index.json'),
      'invalid'
    );
    expect(invalidResponse.status).toBe(401);

    const expiredToken = await validBuyerToken(Date.now() - 60_000);
    const expiredResponse = await createRoutes(null).serveIndex(
      new Request(`https://api.test/api/vpm/${expiredToken}/index.json`),
      expiredToken
    );
    expect(expiredResponse.status).toBe(401);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('serves the VCC repository schema with 1-hour signed READY-version URLs', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.entitlements.listByAuthUser) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          actor: 'buyer-vpm-actor',
          authUserId: 'buyer-auth-user',
          limit: 100,
          scope: 'subject_holder',
          status: 'active',
        });
        return {
          data: [
            { id: 'ent_1', catalogProductId: 'catalog_ready' },
            { id: 'ent_2', catalogProductId: 'catalog_pending' },
            { id: 'ent_3', catalogProductId: 'catalog_ready' },
            { id: 'ent_4', catalogProductId: 'catalog_non_vpm' },
            { id: 'ent_5' },
          ],
          hasMore: false,
          nextCursor: null,
        };
      }
      if (reference === apiMock.packageVersions.resolveDownloadableVersion) {
        const catalogProductId = (args as { catalogProductId: string }).catalogProductId;
        if (catalogProductId === 'catalog_ready') {
          return {
            contentType: 'application/zip',
            packageId: 'com.creator.avatar-tools',
            version: '1.2.3',
            versionId: 'version-ready-123',
          };
        }
        if (catalogProductId === 'catalog_pending') {
          return null;
        }
        if (catalogProductId === 'catalog_non_vpm') {
          return {
            contentType: 'application/octet-stream',
            packageId: 'com.creator.substance-project',
            version: '3.0.0',
            versionId: 'version-non-vpm-456',
          };
        }
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    const token = await validBuyerToken();
    const beforeRequest = Date.now();
    const response = await createRoutes(null).serveIndex(
      new Request(`https://vpm.test/api/vpm/${token}/index.json`),
      token
    );
    const afterRequest = Date.now();
    const body = (await response.json()) as {
      author: string;
      id: string;
      name: string;
      packages: Record<string, { versions: Record<string, Record<string, unknown>> }>;
      url: string;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body).toMatchObject({
      name: 'YUCP Buyer Packages',
      author: 'YUCP',
      id: 'club.yucp.buyer',
      url: `https://vpm.test/api/vpm/${token}/index.json`,
      packages: {
        'com.creator.avatar-tools': {
          versions: {
            '1.2.3': {
              name: 'com.creator.avatar-tools',
              displayName: 'com.creator.avatar-tools',
              version: '1.2.3',
              author: {
                name: 'YUCP',
                email: 'contact@yucp.club',
              },
            },
          },
        },
      },
    });
    expect(Object.keys(body.packages)).toEqual(['com.creator.avatar-tools']);
    const manifest = body.packages['com.creator.avatar-tools']?.versions['1.2.3'];
    const deliveryUrl = new URL(String(manifest?.url));
    expect(deliveryUrl.pathname).toBe('/d/version-ready-123');
    const exp = deliveryUrl.searchParams.get('exp') ?? '';
    const sig = deliveryUrl.searchParams.get('sig') ?? '';
    expect(Number(exp) * 1_000).toBeGreaterThanOrEqual(beforeRequest + 60 * 60_000 - 1_000);
    expect(Number(exp) * 1_000).toBeLessThanOrEqual(afterRequest + 60 * 60_000);
    await expect(
      verifyDeliveryUrl({
        exp,
        key: deliveryHmacKey,
        sig,
        versionId: 'version-ready-123',
      })
    ).resolves.toBe(true);
    expect(convexQueryMock).toHaveBeenCalledTimes(4);
  });

  it('serves an empty but valid repository when the buyer has no active entitlements', async () => {
    convexQueryMock.mockResolvedValue({ data: [], hasMore: false, nextCursor: null });
    const token = await validBuyerToken();
    const response = await createRoutes(null).serveIndex(
      new Request(`https://vpm.test/api/vpm/${token}/index.json`),
      token
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: 'YUCP Buyer Packages',
      author: 'YUCP',
      id: 'club.yucp.buyer',
      url: `https://vpm.test/api/vpm/${token}/index.json`,
      packages: {},
    });
  });
});
