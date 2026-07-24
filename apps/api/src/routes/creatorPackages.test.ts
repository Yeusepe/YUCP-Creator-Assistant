import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const createAuthUserActorBindingMock = mock(
  async (_input?: unknown) => 'creator-actor-binding' as const
);

const apiMock = {
  packageRegistry: {
    getByIdForAuthUser: 'packageRegistry.getByIdForAuthUser',
    listByAuthUser: 'packageRegistry.listByAuthUser',
  },
} as const;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: {},
}));

mock.module('../lib/apiActor', () => ({
  createAuthUserActorBinding: createAuthUserActorBindingMock,
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
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
    convexQueryMock.mockReset();
    createAuthUserActorBindingMock.mockClear();
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
