import { beforeEach, describe, expect, it, mock } from 'bun:test';

let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let actionImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let listProviderProductsViaApiImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  products: [],
});
let listProviderTiersViaApiImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  tiers: [],
});
let lastActionArgs: unknown;

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    authViewer: {
      getViewerByAuthUser: 'authViewer.getViewerByAuthUser',
    },
    catalogTiers: {
      upsertCatalogTier: 'catalogTiers.upsertCatalogTier',
    },
    backstageRepos: {
      getSubjectByAuthUserForApi: 'backstageRepos.getSubjectByAuthUserForApi',
      issueRepoTokenForApi: 'backstageRepos.issueRepoTokenForApi',
      generateReleaseUploadUrlForAuthUser: 'backstageRepos.generateReleaseUploadUrlForAuthUser',
      publishUploadedReleaseForAuthUser: 'backstageRepos.publishUploadedReleaseForAuthUser',
    },
    creatorProfiles: {
      getCreatorByAuthUser: 'creatorProfiles.getCreatorByAuthUser',
    },
    packageRegistry: {
      listByAuthUser: 'packageRegistry.listByAuthUser',
      listForAuthUser: 'packageRegistry.listForAuthUser',
      renameForAuthUser: 'packageRegistry.renameForAuthUser',
      archiveForAuthUser: 'packageRegistry.archiveForAuthUser',
      restoreForAuthUser: 'packageRegistry.restoreForAuthUser',
      deleteForAuthUser: 'packageRegistry.deleteForAuthUser',
      archiveProductForAuthUser: 'packageRegistry.archiveProductForAuthUser',
      restoreProductForAuthUser: 'packageRegistry.restoreProductForAuthUser',
      deleteProductForAuthUser: 'packageRegistry.deleteProductForAuthUser',
      archiveReleaseForAuthUser: 'packageRegistry.archiveReleaseForAuthUser',
    },
    providerConnections: {
      getConnectionStatus: 'providerConnections.getConnectionStatus',
    },
    role_rules: {
      addCatalogProduct: 'role_rules.addCatalogProduct',
    },
  },
  internal: {},
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: (...args: unknown[]) => mutationImpl(...args),
    action: (...args: unknown[]) => actionImpl(...args),
  }),
}));

mock.module('../lib/oauthAccessToken', () => ({
  verifyBetterAuthAccessToken: async () => ({
    ok: true,
    token: { sub: 'auth-user-1' },
  }),
}));

mock.module('../lib/apiActor', () => ({
  createAuthUserActorBinding: async () => 'actor-binding',
}));

mock.module('../internalRpc/router', () => ({
  listProviderProductsViaApi: (...args: unknown[]) => listProviderProductsViaApiImpl(...args),
  listProviderTiersViaApi: (...args: unknown[]) => listProviderTiersViaApiImpl(...args),
}));

const { createPackageRoutes } = await import('./packages');

