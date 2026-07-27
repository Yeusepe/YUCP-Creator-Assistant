import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const convexMutationMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const deleteVersionMock = mock(async (_input?: unknown) => ({
  deletedAt: '2026-07-25T12:00:00.000Z',
  state: 'DELETED' as const,
  versionId: 'version-1',
}));
const getVersionStatusMock = mock(async (_input?: unknown) => ({
  editionId: 'standard',
  errorCategory: null,
  errorCode: null,
  estimatedStartAt: null,
  packageId: 'com.creator.avatar',
  queuePosition: null,
  state: 'preparing' as const,
  updatedAt: '2026-07-26T12:00:00.000Z',
  version: '2.5.0',
  versionId: 'version-processing',
}));
const listVersionsMock = mock(async (_input?: unknown) => ({
  data: [
    {
      createdAt: '2026-07-26T12:00:00.000Z',
      editionId: 'commercial',
      packageId: 'com.creator.avatar',
      releaseRoot: '11'.repeat(32),
      state: 'ready' as const,
      updatedAt: '2026-07-26T12:01:00.000Z',
      version: 'Summer release',
      versionId: 'version-205',
    },
  ],
  hasMore: true,
  nextCursor: 'next_page_cursor',
}));
const createAuthUserActorBindingMock = mock(
  async (_input?: unknown) => 'creator-actor-binding' as const
);

const apiMock = {
  packageEditions: {
    archiveForCreator: 'packageEditions.archiveForCreator',
    getManagementScopeForCreator: 'packageEditions.getManagementScopeForCreator',
    upsertForCreator: 'packageEditions.upsertForCreator',
  },
  packageRegistry: {
    bindCatalogProductForCreator: 'packageRegistry.bindCatalogProductForCreator',
    getByIdForAuthUser: 'packageRegistry.getByIdForAuthUser',
    listByAuthUser: 'packageRegistry.listByAuthUser',
    unbindCatalogProductForCreator: 'packageRegistry.unbindCatalogProductForCreator',
  },
} as const;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: {},
}));

mock.module('../lib/apiActor', () => ({
  createApiServiceActorBinding: async () => 'service-actor-binding',
  createAuthUserActorBinding: createAuthUserActorBindingMock,
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    mutation: convexMutationMock,
    query: convexQueryMock,
  }),
}));

const { createCreatorPackageRoutes } = await import('./creatorPackages');

const config = {
  apiBaseUrl: 'http://localhost:3001',
  frontendBaseUrl: 'http://localhost:3000',
  convexApiSecret: 'test-convex-api-secret',
  convexUrl: 'http://localhost:3210',
};

function createRoutes(userId: string | null) {
  return createCreatorPackageRoutes({
    auth: {
      getSession: async () =>
        userId
          ? {
              user: { id: userId },
            }
          : null,
    } as never,
    catalogControl: {
      deleteVersion: deleteVersionMock,
      getVersionStatus: getVersionStatusMock,
      listVersions: listVersionsMock,
    },
    config,
  });
}

function listRequest(search = 'limit=100'): Request {
  return new Request(`http://localhost:3001/api/creator/packages?${search}`, {
    headers: { Origin: 'http://localhost:3000' },
  });
}

