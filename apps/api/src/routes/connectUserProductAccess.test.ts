import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { PublicApiRateLimitStore } from '../lib/publicApiRateLimit';
import type { ConnectConfig } from '../providers/types';
import { createTestLogger } from '../testSupport/loggerMock';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const convexMutationMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => undefined
);
const convexActionMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => undefined
);
const loggerErrorMock = mock(() => undefined);
const providerMetadataActual = await import('@yucp/providers/providerMetadata');
const sharedActual = await import('@yucp/shared');
const verificationConfigActual = await import('../verification/verificationConfig');

const apiMock = {
  buyerCreatorVpmRepositories: {
    ensureActive: 'buyerCreatorVpmRepositories.ensureActive',
  },
  creatorVpmLinks: {
    getActiveForPackageAccess: 'creatorVpmLinks.getActiveForPackageAccess',
  },
  packageRegistry: {
    getBuyerAccessContextByCatalogProductId:
      'packageRegistry.getBuyerAccessContextByCatalogProductId',
    getBuyerAccessContextByCreatorAndProductRef:
      'packageRegistry.getBuyerAccessContextByCreatorAndProductRef',
  },
  entitlements: {
    listByAuthUser: 'entitlements.listByAuthUser',
  },
  verificationIntents: {
    createVerificationIntent: 'verificationIntents.createVerificationIntent',
    getVerificationIntent: 'verificationIntents.getVerificationIntent',
  },
} as const;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: {},
}));

function applyExplicitActor(args: unknown, actor: unknown): unknown {
  if (!actor || !args || typeof args !== 'object' || Array.isArray(args)) {
    return args;
  }

  if (!('apiSecret' in (args as Record<string, unknown>))) {
    return args;
  }

  return {
    ...(args as Record<string, unknown>),
    actor,
  };
}

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: (_url: string, actor?: unknown) => ({
    query: (reference: unknown, args?: unknown) =>
      convexQueryMock(reference, applyExplicitActor(args, actor)),
    mutation: (reference: unknown, args?: unknown) =>
      convexMutationMock(reference, applyExplicitActor(args, actor)),
    action: (reference: unknown, args?: unknown) =>
      convexActionMock(reference, applyExplicitActor(args, actor)),
  }),
}));

mock.module('../lib/logger', () => ({
  logger: createTestLogger({
    error: loggerErrorMock,
    info: mock(() => undefined),
    warn: mock(() => undefined),
  }),
}));

mock.module('../lib/apiActor', () => ({
  createAuthUserActorBinding: async () => 'actor-binding',
  createApiServiceActorBinding: async () => 'service-actor-binding',
}));

mock.module('@yucp/providers/providerMetadata', () => ({
  ...providerMetadataActual,
  CATALOG_SYNC_PROVIDER_KEYS: ['gumroad', 'jinxxy', 'lemonsqueezy', 'patreon'],
  providerIcon: (provider: string) => {
    const icons: Record<string, string> = {
      gumroad: 'Gumorad.png',
      jinxxy: 'Jinxxy.png',
    };
    return icons[provider] ?? null;
  },
  getProviderDescriptor: (provider: string) => {
    const descriptors: Record<
      string,
      {
        buyerVerificationMethods: string[];
        capabilities: string[];
        catalogProductUrlTemplate?: string;
        supportsAutoDiscovery?: boolean;
        supportsBuyerOAuthLink?: boolean;
      }
    > = {
      gumroad: {
        buyerVerificationMethods: ['account_link', 'license_key'],
        capabilities: ['catalog_sync', 'license_verification'],
        catalogProductUrlTemplate: 'https://gumroad.com/l/{slug}',
        supportsAutoDiscovery: true,
        supportsBuyerOAuthLink: true,
      },
      jinxxy: {
        buyerVerificationMethods: ['account_link', 'license_key'],
        capabilities: ['catalog_sync', 'tier_catalog', 'license_verification'],
        supportsAutoDiscovery: false,
        supportsBuyerOAuthLink: false,
      },
      lemonsqueezy: {
        buyerVerificationMethods: ['account_link', 'license_key'],
        capabilities: ['catalog_sync', 'license_verification'],
        supportsAutoDiscovery: true,
        supportsBuyerOAuthLink: false,
      },
      patreon: {
        buyerVerificationMethods: ['account_link'],
        capabilities: ['catalog_sync', 'tier_catalog', 'tier_entitlements', 'subscriptions'],
        supportsAutoDiscovery: true,
        supportsBuyerOAuthLink: true,
      },
    };
    return descriptors[provider] ?? null;
  },
  providerLabel: (provider: string) => (provider === 'gumroad' ? 'Gumroad' : provider),
}));