describe('package Backstage publishing routes', () => {
  const routes = createPackageRoutes(
    {
      getSession: async () => null,
    } as never,
    {
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://creators.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
    }
  );

  beforeEach(() => {
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
        case 'providerConnections.getConnectionStatus':
          return {};
        case 'packageRegistry.listByAuthUser':
          return {
            data: [
              {
                _id: 'product_1',
                aliases: ['Backstage Bundle'],
                productId: 'gumroad-product-1',
                provider: 'gumroad',
                providerProductRef: 'gumroad-product-1',
                displayName: 'Backstage Bundle',
                thumbnailUrl: 'https://public-files.gumroad.com/backstage-bundle.png',
                canonicalSlug: 'backstage-bundle',
                status: 'active',
                supportsAutoDiscovery: true,
                updatedAt: 1_710_000_000_000,
                canArchive: true,
                canDelete: false,
                canRestore: false,
                deleteBlockedReason: 'Product has package history.',
                catalogTiers: [
                  {
                    _id: 'tier_gold',
                    catalogProductId: 'product_1',
                    provider: 'gumroad',
                    providerTierRef: 'gumroad-tier-gold',
                    displayName: 'Gold Monthly',
                    description: 'Monthly supporter tier',
                    amountCents: 1200,
                    currency: 'USD',
                    status: 'active',
                    createdAt: 1_710_000_000_000,
                    updatedAt: 1_710_000_000_000,
                  },
                ],
                backstagePackages: [
                  {
                    packageId: 'com.yucp.example',
                    packageName: 'Example Package',
                    displayName: 'Example Package',
                    status: 'active',
                    repositoryVisibility: 'listed',
                    defaultChannel: 'stable',
                    latestPublishedVersion: '1.2.3',
                    latestRelease: {
                      deliveryPackageReleaseId: 'release_current',
                      version: '1.2.3',
                      channel: 'stable',
                      releaseStatus: 'published',
                      repositoryVisibility: 'listed',
                      artifactKey: 'artifact:example',
                      contentType: 'application/zip',
                      createdAt: 1_709_999_900_000,
                      deliveryName: 'example-package-1.2.3.zip',
                      metadata: { source: 'unitypackage' },
                      publishedAt: 1_710_000_000_000,
                      unityVersion: '2022.3',
                      updatedAt: 1_710_000_000_000,
                      zipSha256: 'a'.repeat(64),
                    },
                    releases: [
                      {
                        deliveryPackageReleaseId: 'release_current',
                        version: '1.2.3',
                        channel: 'stable',
                        releaseStatus: 'published',
                        repositoryVisibility: 'listed',
                        artifactKey: 'artifact:example',
                        contentType: 'application/zip',
                        createdAt: 1_709_999_900_000,
                        deliveryName: 'example-package-1.2.3.zip',
                        metadata: { source: 'unitypackage' },
                        publishedAt: 1_710_000_000_000,
                        unityVersion: '2022.3',
                        updatedAt: 1_710_000_000_000,
                        zipSha256: 'a'.repeat(64),
                      },
                      {
                        deliveryPackageReleaseId: 'release_old',
                        version: '1.2.2',
                        channel: 'stable',
                        releaseStatus: 'superseded',
                        repositoryVisibility: 'hidden',
                        artifactKey: 'artifact:example-older',
                        contentType: 'application/zip',
                        createdAt: 1_709_000_000_000,
                        deliveryName: 'example-package-1.2.2.zip',
                        metadata: { source: 'zip' },
                        publishedAt: 1_709_000_500_000,
                        unityVersion: '2022.3',
                        updatedAt: 1_709_001_000_000,
                        zipSha256: 'b'.repeat(64),
                      },
                    ],
                  },
                ],
              },
            ],
            hasMore: false,
            nextCursor: null,
          };
        default:
          return [];
      }
    };
    lastActionArgs = undefined;
    listProviderProductsViaApiImpl = async () => ({ products: [] });
    mutationImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.issueRepoTokenForApi':
          return {
            tokenId: 'repo_token_1',
            token: 'ybt_example',
            expiresAt: 1_710_000_000_000,
          };
        case 'backstageRepos.generateReleaseUploadUrlForAuthUser':
          return 'https://upload.test/backstage';
        case 'packageRegistry.archiveProductForAuthUser':
          return { archived: true, catalogProductId: 'product_1' };
        case 'packageRegistry.archiveReleaseForAuthUser':
          return { archived: true, deliveryPackageReleaseId: 'release_old' };
        case 'packageRegistry.deleteProductForAuthUser':
          return { deleted: true, catalogProductId: 'product_2' };
        default:
          return null;
      }
    };
    actionImpl = async (ref: unknown, args: unknown) => {
      lastActionArgs = args;
      switch (ref) {
        case 'backstageRepos.publishUploadedReleaseForAuthUser':
          return {
            deliveryPackageReleaseId: 'release_1',
            artifactId: 'artifact_1',
            artifactKey: 'backstage-package:com.yucp.example',
            zipSha256: 'a'.repeat(64),
            version: '1.2.3',
            channel: 'stable',
          };
        default:
          return null;
      }
    };
  });

  it('creates upload URLs for Backstage package release uploads', async () => {
    const response = await routes.createBackstageReleaseUploadUrl(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-url', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      packageId: 'com.yucp.example',
      uploadUrl: 'https://upload.test/backstage',
    });
  });

  it('issues creator repo access links from the authenticated package workspace', async () => {
    const response = await routes.getBackstageRepoAccess(
      new Request('https://api.test/api/packages/backstage/repo-access', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      repositoryUrl: 'https://api.test/v1/backstage/repos/mapache/index.json',
      repositoryName: 'Mapache repo',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fmapache%2Findex.json&headers%5B%5D=X-YUCP-Repo-Token%3Aybt_example',
      repoTokenHeader: 'X-YUCP-Repo-Token',
      repoToken: 'ybt_example',
      expiresAt: 1_710_000_000_000,
    });
  });

  it('falls back to generic repo labeling for synthetic creator names', async () => {
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
        case 'packageRegistry.listByAuthUser':
          return {
            data: [],
            hasMore: false,
            nextCursor: null,
          };
        default:
          return [];
      }
    };

    const response = await routes.getBackstageRepoAccess(
      new Request('https://api.test/api/packages/backstage/repo-access', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      creatorName: 'Actual Discord Name',
      creatorRepoRef: 'auth-user-1',
      repositoryUrl: 'https://api.test/v1/backstage/repos/auth-user-1/index.json',
      repositoryName: 'Actual Discord Name repo',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fauth-user-1%2Findex.json&headers%5B%5D=X-YUCP-Repo-Token%3Aybt_example',
      repoTokenHeader: 'X-YUCP-Repo-Token',
      repoToken: 'ybt_example',
      expiresAt: 1_710_000_000_000,
    });
  });

  it('lists creator product links for the Backstage release picker', async () => {
    const response = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      products: [
        {
          aliases: ['Backstage Bundle'],
          catalogTiers: [
            {
              catalogTierId: 'tier_gold',
              catalogProductId: 'product_1',
              provider: 'gumroad',
              providerTierRef: 'gumroad-tier-gold',
              displayName: 'Gold Monthly',
              description: 'Monthly supporter tier',
              amountCents: 1200,
              currency: 'USD',
              status: 'active',
              createdAt: 1_710_000_000_000,
              updatedAt: 1_710_000_000_000,
            },
          ],
          backstagePackages: [
            {
              packageId: 'com.yucp.example',
              packageName: 'Example Package',
              displayName: 'Example Package',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '1.2.3',
              latestRelease: {
                deliveryPackageReleaseId: 'release_current',
                version: '1.2.3',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:example',
                contentType: 'application/zip',
                createdAt: 1_709_999_900_000,
                deliveryName: 'example-package-1.2.3.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_000_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_000_000,
                zipSha256: 'a'.repeat(64),
              },
              releases: [
                {
                  deliveryPackageReleaseId: 'release_current',
                  version: '1.2.3',
                  channel: 'stable',
                  releaseStatus: 'published',
                  repositoryVisibility: 'listed',
                  artifactKey: 'artifact:example',
                  contentType: 'application/zip',
                  createdAt: 1_709_999_900_000,
                  deliveryName: 'example-package-1.2.3.zip',
                  metadata: { source: 'unitypackage' },
                  publishedAt: 1_710_000_000_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_710_000_000_000,
                  zipSha256: 'a'.repeat(64),
                },
                {
                  deliveryPackageReleaseId: 'release_old',
                  version: '1.2.2',
                  channel: 'stable',
                  releaseStatus: 'superseded',
                  repositoryVisibility: 'hidden',
                  artifactKey: 'artifact:example-older',
                  contentType: 'application/zip',
                  createdAt: 1_709_000_000_000,
                  deliveryName: 'example-package-1.2.2.zip',
                  metadata: { source: 'zip' },
                  publishedAt: 1_709_000_500_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_709_001_000_000,
                  zipSha256: 'b'.repeat(64),
                },
              ],
            },
          ],
          canArchive: true,
          canDelete: false,
          canRestore: false,
          canonicalSlug: 'backstage-bundle',
          catalogProductId: 'product_1',
          displayName: 'Backstage Bundle',
          thumbnailUrl: 'https://public-files.gumroad.com/backstage-bundle.png',
          productId: 'gumroad-product-1',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_000_000,
          deleteBlockedReason: 'Product has package history.',
        },
      ],
    });
  });

  it('syncs provider tiers into the Backstage picker and strips Patreon HTML descriptions', async () => {
    let syncedTiers = [
      {
        _id: 'tier_existing',
        catalogProductId: 'product_1',
        provider: 'patreon',
        providerTierRef: 'tier_existing',
        displayName: 'Existing Tier',
        description: '<p>Legacy <strong>HTML</strong></p>',
        amountCents: 500,
        currency: 'USD',
        status: 'active',
        createdAt: 1_710_000_000_000,
        updatedAt: 1_710_000_000_000,
      },
    ];
    const tierUpserts: Array<Record<string, unknown>> = [];

    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'providerConnections.getConnectionStatus':
          return { patreon: true };
        case 'packageRegistry.listByAuthUser':
          return {
            data: [
              {
                _id: 'product_1',
                aliases: ['Membership Bundle'],
                productId: 'patreon-campaign-1',
                provider: 'patreon',
                providerProductRef: 'patreon-campaign-1',
                displayName: 'Membership Bundle',
                canonicalSlug: 'membership-bundle',
                status: 'active',
                supportsAutoDiscovery: true,
                updatedAt: 1_710_000_000_000,
                canArchive: true,
                canDelete: true,
                canRestore: false,
                catalogTiers: syncedTiers,
                backstagePackages: [],
              },
            ],
          };
        default:
          return null;
      }
    };

    mutationImpl = async (ref: unknown, args: unknown) => {
      switch (ref) {
        case 'catalogTiers.upsertCatalogTier': {
          const payload = args as {
            providerTierRef: string;
            displayName: string;
            description?: string;
            amountCents?: number;
            currency?: string;
            status?: 'active' | 'archived';
          };
          tierUpserts.push(payload as Record<string, unknown>);
          syncedTiers = [
            ...syncedTiers.filter((tier) => tier.providerTierRef !== payload.providerTierRef),
            {
              _id: payload.providerTierRef,
              catalogProductId: 'product_1',
              provider: 'patreon',
              providerTierRef: payload.providerTierRef,
              displayName: payload.displayName,
              description: payload.description,
              amountCents: payload.amountCents,
              currency: payload.currency,
              status: payload.status ?? 'active',
              createdAt: 1_710_000_000_000,
              updatedAt: 1_710_000_000_100,
            },
          ];
          return payload.providerTierRef;
        }
        default:
          return null;
      }
    };

    listProviderProductsViaApiImpl = async () => ({ products: [] });
    listProviderTiersViaApiImpl = async () => ({
      tiers: [
        {
          id: 'tier_existing',
          productId: 'patreon-campaign-1',
          name: 'Existing Tier',
          description: '<p>Legacy <strong>HTML</strong></p>',
          amountCents: 500,
          currency: 'USD',
          active: true,
        },
        {
          id: 'tier_gold',
          productId: 'patreon-campaign-1',
          name: 'Gold Monthly',
          description: '<div><p>Includes <strong>Discord</strong> role</p></div>',
          amountCents: 1200,
          currency: 'USD',
          active: true,
        },
      ],
    });

    const response = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(tierUpserts).toHaveLength(2);
    await expect(response.json()).resolves.toMatchObject({
      products: [
        {
          catalogProductId: 'product_1',
          provider: 'patreon',
          catalogTiers: [
            {
              catalogTierId: 'tier_existing',
              displayName: 'Existing Tier',
              description: 'Legacy HTML',
            },
            {
              catalogTierId: 'tier_gold',
              displayName: 'Gold Monthly',
              description: 'Includes Discord role',
            },
          ],
        },
      ],
    });
  });

  it('syncs connected provider products into the Backstage picker before listing products', async () => {
    let syncedCatalog = false;
    const catalogUpserts: Array<Record<string, unknown>> = [];

    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'providerConnections.getConnectionStatus':
          return {
            gumroad: true,
            jinxxy: true,
            patreon: false,
          };
        case 'packageRegistry.listByAuthUser':
          return {
            data: syncedCatalog
              ? [
                  {
                    _id: 'product_song_gumroad',
                    aliases: [],
                    productId: 'QAJc7ErxdAC815P5P8R89g==',
                    provider: 'gumroad',
                    providerProductRef: 'QAJc7ErxdAC815P5P8R89g==',
                    displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
                    canonicalSlug: 'song-thing',
                    status: 'active',
                    supportsAutoDiscovery: true,
                    updatedAt: 1_710_000_000_000,
                    canArchive: true,
                    canDelete: true,
                    canRestore: false,
                    backstagePackages: [],
                  },
                  {
                    _id: 'product_song_jinxxy',
                    aliases: [],
                    productId: '3788600424102102387',
                    provider: 'jinxxy',
                    providerProductRef: '3788600424102102387',
                    displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
                    canonicalSlug: 'song-thing',
                    status: 'active',
                    supportsAutoDiscovery: false,
                    updatedAt: 1_710_000_000_001,
                    canArchive: true,
                    canDelete: true,
                    canRestore: false,
                    backstagePackages: [],
                  },
                ]
              : [
                  {
                    _id: 'product_song_gumroad',
                    aliases: [],
                    productId: 'QAJc7ErxdAC815P5P8R89g==',
                    provider: 'gumroad',
                    providerProductRef: 'QAJc7ErxdAC815P5P8R89g==',
                    displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
                    canonicalSlug: 'song-thing',
                    status: 'active',
                    supportsAutoDiscovery: true,
                    updatedAt: 1_710_000_000_000,
                    canArchive: true,
                    canDelete: true,
                    canRestore: false,
                    backstagePackages: [],
                  },
                ],
            hasMore: false,
            nextCursor: null,
          };
        default:
          return [];
      }
    };

    listProviderProductsViaApiImpl = async (_config: unknown, request: unknown) => {
      const provider = (request as { provider?: string }).provider;
      if (provider === 'gumroad') {
        return {
          products: [
            {
              id: 'QAJc7ErxdAC815P5P8R89g==',
              name: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
              productUrl: 'https://yeusepe.gumroad.com/l/songthing',
              thumbnailUrl: 'https://public-files.gumroad.com/song-thing.png',
            },
          ],
        };
      }
      if (provider === 'jinxxy') {
        return {
          products: [
            {
              id: '3788600424102102387',
              name: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
            },
          ],
        };
      }
      return { products: [] };
    };

    mutationImpl = async (ref: unknown, args: unknown) => {
      if (ref === 'role_rules.addCatalogProduct') {
        catalogUpserts.push(args as Record<string, unknown>);
        syncedCatalog = true;
        return {
          productId: (args as { productId: string }).productId,
          catalogProductId:
            (args as { provider: string }).provider === 'gumroad'
              ? 'product_song_gumroad'
              : 'product_song_jinxxy',
        };
      }
      return null;
    };

    const response = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(catalogUpserts).toHaveLength(1);
    expect(catalogUpserts).toEqual([
      {
        apiSecret: 'convex-secret',
        authUserId: 'auth-user-1',
        productId: '3788600424102102387',
        providerProductRef: '3788600424102102387',
        provider: 'jinxxy',
        canonicalUrl: 'https://jinxxy.app/products/3788600424102102387',
        supportsAutoDiscovery: false,
        displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
      },
    ]);
    await expect(response.json()).resolves.toEqual({
      products: [
        {
          aliases: [],
          backstagePackages: [],
          canArchive: true,
          canDelete: true,
          canRestore: false,
          canonicalSlug: 'song-thing',
          catalogProductId: 'product_song_gumroad',
          catalogTiers: [],
          displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
          thumbnailUrl: 'https://public-files.gumroad.com/song-thing.png',
          productId: 'QAJc7ErxdAC815P5P8R89g==',
          provider: 'gumroad',
          providerProductRef: 'QAJc7ErxdAC815P5P8R89g==',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_000_000,
        },
        {
          aliases: [],
          backstagePackages: [],
          canArchive: true,
          canDelete: true,
          canRestore: false,
          canonicalSlug: 'song-thing',
          catalogProductId: 'product_song_jinxxy',
          catalogTiers: [],
          displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
          productId: '3788600424102102387',
          provider: 'jinxxy',
          providerProductRef: '3788600424102102387',
          status: 'active',
          supportsAutoDiscovery: false,
          updatedAt: 1_710_000_000_001,
        },
      ],
    });
  });

  it('hides and deletes Backstage product links through catalog product mutations', async () => {
    const archiveResponse = await routes.archiveBackstageProduct(
      new Request('https://api.test/api/packages/backstage/products/product_1/archive', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'product_1'
    );
    expect(archiveResponse.status).toBe(200);
    await expect(archiveResponse.json()).resolves.toEqual({
      archived: true,
      catalogProductId: 'product_1',
    });

    const deleteResponse = await routes.deleteBackstageProduct(
      new Request('https://api.test/api/packages/backstage/products/product_2', {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'product_2'
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      deleted: true,
      catalogProductId: 'product_2',
    });
  });

  it('archives old Backstage package releases through release mutations', async () => {
    const response = await routes.archiveBackstageRelease(
      new Request(
        'https://api.test/api/packages/com.yucp.example/backstage/releases/release_old/archive',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
          },
        }
      ),
      'com.yucp.example',
      'release_old'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archived: true,
      deliveryPackageReleaseId: 'release_old',
    });
  });

  it('publishes uploaded Backstage releases for the authenticated creator', async () => {
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1', 'product_2'],
          storageId: 'storage_1',
          version: '1.2.3',
          channel: 'stable',
          zipSha256: 'd'.repeat(64),
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(201);
    expect(lastActionArgs).toMatchObject({
      accessSelectors: [
        { kind: 'catalogProduct', catalogProductId: 'product_1' },
        { kind: 'catalogProduct', catalogProductId: 'product_2' },
      ],
      zipSha256: 'd'.repeat(64),
    });
    await expect(response.json()).resolves.toMatchObject({
      deliveryPackageReleaseId: 'release_1',
      artifactId: 'artifact_1',
      version: '1.2.3',
      channel: 'stable',
    });
  });

  it('publishes wrapped VPM ZIP metadata for unitypackage sources', async () => {
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          storageId: 'storage_1',
          version: '4.0.0',
          zipSha256: 'e'.repeat(64),
          deliveryName: 'com.yucp.example-4.0.0.zip',
          contentType: 'application/zip',
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(201);
    expect(lastActionArgs).toMatchObject({
      deliveryName: 'com.yucp.example-4.0.0.zip',
      contentType: 'application/zip',
      zipSha256: 'e'.repeat(64),
    });
  });

  it('publishes uploaded Backstage releases with selector-based access rules', async () => {
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accessSelectors: [
            { kind: 'catalogProduct', catalogProductId: 'product_1' },
            { kind: 'catalogTier', catalogTierId: 'tier_1' },
          ],
          storageId: 'storage_1',
          version: '5.0.0',
          zipSha256: 'f'.repeat(64),
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(201);
    expect(lastActionArgs).toMatchObject({
      accessSelectors: [
        { kind: 'catalogProduct', catalogProductId: 'product_1' },
        { kind: 'catalogTier', catalogTierId: 'tier_1' },
      ],
      zipSha256: 'f'.repeat(64),
    });
  });
});
