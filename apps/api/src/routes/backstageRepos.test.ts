import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { loreRepositoryIdForCreator } from '@yucp/shared/loreBackstageClient';
import { createTestLogger } from '../testSupport/loggerMock';

let sessionImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let actionImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
const convexQueryCalls: Array<{ reference: unknown; args: unknown; actor: unknown }> = [];
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

function applyBoundActorForProtectedMockCall(
  reference: unknown,
  args: unknown,
  actor: unknown
): unknown {
  if (
    !actor ||
    typeof reference !== 'string' ||
    !reference.startsWith('packageRegistry.') ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  ) {
    return args;
  }

  return {
    ...(args as Record<string, unknown>),
    actor,
  };
}

type TestLoreArtifactReference = {
  repositoryId: string;
  address: string;
  tenantId?: string;
  sha256: string;
  byteSize: number;
  uploadedAt: string;
};

function makeTestLoreArtifactReference(
  authUserId: string,
  overrides: Partial<Omit<TestLoreArtifactReference, 'tenantId'>> = {}
): TestLoreArtifactReference {
  return {
    repositoryId: loreRepositoryIdForCreator(authUserId, loreTestConfig.repoNamespaceSalt),
    address: `${'2'.repeat(64)}-${'3'.repeat(32)}`,
    tenantId: authUserId,
    sha256: 'b'.repeat(64),
    byteSize: 1234,
    uploadedAt: '2024-03-09T16:00:00.000Z',
    ...overrides,
  };
}

function decodeLorePresignPayload(url: string): Record<string, unknown> {
  const token = new URL(url).searchParams.get('token');
  expect(token).toBeString();
  const [payload, signature] = token?.split('.') ?? [];
  expect(payload).toBeString();
  expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

const loreTestConfig = {
  apiBaseUrl: 'https://lore.test',
  presignHmacKey: '11'.repeat(32),
  repoNamespaceSalt: 'test-repository-salt',
  accessClientId: 'lore-client-id',
  accessClientSecret: 'lore-client-secret',
};

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
    query: (reference: unknown, args?: unknown) => {
      convexQueryCalls.push({ reference, args, actor });
      return queryImpl(reference, applyBoundActorForProtectedMockCall(reference, args, actor));
    },
    mutation: (reference: unknown, args?: unknown) =>
      mutationImpl(reference, applyBoundActorForProtectedMockCall(reference, args, actor)),
    action: (reference: unknown, args?: unknown) =>
      actionImpl(reference, applyBoundActorForProtectedMockCall(reference, args, actor)),
  }),
}));

mock.module('../lib/oauthAccessToken', () => ({
  verifyBetterAuthAccessToken: async () => ({
    ok: true,
    token: { sub: 'auth-user-1' },
  }),
}));

