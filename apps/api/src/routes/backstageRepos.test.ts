import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

let sessionImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
const fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> =
  async () =>
    new Response(
      JSON.stringify({
        packages: {
          'com.yucp.importer': {
            versions: {
              '0.1.8': {
                name: 'com.yucp.importer',
                version: '0.1.8',
              },
            },
          },
          'com.yucp.motion': {
            versions: {
              '0.1.1': {
                name: 'com.yucp.motion',
                version: '0.1.1',
              },
            },
          },
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
const originalFetch = globalThis.fetch;

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    authViewer: {
      getViewerByAuthUser: 'authViewer.getViewerByAuthUser',
    },
    backstageRepos: {
      getSubjectByAuthUserForApi: 'backstageRepos.getSubjectByAuthUserForApi',
      issueRepoTokenForApi: 'backstageRepos.issueRepoTokenForApi',
      getRepoAccessByTokenForApi: 'backstageRepos.getRepoAccessByTokenForApi',
      touchRepoTokenForApi: 'backstageRepos.touchRepoTokenForApi',
      buildRepositoryForApi: 'backstageRepos.buildRepositoryForApi',
      resolvePackageDownloadForApi: 'backstageRepos.resolvePackageDownloadForApi',
    },
    packageRegistry: {
      getPublicBackstageProductAccessByRef: 'packageRegistry.getPublicBackstageProductAccessByRef',
      getAuthorizedAliasInstallPlanByRef: 'packageRegistry.getAuthorizedAliasInstallPlanByRef',
      getBuyerAccessContextByCatalogProductId:
        'packageRegistry.getBuyerAccessContextByCatalogProductId',
    },
    verificationIntents: {
      createVerificationIntent: 'verificationIntents.createVerificationIntent',
    },
    creatorProfiles: {
      getCreatorByAuthUser: 'creatorProfiles.getCreatorByAuthUser',
    },
  },
  internal: {},
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: (_url: string, actor?: unknown) => ({
    query: (reference: unknown, args?: unknown) =>
      queryImpl(reference, actor && args && typeof args === 'object' ? { ...args, actor } : args),
    mutation: (reference: unknown, args?: unknown) =>
      mutationImpl(
        reference,
        actor && args && typeof args === 'object' ? { ...args, actor } : args
      ),
  }),
}));

mock.module('../lib/oauthAccessToken', () => ({
  verifyBetterAuthAccessToken: async () => ({
    ok: true,
    token: { sub: 'auth-user-1' },
  }),
}));

mock.module('../lib/apiActor', () => ({
  createAuthUserActorBinding: async (input: unknown) => ({
    payload: JSON.stringify(input),
    signature: 'test-signature',
  }),
}));

const { createBackstageRepoRoutes } = await import('./backstageRepos');

