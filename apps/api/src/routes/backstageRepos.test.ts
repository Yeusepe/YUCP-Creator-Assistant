import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

let sessionImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let actionImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
const fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> =
  async () =>
    new Response(
      JSON.stringify({
        packages: {
          'com.yucp.importer': {
            versions: {
              '0.1.9': {
                name: 'com.yucp.importer',
                version: '0.1.9',
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
      resolveRawPackageDownloadForApi: 'backstageRepos.resolveRawPackageDownloadForApi',
    },
    packageRegistry: {
      getPublicBackstageProductAccessByRef: 'packageRegistry.getPublicBackstageProductAccessByRef',
      getAuthorizedAliasInstallPlanByRef: 'packageRegistry.getAuthorizedAliasInstallPlanByRef',
      getBuyerAccessContextByCatalogProductId:
        'packageRegistry.getBuyerAccessContextByCatalogProductId',
    },
    verificationIntents: {
      createVerificationIntent: 'verificationIntents.createVerificationIntent',
      redeemVerificationIntent: 'verificationIntents.redeemVerificationIntent',
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
    action: (reference: unknown, args?: unknown) =>
      actionImpl(reference, actor && args && typeof args === 'object' ? { ...args, actor } : args),
  }),
}));

mock.module('../lib/oauthAccessToken', () => ({
  verifyBetterAuthAccessToken: async () => ({
    ok: true,
    token: { sub: 'auth-user-1' },
  }),
}));

mock.module('../lib/logger', () => ({
  logger: {
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

mock.module('../lib/apiActor', () => ({
  createApiServiceActorBinding: async (input: unknown) => ({
    payload: JSON.stringify(input),
    signature: 'test-signature',
  }),
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
    actionImpl = async () => null;
    queryImpl = async (ref: unknown, args?: unknown) => {
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
            zipSha256: 'b'.repeat(64),
            version: '1.2.3',
            channel: 'stable',
          };
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: 'https://downloads.example/package.unitypackage',
            deliveryName: 'example-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
          };
        case 'packageRegistry.getPublicBackstageProductAccessByRef':
          expect(args).toMatchObject({
            actor: {
              payload: expect.any(String),
              signature: 'test-signature',
            },
          });
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

  it('issues buyer repo access for the product creator repo instead of the buyer workspace', async () => {
    const mutationCalls: Array<{ ref: unknown; args: unknown }> = [];
    queryImpl = async (ref: unknown, args?: unknown) => {
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          expect(args).toMatchObject({ authUserId: 'buyer-user-1' });
          return { _id: 'subject_buyer_1' };
        case 'packageRegistry.getPublicBackstageProductAccessByRef':
          expect(args).toMatchObject({
            creatorRef: 'mapache',
            productRef: 'song-thing',
            actor: {
              payload: JSON.stringify({
                authUserId: 'buyer-user-1',
                source: 'session',
              }),
              signature: 'test-signature',
            },
          });
          return {
            creatorAuthUserId: 'creator-user-1',
            creatorSlug: 'mapache',
            catalogProductId: 'catalog_1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            packageSummaries: [],
          };
        case 'creatorProfiles.getCreatorByAuthUser':
          expect(args).toMatchObject({ authUserId: 'creator-user-1' });
          return { _id: 'creator_1', name: 'Mapache', slug: 'mapache' };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          expect(args).toMatchObject({
            authUserId: 'creator-user-1',
            subjectId: 'subject_buyer_1',
            creatorRef: 'mapache',
            productRef: 'song-thing',
            actor: {
              payload: JSON.stringify({
                authUserId: 'buyer-user-1',
                source: 'session',
              }),
              signature: 'test-signature',
            },
          });
          return {
            creatorAuthUserId: 'creator-user-1',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            packages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                version: '1.2.3',
                channel: 'stable',
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  catalogProductIds: ['catalog_1'],
                },
              },
            ],
          };
        default:
          return null;
      }
    };
    mutationImpl = async (ref: unknown, args?: unknown) => {
      mutationCalls.push({ ref, args });
      if (ref === 'backstageRepos.issueRepoTokenForApi') {
        return {
          token: 'ybt_example',
          tokenId: 'token_1',
          expiresAt: 1_700_000_000_000,
        };
      }
      return null;
    };
    sessionImpl = async () => ({
      user: {
        id: 'buyer-user-1',
      },
    });

    const response = await routes.handleRequest(
      new Request(
        'https://api.test/api/backstage/repos/access?creatorRef=mapache&productRef=song-thing',
        {
          headers: {
            origin: 'https://app.test',
          },
        }
      )
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
    expect(mutationCalls).toContainEqual({
      ref: 'backstageRepos.issueRepoTokenForApi',
      args: expect.objectContaining({
        authUserId: 'creator-user-1',
        subjectAuthUserId: 'buyer-user-1',
        subjectId: 'subject_buyer_1',
      }),
    });
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
            '0.1.9': {
              name: 'com.yucp.importer',
              version: '0.1.9',
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

  it('serves creator repository packages when forwarded toolchain packages are unavailable', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://vpm.yucp.club/')) {
        return new Response('upstream unavailable', { status: 503 });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;

    const response = await routes.handleRequest(
      new Request('https://api.test/v1/backstage/repos/mapache/index.json', {
        headers: {
          'X-YUCP-Repo-Token': 'ybt_example',
        },
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
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
            zipSha256: 'b'.repeat(64),
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

  it('does not fall back to CDNgine source export for VPM package downloads when delivery is not ready', async () => {
    const fetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      const url = String(input);
      if (url.endsWith('/deliveries/paid-downloads/authorize')) {
        return new Response(
          JSON.stringify({
            type: 'https://docs.cdngine.dev/problems/version-not-ready',
            title: 'Version not ready',
            status: 409,
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
        throw new Error('VPM package downloads must not authorize source exports.');
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
            zipSha256: 'b'.repeat(64),
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
            zipSha256: 'b'.repeat(64),
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

  it('rejects untrusted buyer verification return URLs before creating an intent', async () => {
    const mutationCalls: Array<{ ref: unknown; args: unknown }> = [];
    const defaultMutationImpl = mutationImpl;
    mutationImpl = async (ref: unknown, args?: unknown) => {
      mutationCalls.push({ ref, args });
      return defaultMutationImpl(ref, args);
    };
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
          returnUrl: 'https://attacker.test/get-in-unity/mapache/song-thing',
          machineFingerprint: 'machine_1',
          codeChallenge: 'challenge_1',
        }),
      })
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: 'Invalid returnUrl' });
    expect(
      mutationCalls.some((call) => call.ref === 'verificationIntents.createVerificationIntent')
    ).toBe(false);
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
          packageSha256: 'b'.repeat(64),
          downloadAuthorizationUrl:
            'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/download',
          sourceKind: 'unitypackage',
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

  it('resolves bearer alias install plans against the creator entitlement scope', async () => {
    queryImpl = async (ref: unknown, args?: unknown) => {
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          expect(args).toMatchObject({ authUserId: 'auth-user-1' });
          return { _id: 'subject_1' };
        case 'packageRegistry.getPublicBackstageProductAccessByRef':
          return {
            creatorAuthUserId: 'creator-user-1',
            creatorSlug: 'mapache',
            catalogProductId: 'catalog_1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            packageSummaries: [],
          };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          expect(args).toMatchObject({
            authUserId: 'creator-user-1',
            subjectId: 'subject_1',
            creatorRef: 'mapache',
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
            creatorAuthUserId: 'creator-user-1',
            creatorSlug: 'mapache',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            packages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                version: '1.2.3',
                channel: 'stable',
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  catalogProductIds: ['catalog_1'],
                },
              },
            ],
          };
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: 'https://downloads.example/com.yucp.song-1.2.3.unitypackage',
            deliveryName: 'com.yucp.song-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
          };
        case 'creatorProfiles.getCreatorByAuthUser':
          expect(args).toMatchObject({ authUserId: 'creator-user-1' });
          return { _id: 'creator_1', name: 'Mapache', slug: 'mapache' };
        default:
          return null;
      }
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/mapache/song-thing/install-plan', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      packages: [{ packageId: 'com.yucp.song', version: '1.2.3' }],
    });
  });

  it('authorizes alias package downloads through buyer bearer auth and CDNgine', async () => {
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
            url: '/uploads/backstage/vrc-get-com.yucp.song-1.2.3.zip',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    queryImpl = async (ref: unknown, args?: unknown) => {
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          expect(args).toMatchObject({ authUserId: 'auth-user-1' });
          return { _id: 'subject_1' };
        case 'packageRegistry.getBuyerAccessContextByCatalogProductId':
          return {
            catalogProductId: 'catalog_1',
            creatorAuthUserId: 'creator-user-1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            status: 'active',
          };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          expect(args).toMatchObject({
            authUserId: 'creator-user-1',
            subjectId: 'subject_1',
            creatorRef: 'creator-user-1',
            productRef: 'song-thing',
          });
          return {
            creatorAuthUserId: 'creator-user-1',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            packages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                version: '1.2.3',
                channel: 'stable',
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  catalogProductIds: ['catalog_1'],
                },
              },
            ],
          };
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          expect(args).toMatchObject({
            authUserId: 'creator-user-1',
            subjectId: 'subject_1',
            packageId: 'com.yucp.song',
            version: '1.2.3',
            channel: 'stable',
          });
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: '',
            deliveryName: 'com.yucp.song-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'c'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            cdngineDelivery: {
              assetId: 'ast_backstage_1',
              versionId: 'ver_backstage_1',
              deliveryScopeId: 'paid-downloads',
              variant: 'raw-upload',
              serviceNamespaceId: 'yucp-backstage',
              tenantId: 'creator-user-1',
              assetOwner: 'creator:creator-user-1',
              sha256: 'c'.repeat(64),
              byteSize: 4567,
              uploadedAt: 1_700_000_000_000,
            },
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
        accessToken: 'cdngine-token',
        apiBaseUrl: 'https://cdngine.test',
        required: true,
      },
    });

    const response = await cdngineRoutes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/download',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ version: '1.2.3', channel: 'stable' }),
        }
      )
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      downloadUrl: 'https://cdngine.test/uploads/backstage/vrc-get-com.yucp.song-1.2.3.zip',
      packageSha256: 'c'.repeat(64),
      sourceKind: 'unitypackage',
      version: '1.2.3',
      channel: 'stable',
      contentType: 'application/vnd.unity',
      deliveryName: 'com.yucp.song-1.2.3.unitypackage',
    });
    const cdngineCall = fetchCalls.find((call) =>
      String(call.input).includes('/deliveries/paid-downloads/authorize')
    );
    expect(cdngineCall?.init?.headers).toMatchObject({
      authorization: 'Bearer cdngine-token',
    });
  });

  it('falls back to the raw package download URL when optional CDNgine authorization fails', async () => {
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
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'packageRegistry.getBuyerAccessContextByCatalogProductId':
          return {
            catalogProductId: 'catalog_1',
            creatorAuthUserId: 'creator-user-1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            status: 'active',
          };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          return {
            creatorAuthUserId: 'creator-user-1',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            packages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                version: '1.2.3',
                channel: 'stable',
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  catalogProductIds: ['catalog_1'],
                },
              },
            ],
          };
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: 'https://downloads.example/com.yucp.song-1.2.3.unitypackage',
            deliveryName: 'com.yucp.song-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'c'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            cdngineDelivery: {
              assetId: 'ast_backstage_1',
              versionId: 'ver_backstage_1',
              deliveryScopeId: 'paid-downloads',
              variant: 'raw-upload',
              serviceNamespaceId: 'yucp-backstage',
              tenantId: 'creator-user-1',
              assetOwner: 'creator:creator-user-1',
              sha256: 'c'.repeat(64),
              byteSize: 4567,
              uploadedAt: 1_700_000_000_000,
            },
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
        accessToken: 'cdngine-token',
        apiBaseUrl: 'https://cdngine.test',
        required: false,
      },
    });

    const response = await cdngineRoutes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/download',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ version: '1.2.3', channel: 'stable' }),
        }
      )
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      downloadUrl: 'https://downloads.example/com.yucp.song-1.2.3.unitypackage',
      packageSha256: 'c'.repeat(64),
      sourceKind: 'unitypackage',
    });
  });

  it('redeems buyer verification grants with the session actor before VCC repo access', async () => {
    sessionImpl = async () => ({ user: { id: 'auth-user-1' } });
    const observedCalls: unknown[][] = [];
    actionImpl = async (...args: unknown[]) => {
      observedCalls.push(args);
      return {
        success: true,
        token: 'license.jwt',
        expiresAt: 123,
      };
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/verification-intents/intent_123/redeem', {
        method: 'POST',
        headers: {
          origin: 'https://app.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          codeVerifier: 'verifier',
          machineFingerprint: 'buyer-web-machine',
          grantToken: 'grant-token',
        }),
      })
    );

    expect(response?.status).toBe(200);
    expect(observedCalls[0]?.[0]).toBe('verificationIntents.redeemVerificationIntent');
    expect(observedCalls[0]?.[1]).toMatchObject({
      apiSecret: 'convex-secret',
      actor: {
        payload: JSON.stringify({
          authUserId: 'auth-user-1',
          source: 'session',
        }),
        signature: 'test-signature',
      },
      authUserId: 'auth-user-1',
      intentId: 'intent_123',
      codeVerifier: 'verifier',
      machineFingerprint: 'buyer-web-machine',
      grantToken: 'grant-token',
      issuerBaseUrl: 'https://api.test',
    });
    await expect(response?.json()).resolves.toEqual({
      success: true,
      token: 'license.jwt',
      expiresAt: 123,
    });
  });

  it('falls back to CDNgine source authorization when a package delivery variant is not materialized yet', async () => {
    const fetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      const url = String(input);
      if (url.endsWith('/deliveries/paid-downloads/authorize')) {
        return new Response(JSON.stringify({ detail: 'delivery variant is not ready' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/source/authorize')) {
        return new Response(
          JSON.stringify({
            assetId: 'ast_backstage_1',
            versionId: 'ver_backstage_1',
            authorizationMode: 'signed-url',
            resolvedOrigin: 'cdn-source',
            expiresAt: '2026-05-01T12:00:00Z',
            url: '/uploads/backstage/source/vrc-get-com.yucp.song-1.2.3.zip',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    queryImpl = async (ref: unknown, _args?: unknown) => {
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'packageRegistry.getBuyerAccessContextByCatalogProductId':
          return {
            catalogProductId: 'catalog_1',
            creatorAuthUserId: 'creator-user-1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            status: 'active',
          };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          return {
            creatorAuthUserId: 'creator-user-1',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            packages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                version: '1.2.3',
                channel: 'stable',
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  catalogProductIds: ['catalog_1'],
                },
              },
            ],
          };
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: '',
            deliveryName: 'com.yucp.song-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            cdngineDelivery: {
              assetId: 'ast_backstage_1',
              versionId: 'ver_backstage_1',
              deliveryScopeId: 'paid-downloads',
              variant: 'raw-upload',
              serviceNamespaceId: 'yucp-backstage',
              tenantId: 'creator-user-1',
              assetOwner: 'creator:creator-user-1',
              sha256: 'b'.repeat(64),
              byteSize: 4567,
              uploadedAt: 1_700_000_000_000,
            },
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
        accessToken: 'cdngine-token',
        apiBaseUrl: 'https://cdngine.test',
        required: true,
      },
    });

    const response = await cdngineRoutes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/download',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ version: '1.2.3', channel: 'stable' }),
        }
      )
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      downloadUrl: 'https://cdngine.test/uploads/backstage/source/vrc-get-com.yucp.song-1.2.3.zip',
      packageSha256: 'b'.repeat(64),
      sourceKind: 'unitypackage',
      version: '1.2.3',
      channel: 'stable',
      contentType: 'application/vnd.unity',
      deliveryName: 'com.yucp.song-1.2.3.unitypackage',
    });
    expect(fetchCalls.map((call) => String(call.input))).toEqual([
      'https://cdngine.test/v1/assets/ast_backstage_1/versions/ver_backstage_1/deliveries/paid-downloads/authorize',
      'https://cdngine.test/v1/assets/ast_backstage_1/versions/ver_backstage_1/source/authorize',
    ]);
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
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: 'https://downloads.example/com.yucp.song-1.2.3.unitypackage',
            deliveryName: 'com.yucp.song-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
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

  it('uses the raw upload artifact for alias install plans', async () => {
    const seenQueryRefs: unknown[] = [];
    queryImpl = async (ref: unknown, args?: unknown) => {
      seenQueryRefs.push(ref);
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'packageRegistry.getBuyerAccessContextByCatalogProductId':
          return {
            catalogProductId: 'catalog_1',
            creatorAuthUserId: 'auth-user-1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            status: 'active',
          };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          return {
            creatorAuthUserId: 'auth-user-1',
            creatorSlug: 'mapache',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
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
                  catalogProductIds: ['catalog_1'],
                },
              },
            ],
          };
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          expect(args).toMatchObject({
            authUserId: 'auth-user-1',
            subjectId: 'subject_1',
            packageId: 'com.yucp.song',
            version: '1.2.3',
            channel: 'stable',
          });
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: 'https://downloads.example/com.yucp.song-1.2.3.unitypackage',
            deliveryName: 'com.yucp.song-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'a'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
          };
        case 'backstageRepos.resolvePackageDownloadForApi':
          throw new Error('Alias install plans must resolve raw upload artifacts');
        default:
          return null;
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
    await expect(response?.json()).resolves.toMatchObject({
      kind: 'alias-install-plan-v1',
      packages: [
        {
          packageId: 'com.yucp.song',
          packageSha256: 'a'.repeat(64),
          sourceKind: 'unitypackage',
          downloadAuthorizationUrl:
            'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/download',
        },
      ],
    });
    expect(seenQueryRefs).toContain('backstageRepos.resolveRawPackageDownloadForApi');
  });

  it('rejects alias install plans with invalid raw artifact digests', async () => {
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'packageRegistry.getBuyerAccessContextByCatalogProductId':
          return {
            catalogProductId: 'catalog_1',
            creatorAuthUserId: 'auth-user-1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            status: 'active',
          };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          return {
            creatorAuthUserId: 'auth-user-1',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
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
                  catalogProductIds: ['catalog_1'],
                },
              },
            ],
          };
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: 'https://downloads.example/com.yucp.song-1.2.3.unitypackage',
            deliveryName: 'com.yucp.song-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'not-a-sha256-digest',
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
          };
        default:
          return null;
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

    expect(response?.status).toBe(500);
    await expect(response?.json()).resolves.toEqual({
      error: 'Failed to issue alias install plan',
    });
  });

  it('authorizes alias package downloads from the raw upload artifact', async () => {
    const seenQueryRefs: unknown[] = [];
    queryImpl = async (ref: unknown, args?: unknown) => {
      seenQueryRefs.push(ref);
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'packageRegistry.getBuyerAccessContextByCatalogProductId':
          return {
            catalogProductId: 'catalog_1',
            creatorAuthUserId: 'auth-user-1',
            productId: 'product_1',
            provider: 'gumroad',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            displayName: 'Song Thing',
            status: 'active',
          };
        case 'packageRegistry.getAuthorizedAliasInstallPlanByRef':
          return {
            creatorAuthUserId: 'auth-user-1',
            providerProductRef: 'song-thing',
            canonicalSlug: 'song-thing',
            packages: [
              {
                packageId: 'com.yucp.song',
                displayName: 'Song Thing Package',
                version: '1.2.3',
                channel: 'stable',
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  catalogProductIds: ['catalog_1'],
                },
              },
            ],
          };
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          expect(args).toMatchObject({
            authUserId: 'auth-user-1',
            subjectId: 'subject_1',
            packageId: 'com.yucp.song',
            version: '1.2.3',
            channel: 'stable',
          });
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: 'https://downloads.example/com.yucp.song-1.2.3.unitypackage',
            deliveryName: 'com.yucp.song-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'a'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
          };
        case 'backstageRepos.resolvePackageDownloadForApi':
          throw new Error('Alias package downloads must resolve raw upload artifacts');
        default:
          return null;
      }
    };

    const response = await routes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/download',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ version: '1.2.3', channel: 'stable' }),
        }
      )
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      downloadUrl: 'https://downloads.example/com.yucp.song-1.2.3.unitypackage',
      packageSha256: 'a'.repeat(64),
      sourceKind: 'unitypackage',
      version: '1.2.3',
      channel: 'stable',
      contentType: 'application/vnd.unity',
      deliveryName: 'com.yucp.song-1.2.3.unitypackage',
    });
    expect(seenQueryRefs).toContain('backstageRepos.resolveRawPackageDownloadForApi');
  });

  it('rejects malformed alias package download bodies as client errors', async () => {
    queryImpl = async () => {
      throw new Error('Malformed raw package download bodies should not reach Convex');
    };

    const response = await routes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/download',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
            'content-type': 'application/json',
          },
          body: '{not-json',
        }
      )
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: 'Invalid JSON body' });
  });

  it('rejects oversized alias package download bodies before Convex reads', async () => {
    queryImpl = async () => {
      throw new Error('Oversized raw package download bodies should not reach Convex');
    };

    const response = await routes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/download',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ version: '1.2.3', padding: 'x'.repeat(5_000) }),
        }
      )
    );

    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toEqual({ error: 'Request body too large' });
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
