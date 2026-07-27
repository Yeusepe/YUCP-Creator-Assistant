import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);

const apiMock = {
  packageEditions: {
    resolveBuyerEdition: 'packageEditions.resolveBuyerEdition',
  },
  packageRegistry: {
    getBuyerAccessContextByPackageId: 'packageRegistry.getBuyerAccessContextByPackageId',
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

mock.module('./apiActor', () => ({
  createApiServiceActorBinding: async () => 'package-install-service-actor',
  createAuthUserActorBinding: async () => 'creator-session-actor',
}));

mock.module('./convex', () => ({
  getConvexClientFromUrl: () => ({
    query: convexQueryMock,
  }),
}));

const { createConvexPackageInstallAccess } = await import('./packageInstallAccess');

describe('package install access', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    convexQueryMock.mockReset();
  });

  it('resolves a stale alias by package identity and returns only current storefronts', async () => {
    convexQueryMock.mockResolvedValue({
      aliasId: 'com.yucp.jammr',
      catalogProductIds: ['catalog-jammr-jinxxy'],
      creatorAuthUserId: 'creator-jammr',
      packageId: 'com.yucp.jammr',
      storefronts: [
        {
          catalogProductId: 'catalog-jammr-jinxxy',
          productId: 'jinxxy-jammr',
        },
      ],
    });
    const access = createConvexPackageInstallAccess({
      convexApiSecret: 'test-convex-secret',
      convexUrl: 'https://convex.example.test',
      publicationAuthority: {
        async resolveReadyVersion() {
          return null;
        },
      },
    });

    const group = await access.resolveProductGroup('com.yucp.jammr');

    expect(convexQueryMock).toHaveBeenCalledWith(
      apiMock.packageRegistry.getBuyerAccessContextByPackageId,
      {
        apiSecret: 'test-convex-secret',
        actor: 'package-install-service-actor',
        packageId: 'com.yucp.jammr',
      }
    );
    expect(group).toEqual({
      aliasId: 'com.yucp.jammr',
      catalogProductIds: ['catalog-jammr-jinxxy'],
      creatorId: 'creator-jammr',
      packageId: 'com.yucp.jammr',
      storefronts: [
        {
          catalogProductId: 'catalog-jammr-jinxxy',
          productId: 'jinxxy-jammr',
        },
      ],
    });
  });

  it('uses the current PostgreSQL version for an immutable Convex release projection', async () => {
    convexQueryMock.mockResolvedValue({
      activeContentDigest: '11'.repeat(32),
      activePolicyVersion: 'policy-v1',
      bindingRoot: '22'.repeat(32),
      commonRoot: '33'.repeat(32),
      logicalBytes: 1024,
      logicalFiles: 2,
      manifestSha256: '44'.repeat(32),
      packageId: 'com.yucp.jammr',
      protectedFiles: [],
      protectedSourceRoot: '55'.repeat(32),
      protectionPolicyDigest: '66'.repeat(32),
      protectionPolicyId: 'protect-v1',
      releaseRoot: '77'.repeat(32),
      version: '2.1.11',
      versionId: 'stale-convex-version-id',
    });
    const access = createConvexPackageInstallAccess({
      convexApiSecret: 'test-convex-secret',
      convexUrl: 'https://convex.example.test',
      publicationAuthority: {
        async resolveReadyVersion() {
          return {
            activeContentDigest: '11'.repeat(32),
            activePolicyVersion: 'policy-v1',
            bindingRoot: '22'.repeat(32),
            commonRoot: '33'.repeat(32),
            id: 'current-postgres-version-id',
            logicalBytes: 1024,
            logicalFiles: 2,
            manifestSha256: '44'.repeat(32),
            protectedFiles: [],
            protectedSourceRoot: '55'.repeat(32),
            protectionPolicyDigest: '66'.repeat(32),
            protectionPolicyId: 'protect-v1',
            releaseRoot: '77'.repeat(32),
            version: '2.1.11',
          };
        },
      },
    });

    const publication = await access.resolvePublication(
      {
        aliasId: 'com.yucp.jammr',
        catalogProductIds: ['catalog-jammr'],
        creatorId: 'creator-jammr',
        packageId: 'com.yucp.jammr',
        storefronts: [],
      },
      'standard',
      undefined
    );

    expect(publication?.versionId).toBe('current-postgres-version-id');
  });
});