describe('backstage repo routes', () => {
  const routes = createBackstageRepoRoutes({
    auth: {
      getSession: (...args: unknown[]) =>
        sessionImpl(...args) as Promise<{ user: { id: string } } | null>,
    } as never,
    apiBaseUrl: 'https://api.test',
    enableSessionAccess: true,
    frontendBaseUrl: 'https://app.test',
    convexApiSecret: 'convex-secret',
    convexSiteUrl: 'https://convex.test',
    convexUrl: 'https://convex.cloud',
  });

  beforeEach(() => {
    globalThis.fetch = ((...args) => fetchImpl(...args)) as typeof fetch;
    sessionImpl = async () => null;
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'creatorProfiles.getCreatorByAuthUser':
          return { _id: 'creator_1', name: '10705330', slug: 'mapache' };
        case 'authViewer.getViewerByAuthUser':
          return {
            authUserId: 'auth-user-1',
            name: 'Mapache',
            email: null,
            image: null,
            discordUserId: 'discord-user-1',
          };
        case 'backstageRepos.getRepoAccessByTokenForApi':
          return {
            tokenId: 'token_1',
            authUserId: 'auth-user-1',
            subjectId: 'subject_1',
            status: 'active',
          };
        case 'backstageRepos.buildRepositoryForApi':
          return {
            name: 'Backstage Repos',
            packages: {
              'com.yucp.example': {
                versions: {
                  '1.2.3': {
                    name: 'com.yucp.example',
                    version: '1.2.3',
                    yucpDeliveryMode: 'repo-token-vpm-v1',
                    yucpDeliverySourceKind: 'zip',
                  },
                },
              },
            },
          };
        case 'backstageRepos.resolvePackageDownloadForApi':
          return {
            artifactKey: 'backstage-package:com.yucp.example',
            downloadUrl: 'https://downloads.example/package.zip',
            deliveryName: 'example-1.2.3.zip',
            contentType: 'application/zip',
            version: '1.2.3',
            channel: 'stable',
          };
        case 'packageRegistry.getPublicBackstageProductAccessByRef':
          return {
            creatorAuthUserId: 'auth-user-1',
            creatorSlug: 'mapache',
            catalogProductId: 'catalog_1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            thumbnailUrl: 'https://cdn.test/song.png',
            primaryPackageId: 'com.yucp.song',
            primaryPackageName: 'Song Thing Package',
            packageSummaries: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                latestPublishedVersion: '1.2.3',
                latestReleaseChannel: 'stable',
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  minImporterVersion: '1.4.0',
                  catalogProductIds: ['catalog_1'],
                  channel: 'stable',
                },
              },
            ],
          };
        case 'packageRegistry.getBuyerAccessContextByCatalogProductId':
          return {
            catalogProductId: 'catalog_1',
            creatorAuthUserId: 'auth-user-1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            thumbnailUrl: 'https://cdn.test/song.png',
            status: 'active',
            backstagePackages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                latestPublishedVersion: '1.2.3',
                repositoryVisibility: 'hidden',
              },
            ],
          };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          return {
            creatorAuthUserId: 'auth-user-1',
            creatorSlug: 'mapache',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            thumbnailUrl: 'https://cdn.test/song.png',
            packages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                version: '1.2.3',
                channel: 'stable',
                zipSha256: 'a'.repeat(64),
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  minImporterVersion: '1.4.0',
                  catalogProductIds: ['catalog_1'],
                  channel: 'stable',
                },
              },
            ],
          };
        default:
          return null;
      }
    };
    mutationImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.issueRepoTokenForApi':
          return {
            token: 'ybt_example',
            tokenId: 'token_1',
            expiresAt: 1_700_000_000_000,
          };
        case 'backstageRepos.touchRepoTokenForApi':
          return null;
        case 'verificationIntents.createVerificationIntent':
          return {
            intentId: 'intent_1',
            status: 'pending',
            expiresAt: 1_700_000_000_000,
          };
        default:
          return null;
      }
    };
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('issues a VCC add-repo link for authenticated users', async () => {
    const response = await routes.handleRequest(
      new Request('https://api.test/v1/backstage/repos/access', {
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      repositoryUrl: 'https://api.test/v1/backstage/repos/mapache/index.json',
      repositoryName: 'Mapache repo',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fmapache%2Findex.json&headers%5B%5D=X-YUCP-Repo-Token%3Aybt_example',
    });
  });

  it('issues a VCC add-repo link from the session-backed API route', async () => {
    sessionImpl = async () => ({
      user: {
        id: 'auth-user-1',
      },
    });

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/repos/access?mode=redirect', {
        headers: {
          origin: 'https://app.test',
        },
      })
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe(
      'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fmapache%2Findex.json&headers%5B%5D=X-YUCP-Repo-Token%3Aybt_example'
    );
  });

  it('falls back to a generic repository name for synthetic creator labels', async () => {
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'creatorProfiles.getCreatorByAuthUser':
          return { _id: 'creator_1', name: 'Creator 10705330' };
        case 'authViewer.getViewerByAuthUser':
          return {
            authUserId: 'auth-user-1',
            name: 'Actual Discord Name',
            email: null,
            image: null,
            discordUserId: 'discord-user-1',
          };
        case 'backstageRepos.getRepoAccessByTokenForApi':
          return {
            tokenId: 'token_1',
            authUserId: 'auth-user-1',
            subjectId: 'subject_1',
            status: 'active',
          };
        default:
          return null;
      }
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/v1/backstage/repos/access', {
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response?.status).toBe(200);
    const payload = await response?.json();
    expect(payload).toMatchObject({
      creatorName: 'Actual Discord Name',
      creatorRepoRef: 'auth-user-1',
      repositoryUrl: 'https://api.test/v1/backstage/repos/auth-user-1/index.json',
      repositoryName: 'Actual Discord Name repo',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fauth-user-1%2Findex.json&headers%5B%5D=X-YUCP-Repo-Token%3Aybt_example',
    });
    expect(payload).not.toHaveProperty('repoToken');
    expect(payload).not.toHaveProperty('repoTokenHeader');
  });

  it('does not expose the session-backed API route when session access is disabled', async () => {
    const disabledRoutes = createBackstageRepoRoutes({
      apiBaseUrl: 'https://api.test',
      enableSessionAccess: false,
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
    });

    const response = await disabledRoutes.handleRequest(
      new Request('https://api.test/api/backstage/repos/access')
    );

    expect(response).toBeNull();
  });

  it('serves an entitled VPM repository document when the repo token header is present', async () => {
    const response = await routes.handleRequest(
      new Request('https://api.test/v1/backstage/repos/mapache/index.json', {
        headers: {
          'X-YUCP-Repo-Token': 'ybt_example',
        },
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      name: 'Backstage Repos',
      packages: {
        'com.yucp.example': {
          versions: {
            '1.2.3': {
              name: 'com.yucp.example',
              yucpDeliveryMode: 'repo-token-vpm-v1',
              yucpDeliverySourceKind: 'zip',
            },
          },
        },
        'com.yucp.importer': {
          versions: {
            '0.1.8': {
              name: 'com.yucp.importer',
              version: '0.1.8',
            },
          },
        },
        'com.yucp.motion': {
          versions: {
            '0.1.1': {
              name: 'com.yucp.motion',
              version: '0.1.1',
            },
          },
        },
      },
    });
  });

  it('redirects entitled package downloads through the signed artifact URL', async () => {
    const response = await routes.handleRequest(
      new Request(
        'https://api.test/v1/backstage/repos/mapache/package?packageId=com.yucp.example&version=1.2.3&channel=stable',
        {
          headers: {
            'X-YUCP-Repo-Token': 'ybt_example',
          },
        }
      )
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe('https://downloads.example/package.zip');
  });

  it('redirects entitled package downloads through CDNgine when a deliverable reference exists', async () => {
    const fetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      const url = String(input);
      if (url.startsWith('https://cdngine.test/')) {
        return new Response(
          JSON.stringify({
            assetId: 'ast_backstage_1',
            versionId: 'ver_backstage_1',
            deliveryScopeId: 'paid-downloads',
            authorizationMode: 'signed-url',
            resolvedOrigin: 'cdn-derived',
            expiresAt: '2026-05-01T12:00:00Z',
            url: '/uploads/backstage/example-1.2.3.zip',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.getRepoAccessByTokenForApi':
          return {
            tokenId: 'token_1',
            authUserId: 'auth-user-1',
            subjectId: 'subject_1',
            status: 'active',
          };
        case 'backstageRepos.resolvePackageDownloadForApi':
          return {
            deliveryArtifactId: 'artifact_1',
            deliveryArtifactMode: 'server_materialized',
            downloadUrl: 'https://downloads.example/package.zip',
            deliveryName: 'example-1.2.3.zip',
            contentType: 'application/zip',
            version: '1.2.3',
            channel: 'stable',
            cdngineDelivery: {
              assetId: 'ast_backstage_1',
              versionId: 'ver_backstage_1',
              deliveryScopeId: 'paid-downloads',
              variant: 'vpm-package',
              serviceNamespaceId: 'yucp-backstage',
              tenantId: 'auth-user-1',
              assetOwner: 'creator:auth-user-1',
              sha256: 'a'.repeat(64),
              byteSize: 1234,
              uploadedAt: 1_700_000_000_000,
            },
          };
        case 'creatorProfiles.getCreatorByAuthUser':
          return { _id: 'creator_1', name: '10705330', slug: 'mapache' };
        case 'authViewer.getViewerByAuthUser':
          return {
            authUserId: 'auth-user-1',
            name: 'Mapache',
            email: null,
            image: null,
            discordUserId: 'discord-user-1',
          };
        default:
          return null;
      }
    };

    const cdngineRoutes = createBackstageRepoRoutes({
      auth: {
        getSession: (...args: unknown[]) =>
          sessionImpl(...args) as Promise<{ user: { id: string } } | null>,
      } as never,
      apiBaseUrl: 'https://api.test',
      enableSessionAccess: true,
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      cdngine: {
        apiBaseUrl: 'https://cdngine.test',
        accessToken: 'cdngine-token',
        required: true,
      },
    });

    const response = await cdngineRoutes.handleRequest(
      new Request(
        'https://api.test/v1/backstage/repos/mapache/package?packageId=com.yucp.example&version=1.2.3&channel=stable',
        {
          headers: {
            'X-YUCP-Repo-Token': 'ybt_example',
          },
        }
      )
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe(
      'https://cdngine.test/uploads/backstage/example-1.2.3.zip'
    );
    const cdngineCall = fetchCalls.find((call) =>
      String(call.input).startsWith('https://cdngine.test/')
    );
    expect(cdngineCall?.input.toString()).toBe(
      'https://cdngine.test/v1/assets/ast_backstage_1/versions/ver_backstage_1/deliveries/paid-downloads/authorize'
    );
    expect((cdngineCall?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer cdngine-token'
    );
    expect((cdngineCall?.init?.headers as Record<string, string>)['idempotency-key']).toMatch(
      /^backstage-download-[0-9a-f]{64}$/
    );
    expect(JSON.parse(String(cdngineCall?.init?.body))).toEqual({
      responseFormat: 'url',
      variant: 'vpm-package',
    });
  });

  it('does not redirect VPM clients to raw CDNgine source when delivery publication is missing', async () => {
    const fetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      const url = String(input);
      if (url.endsWith('/deliveries/paid-downloads/authorize')) {
        return new Response(
          JSON.stringify({
            type: 'about:blank',
            detail:
              'Version "ver_backstage_1" for asset "ast_backstage_1" is not ready for this operation from state "canonical".',
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      if (url.endsWith('/source/authorize')) {
        throw new Error('VPM package downloads must not authorize raw source fallbacks.');
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.getRepoAccessByTokenForApi':
          return {
            tokenId: 'token_1',
            authUserId: 'auth-user-1',
            subjectId: 'subject_1',
            status: 'active',
          };
        case 'backstageRepos.resolvePackageDownloadForApi':
          return {
            deliveryArtifactId: 'artifact_1',
            deliveryArtifactMode: 'server_materialized',
            downloadUrl: '',
            deliveryName: 'example-1.2.3.zip',
            contentType: 'application/zip',
            version: '1.2.3',
            channel: 'stable',
            cdngineDelivery: {
              assetId: 'ast_backstage_1',
              versionId: 'ver_backstage_1',
              deliveryScopeId: 'paid-downloads',
              variant: 'vpm-package',
              serviceNamespaceId: 'yucp-backstage',
              tenantId: 'auth-user-1',
              assetOwner: 'creator:auth-user-1',
              sha256: 'a'.repeat(64),
              byteSize: 1234,
              uploadedAt: 1_700_000_000_000,
            },
          };
        case 'creatorProfiles.getCreatorByAuthUser':
          return { _id: 'creator_1', name: '10705330', slug: 'mapache' };
        case 'authViewer.getViewerByAuthUser':
          return {
            authUserId: 'auth-user-1',
            name: 'Mapache',
            email: null,
            image: null,
            discordUserId: 'discord-user-1',
          };
        default:
          return null;
      }
    };

    const cdngineRoutes = createBackstageRepoRoutes({
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      cdngine: {
        apiBaseUrl: 'https://cdngine.test',
        accessToken: 'cdngine-token',
        required: true,
      },
    });

    const response = await cdngineRoutes.handleRequest(
      new Request(
        'https://api.test/v1/backstage/repos/mapache/package?packageId=com.yucp.example&version=1.2.3&channel=stable',
        {
          headers: {
            'X-YUCP-Repo-Token': 'ybt_example',
          },
        }
      )
    );

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({
      error: 'Package delivery is temporarily unavailable',
    });
    const cdngineCalls = fetchCalls.filter((call) =>
      String(call.input).startsWith('https://cdngine.test/')
    );
    expect(cdngineCalls.map((call) => call.input.toString())).toEqual([
      'https://cdngine.test/v1/assets/ast_backstage_1/versions/ver_backstage_1/deliveries/paid-downloads/authorize',
    ]);
  });

  it('does not fall back to Convex storage for CDNgine-only package artifacts', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://cdngine.test/')) {
        return new Response(JSON.stringify({ type: 'about:blank', title: 'Not ready' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.getRepoAccessByTokenForApi':
          return {
            tokenId: 'token_1',
            authUserId: 'auth-user-1',
            subjectId: 'subject_1',
            status: 'active',
          };
        case 'backstageRepos.resolvePackageDownloadForApi':
          return {
            deliveryArtifactId: 'artifact_1',
            deliveryArtifactMode: 'server_materialized',
            downloadUrl: '',
            deliveryName: 'example-1.2.3.zip',
            contentType: 'application/zip',
            version: '1.2.3',
            channel: 'stable',
            cdngineDelivery: {
              assetId: 'ast_backstage_1',
              versionId: 'ver_backstage_1',
              deliveryScopeId: 'paid-downloads',
              variant: 'vpm-package',
              serviceNamespaceId: 'yucp-backstage',
              assetOwner: 'creator:auth-user-1',
              sha256: 'a'.repeat(64),
              byteSize: 1234,
              uploadedAt: 1_700_000_000_000,
            },
          };
        case 'creatorProfiles.getCreatorByAuthUser':
          return { _id: 'creator_1', name: '10705330', slug: 'mapache' };
        case 'authViewer.getViewerByAuthUser':
          return {
            authUserId: 'auth-user-1',
            name: 'Mapache',
            email: null,
            image: null,
            discordUserId: 'discord-user-1',
          };
        default:
          return null;
      }
    };

    const cdngineRoutes = createBackstageRepoRoutes({
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      cdngine: {
        apiBaseUrl: 'https://cdngine.test',
        accessToken: 'cdngine-token',
        required: false,
      },
    });

    const response = await cdngineRoutes.handleRequest(
      new Request(
        'https://api.test/v1/backstage/repos/mapache/package?packageId=com.yucp.example&version=1.2.3&channel=stable',
        {
          headers: {
            'X-YUCP-Repo-Token': 'ybt_example',
          },
        }
      )
    );

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({
      error: 'Package delivery is temporarily unavailable',
    });
  });

  it('returns public buyer access details for a creator product link', async () => {
    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/mapache/song-thing')
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      productRef: 'song-thing',
      title: 'Song Thing',
      ready: true,
      primaryPackageId: 'com.yucp.song',
      primaryPackage: {
        packageId: 'com.yucp.song',
        displayName: 'Song Thing Package',
        latestPublishedVersion: '1.2.3',
        latestReleaseChannel: 'stable',
        aliasContract: {
          kind: 'alias-v1',
          aliasId: 'song-thing',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          minImporterVersion: '1.4.0',
          catalogProductIds: ['catalog_1'],
          channel: 'stable',
        },
        importerDelivery: {
          packageInstallStrategy: 'server-authorized',
          repoCatalogDeliveryMode: 'repo-token-vpm-v1',
          repoCatalogReadOnly: true,
        },
      },
      packageSummaries: [
        {
          packageId: 'com.yucp.song',
          displayName: 'Song Thing Package',
          latestPublishedVersion: '1.2.3',
          latestReleaseChannel: 'stable',
          aliasContract: {
            kind: 'alias-v1',
            aliasId: 'song-thing',
            installStrategy: 'server-authorized',
            importerPackage: 'com.yucp.importer',
            minImporterVersion: '1.4.0',
            catalogProductIds: ['catalog_1'],
            channel: 'stable',
          },
          importerDelivery: {
            packageInstallStrategy: 'server-authorized',
            repoCatalogDeliveryMode: 'repo-token-vpm-v1',
            repoCatalogReadOnly: true,
          },
        },
      ],
    });
  });

  it('bootstraps a hosted verification intent from the session-backed buyer access route', async () => {
    sessionImpl = async () => ({
      user: {
        id: 'auth-user-1',
      },
    });

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/mapache/song-thing/verification-intent', {
        method: 'POST',
        headers: {
          origin: 'https://app.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          returnUrl: 'https://app.test/get-in-unity/mapache/song-thing',
          machineFingerprint: 'machine_1',
          codeChallenge: 'challenge_1',
        }),
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      intentId: 'intent_1',
      verificationUrl: 'https://app.test/verify/purchase?intent=intent_1',
    });
  });

  it('issues a bearer-authenticated alias install plan without exposing repo credentials', async () => {
    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/mapache/song-thing/install-plan', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response?.status).toBe(200);
    const payload = await response?.json();
    expect(payload).toMatchObject({
      kind: 'alias-install-plan-v1',
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      productRef: 'song-thing',
      title: 'Song Thing',
      thumbnailUrl: 'https://cdn.test/song.png',
      repositoryUrl: 'https://api.test/v1/backstage/repos/mapache/index.json',
      packages: [
        {
          packageId: 'com.yucp.song',
          displayName: 'Song Thing Package',
          version: '1.2.3',
          channel: 'stable',
          zipSha256: 'a'.repeat(64),
          aliasContract: {
            kind: 'alias-v1',
            aliasId: 'song-thing',
            installStrategy: 'server-authorized',
            importerPackage: 'com.yucp.importer',
            minImporterVersion: '1.4.0',
            catalogProductIds: ['catalog_1'],
            channel: 'stable',
          },
          importerDelivery: {
            packageInstallStrategy: 'server-authorized',
            repoCatalogDeliveryMode: 'repo-token-vpm-v1',
            repoCatalogReadOnly: true,
          },
        },
      ],
    });
    expect(typeof payload.expiresAt).toBe('number');
    expect(payload).not.toHaveProperty('repoToken');
    expect(payload).not.toHaveProperty('addRepoUrl');
  });

  it('issues a catalog-product alias install plan without using the creator-owned product API', async () => {
    const seenQueryRefs: unknown[] = [];
    queryImpl = async (ref: unknown, args?: unknown) => {
      seenQueryRefs.push(ref);
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'packageRegistry.getBuyerAccessContextByCatalogProductId':
          expect(args).toEqual({
            apiSecret: 'convex-secret',
            catalogProductId: 'catalog_1',
            actor: {
              payload: JSON.stringify({
                authUserId: 'auth-user-1',
                source: 'oauth',
                scopes: ['products:read'],
              }),
              signature: 'test-signature',
            },
          });
          return {
            catalogProductId: 'catalog_1',
            creatorAuthUserId: 'auth-user-1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            thumbnailUrl: 'https://cdn.test/song.png',
            status: 'active',
            backstagePackages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                latestPublishedVersion: '1.2.3',
                repositoryVisibility: 'hidden',
              },
            ],
          };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          expect(args).toMatchObject({
            apiSecret: 'convex-secret',
            authUserId: 'auth-user-1',
            subjectId: 'subject_1',
            creatorRef: 'auth-user-1',
            productRef: 'song-thing',
            actor: {
              payload: JSON.stringify({
                authUserId: 'auth-user-1',
                source: 'oauth',
                scopes: ['products:read'],
              }),
              signature: 'test-signature',
            },
          });
          return {
            creatorAuthUserId: 'auth-user-1',
            creatorSlug: 'mapache',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            thumbnailUrl: 'https://cdn.test/song.png',
            packages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                version: '1.2.3',
                channel: 'stable',
                zipSha256: 'a'.repeat(64),
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  minImporterVersion: '1.4.0',
                  catalogProductIds: ['catalog_1'],
                  channel: 'stable',
                },
              },
            ],
          };
        case 'creatorProfiles.getCreatorByAuthUser':
          return { _id: 'creator_1', name: '10705330', slug: 'mapache' };
        case 'authViewer.getViewerByAuthUser':
          return {
            authUserId: 'auth-user-1',
            name: 'Mapache',
            email: null,
            image: null,
            discordUserId: 'discord-user-1',
          };
        default:
          throw new Error(`Unexpected query reference: ${String(ref)}`);
      }
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/products/catalog_1/install-plan', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response?.status).toBe(200);
    const payload = await response?.json();
    expect(payload).toMatchObject({
      kind: 'alias-install-plan-v1',
      creatorRepoRef: 'mapache',
      productRef: 'song-thing',
      packages: [
        {
          packageId: 'com.yucp.song',
          importerDelivery: {
            packageInstallStrategy: 'server-authorized',
            repoCatalogDeliveryMode: 'repo-token-vpm-v1',
            repoCatalogReadOnly: true,
          },
        },
      ],
    });
    expect(seenQueryRefs).toContain('packageRegistry.getBuyerAccessContextByCatalogProductId');
  });

  it('issues an alias install plan from the session-backed auth flow', async () => {
    sessionImpl = async () => ({
      user: {
        id: 'auth-user-1',
      },
    });

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/mapache/song-thing/install-plan', {
        method: 'POST',
        headers: {
          origin: 'https://app.test',
        },
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      kind: 'alias-install-plan-v1',
      creatorRepoRef: 'mapache',
      packages: [
        {
          packageId: 'com.yucp.song',
        },
      ],
    });
  });
});
