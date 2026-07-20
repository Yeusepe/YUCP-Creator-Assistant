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

function listRequest(): Request {
  return new Request('http://localhost:3001/api/creator/packages?limit=100', {
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
    const page = {
      data: [
        {
          _id: 'catalog_product_1',
          displayName: 'Avatar Bundle',
          status: 'active',
          catalogTiers: [],
        },
      ],
      hasMore: false,
      nextCursor: null,
    };
    convexQueryMock.mockResolvedValue(page);

    const response = await createRoutes('creator-123').listPackages(listRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual(page);
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

  it("returns one creator-owned package through the signed-in creator's actor", async () => {
    const product = {
      _id: 'catalog_product_1',
      displayName: 'Avatar Bundle',
      status: 'active',
      catalogTiers: [],
    };
    convexQueryMock.mockResolvedValue(product);

    const response = await createRoutes('creator-123').getPackage(
      new Request('http://localhost:3001/api/creator/packages/catalog_product_1', {
        headers: { Origin: 'http://localhost:3000' },
      }),
      'catalog_product_1'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual(product);
    expect(convexQueryMock).toHaveBeenCalledWith(apiMock.packageRegistry.getByIdForAuthUser, {
      apiSecret: config.convexApiSecret,
      actor: 'creator-actor-binding',
      authUserId: 'creator-123',
      catalogProductId: 'catalog_product_1',
    });
  });
});