mock.module('../verification/verificationConfig', () => ({
  ...verificationConfigActual,
  getVerificationConfig: (provider: string) =>
    provider === 'gumroad'
      ? { clientId: 'test-client-id' }
      : verificationConfigActual.getVerificationConfig(provider),
}));

mock.module('@yucp/shared', () => ({
  ...sharedActual,
  getSafeRelativeRedirectTarget: (value?: string) =>
    typeof value === 'string' && value.startsWith('/') ? value : null,
}));

mock.module('@yucp/shared/crypto', () => ({
  sha256Base64Url: async () => 'hashed-code-challenge',
}));

mock.module('../verification/hostedIntents', () => ({
  normalizeHostedVerificationRequirements: (requirements: unknown) => requirements,
  mapHostedVerificationIntentResponse: (intent: { id: string }, frontendBaseUrl: string) => ({
    id: intent.id,
    verificationUrl: `${frontendBaseUrl}/verify/purchase?intent=${intent.id}`,
  }),
}));

const { createConnectUserProductAccessRoutes } = await import('./connectUserProductAccess');

const testConfig: ConnectConfig = {
  apiBaseUrl: 'http://localhost:3001',
  frontendBaseUrl: 'http://localhost:3000',
  convexSiteUrl: 'http://localhost:3210',
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
  convexApiSecret: 'test-convex-secret',
  convexUrl: 'http://localhost:3210',
  encryptionSecret: 'test-encryption-secret-32chars!!',
  privateVpmRootDomain: 'private.yucp.club',
};

function createRoutes(
  configOverrides: Partial<ConnectConfig> = {},
  authUserId = 'buyer-auth-user'
) {
  return createConnectUserProductAccessRoutes({
    auth: {
      getSession: async () => ({
        user: {
          id: authUserId,
        },
      }),
    } as never,
    config: { ...testConfig, ...configOverrides },
  });
}

function createSignedOutRoutes(configOverrides: Partial<ConnectConfig> = {}) {
  return createConnectUserProductAccessRoutes({
    auth: {
      getSession: async () => null,
    } as never,
    config: { ...testConfig, ...configOverrides },
  });
}

