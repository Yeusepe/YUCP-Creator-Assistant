import { beforeEach, describe, expect, it, mock } from 'bun:test';

let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => [];

mock.module('../../../../../convex/_generated/api', () => ({
  api: {
    entitlements: { listByAuthUser: 'entitlements.listByAuthUser' },
    role_rules: { listByAuthUser: 'role_rules.listByAuthUser' },
    packageRegistry: {
      listByAuthUser: 'packageRegistry.listByAuthUser',
      getByIdForAuthUser: 'packageRegistry.getByIdForAuthUser',
    },
  },
  internal: {},
  components: {},
}));

mock.module('../../lib/convex', () => ({
  getConvexApiSecret: () => 'test-convex-secret',
  getConvexClient: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: async () => null,
  }),
  getConvexClientFromUrl: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: async () => null,
  }),
}));

mock.module('./auth', () => ({
  resolveAuth: async (
    _request: Request,
    _config: unknown,
    _requiredScopes: string[],
    _requestId?: string,
    timing?: { record: (name: string, durationMs: number, description?: string) => void }
  ) => {
    timing?.record('auth_mock', 1, 'resolve product auth');
    return {
      authUserId: 'user_abc',
      scopes: ['products:read'],
    };
  },
}));

const { handleProductsRoutes } = await import('./products');

const config = {
  apiBaseUrl: 'https://api.test',
  convexUrl: 'https://test.convex.cloud',
  convexApiSecret: 'test-secret',
  convexSiteUrl: 'https://test.convex.site',
  encryptionSecret: 'test-encryption-secret',
  frontendBaseUrl: 'https://creators.test',
};

beforeEach(() => {
  queryImpl = async () => [];
});

describe('handleProductsRoutes timing', () => {
  it('emits Server-Timing headers for product list requests', async () => {
    queryImpl = async () => ({
      items: [{ id: 'prod_123' }],
      hasMore: false,
      cursor: null,
    });

    const response = await handleProductsRoutes(
      new Request('http://localhost/api/public/v2/products', {
        headers: { authorization: 'Bearer test-token' },
      }),
      '/products',
      config
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Server-Timing')).toMatch(
      /auth_mock;dur=.*convex_products;dur=.*serialize;dur=.*total;dur=/
    );
    await expect(response.json()).resolves.toMatchObject({
      object: 'list',
      data: [{ id: 'prod_123' }],
    });
  });
});