mock.module('../lib/logger', () => ({
  logger: createTestLogger({
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  }),
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
    lore: loreTestConfig,
  });

  beforeEach(() => {
    globalThis.fetch = ((...args) => fetchImpl(...args)) as typeof fetch;
    convexQueryCalls.length = 0;
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
            downloadUrl: '',
            deliveryName: 'example-1.2.3.unitypackage',
            contentType: 'application/vnd.unity',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            loreSource: makeTestLoreArtifactReference('auth-user-1'),
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
            canonicalSlug: '   ',
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
            creatorAuthUserId: 'creator-user-1',
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
                media: {
                  banner: {
                    kind: 'banner',
                    byteSize: 12,
                    contentType: 'image/webp',
                    deliveryName: 'song-banner.webp',
                    sha256: 'c'.repeat(64),
                    sourcePath: 'Assets/YUCP/banner.webp',
                  },
                  icon: {
                    kind: 'icon',
                    byteSize: 10,
                    contentType: 'image/png',
                    deliveryName: 'song-icon.png',
                    sha256: 'd'.repeat(64),
                    sourcePath: 'Assets/YUCP/icon.png',
                  },
                },
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

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
    expect(response?.headers.get('cache-control')).toBe('no-store');
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
                service: 'backstage-access',
                scopes: ['creator:delegate'],
                authUserId: 'creator-user-1',
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
        actor: expect.objectContaining({
          payload: JSON.stringify({
            authUserId: 'buyer-user-1',
            source: 'session',
          }),
          signature: 'test-signature',
        }),
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

  it('rejects revoked repo tokens before touching or serving repository contents', async () => {
    const mutationCalls: Array<{ ref: unknown; args: unknown }> = [];
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.getRepoAccessByTokenForApi':
          return {
            tokenId: 'token_1',
            authUserId: 'auth-user-1',
            subjectId: 'subject_1',
            status: 'revoked',
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
    mutationImpl = async (ref: unknown, args?: unknown) => {
      mutationCalls.push({ ref, args });
      return null;
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/v1/backstage/repos/mapache/index.json', {
        headers: {
          'X-YUCP-Repo-Token': 'ybt_revoked',
        },
      })
    );

    expect(response?.status).toBe(404);
    expect(mutationCalls).not.toContainEqual(
      expect.objectContaining({ ref: 'backstageRepos.touchRepoTokenForApi' })
    );
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
    expect(response?.headers.get('cache-control')).toBe('no-store');
    const repoAccessCall = convexQueryCalls.find(
      (call) => call.reference === 'backstageRepos.getRepoAccessByTokenForApi'
    );
    const packageDownloadCall = convexQueryCalls.find(
      (call) => call.reference === 'backstageRepos.resolvePackageDownloadForApi'
    );
    expect(packageDownloadCall?.args).toEqual(
      expect.objectContaining({
        tokenHash: (repoAccessCall?.args as { tokenHash?: string } | undefined)?.tokenHash,
      })
    );
  });

  it('maps repo-token download authorization races to package not found responses', async () => {
    const defaultQueryImpl = queryImpl;
    queryImpl = async (ref: unknown, args?: unknown) => {
      if (ref === 'backstageRepos.resolvePackageDownloadForApi') {
        throw new Error('Unauthorized: Backstage repo token does not authorize this subject.');
      }
      return defaultQueryImpl(ref, args);
    };

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

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({ error: 'Package not found' });
  });

  it('redirects entitled package downloads through a client-minted Lore presigned URL', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore presigning must not make a network request');
    }) as unknown as typeof fetch;
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
            loreDelivery: makeTestLoreArtifactReference('auth-user-1', {
              sha256: 'a'.repeat(64),
            }),
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

    const loreRoutes = createBackstageRepoRoutes({
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
      lore: loreTestConfig,
    });

    const response = await loreRoutes.handleRequest(
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
    const location = response?.headers.get('location') ?? '';
    expect(location).toMatch(
      /^https:\/\/lore\.test\/v1\/presigned\/[0-9a-f]{32}\/[0-9a-f]{64}-[0-9a-f]{32}\?token=/
    );
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(fetchCount).toBe(0);
    expect(decodeLorePresignPayload(location)).toMatchObject({
      repository: loreRepositoryIdForCreator('auth-user-1', loreTestConfig.repoNamespaceSalt),
      address: `${'2'.repeat(64)}-${'3'.repeat(32)}`,
      content_type: 'application/zip',
      content_disposition: 'attachment; filename="example-1.2.3.zip"',
    });
  });

  it('returns a temporary outage without network access when Lore delivery config is missing', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Missing Lore configuration must fail before network access');
    }) as unknown as typeof fetch;
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
            loreDelivery: makeTestLoreArtifactReference('auth-user-1', {
              sha256: 'a'.repeat(64),
            }),
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

    const unconfiguredRoutes = createBackstageRepoRoutes({
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

    const response = await unconfiguredRoutes.handleRequest(
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
    expect(fetchCount).toBe(0);
  });

  it('does not fall back to raw sources when Lore VPM delivery presigning fails', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore presigning and raw fallback must not make network requests');
    }) as unknown as typeof fetch;
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
            loreDelivery: makeTestLoreArtifactReference('auth-user-1', {
              sha256: 'a'.repeat(64),
            }),
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

    const invalidLoreRoutes = createBackstageRepoRoutes({
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      lore: { ...loreTestConfig, presignHmacKey: 'invalid-key' },
    });

    const response = await invalidLoreRoutes.handleRequest(
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
    expect(fetchCount).toBe(0);
  });

  it('does not fall back to Convex storage for Lore-only package artifacts', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore presigning must not make a network request');
    }) as unknown as typeof fetch;
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
            loreDelivery: makeTestLoreArtifactReference('auth-user-1', {
              address: 'invalid-address',
              sha256: 'a'.repeat(64),
            }),
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

    const loreRoutes = createBackstageRepoRoutes({
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      lore: loreTestConfig,
    });

    const response = await loreRoutes.handleRequest(
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
    expect(fetchCount).toBe(0);
  });

  it('returns public buyer access details for a creator product link', async () => {
    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/mapache/song-thing')
    );

    expect(response?.status).toBe(200);
    const payload = await response?.json();
    expect(payload).toMatchObject({
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
          importerDelivery: {
            packageInstallStrategy: 'server-authorized',
            repoCatalogDeliveryMode: 'repo-token-vpm-v1',
            repoCatalogReadOnly: true,
          },
        },
      ],
    });
    expect(payload.primaryPackage).not.toHaveProperty('aliasContract');
    for (const summary of payload.packageSummaries) {
      expect(summary).not.toHaveProperty('aliasContract');
    }
  });

  it('returns a safe 404 when public buyer access has no usable product ref', async () => {
    const defaultQueryImpl = queryImpl;
    queryImpl = async (ref: unknown, args?: unknown) => {
      if (ref !== 'packageRegistry.getPublicBackstageProductAccessByRef') {
        return defaultQueryImpl(ref, args);
      }

      return {
        creatorAuthUserId: 'auth-user-1',
        creatorSlug: 'mapache',
        catalogProductId: 'catalog_1',
        productId: 'product_1',
        provider: 'gumroad',
        providerProductRef: '   ',
        canonicalSlug: '',
        displayName: 'Song Thing',
        thumbnailUrl: 'https://cdn.test/song.png',
        primaryPackageId: 'com.yucp.song',
        primaryPackageName: 'Song Thing Package',
        packageSummaries: [],
      };
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/mapache/song-thing')
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({
      error: 'Product not found',
    });
  });

  it('selects the buyer access primary package by primaryPackageId', async () => {
    const defaultQueryImpl = queryImpl;
    queryImpl = async (ref: unknown, args?: unknown) => {
      if (ref !== 'packageRegistry.getPublicBackstageProductAccessByRef') {
        return defaultQueryImpl(ref, args);
      }

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
        primaryPackageId: 'com.yucp.primary',
        primaryPackageName: 'Primary Package',
        packageSummaries: [
          {
            packageId: 'com.yucp.secondary',
            displayName: 'Secondary Package',
            latestPublishedVersion: '1.0.0',
            latestReleaseChannel: 'stable',
            aliasContract: null,
          },
          {
            packageId: 'com.yucp.primary',
            displayName: 'Primary Package',
            latestPublishedVersion: '2.0.0',
            latestReleaseChannel: 'beta',
            aliasContract: {
              kind: 'alias-v1',
              aliasId: 'song-thing',
              installStrategy: 'server-authorized',
              importerPackage: 'com.yucp.importer',
              minImporterVersion: '1.4.0',
              catalogProductIds: ['catalog_1'],
              channel: 'beta',
            },
          },
        ],
      };
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/mapache/song-thing')
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      primaryPackageId: 'com.yucp.primary',
      primaryPackage: {
        packageId: 'com.yucp.primary',
        displayName: 'Primary Package',
        latestPublishedVersion: '2.0.0',
        latestReleaseChannel: 'beta',
      },
      packageSummaries: [
        {
          packageId: 'com.yucp.secondary',
        },
        {
          packageId: 'com.yucp.primary',
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

  it('rejects blank buyer verification bootstrap fields before creating an intent', async () => {
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
          returnUrl: '   ',
          machineFingerprint: 'machine_1',
          codeChallenge: 'challenge_1',
        }),
      })
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: 'returnUrl, machineFingerprint, and codeChallenge are required',
    });
    expect(
      mutationCalls.some((call) => call.ref === 'verificationIntents.createVerificationIntent')
    ).toBe(false);
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

  it('rejects oversized buyer verification bootstrap bodies before creating an intent', async () => {
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
          returnUrl: 'https://app.test/get-in-unity/mapache/song-thing',
          machineFingerprint: 'machine_1',
          codeChallenge: 'challenge_1',
          padding: 'x'.repeat(5_000),
        }),
      })
    );

    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toEqual({ error: 'Request body too large' });
    expect(
      mutationCalls.some((call) => call.ref === 'verificationIntents.createVerificationIntent')
    ).toBe(false);
  });

  it('rejects oversized catalog install-plan bodies before Convex reads', async () => {
    queryImpl = async () => {
      throw new Error('Oversized install-plan bodies should not reach Convex');
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/products/catalog_1/install-plan', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          machineFingerprint: 'machine_1',
          padding: 'x'.repeat(5_000),
        }),
      })
    );

    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toEqual({ error: 'Request body too large' });
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
            'https://api.test/api/backstage/access/products/song-thing/packages/com.yucp.song/download',
          sourceKind: 'unitypackage',
          media: {
            banner: {
              kind: 'banner',
              byteSize: 12,
              contentType: 'image/webp',
              downloadUrl:
                'https://api.test/api/backstage/access/products/song-thing/packages/com.yucp.song/media/banner',
              sha256: 'c'.repeat(64),
              sourcePath: 'Assets/YUCP/banner.webp',
            },
            icon: {
              kind: 'icon',
              byteSize: 10,
              contentType: 'image/png',
              downloadUrl:
                'https://api.test/api/backstage/access/products/song-thing/packages/com.yucp.song/media/icon',
              sha256: 'd'.repeat(64),
              sourcePath: 'Assets/YUCP/icon.png',
            },
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
    for (const pkg of payload.packages) {
      expect(pkg).not.toHaveProperty('aliasContract');
    }
  });

  it('reports invalid Lore media references as temporary delivery outages', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore media presigning must not make a network request');
    }) as unknown as typeof fetch;
    queryImpl = async (ref: unknown, args?: unknown) => {
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
          expect(args).toMatchObject({
            authUserId: 'creator-user-1',
            subjectId: 'subject_1',
            creatorRef: 'creator-user-1',
            productRef: 'song-thing',
            actor: {
              payload: JSON.stringify({
                service: 'backstage-access',
                scopes: ['creator:delegate'],
                authUserId: 'creator-user-1',
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
                media: {
                  icon: {
                    kind: 'icon',
                    byteSize: 10,
                    contentType: 'image/png',
                    deliveryName: 'song-icon.png',
                    sha256: 'd'.repeat(64),
                    loreDelivery: makeTestLoreArtifactReference('creator-user-1', {
                      address: 'invalid-address',
                      sha256: 'd'.repeat(64),
                      byteSize: 10,
                    }),
                  },
                },
              },
            ],
          };
        default:
          return null;
      }
    };

    const loreRoutes = createBackstageRepoRoutes({
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      lore: loreTestConfig,
    });

    const response = await loreRoutes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/media/icon',
        {
          headers: {
            authorization: 'Bearer oauth-token',
          },
        }
      )
    );

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({
      error: 'Package media is temporarily unavailable',
    });
    expect(fetchCount).toBe(0);
  });

  it('rejects Lore package media references owned by another creator repository', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore media presigning must not make a network request');
    }) as unknown as typeof fetch;
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
                media: {
                  icon: {
                    kind: 'icon',
                    byteSize: 10,
                    contentType: 'image/png',
                    deliveryName: 'song-icon.png',
                    sha256: 'd'.repeat(64),
                    loreDelivery: makeTestLoreArtifactReference('auth-user-1', {
                      repositoryId: loreRepositoryIdForCreator(
                        'different-creator',
                        loreTestConfig.repoNamespaceSalt
                      ),
                      sha256: 'd'.repeat(64),
                      byteSize: 10,
                    }),
                  },
                },
              },
            ],
          };
        default:
          return null;
      }
    };

    const loreRoutes = createBackstageRepoRoutes({
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      lore: loreTestConfig,
    });

    const response = await loreRoutes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/media/icon',
        {
          headers: {
            authorization: 'Bearer oauth-token',
          },
        }
      )
    );

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({
      error: 'Package media is temporarily unavailable',
    });
    expect(response?.headers.get('location')).toBeNull();
    expect(fetchCount).toBe(0);
  });

  it('marks Lore package media redirects as non-cacheable', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore media presigning must not make a network request');
    }) as unknown as typeof fetch;
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
                media: {
                  icon: {
                    kind: 'icon',
                    byteSize: 10,
                    contentType: 'image/png',
                    deliveryName: 'song-icon.png',
                    sha256: 'd'.repeat(64),
                    loreDelivery: makeTestLoreArtifactReference('auth-user-1', {
                      sha256: 'd'.repeat(64),
                      byteSize: 10,
                    }),
                  },
                },
              },
            ],
          };
        default:
          return null;
      }
    };

    const loreRoutes = createBackstageRepoRoutes({
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      lore: loreTestConfig,
    });

    const response = await loreRoutes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/media/icon',
        {
          headers: {
            authorization: 'Bearer oauth-token',
          },
        }
      )
    );

    expect(response?.status).toBe(302);
    const mediaLocation = response?.headers.get('location') ?? '';
    expect(mediaLocation).toMatch(
      /^https:\/\/lore\.test\/v1\/presigned\/[0-9a-f]{32}\/[0-9a-f]{64}-[0-9a-f]{32}\?token=/
    );
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(fetchCount).toBe(0);
    expect(decodeLorePresignPayload(mediaLocation)).toMatchObject({
      content_type: 'image/png',
      content_disposition: 'attachment; filename="song-icon.png"',
    });
  });

  it('reports invalid Lore media presign configuration as a temporary delivery outage', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore media presigning must not make a network request');
    }) as unknown as typeof fetch;
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
                media: {
                  icon: {
                    kind: 'icon',
                    byteSize: 10,
                    contentType: 'image/png',
                    deliveryName: 'song-icon.png',
                    sha256: 'd'.repeat(64),
                    loreDelivery: makeTestLoreArtifactReference('auth-user-1', {
                      sha256: 'd'.repeat(64),
                      byteSize: 10,
                    }),
                  },
                },
              },
            ],
          };
        default:
          return null;
      }
    };

    const invalidLoreRoutes = createBackstageRepoRoutes({
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://app.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      lore: { ...loreTestConfig, presignHmacKey: 'invalid-key' },
    });

    const response = await invalidLoreRoutes.handleRequest(
      new Request(
        'https://api.test/api/backstage/access/products/catalog_1/packages/com.yucp.song/media/icon',
        {
          headers: {
            authorization: 'Bearer oauth-token',
          },
        }
      )
    );

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({
      error: 'Package media is temporarily unavailable',
    });
    expect(fetchCount).toBe(0);
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
                service: 'backstage-access',
                scopes: ['creator:delegate'],
                authUserId: 'creator-user-1',
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
        case 'backstageRepos.resolvePackageDownloadForApi':
          throw new Error('Catalog-product install plans must not resolve VPM deliverables.');
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: '',
            deliveryName: 'Song Thing_1.2.3.unitypackage',
            contentType: 'application/octet-stream',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            loreSource: makeTestLoreArtifactReference('creator-user-1'),
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

  it('authorizes alias package downloads through buyer bearer auth and Lore', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore source presigning must not make a network request');
    }) as unknown as typeof fetch;
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
            actor: {
              payload: JSON.stringify({
                service: 'backstage-access',
                scopes: ['creator:delegate'],
                authUserId: 'creator-user-1',
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
        case 'backstageRepos.resolvePackageDownloadForApi':
          throw new Error('Alias package downloads must not resolve VPM deliverables.');
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
            deliveryName: 'Song Thing_1.2.3.unitypackage',
            contentType: 'application/octet-stream',
            packageSha256: 'c'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            loreSource: makeTestLoreArtifactReference('creator-user-1', {
              sha256: 'c'.repeat(64),
              byteSize: 4567,
            }),
          };
        default:
          return null;
      }
    };

    const loreRoutes = createBackstageRepoRoutes({
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
      lore: loreTestConfig,
    });

    const response = await loreRoutes.handleRequest(
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
    const payload = await response?.json();
    expect(payload).toMatchObject({
      packageSha256: 'c'.repeat(64),
      sourceKind: 'unitypackage',
      version: '1.2.3',
      channel: 'stable',
      contentType: 'application/octet-stream',
      deliveryName: 'Song Thing_1.2.3.unitypackage',
    });
    expect(payload.downloadUrl).toMatch(
      /^https:\/\/lore\.test\/v1\/presigned\/[0-9a-f]{32}\/[0-9a-f]{64}-[0-9a-f]{32}\?token=/
    );
    expect(fetchCount).toBe(0);
    expect(decodeLorePresignPayload(payload.downloadUrl)).toMatchObject({
      content_type: 'application/octet-stream',
      content_disposition: 'attachment; filename="Song Thing_1.2.3.unitypackage"',
    });
    const rawPackageResolutionCall = convexQueryCalls.find(
      (call) => call.reference === 'backstageRepos.resolveRawPackageDownloadForApi'
    );
    expect(rawPackageResolutionCall?.actor).toMatchObject({
      payload: JSON.stringify({
        service: 'backstage-access',
        scopes: ['creator:delegate'],
        authUserId: 'creator-user-1',
      }),
      signature: 'test-signature',
    });
    expect(rawPackageResolutionCall?.args).toEqual(
      expect.objectContaining({
        actor: expect.objectContaining({
          payload: JSON.stringify({
            service: 'backstage-access',
            scopes: ['creator:delegate'],
            authUserId: 'creator-user-1',
          }),
          signature: 'test-signature',
        }),
      })
    );
  });

  it('does not fall back to package URLs when Lore source presigning fails', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore source presigning must not make a network request');
    }) as unknown as typeof fetch;
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
        case 'backstageRepos.resolvePackageDownloadForApi':
          throw new Error('Alias package downloads must not resolve VPM deliverables.');
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: 'https://downloads.example/Song%20Thing_1.2.3.unitypackage',
            deliveryName: 'Song Thing_1.2.3.unitypackage',
            contentType: 'application/octet-stream',
            packageSha256: 'c'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            loreSource: makeTestLoreArtifactReference('creator-user-1', {
              address: 'invalid-address',
              sha256: 'c'.repeat(64),
              byteSize: 4567,
            }),
          };
        default:
          return null;
      }
    };

    const loreRoutes = createBackstageRepoRoutes({
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
      lore: loreTestConfig,
    });

    const response = await loreRoutes.handleRequest(
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

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({
      error: 'Package delivery is temporarily unavailable',
    });
    expect(fetchCount).toBe(0);
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

  it('requires a session before redeeming buyer verification grants', async () => {
    actionImpl = async () => {
      throw new Error('Unauthenticated requests must not redeem verification grants.');
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

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({
      error: 'Authentication required',
    });
  });

  it('rejects blank buyer verification redemption fields before redeeming grants', async () => {
    sessionImpl = async () => ({ user: { id: 'auth-user-1' } });
    const actionCalls: unknown[][] = [];
    actionImpl = async (...args: unknown[]) => {
      actionCalls.push(args);
      return { success: true };
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
          machineFingerprint: '   ',
          grantToken: 'grant-token',
        }),
      })
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: 'codeVerifier, machineFingerprint, and grantToken are required',
    });
    expect(actionCalls).toHaveLength(0);
  });

  it('blocks cross-site buyer verification grant redemption before mutating state', async () => {
    sessionImpl = async () => ({ user: { id: 'auth-user-1' } });
    actionImpl = async () => {
      throw new Error('Cross-site requests must not redeem verification grants.');
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/verification-intents/intent_123/redeem', {
        method: 'POST',
        headers: {
          origin: 'https://attacker.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          codeVerifier: 'verifier',
          machineFingerprint: 'buyer-web-machine',
          grantToken: 'grant-token',
        }),
      })
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: 'Cross-site requests are not allowed',
    });
  });

  it('rejects malformed buyer verification grant redemption bodies before mutating state', async () => {
    sessionImpl = async () => ({ user: { id: 'auth-user-1' } });
    actionImpl = async () => {
      throw new Error('Malformed redemption bodies must not reach Convex.');
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/verification-intents/intent_123/redeem', {
        method: 'POST',
        headers: {
          origin: 'https://app.test',
          'content-type': 'application/json',
        },
        body: '{',
      })
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: 'Invalid JSON body',
    });
  });

  it('rejects oversized buyer verification grant redemption bodies before mutating state', async () => {
    sessionImpl = async () => ({ user: { id: 'auth-user-1' } });
    actionImpl = async () => {
      throw new Error('Oversized redemption bodies must not reach Convex.');
    };

    const response = await routes.handleRequest(
      new Request('https://api.test/api/backstage/access/verification-intents/intent_123/redeem', {
        method: 'POST',
        headers: {
          origin: 'https://app.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          codeVerifier: 'v'.repeat(5_000),
          machineFingerprint: 'buyer-web-machine',
          grantToken: 'grant-token',
        }),
      })
    );

    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toEqual({
      error: 'Request body too large',
    });
  });

  it('does not authorize VPM deliverable downloads for alias package installer downloads', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore source presigning must not make a network request');
    }) as unknown as typeof fetch;
    queryImpl = async (ref: unknown, args?: unknown) => {
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
        case 'backstageRepos.resolvePackageDownloadForApi':
          throw new Error('Alias package installer downloads must not resolve VPM deliverables.');
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
            deliveryName: 'Song Thing_1.2.3.unitypackage',
            contentType: 'application/octet-stream',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            loreSource: makeTestLoreArtifactReference('creator-user-1'),
          };
        default:
          return null;
      }
    };

    const loreRoutes = createBackstageRepoRoutes({
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
      lore: loreTestConfig,
    });

    const response = await loreRoutes.handleRequest(
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
    const payload = await response?.json();
    expect(payload).toMatchObject({
      packageSha256: 'b'.repeat(64),
      sourceKind: 'unitypackage',
      contentType: 'application/octet-stream',
      deliveryName: 'Song Thing_1.2.3.unitypackage',
    });
    expect(payload.downloadUrl).toMatch(/^https:\/\/lore\.test\/v1\/presigned\//);
    expect(fetchCount).toBe(0);
  });

  it('keeps stable public product refs in catalog-product alias install plan URLs', async () => {
    const seenQueryRefs: unknown[] = [];
    queryImpl = async (ref: unknown, args?: unknown) => {
      seenQueryRefs.push(ref);
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'packageRegistry.getBuyerAccessContextByCatalogProductId':
          expect(args).toEqual({
            apiSecret: 'convex-secret',
            catalogProductId: 'legacy_catalog_1',
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
            catalogProductId: 'internal_catalog_1',
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
        case 'backstageRepos.resolvePackageDownloadForApi':
          throw new Error('Catalog-product install plans must not resolve VPM deliverables.');
        case 'backstageRepos.resolveRawPackageDownloadForApi':
          return {
            deliveryArtifactId: 'raw_artifact_1',
            downloadUrl: '',
            deliveryName: 'Song Thing_1.2.3.unitypackage',
            contentType: 'application/octet-stream',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            loreSource: makeTestLoreArtifactReference('auth-user-1'),
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
      new Request('https://api.test/api/backstage/access/products/legacy_catalog_1/install-plan', {
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
          downloadAuthorizationUrl:
            'https://api.test/api/backstage/access/products/song-thing/packages/com.yucp.song/download',
          importerDelivery: {
            packageInstallStrategy: 'server-authorized',
            repoCatalogDeliveryMode: 'repo-token-vpm-v1',
            repoCatalogReadOnly: true,
          },
        },
      ],
    });
    expect(seenQueryRefs).toContain('packageRegistry.getBuyerAccessContextByCatalogProductId');
    expect(seenQueryRefs).toContain('backstageRepos.resolveRawPackageDownloadForApi');
    expect(seenQueryRefs).not.toContain('backstageRepos.resolvePackageDownloadForApi');
    for (const pkg of payload.packages) {
      expect(pkg).not.toHaveProperty('aliasContract');
    }
  });

  it('uses the raw package source for alias install package downloads', async () => {
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
        case 'backstageRepos.resolvePackageDownloadForApi':
          throw new Error('Alias install plans must not resolve VPM deliverables.');
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
            downloadUrl: '',
            deliveryName: 'Song Thing_1.2.3.unitypackage',
            contentType: 'application/octet-stream',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            loreSource: makeTestLoreArtifactReference('auth-user-1'),
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

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      kind: 'alias-install-plan-v1',
      packages: [
        {
          packageId: 'com.yucp.song',
          packageSha256: 'b'.repeat(64),
          sourceKind: 'unitypackage',
          downloadAuthorizationUrl:
            'https://api.test/api/backstage/access/products/song-thing/packages/com.yucp.song/download',
        },
      ],
    });
    expect(seenQueryRefs).toContain('backstageRepos.resolveRawPackageDownloadForApi');
    expect(seenQueryRefs).not.toContain('backstageRepos.resolvePackageDownloadForApi');
  });

  it('rejects alias install plans with invalid raw package digests', async () => {
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
            downloadUrl: '',
            deliveryName: 'Song Thing_1.2.3.unitypackage',
            contentType: 'application/octet-stream',
            packageSha256: 'not-a-sha256-digest',
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            loreSource: makeTestLoreArtifactReference('auth-user-1'),
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

  it('authorizes alias package installer downloads from the raw Lore source', async () => {
    const seenQueryRefs: unknown[] = [];
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('Lore source presigning must not make a network request');
    }) as unknown as typeof fetch;
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
        case 'backstageRepos.resolvePackageDownloadForApi':
          throw new Error('Alias package source downloads must not resolve VPM deliverables.');
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
            downloadUrl: '',
            deliveryName: 'Song Thing_1.2.3.unitypackage',
            contentType: 'application/octet-stream',
            packageSha256: 'b'.repeat(64),
            sourceKind: 'unitypackage',
            version: '1.2.3',
            channel: 'stable',
            loreSource: makeTestLoreArtifactReference('auth-user-1'),
          };
        default:
          return null;
      }
    };

    const loreRoutes = createBackstageRepoRoutes({
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
      lore: loreTestConfig,
    });

    const response = await loreRoutes.handleRequest(
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
    const payload = await response?.json();
    expect(payload).toMatchObject({
      packageSha256: 'b'.repeat(64),
      sourceKind: 'unitypackage',
      version: '1.2.3',
      channel: 'stable',
      contentType: 'application/octet-stream',
      deliveryName: 'Song Thing_1.2.3.unitypackage',
    });
    expect(payload.downloadUrl).toMatch(
      /^https:\/\/lore\.test\/v1\/presigned\/[0-9a-f]{32}\/[0-9a-f]{64}-[0-9a-f]{32}\?token=/
    );
    expect(seenQueryRefs).toContain('backstageRepos.resolveRawPackageDownloadForApi');
    expect(seenQueryRefs).not.toContain('backstageRepos.resolvePackageDownloadForApi');
    expect(fetchCount).toBe(0);
  });

  it('rejects malformed alias package download bodies as client errors', async () => {
    queryImpl = async () => {
      throw new Error('Malformed package download bodies should not reach Convex');
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
      throw new Error('Oversized package download bodies should not reach Convex');
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
