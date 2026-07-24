import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { signVpmRepoToken, verifyVpmRepoToken } from '../../../../ops/storage-core/vpmToken';
import { createTestLogger } from '../testSupport/loggerMock';
import { buildYucpAliasVpmPackage, YUCP_ALIAS_BOOTSTRAP_VERSION } from './vpmAliasPackage';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const loggerErrorMock = mock(() => undefined);
const importerIndexFetchMock = mock(async () =>
  Response.json({
    packages: {
      'com.yucp.importer': {
        versions: {
          '0.1.14': {
            name: 'com.yucp.importer',
            displayName: 'YUCP Package Importer',
            version: '0.1.14',
            unity: '2022.3',
            description: 'YUCP package importer',
            author: {
              name: 'YUCP Club',
              url: 'https://vpm.yucp.club/',
            },
            zipSHA256: 'a'.repeat(64),
            url: 'https://packages.example.test/com.yucp.importer-0.1.14.zip',
          },
        },
      },
    },
  })
);

const apiMock = {
  entitlements: {
    listByAuthUser: 'entitlements.listByAuthUser',
  },
  packageRegistry: {
    getBuyerAccessContextByCatalogProductId:
      'packageRegistry.getBuyerAccessContextByCatalogProductId',
    getBuyerAccessContextByEntitlement: 'packageRegistry.getBuyerAccessContextByEntitlement',
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

const vpmTokenKey = 'vpm-route-token-hmac-key-purpose-separated';
const config = {
  apiBaseUrl: 'https://api.test',
  frontendBaseUrl: 'https://app.test',
  convexApiSecret: 'test-convex-secret',
  convexUrl: 'https://convex.test',
  publicVpmIndexUrl: 'https://vpm.yucp.club/index.json',
  vpmBaseUrl: 'https://vpm.test/',
  vpmTokenKey,
};

function createRoutes(userId: string | null, configOverrides: Partial<typeof config> = {}) {
  return createVpmRoutes({
    auth: {
      getSession: async () => (userId ? { user: { id: userId } } : null),
    } as never,
    config: { ...config, ...configOverrides },
    fetchImpl: importerIndexFetchMock as unknown as typeof fetch,
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
      key: vpmTokenKey,
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
    importerIndexFetchMock.mockClear();
  });

  it('requires a Better Auth session to mint a repository token', async () => {
    const response = await createRoutes(null).mintRepoToken(mintRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required' });
  });

  it('returns 503 from both routes when optional VPM delivery config is unavailable', async () => {
    const mintResponse = await createRoutes('buyer-auth-user', {
      publicVpmIndexUrl: undefined,
      vpmBaseUrl: undefined,
      vpmTokenKey: undefined,
    }).mintRepoToken(mintRequest());
    expect(mintResponse.status).toBe(503);

    const token = await validBuyerToken();
    const indexResponse = await createRoutes(null, {
      publicVpmIndexUrl: undefined,
    }).serveIndex(new Request(`https://api.test/api/vpm/${token}/index.json`), token);
    expect(indexResponse.status).toBe(503);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('requires HTTPS for the public importer index while allowing loopback HTTP', async () => {
    const remoteHttpResponse = await createRoutes('buyer-auth-user', {
      publicVpmIndexUrl: 'http://packages.test/index.json',
    }).mintRepoToken(mintRequest());
    expect(remoteHttpResponse.status).toBe(503);
    await expect(remoteHttpResponse.json()).resolves.toEqual({
      error: 'VPM delivery is not configured',
    });

    const httpsResponse = await createRoutes('buyer-auth-user', {
      publicVpmIndexUrl: 'https://packages.test/index.json',
    }).mintRepoToken(mintRequest());
    expect(httpsResponse.status).toBe(200);

    const loopbackResponse = await createRoutes('buyer-auth-user', {
      publicVpmIndexUrl: 'http://localhost:8787/index.json',
    }).mintRepoToken(mintRequest());
    expect(loopbackResponse.status).toBe(200);
  });

  it('requires HTTPS for remote VPM base URLs while allowing loopback HTTP', async () => {
    const remoteHttpResponse = await createRoutes('buyer-auth-user', {
      vpmBaseUrl: 'http://vpm.test/',
    }).mintRepoToken(mintRequest());
    expect(remoteHttpResponse.status).toBe(503);
    await expect(remoteHttpResponse.json()).resolves.toEqual({
      error: 'VPM delivery is not configured',
    });

    const httpsResponse = await createRoutes('buyer-auth-user', {
      vpmBaseUrl: 'https://vpm.test/',
    }).mintRepoToken(mintRequest());
    expect(httpsResponse.status).toBe(200);

    const loopbackResponse = await createRoutes('buyer-auth-user', {
      vpmBaseUrl: 'http://127.0.0.1:8787/',
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
    await expect(verifyVpmRepoToken({ key: vpmTokenKey, token: body.token })).resolves.toEqual({
      authUserId: 'buyer-auth-user',
      expiresAt: body.expiresAt,
    });
  });

  it('does not log raw token-signing error messages', async () => {
    const rawUpstreamMessage = 'VPM repository token HMAC key must be at least 32 UTF-8 bytes';
    const response = await createRoutes('buyer-auth-user', {
      vpmTokenKey: 'short-key',
    }).mintRepoToken(mintRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to prepare VPM repository',
    });
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to mint buyer VPM repository token', {
      errorName: 'Error',
    });
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(rawUpstreamMessage);
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

  it('serves public alias bytes without repository-token or importer-index configuration', async () => {
    const routes = createRoutes(null, {
      publicVpmIndexUrl: undefined,
      vpmTokenKey: undefined,
    });
    const alias = buildYucpAliasVpmPackage({
      aliasId: 'public-alias',
      catalogProductIds: ['catalog_public'],
      vpmBaseUrl: 'https://vpm.test/',
    });
    const artifactDescriptor = alias.manifest.url.split('/').at(-2);
    const response = await routes.serveAliasPackage(
      new Request(alias.manifest.url),
      artifactDescriptor ?? '',
      YUCP_ALIAS_BOOTSTRAP_VERSION
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves public aliases and the importer without paid package URLs', async () => {
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
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        const catalogProductId = (args as { catalogProductId: string }).catalogProductId;
        return {
          aliasId: catalogProductId,
          catalogProductId,
          catalogProductIds: [catalogProductId],
          packageId:
            catalogProductId === 'catalog_ready'
              ? 'com.creator.avatar-tools'
              : catalogProductId === 'catalog_non_vpm'
                ? 'com.creator.substance-project'
                : undefined,
        };
      }
      if (reference === apiMock.packageVersions.resolveDownloadableVersion) {
        const query = args as { catalogProductId?: string; packageId?: string };
        if (query.packageId === 'com.creator.avatar-tools') {
          return {
            contentType: 'application/zip',
            packageId: 'com.creator.avatar-tools',
            version: '1.2.3',
            versionId: 'version-ready-123',
          };
        }
        if (query.catalogProductId === 'catalog_pending') {
          return null;
        }
        if (query.packageId === 'com.creator.substance-project') {
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
    const routes = createRoutes(null);
    const response = await routes.serveIndex(
      new Request(`https://vpm.test/api/vpm/${token}/index.json`),
      token
    );
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
        'com.yucp.importer': {
          versions: {
            '0.1.14': {
              name: 'com.yucp.importer',
              url: 'https://packages.example.test/com.yucp.importer-0.1.14.zip',
            },
          },
        },
      },
    });

    const readyAlias = buildYucpAliasVpmPackage({
      aliasId: 'catalog_ready',
      catalogProductIds: ['catalog_ready'],
      vpmBaseUrl: 'https://vpm.test/',
    });
    const opaqueAlias = buildYucpAliasVpmPackage({
      aliasId: 'catalog_non_vpm',
      catalogProductIds: ['catalog_non_vpm'],
      vpmBaseUrl: 'https://vpm.test/',
    });
    expect(Object.keys(body.packages).sort()).toEqual(
      ['com.yucp.importer', readyAlias.packageId, opaqueAlias.packageId].sort()
    );
    expect(body.packages[readyAlias.packageId]?.versions[YUCP_ALIAS_BOOTSTRAP_VERSION]).toEqual(
      readyAlias.manifest
    );
    expect(body.packages[opaqueAlias.packageId]?.versions[YUCP_ALIAS_BOOTSTRAP_VERSION]).toEqual(
      opaqueAlias.manifest
    );
    const serializedIndex = JSON.stringify(body);
    expect(serializedIndex).not.toContain('/d/version-ready-123');
    expect(serializedIndex).not.toContain('version-non-vpm-456');
    expect(serializedIndex).not.toContain('sig=');

    const artifactResponse = await routes.serveAliasPackage(
      new Request(readyAlias.manifest.url),
      readyAlias.manifest.url.split('/').at(-2) ?? '',
      YUCP_ALIAS_BOOTSTRAP_VERSION
    );
    const artifactBytes = new Uint8Array(await artifactResponse.arrayBuffer());
    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable'
    );
    expect(createHash('sha256').update(artifactBytes).digest('hex')).toBe(
      readyAlias.manifest.zipSHA256
    );
    const artifactEntries = unzipSync(artifactBytes);
    const artifactPackageJson = JSON.parse(
      Buffer.from(artifactEntries['package.json'] ?? []).toString('utf8')
    ) as Record<string, unknown>;
    expect(artifactPackageJson.name).toBe(readyAlias.packageId);
    expect(JSON.stringify(artifactPackageJson)).not.toContain('version-ready-123');
    expect(importerIndexFetchMock).toHaveBeenCalledTimes(1);
    expect(convexQueryMock).toHaveBeenCalledTimes(7);
  });

  it('publishes one alias with every catalog product in a logical cross-store group', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.entitlements.listByAuthUser) {
        return {
          data: [
            { id: 'ent_gumroad', catalogProductId: 'catalog_jammr_gumroad' },
            { id: 'ent_jinxxy', catalogProductId: 'catalog_jammr_jinxxy' },
          ],
          hasMore: false,
          nextCursor: null,
        };
      }
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          aliasId: 'jammr',
          catalogProductId: (args as { catalogProductId: string }).catalogProductId,
          catalogProductIds: ['catalog_jammr_gumroad', 'catalog_jammr_jinxxy'],
          packageId: 'com.yucp.jammr',
        };
      }
      if (reference === apiMock.packageVersions.resolveDownloadableVersion) {
        expect(args).toMatchObject({ packageId: 'com.yucp.jammr' });
        return {
          packageId: 'com.yucp.jammr',
          version: '1.0.0',
          versionId: 'version-jammr',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const token = await validBuyerToken();
    const response = await createRoutes(null).serveIndex(
      new Request(`https://vpm.test/api/vpm/${token}/index.json`),
      token
    );
    const body = (await response.json()) as {
      packages: Record<string, { versions: Record<string, Record<string, unknown>> }>;
    };
    const expectedAlias = buildYucpAliasVpmPackage({
      aliasId: 'jammr',
      catalogProductIds: ['catalog_jammr_gumroad', 'catalog_jammr_jinxxy'],
      vpmBaseUrl: 'https://vpm.test/',
    });

    expect(response.status).toBe(200);
    expect(Object.keys(body.packages).sort()).toEqual(
      ['com.yucp.importer', expectedAlias.packageId].sort()
    );
    expect(body.packages[expectedAlias.packageId]?.versions[YUCP_ALIAS_BOOTSTRAP_VERSION]).toEqual(
      expectedAlias.manifest
    );
    expect(
      convexQueryMock.mock.calls.filter(
        ([reference]) => reference === apiMock.packageVersions.resolveDownloadableVersion
      )
    ).toHaveLength(1);
  });

  it('resolves a legacy product-level entitlement into its logical package group', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.entitlements.listByAuthUser) {
        return {
          data: [
            {
              id: 'ent_jammr_legacy',
              productId: 'jinxxy-jammr',
              sourceProvider: 'jinxxy',
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      }
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByEntitlement) {
        expect(args).toMatchObject({
          productId: 'jinxxy-jammr',
          sourceProvider: 'jinxxy',
        });
        return {
          aliasId: 'jammr',
          catalogProductId: 'catalog_jammr_jinxxy',
          catalogProductIds: ['catalog_jammr_gumroad', 'catalog_jammr_jinxxy'],
          packageId: 'com.yucp.jammr',
        };
      }
      if (reference === apiMock.packageVersions.resolveDownloadableVersion) {
        expect(args).toMatchObject({ packageId: 'com.yucp.jammr' });
        return {
          packageId: 'com.yucp.jammr',
          version: '1.0.1',
          versionId: 'version-jammr-legacy',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const token = await validBuyerToken();
    const response = await createRoutes(null).serveIndex(
      new Request(`https://vpm.test/api/vpm/${token}/index.json`),
      token
    );
    const body = (await response.json()) as {
      packages: Record<string, { versions: Record<string, Record<string, unknown>> }>;
    };
    const expectedAlias = buildYucpAliasVpmPackage({
      aliasId: 'jammr',
      catalogProductIds: ['catalog_jammr_gumroad', 'catalog_jammr_jinxxy'],
      vpmBaseUrl: 'https://vpm.test/',
    });

    expect(response.status).toBe(200);
    expect(Object.keys(body.packages).sort()).toEqual(
      ['com.yucp.importer', expectedAlias.packageId].sort()
    );
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

  it('returns 503 when the public repository lacks the required importer release', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.entitlements.listByAuthUser) {
        return {
          data: [{ id: 'ent_1', catalogProductId: 'catalog_ready' }],
          hasMore: false,
          nextCursor: null,
        };
      }
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          aliasId: 'catalog_ready',
          catalogProductId: 'catalog_ready',
          catalogProductIds: ['catalog_ready'],
          packageId: 'com.creator.avatar-tools',
        };
      }
      if (reference === apiMock.packageVersions.resolveDownloadableVersion) {
        return {
          packageId: 'com.creator.avatar-tools',
          version: '1.2.3',
          versionId: 'version-ready-123',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    importerIndexFetchMock.mockImplementationOnce(async () =>
      Response.json({
        packages: {
          'com.yucp.importer': {
            versions: {
              '0.1.13': {
                name: 'com.yucp.importer',
                displayName: 'YUCP Package Importer',
                version: '0.1.13',
                zipSHA256: 'b'.repeat(64),
                url: 'https://packages.example.test/com.yucp.importer-0.1.13.zip',
              },
            },
          },
        },
      })
    );
    const token = await validBuyerToken();
    const response = await createRoutes(null).serveIndex(
      new Request(`https://vpm.test/api/vpm/${token}/index.json`),
      token
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'The public YUCP importer is not available',
    });
  });

  it('does not log raw Convex error messages', async () => {
    const rawUpstreamMessage = 'Convex upstream leaked details';
    convexQueryMock.mockRejectedValue(new TypeError(rawUpstreamMessage));
    const token = await validBuyerToken();
    const response = await createRoutes(null).serveIndex(
      new Request(`https://vpm.test/api/vpm/${token}/index.json`),
      token
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to build VPM repository',
    });
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to build buyer VPM repository index', {
      phase: 'entitlements',
      errorName: 'TypeError',
    });
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(rawUpstreamMessage);
  });
});
