import { beforeEach, describe, expect, it, mock } from 'bun:test';

let sessionImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;

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
    creatorProfiles: {
      getCreatorByAuthUser: 'creatorProfiles.getCreatorByAuthUser',
    },
  },
  internal: {},
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: (...args: unknown[]) => mutationImpl(...args),
  }),
}));

mock.module('../lib/oauthAccessToken', () => ({
  verifyBetterAuthAccessToken: async () => ({
    ok: true,
    token: { sub: 'auth-user-1' },
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
        default:
          return null;
      }
    };
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
      repoToken: 'ybt_example',
      repoTokenHeader: 'X-YUCP-Repo-Token',
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
      repoToken: 'ybt_example',
      repoTokenHeader: 'X-YUCP-Repo-Token',
    });
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
});