describe('creator packages session routes', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    convexMutationMock.mockReset();
    convexQueryMock.mockReset();
    deleteVersionMock.mockClear();
    getVersionStatusMock.mockClear();
    listVersionsMock.mockClear();
    createAuthUserActorBindingMock.mockClear();
  });

  it('lists one authoritative creator package edition version page', async () => {
    convexQueryMock.mockResolvedValue({
      displayName: 'Commercial',
      editionId: 'commercial',
      packageId: 'com.creator.avatar',
      status: 'active',
    });
    const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';

    const response = await createRoutes('creator-123').listVersions(
      new Request(
        'http://localhost:3001/api/creator/packages/by-package/com.creator.avatar/editions/commercial/versions?limit=50&cursor=current_page_cursor',
        {
          headers: { Origin: 'http://localhost:3000', traceparent },
        }
      ),
      'com.creator.avatar',
      'commercial'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      data: [
        {
          createdAt: '2026-07-26T12:00:00.000Z',
          editionId: 'commercial',
          packageId: 'com.creator.avatar',
          releaseRoot: '11'.repeat(32),
          state: 'ready',
          updatedAt: '2026-07-26T12:01:00.000Z',
          version: 'Summer release',
          versionId: 'version-205',
        },
      ],
      hasMore: true,
      nextCursor: 'next_page_cursor',
    });
    expect(convexQueryMock).toHaveBeenCalledWith(
      apiMock.packageEditions.getManagementScopeForCreator,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'creator-123',
        editionId: 'commercial',
        packageId: 'com.creator.avatar',
      }
    );
    expect(listVersionsMock).toHaveBeenCalledWith({
      cursor: 'current_page_cursor',
      editionId: 'commercial',
      limit: 50,
      packageId: 'com.creator.avatar',
      traceparent,
    });
  });

  it('rejects unknown or duplicate creator version page parameters', async () => {
    const routes = createRoutes('creator-123');
    for (const search of ['limit=50&limit=10', 'limit=50&provider=jinxxy']) {
      const response = await routes.listVersions(
        new Request(
          `http://localhost:3001/api/creator/packages/by-package/com.creator.avatar/editions/commercial/versions?${search}`,
          { headers: { Origin: 'http://localhost:3000' } }
        ),
        'com.creator.avatar',
        'commercial'
      );
      expect(response.status).toBe(400);
    }
    const invalidEditionResponse = await routes.listVersions(
      new Request(
        'http://localhost:3001/api/creator/packages/by-package/com.creator.avatar/editions/Commercial%20Plus/versions?limit=50',
        { headers: { Origin: 'http://localhost:3000' } }
      ),
      'com.creator.avatar',
      'Commercial Plus'
    );
    expect(invalidEditionResponse.status).toBe(400);
    expect(convexQueryMock).not.toHaveBeenCalled();
    expect(listVersionsMock).not.toHaveBeenCalled();
  });

  it('links an owned storefront to the open package without an upload', async () => {
    convexQueryMock.mockResolvedValue({
      _id: 'catalog_product_anchor',
      catalogProductIds: ['catalog_product_anchor'],
      catalogTiers: [],
      packageId: 'com.creator.avatar',
    });
    convexMutationMock.mockResolvedValue({
      bound: true,
      catalogProductId: 'catalog_product_jinxxy',
      created: true,
      packageId: 'com.creator.avatar',
    });

    const response = await createRoutes('creator-123').manageStorefrontBinding(
      new Request(
        'http://localhost:3001/api/creator/packages/catalog_product_anchor/storefronts/catalog_product_jinxxy',
        {
          headers: { Origin: 'http://localhost:3000' },
          method: 'PUT',
        }
      ),
      'catalog_product_anchor',
      'catalog_product_jinxxy'
    );

    expect(response.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.packageRegistry.bindCatalogProductForCreator,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'creator-123',
        catalogProductId: 'catalog_product_jinxxy',
        packageId: 'com.creator.avatar',
      }
    );
  });

  it('unlinks a storefront from the open package after creator confirmation', async () => {
    convexQueryMock.mockResolvedValue({
      _id: 'catalog_product_anchor',
      catalogProductIds: ['catalog_product_anchor', 'catalog_product_jinxxy'],
      catalogTiers: [],
      packageId: 'com.creator.avatar',
    });
    convexMutationMock.mockResolvedValue({ unbound: true });

    const response = await createRoutes('creator-123').manageStorefrontBinding(
      new Request(
        'http://localhost:3001/api/creator/packages/catalog_product_anchor/storefronts/catalog_product_jinxxy',
        {
          headers: { Origin: 'http://localhost:3000' },
          method: 'DELETE',
        }
      ),
      'catalog_product_anchor',
      'catalog_product_jinxxy'
    );

    expect(response.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.packageRegistry.unbindCatalogProductForCreator,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'creator-123',
        catalogProductId: 'catalog_product_jinxxy',
        packageId: 'com.creator.avatar',
      }
    );
  });

  it('creates or updates an owned package edition through the delegated creator actor', async () => {
    convexQueryMock.mockResolvedValue({
      _id: 'catalog_product_1',
      catalogProductIds: ['catalog_product_1', 'catalog_product_2'],
      catalogTiers: [
        {
          _id: 'catalog_tier_commercial',
          catalogProductId: 'catalog_product_1',
          displayName: 'Commercial',
          provider: 'gumroad',
          providerTierRef: 'commercial',
          status: 'active',
        },
      ],
      packageId: 'com.creator.avatar',
    });
    convexMutationMock.mockResolvedValue('package_edition_1');

    const response = await createRoutes('creator-123').manageEdition(
      new Request(
        'http://localhost:3001/api/creator/packages/catalog_product_1/editions/commercial',
        {
          body: JSON.stringify({
            catalogProductIds: ['catalog_product_1', 'catalog_product_2'],
            catalogTierIds: ['catalog_tier_commercial'],
            displayName: 'Commercial',
            priority: 100,
          }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:3000',
          },
          method: 'PUT',
        }
      ),
      'catalog_product_1',
      'commercial'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      editionId: 'commercial',
      saved: true,
    });
    expect(convexMutationMock).toHaveBeenCalledWith(apiMock.packageEditions.upsertForCreator, {
      apiSecret: config.convexApiSecret,
      actor: 'creator-actor-binding',
      authUserId: 'creator-123',
      catalogProductIds: ['catalog_product_1', 'catalog_product_2'],
      catalogTierIds: ['catalog_tier_commercial'],
      displayName: 'Commercial',
      editionId: 'commercial',
      packageId: 'com.creator.avatar',
      priority: 100,
    });
  });

  it('archives an owned package edition through the delegated creator actor', async () => {
    convexQueryMock.mockResolvedValue({
      _id: 'catalog_product_1',
      catalogTiers: [],
      packageId: 'com.creator.avatar',
    });
    convexMutationMock.mockResolvedValue('package_edition_1');

    const response = await createRoutes('creator-123').manageEdition(
      new Request(
        'http://localhost:3001/api/creator/packages/catalog_product_1/editions/commercial',
        {
          headers: { Origin: 'http://localhost:3000' },
          method: 'DELETE',
        }
      ),
      'catalog_product_1',
      'commercial'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archived: true,
      editionId: 'commercial',
    });
    expect(convexMutationMock).toHaveBeenCalledWith(apiMock.packageEditions.archiveForCreator, {
      apiSecret: config.convexApiSecret,
      actor: 'creator-actor-binding',
      authUserId: 'creator-123',
      editionId: 'commercial',
      packageId: 'com.creator.avatar',
    });
  });

  it('rejects invalid edition input before calling Convex', async () => {
    convexQueryMock.mockResolvedValue({
      _id: 'catalog_product_1',
      catalogTiers: [],
      packageId: 'com.creator.avatar',
    });
    const response = await createRoutes('creator-123').manageEdition(
      new Request(
        'http://localhost:3001/api/creator/packages/catalog_product_1/editions/commercial',
        {
          body: JSON.stringify({
            catalogProductIds: [],
            catalogTierIds: ['catalog_tier_commercial'],
            displayName: '',
            priority: 1.5,
          }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:3000',
          },
          method: 'PUT',
        }
      ),
      'catalog_product_1',
      'commercial'
    );

    expect(response.status).toBe(400);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('rejects excessive edition mappings before calling the Convex mutation', async () => {
    convexQueryMock.mockResolvedValue({
      _id: 'catalog_product_1',
      packageId: 'com.creator.avatar',
    });
    const response = await createRoutes('creator-123').manageEdition(
      new Request(
        'http://localhost:3001/api/creator/packages/catalog_product_1/editions/commercial',
        {
          body: JSON.stringify({
            catalogProductIds: Array.from({ length: 129 }, (_, index) => `product_${index}`),
            catalogTierIds: [],
            displayName: 'Commercial',
            priority: 100,
          }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:3000',
          },
          method: 'PUT',
        }
      ),
      'catalog_product_1',
      'commercial'
    );

    expect(response.status).toBe(400);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('keeps the built-in standard edition available', async () => {
    const response = await createRoutes('creator-123').manageEdition(
      new Request(
        'http://localhost:3001/api/creator/packages/catalog_product_1/editions/standard',
        {
          headers: { Origin: 'http://localhost:3000' },
          method: 'DELETE',
        }
      ),
      'catalog_product_1',
      'standard'
    );

    expect(response.status).toBe(409);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('checks the creator session before reading an oversized edition body', async () => {
    const response = await createRoutes(null).manageEdition(
      new Request(
        'http://localhost:3001/api/creator/packages/catalog_product_1/editions/commercial',
        {
          body: JSON.stringify({ displayName: 'x'.repeat(20_000) }),
          headers: {
            'Content-Length': '20020',
            'Content-Type': 'application/json',
            Origin: 'http://localhost:3000',
          },
          method: 'PUT',
        }
      ),
      'catalog_product_1',
      'commercial'
    );

    expect(response.status).toBe(401);
    expect(convexQueryMock).not.toHaveBeenCalled();
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized edition body after authenticating the creator', async () => {
    convexQueryMock.mockResolvedValue({
      _id: 'catalog_product_1',
      packageId: 'com.creator.avatar',
    });
    const response = await createRoutes('creator-123').manageEdition(
      new Request(
        'http://localhost:3001/api/creator/packages/catalog_product_1/editions/commercial',
        {
          body: JSON.stringify({ displayName: 'x'.repeat(20_000) }),
          headers: {
            'Content-Length': '20020',
            'Content-Type': 'application/json',
            Origin: 'http://localhost:3000',
          },
          method: 'PUT',
        }
      ),
      'catalog_product_1',
      'commercial'
    );

    expect(response.status).toBe(413);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('deletes an owned package version through the catalog control boundary', async () => {
    convexQueryMock.mockResolvedValue({
      displayName: 'Commercial',
      editionId: 'commercial',
      packageId: 'com.creator.avatar',
      status: 'active',
    });
    const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';

    const response = await createRoutes('creator-123').deleteVersion(
      new Request(
        'http://localhost:3001/api/creator/packages/by-package/com.creator.avatar/editions/commercial/versions/version-1',
        {
          headers: { Origin: 'http://localhost:3000', traceparent },
          method: 'DELETE',
        }
      ),
      'com.creator.avatar',
      'commercial',
      'version-1'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      deletedAt: '2026-07-25T12:00:00.000Z',
      state: 'DELETED',
      versionId: 'version-1',
    });
    expect(deleteVersionMock).toHaveBeenCalledWith({
      editionId: 'commercial',
      packageId: 'com.creator.avatar',
      traceparent,
      versionId: 'version-1',
    });
  });

  it('authorizes ownership before reading a durable package version status', async () => {
    convexQueryMock.mockResolvedValue({
      displayName: 'Standard',
      editionId: 'standard',
      packageId: 'com.creator.avatar',
      status: 'active',
    });
    const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';

    const response = await createRoutes('creator-123').getVersionStatus(
      new Request(
        'http://localhost:3001/api/creator/packages/by-package/com.creator.avatar/editions/standard/versions/version-processing/status',
        {
          headers: { Origin: 'http://localhost:3000', traceparent },
        }
      ),
      'com.creator.avatar',
      'standard',
      'version-processing'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      editionId: 'standard',
      errorCategory: null,
      errorCode: null,
      estimatedStartAt: null,
      packageId: 'com.creator.avatar',
      queuePosition: null,
      state: 'preparing',
      updatedAt: '2026-07-26T12:00:00.000Z',
      version: '2.5.0',
      versionId: 'version-processing',
    });
    expect(getVersionStatusMock).toHaveBeenCalledWith({
      editionId: 'standard',
      packageId: 'com.creator.avatar',
      traceparent,
      versionId: 'version-processing',
    });
  });

  it('does not read durable status for a product outside the creator account', async () => {
    convexQueryMock.mockResolvedValue(null);

    const response = await createRoutes('creator-123').getVersionStatus(
      new Request(
        'http://localhost:3001/api/creator/packages/by-package/com.creator.other/editions/standard/versions/version-processing/status',
        { headers: { Origin: 'http://localhost:3000' } }
      ),
      'com.creator.other',
      'standard',
      'version-processing'
    );

    expect(response.status).toBe(404);
    expect(getVersionStatusMock).not.toHaveBeenCalled();
  });

  it('does not send a deletion command for a version outside the owned product', async () => {
    convexQueryMock.mockResolvedValue(null);

    const response = await createRoutes('creator-123').deleteVersion(
      new Request(
        'http://localhost:3001/api/creator/packages/by-package/com.creator.avatar/editions/commercial/versions/version-other',
        {
          headers: { Origin: 'http://localhost:3000' },
          method: 'DELETE',
        }
      ),
      'com.creator.avatar',
      'commercial',
      'version-other'
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      errorCode: 'PACKAGE_VERSION_NOT_FOUND',
    });
    expect(deleteVersionMock).not.toHaveBeenCalled();
  });

  it('drops malformed trace context without blocking an owned deletion', async () => {
    convexQueryMock.mockResolvedValue({
      displayName: 'Commercial',
      editionId: 'commercial',
      packageId: 'com.creator.avatar',
      status: 'active',
    });

    const response = await createRoutes('creator-123').deleteVersion(
      new Request(
        'http://localhost:3001/api/creator/packages/by-package/com.creator.avatar/editions/commercial/versions/version-1',
        {
          headers: {
            Origin: 'http://localhost:3000',
            traceparent: 'malformed-context',
          },
          method: 'DELETE',
        }
      ),
      'com.creator.avatar',
      'commercial',
      'version-1'
    );

    expect(response.status).toBe(200);
    expect(deleteVersionMock).toHaveBeenCalledWith({
      editionId: 'commercial',
      packageId: 'com.creator.avatar',
      versionId: 'version-1',
    });
  });

  it('returns 401 without a Better Auth session', async () => {
    const response = await createRoutes(null).listPackages(listRequest());

    expect(response.status).toBe(401);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it("returns the signed-in creator's packages through the delegated session actor", async () => {
    const internalPage = {
      data: [
        {
          _id: 'catalog_product_1',
          _creationTime: 100,
          authUserId: 'creator-123',
          tenantId: 'legacy-tenant',
          productId: 'avatar-bundle',
          provider: 'gumroad',
          providerProductRef: 'avatar-bundle-ref',
          displayName: 'Avatar Bundle',
          packageId: 'com.creator.avatar-bundle',
          status: 'active',
          supportsAutoDiscovery: true,
          createdAt: 100,
          updatedAt: 200,
          canArchive: true,
          canRestore: false,
          canDelete: true,
          catalogTiers: [
            {
              _id: 'catalog_tier_1',
              _creationTime: 100,
              authUserId: 'creator-123',
              tenantId: 'legacy-tenant',
              productId: 'avatar-bundle',
              catalogProductId: 'catalog_product_1',
              provider: 'gumroad',
              providerProductRef: 'avatar-bundle-ref',
              providerTierRef: 'standard',
              displayName: 'Standard',
              metadata: { internal: true },
              status: 'active',
              createdAt: 100,
              updatedAt: 200,
            },
          ],
        },
      ],
      hasMore: false,
      nextCursor: null,
    };
    convexQueryMock.mockResolvedValue(internalPage);

    const response = await createRoutes('creator-123').listPackages(listRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      data: [
        {
          _id: 'catalog_product_1',
          productId: 'avatar-bundle',
          provider: 'gumroad',
          providerProductRef: 'avatar-bundle-ref',
          displayName: 'Avatar Bundle',
          packageId: 'com.creator.avatar-bundle',
          status: 'active',
          supportsAutoDiscovery: true,
          createdAt: 100,
          updatedAt: 200,
          canArchive: true,
          canRestore: false,
          canDelete: true,
          catalogTiers: [
            {
              _id: 'catalog_tier_1',
              catalogProductId: 'catalog_product_1',
              provider: 'gumroad',
              providerTierRef: 'standard',
              displayName: 'Standard',
              status: 'active',
              createdAt: 100,
              updatedAt: 200,
            },
          ],
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(createAuthUserActorBindingMock).toHaveBeenCalledWith({
      authUserId: 'creator-123',
      source: 'session',
    });
    expect(convexQueryMock).toHaveBeenCalledWith(apiMock.packageRegistry.listByAuthUser, {
      apiSecret: config.convexApiSecret,
      actor: 'creator-actor-binding',
      authUserId: 'creator-123',
      configuredOnly: true,
      limit: 100,
    });
  });

  it('preserves one logical product and every linked storefront in the creator response', async () => {
    convexQueryMock.mockResolvedValue({
      data: [
        {
          _id: 'catalog_product_gumroad',
          aliasId: 'jammr',
          catalogProductIds: ['catalog_product_gumroad', 'catalog_product_jinxxy'],
          catalogTiers: [],
          storefronts: [
            {
              catalogProductId: 'catalog_product_gumroad',
              productId: 'jammr-gumroad',
              provider: 'gumroad',
              providerProductRef: 'jammr-gumroad-ref',
              displayName: 'JAMMR',
            },
            {
              catalogProductId: 'catalog_product_jinxxy',
              productId: 'jammr-jinxxy',
              provider: 'jinxxy',
              providerProductRef: 'jammr-jinxxy-ref',
              displayName: 'JAMMR',
            },
          ],
          productId: 'jammr-gumroad',
          provider: 'gumroad',
          providerProductRef: 'jammr-gumroad-ref',
          displayName: 'JAMMR',
          packageId: 'com.yucp.jammr',
          status: 'active',
          supportsAutoDiscovery: true,
          createdAt: 100,
          updatedAt: 200,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const response = await createRoutes('creator-123').listPackages(listRequest());
    const body = (await response.json()) as {
      data: Array<{
        aliasId?: string;
        catalogProductIds?: string[];
        storefronts?: Array<{ provider: string }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      aliasId: 'jammr',
      catalogProductIds: ['catalog_product_gumroad', 'catalog_product_jinxxy'],
      storefronts: [{ provider: 'gumroad' }, { provider: 'jinxxy' }],
    });
  });

  it('exposes unconfigured products only when the caller requests the picker feed', async () => {
    convexQueryMock.mockResolvedValue({ data: [], hasMore: false, nextCursor: null });

    const response = await createRoutes('creator-123').listPackages(
      listRequest('configured=false&limit=100')
    );

    expect(response.status).toBe(200);
    expect(convexQueryMock).toHaveBeenCalledWith(apiMock.packageRegistry.listByAuthUser, {
      apiSecret: config.convexApiSecret,
      actor: 'creator-actor-binding',
      authUserId: 'creator-123',
      configuredOnly: false,
      limit: 100,
    });
  });

  it("returns one creator-owned package through the signed-in creator's actor", async () => {
    const internalProduct = {
      _id: 'catalog_product_1',
      _creationTime: 100,
      authUserId: 'creator-123',
      tenantId: 'legacy-tenant',
      productId: 'avatar-bundle',
      provider: 'gumroad',
      providerProductRef: 'avatar-bundle-ref',
      displayName: 'Avatar Bundle',
      status: 'active',
      supportsAutoDiscovery: true,
      createdAt: 100,
      updatedAt: 200,
      canArchive: true,
      canRestore: false,
      canDelete: true,
      catalogTiers: [],
    };
    convexQueryMock.mockResolvedValue(internalProduct);

    const response = await createRoutes('creator-123').getPackage(
      new Request('http://localhost:3001/api/creator/packages/catalog_product_1', {
        headers: { Origin: 'http://localhost:3000' },
      }),
      'catalog_product_1'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      _id: 'catalog_product_1',
      productId: 'avatar-bundle',
      provider: 'gumroad',
      providerProductRef: 'avatar-bundle-ref',
      displayName: 'Avatar Bundle',
      status: 'active',
      supportsAutoDiscovery: true,
      createdAt: 100,
      updatedAt: 200,
      canArchive: true,
      canRestore: false,
      canDelete: true,
      catalogTiers: [],
    });
    expect(convexQueryMock).toHaveBeenCalledWith(apiMock.packageRegistry.getByIdForAuthUser, {
      apiSecret: config.convexApiSecret,
      actor: 'creator-actor-binding',
      authUserId: 'creator-123',
      catalogProductId: 'catalog_product_1',
    });
  });
});