describe('connect user product access routes', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    convexQueryMock.mockReset();
    convexMutationMock.mockReset();
    convexActionMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('rate-limits public product resolution before session or Convex work', async () => {
    const getSessionMock = mock(async () => null);
    const rateLimitStore: PublicApiRateLimitStore = {
      consume: mock(async () => ({
        allowed: false,
        limit: 60,
        remaining: 0,
        resetAt: Date.now() + 60_000,
        retryAfterSeconds: 60,
      })),
    };
    const routes = createConnectUserProductAccessRoutes({
      auth: { getSession: getSessionMock } as never,
      config: testConfig,
      rateLimitStore,
    });

    const response = await routes.getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123', {
        headers: { 'cf-connecting-ip': '203.0.113.42' },
      }),
      'catalog_123'
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('returns product entitlement state for the signed-in buyer', async () => {
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.buyerCreatorVpmRepositories.ensureActive) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          buyerAuthUserId: 'buyer-auth-user',
          creatorAuthUserId: 'creator-auth-user',
          creatorSlug: 'avatar-studio',
          proposedLinkId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
          requiredCatalogProductIds: ['catalog_123'],
        });
        return {
          created: true,
          creatorSlug: 'avatar-studio',
          linkId: 'A'.repeat(43),
          status: 'active',
        };
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          catalogProductId: 'catalog_123',
        });
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          packageId: 'com.yucp.avatar-bundle',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          canonicalSlug: 'avatar-bundle',
          productUrl: 'https://quaggycharr.gumroad.com/l/avatar-bundle',
          thumbnailUrl: 'https://cdn.test/avatar.png',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_123',
              productId: 'product_123',
              provider: 'gumroad',
              providerProductRef: 'gumroad-ref',
              canonicalSlug: 'avatar-bundle',
              productUrl: 'https://quaggycharr.gumroad.com/l/avatar-bundle',
            },
          ],
        };
      }
      if (reference === apiMock.entitlements.listByAuthUser) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          authUserId: 'buyer-auth-user',
          scope: 'subject_holder',
          productId: 'product_123',
          status: 'active',
          limit: 100,
        });
        return {
          data: [{ id: 'ent_1', catalogProductId: 'catalog_123' }],
          hasMore: false,
        };
      }
      if (reference === apiMock.creatorVpmLinks.getActiveForPackageAccess) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          authUserId: 'creator-auth-user',
          packageId: 'com.yucp.avatar-bundle',
        });
        return { creatorSlug: 'avatar-studio', status: 'active' };
      }

      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const routes = createRoutes();
    const response = await routes.getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123'),
      'catalog_123'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      product: {
        catalogProductId: 'catalog_123',
        displayName: 'Avatar Bundle',
        canonicalSlug: 'avatar-bundle',
        thumbnailUrl: 'https://cdn.test/avatar.png',
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: 'https://quaggycharr.gumroad.com/l/avatar-bundle',
        storefronts: [
          {
            catalogProductId: 'catalog_123',
            provider: 'gumroad',
            providerLabel: 'Gumroad',
            providerIcon: 'Gumorad.png',
            storefrontUrl: 'https://quaggycharr.gumroad.com/l/avatar-bundle',
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
      repository: {
        addRepoUrl:
          'vcc://vpm/addRepo?url=https%3A%2F%2Favatar-studio.private.yucp.club%2Fapi%2Fvpm%2Faccess%2FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%2Findex.json',
        indexUrl:
          'https://avatar-studio.private.yucp.club/api/vpm/access/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/index.json',
      },
    });
  });

  it('does not issue a shared-origin repository when the private VPM root is unconfigured', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          packageId: 'com.yucp.avatar-bundle',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          status: 'active',
          storefronts: [],
        };
      }
      if (reference === apiMock.entitlements.listByAuthUser) {
        return {
          data: [{ id: 'ent_1', catalogProductId: 'catalog_123' }],
          hasMore: false,
        };
      }
      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const routes = createRoutes({ privateVpmRootDomain: undefined });
    const response = await routes.getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123'),
      'catalog_123'
    );
    const body = (await response.json()) as { repository: unknown };

    expect(response.status).toBe(200);
    expect(body.repository).toBeNull();
    expect(convexQueryMock).not.toHaveBeenCalledWith(
      apiMock.creatorVpmLinks.getActiveForPackageAccess,
      expect.anything()
    );
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('derives the storefront URL from the canonical slug when no stored URL exists', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, _args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'Dcmv6A==',
          displayName: 'Avatar Bundle',
          canonicalSlug: 'avatar-bundle',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_123',
              productId: 'product_123',
              provider: 'gumroad',
              providerProductRef: 'Dcmv6A==',
              canonicalSlug: 'avatar-bundle',
            },
          ],
        };
      }
      if (reference === apiMock.entitlements.listByAuthUser) {
        return { data: [], hasMore: false };
      }
      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const routes = createRoutes();
    const response = await routes.getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123'),
      'catalog_123'
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      product: {
        storefrontUrl: string | null;
        storefronts: Array<{ storefrontUrl: string | null }>;
      };
    };
    // The Gumroad permalink is globally routable; the API product id never is.
    expect(body.product.storefrontUrl).toBe('https://gumroad.com/l/avatar-bundle');
    expect(body.product.storefronts[0]?.storefrontUrl).toBe('https://gumroad.com/l/avatar-bundle');
  });

  it('returns a null storefront URL when the provider has no public product URL', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, _args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-product-uuid',
          displayName: 'Avatar Bundle',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_123',
              productId: 'product_123',
              provider: 'jinxxy',
              providerProductRef: 'jinxxy-product-uuid',
            },
          ],
        };
      }
      if (reference === apiMock.entitlements.listByAuthUser) {
        return { data: [], hasMore: false };
      }
      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const routes = createRoutes();
    const response = await routes.getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123'),
      'catalog_123'
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      product: {
        storefrontUrl: string | null;
        storefronts: Array<{ storefrontUrl: string | null }>;
      };
    };
    // Jinxxy API ids are not routable; a missing URL must surface as null, not a guess.
    expect(body.product.storefrontUrl).toBeNull();
    expect(body.product.storefronts[0]?.storefrontUrl).toBeNull();
  });

  it('returns a distinct durable repository URL to each entitled buyer', async () => {
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.buyerCreatorVpmRepositories.ensureActive) {
        const buyerAuthUserId = String((args as { buyerAuthUserId?: string }).buyerAuthUserId);
        return {
          created: true,
          creatorSlug: 'avatar-studio',
          linkId: (buyerAuthUserId === 'buyer-one' ? 'A' : 'B').repeat(43),
          status: 'active',
        };
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          packageId: 'com.yucp.avatar-bundle',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_123',
              productId: 'product_123',
              provider: 'gumroad',
              providerProductRef: 'gumroad-ref',
            },
          ],
        };
      }
      if (reference === apiMock.entitlements.listByAuthUser) {
        const authUserId = (args as { authUserId?: string }).authUserId;
        expect(['buyer-one', 'buyer-two']).toContain(String(authUserId));
        return {
          data: [{ id: `entitlement-${authUserId}`, catalogProductId: 'catalog_123' }],
          hasMore: false,
        };
      }
      if (reference === apiMock.creatorVpmLinks.getActiveForPackageAccess) {
        return {
          creatorSlug: 'avatar-studio',
          status: 'active',
        };
      }
      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const first = await createRoutes({}, 'buyer-one').getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123'),
      'catalog_123'
    );
    const second = await createRoutes({}, 'buyer-two').getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123'),
      'catalog_123'
    );
    const firstBody = (await first.json()) as { repository: unknown };
    const secondBody = (await second.json()) as { repository: unknown };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.repository).not.toEqual(secondBody.repository);
    expect(firstBody.repository).toEqual({
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Favatar-studio.private.yucp.club%2Fapi%2Fvpm%2Faccess%2FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%2Findex.json',
      indexUrl:
        'https://avatar-studio.private.yucp.club/api/vpm/access/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/index.json',
    });
    expect(secondBody.repository).toEqual({
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Favatar-studio.private.yucp.club%2Fapi%2Fvpm%2Faccess%2FBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB%2Findex.json',
      indexUrl:
        'https://avatar-studio.private.yucp.club/api/vpm/access/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/index.json',
    });
  });

  it('returns the same tailored repository from every entitled product page for one creator', async () => {
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.buyerCreatorVpmRepositories.ensureActive) {
        expect(args).toMatchObject({
          buyerAuthUserId: 'buyer-auth-user',
          creatorAuthUserId: 'creator-auth-user',
        });
        return {
          created: false,
          creatorSlug: 'avatar-studio',
          linkId: 'T'.repeat(43),
          status: 'active',
        };
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        const catalogProductId = String((args as { catalogProductId?: string }).catalogProductId);
        const suffix = catalogProductId === 'catalog_one' ? 'one' : 'two';
        return {
          catalogProductId,
          creatorAuthUserId: 'creator-auth-user',
          packageId: `com.yucp.avatar-${suffix}`,
          productId: `product_${suffix}`,
          provider: 'gumroad',
          providerProductRef: `gumroad-${suffix}`,
          displayName: `Avatar ${suffix}`,
          status: 'active',
          storefronts: [
            {
              catalogProductId,
              productId: `product_${suffix}`,
              provider: 'gumroad',
              providerProductRef: `gumroad-${suffix}`,
            },
          ],
        };
      }
      if (reference === apiMock.entitlements.listByAuthUser) {
        const productId = String((args as { productId?: string }).productId);
        return {
          data: [
            {
              id: `entitlement-${productId}`,
              catalogProductId: productId === 'product_one' ? 'catalog_one' : 'catalog_two',
            },
          ],
          hasMore: false,
        };
      }
      if (reference === apiMock.creatorVpmLinks.getActiveForPackageAccess) {
        return { creatorSlug: 'avatar-studio', status: 'active' };
      }
      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const routes = createRoutes();
    const first = await routes.getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_one'),
      'catalog_one'
    );
    const second = await routes.getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_two'),
      'catalog_two'
    );
    const firstBody = (await first.json()) as { repository: unknown };
    const secondBody = (await second.json()) as { repository: unknown };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.repository).toEqual(secondBody.repository);
    expect(convexMutationMock).toHaveBeenCalledTimes(2);
  });

  it('returns verification-required state to signed-out product access callers', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        expect(args).toMatchObject({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          catalogProductId: 'catalog_123',
        });
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          canonicalSlug: 'avatar-bundle',
          thumbnailUrl: 'https://cdn.test/avatar.png',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_123',
              productId: 'product_123',
              provider: 'gumroad',
              providerProductRef: 'gumroad-ref',
            },
          ],
        };
      }

      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const routes = createSignedOutRoutes();
    const response = await routes.getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123'),
      'catalog_123'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      product: {
        displayName: 'Avatar Bundle',
      },
      accessState: {
        hasActiveEntitlement: false,
        requiresVerification: true,
      },
    });
    expect(convexQueryMock).not.toHaveBeenCalledWith(
      apiMock.entitlements.listByAuthUser,
      expect.anything()
    );
  });

  it('scopes human product aliases to the creator from the public access URL', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCreatorAndProductRef) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          creatorRef: 'mapache',
          productRef: 'avatar-bundle',
        });
        return {
          catalogProductId: 'creator-scoped-catalog-product',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          canonicalSlug: 'avatar-bundle',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'creator-scoped-catalog-product',
              productId: 'product_123',
              provider: 'gumroad',
              providerProductRef: 'gumroad-ref',
            },
          ],
        };
      }

      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const routes = createSignedOutRoutes();
    const response = await routes.getBuyerProductAccess(
      new Request(
        'http://localhost:3001/api/connect/user/product-access/avatar-bundle?creator_ref=mapache'
      ),
      'avatar-bundle'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      product: { catalogProductId: 'creator-scoped-catalog-product' },
    });
  });

  it('omits public catalog and creator references from error telemetry', async () => {
    const catalogProductId = 'private-catalog-reference-never-log';
    const creatorRef = 'private-creator-reference-never-log';
    convexQueryMock.mockRejectedValueOnce(new Error('lookup failed'));

    const response = await createSignedOutRoutes().getBuyerProductAccess(
      new Request(
        `http://localhost:3001/api/connect/user/product-access/${catalogProductId}?creator_ref=${creatorRef}`
      ),
      catalogProductId
    );

    expect(response.status).toBe(500);
    const serializedLogs = JSON.stringify(loggerErrorMock.mock.calls);
    expect(serializedLogs).not.toContain(catalogProductId);
    expect(serializedLogs).not.toContain(creatorRef);
  });

  it('omits catalog references from verification-intent error telemetry', async () => {
    const catalogProductId = 'private-intent-reference-never-log';
    convexQueryMock.mockRejectedValueOnce(new Error('intent lookup failed'));

    const response = await createRoutes().postBuyerProductAccessVerificationIntent(
      new Request(`http://localhost:3001/api/connect/user/product-access/${catalogProductId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      catalogProductId
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(catalogProductId);
  });

  it('returns verification-required state to signed-in buyers without entitlement access', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        expect(args).toMatchObject({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          catalogProductId: 'catalog_123',
        });
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          canonicalSlug: 'avatar-bundle',
          thumbnailUrl: 'https://cdn.test/avatar.png',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_123',
              productId: 'product_123',
              provider: 'gumroad',
              providerProductRef: 'gumroad-ref',
            },
          ],
        };
      }
      if (reference === apiMock.entitlements.listByAuthUser) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          authUserId: 'buyer-auth-user',
          scope: 'subject_holder',
          productId: 'product_123',
          status: 'active',
          limit: 100,
        });
        return { data: [], hasMore: false };
      }

      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const routes = createRoutes();
    const response = await routes.getBuyerProductAccess(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123'),
      'catalog_123'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      product: {
        displayName: 'Avatar Bundle',
      },
      accessState: {
        hasActiveEntitlement: false,
        requiresVerification: true,
      },
    });
  });

  it('blocks cross-site buyer verification intent creation before mutating state', async () => {
    const routes = createRoutes();
    const response = await routes.postBuyerProductAccessVerificationIntent(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123', {
        method: 'POST',
        headers: {
          origin: 'https://attacker.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ returnTo: '/dashboard' }),
      }),
      'catalog_123'
    );

    expect(response.status).toBe(403);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('creates a hosted verification intent with a flow-scoped machine fingerprint when the caller sends an unsafe return path', async () => {
    let createdMachineFingerprint: string | null = null;

    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        expect(args).toMatchObject({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          catalogProductId: 'catalog_123',
        });
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_123',
              productId: 'product_123',
              provider: 'gumroad',
              providerProductRef: 'gumroad-ref',
            },
          ],
        };
      }

      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference !== apiMock.verificationIntents.createVerificationIntent) {
        throw new Error(`Unexpected mutation reference: ${String(reference)}`);
      }

      expect(args).toMatchObject({
        apiSecret: 'test-convex-secret',
        authUserId: 'buyer-auth-user',
        packageId: 'product_123',
        packageName: 'Avatar Bundle',
        returnUrl: 'http://localhost:3000/dashboard',
        idempotencyKey: 'buyer-access:catalog_123:%2Fdashboard:hashed-code-challenge',
      });
      expect((args as { machineFingerprint: string }).machineFingerprint).toMatch(
        /^buyer-access-web:[0-9a-f]{32}$/
      );
      createdMachineFingerprint = (args as { machineFingerprint: string }).machineFingerprint;
      expect((args as { requirements: Array<{ kind: string }> }).requirements).toEqual([
        expect.objectContaining({ kind: 'existing_entitlement' }),
        expect.objectContaining({ kind: 'buyer_provider_link' }),
        expect.objectContaining({
          kind: 'manual_license',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          providerProductRef: 'gumroad-ref',
        }),
      ]);
      return { intentId: 'intent_123' };
    });
    convexActionMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference !== apiMock.verificationIntents.getVerificationIntent) {
        throw new Error(`Unexpected action reference: ${String(reference)}`);
      }

      expect(args).toEqual({
        apiSecret: 'test-convex-secret',
        actor: 'actor-binding',
        authUserId: 'buyer-auth-user',
        intentId: 'intent_123',
      });
      return { id: 'intent_123' };
    });

    const routes = createRoutes();
    const response = await routes.postBuyerProductAccessVerificationIntent(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returnTo: 'https://evil.example/phishing',
        }),
      }),
      'catalog_123'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      id: 'intent_123',
      intentId: 'intent_123',
      codeVerifier: expect.any(String),
      machineFingerprint: createdMachineFingerprint,
      verificationUrl: 'http://localhost:3000/verify/purchase?intent=intent_123',
    });
    expect(response.headers.get('Set-Cookie')).toContain(
      `yucp_buyer_access_machine=${createdMachineFingerprint}`
    );
  });

  it('offers every linked storefront verification method for one logical product', async () => {
    let createdIntent:
      | {
          packageId: string;
          packageName: string;
          requirements: Array<Record<string, unknown>>;
        }
      | undefined;
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog_jammr_gumroad',
          catalogProductIds: ['catalog_jammr_gumroad', 'catalog_jammr_jinxxy'],
          creatorAuthUserId: 'creator-auth-user',
          packageId: 'com.yucp.jammr',
          productId: 'jammr-gumroad',
          provider: 'gumroad',
          providerProductRef: 'gumroad-jammr-ref',
          displayName: 'JAMMR',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_jammr_gumroad',
              productId: 'jammr-gumroad',
              provider: 'gumroad',
              providerProductRef: 'gumroad-jammr-ref',
            },
            {
              catalogProductId: 'catalog_jammr_jinxxy',
              productId: 'jammr-jinxxy',
              provider: 'jinxxy',
              providerProductRef: 'jinxxy-jammr-ref',
            },
          ],
        };
      }
      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.verificationIntents.createVerificationIntent) {
        createdIntent = args as typeof createdIntent;
        return { intentId: 'intent_jammr' };
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });
    convexActionMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.verificationIntents.getVerificationIntent) {
        return { id: 'intent_jammr' };
      }
      throw new Error(`Unexpected action reference: ${String(reference)}`);
    });

    const response = await createRoutes().postBuyerProductAccessVerificationIntent(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_jammr_gumroad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      'catalog_jammr_gumroad'
    );

    expect(response.status).toBe(200);
    expect(createdIntent?.packageId).toBe('com.yucp.jammr');
    expect(createdIntent?.packageName).toBe('JAMMR');
    expect(
      createdIntent?.requirements
        .filter((requirement) => requirement.kind === 'manual_license')
        .map((requirement) => ({
          providerKey: requirement.providerKey,
          productId: requirement.productId,
          providerProductRef: requirement.providerProductRef,
        }))
    ).toEqual([
      {
        providerKey: 'gumroad',
        productId: 'jammr-gumroad',
        providerProductRef: 'gumroad-jammr-ref',
      },
      {
        providerKey: 'jinxxy',
        productId: 'jammr-jinxxy',
        providerProductRef: 'jinxxy-jammr-ref',
      },
    ]);
  });

  it('rejects oversized buyer verification intent bodies before reading product access state', async () => {
    const routes = createRoutes();
    const response = await routes.postBuyerProductAccessVerificationIntent(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          returnTo: '/dashboard',
          padding: 'x'.repeat(4096),
        }),
      }),
      'catalog_123'
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Request body too large' });
    expect(convexQueryMock).not.toHaveBeenCalled();
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it('reuses the existing buyer access machine fingerprint for the same product access flow', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        expect(args).toMatchObject({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          catalogProductId: 'catalog_123',
        });
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_123',
              productId: 'product_123',
              provider: 'gumroad',
              providerProductRef: 'gumroad-ref',
            },
          ],
        };
      }

      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference !== apiMock.verificationIntents.createVerificationIntent) {
        throw new Error(`Unexpected mutation reference: ${String(reference)}`);
      }

      expect(args).toMatchObject({
        machineFingerprint: 'buyer-access-web:0123456789abcdef0123456789abcdef',
        returnUrl: 'http://localhost:3000/account/licenses',
        idempotencyKey: 'buyer-access:catalog_123:%2Faccount%2Flicenses:hashed-code-challenge',
      });
      return { intentId: 'intent_456' };
    });
    convexActionMock.mockImplementation(async (reference: unknown) => {
      if (reference !== apiMock.verificationIntents.getVerificationIntent) {
        throw new Error(`Unexpected action reference: ${String(reference)}`);
      }

      return { id: 'intent_456' };
    });

    const routes = createRoutes();
    const response = await routes.postBuyerProductAccessVerificationIntent(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: 'yucp_buyer_access_machine=buyer-access-web:0123456789abcdef0123456789abcdef',
        },
        body: JSON.stringify({
          returnTo: '/account/licenses',
        }),
      }),
      'catalog_123'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('skips buyer account-link requirements when the provider does not support hosted OAuth linking', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        expect(args).toMatchObject({
          apiSecret: 'test-convex-secret',
          actor: 'service-actor-binding',
          catalogProductId: 'catalog_123',
        });
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'lemonsqueezy',
          providerProductRef: 'lemonsqueezy-ref',
          displayName: 'Avatar Bundle',
          status: 'active',
          storefronts: [
            {
              catalogProductId: 'catalog_123',
              productId: 'product_123',
              provider: 'lemonsqueezy',
              providerProductRef: 'lemonsqueezy-ref',
            },
          ],
        };
      }

      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference !== apiMock.verificationIntents.createVerificationIntent) {
        throw new Error(`Unexpected mutation reference: ${String(reference)}`);
      }

      expect((args as { requirements: Array<{ kind: string }> }).requirements).toEqual([
        expect.objectContaining({ kind: 'existing_entitlement' }),
        expect.objectContaining({
          kind: 'manual_license',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          providerProductRef: 'lemonsqueezy-ref',
        }),
      ]);
      return { intentId: 'intent_789' };
    });
    convexActionMock.mockImplementation(async (reference: unknown) => {
      if (reference !== apiMock.verificationIntents.getVerificationIntent) {
        throw new Error(`Unexpected action reference: ${String(reference)}`);
      }

      return { id: 'intent_789' };
    });

    const routes = createRoutes();
    const response = await routes.postBuyerProductAccessVerificationIntent(
      new Request('http://localhost:3001/api/connect/user/product-access/catalog_123', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnTo: '/dashboard' }),
      }),
      'catalog_123'
    );

    expect(response.status).toBe(200);
  });
});
