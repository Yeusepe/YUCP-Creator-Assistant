import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { verifyDeliveryUrl } from '../../../../ops/storage-core/deliverySigning';
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
  packageRegistry: {
    getBuyerAccessContextByCatalogProductId:
      'packageRegistry.getBuyerAccessContextByCatalogProductId',
    getBuyerAccessContextByCreatorAndProductRef:
      'packageRegistry.getBuyerAccessContextByCreatorAndProductRef',
  },
  entitlements: {
    listByAuthUser: 'entitlements.listByAuthUser',
  },
  packageVersions: {
    resolveDownloadableVersion: 'packageVersions.resolveDownloadableVersion',
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
  buildCatalogProductUrl: (provider: string, ref: string) => {
    if (provider === 'jinxxy') {
      return `https://jinxxy.app/products/${ref}`;
    }
    return `https://store.test/${provider}/${ref}`;
  },
  getProviderDescriptor: (provider: string) => {
    const descriptors: Record<
      string,
      {
        buyerVerificationMethods: string[];
        capabilities: string[];
        supportsAutoDiscovery?: boolean;
        supportsBuyerOAuthLink?: boolean;
      }
    > = {
      gumroad: {
        buyerVerificationMethods: ['account_link', 'license_key'],
        capabilities: ['catalog_sync', 'license_verification'],
        supportsAutoDiscovery: true,
        supportsBuyerOAuthLink: true,
      },
      jinxxy: {
        buyerVerificationMethods: ['account_link', 'license_key'],
        capabilities: ['catalog_sync', 'tier_catalog', 'license_verification'],
        supportsAutoDiscovery: false,
        supportsBuyerOAuthLink: true,
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
};

const deliveryHmacKey = 'buyer-download-route-test-hmac-key';
const downloadConfig = {
  ...testConfig,
  deliveryBaseUrl: 'https://delivery.example.test/',
  deliveryHmacKey,
};

function createRoutes(configOverrides: Partial<typeof downloadConfig> = {}) {
  return createConnectUserProductAccessRoutes({
    auth: {
      getSession: async () => ({
        user: {
          id: 'buyer-auth-user',
        },
      }),
    } as never,
    config: { ...downloadConfig, ...configOverrides },
  });
}

function createSignedOutRoutes(configOverrides: Partial<typeof downloadConfig> = {}) {
  return createConnectUserProductAccessRoutes({
    auth: {
      getSession: async () => null,
    } as never,
    config: { ...downloadConfig, ...configOverrides },
  });
}

function downloadRequest(headers?: HeadersInit): Request {
  return new Request('http://localhost:3001/api/access/catalog_123/download', { headers });
}

function mockDownloadAccess(options: {
  activeEntitlement: boolean | { catalogProductId?: string | null };
  downloadableVersion?: { versionId: string } | null;
  requestedCatalogProductId?: string;
  resolvedCatalogProductId?: string;
}) {
  const requestedCatalogProductId = options.requestedCatalogProductId ?? 'catalog_123';
  const resolvedCatalogProductId = options.resolvedCatalogProductId ?? 'catalog_123';
  convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
    if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
      expect(args).toEqual({
        apiSecret: 'test-convex-secret',
        actor: 'service-actor-binding',
        catalogProductId: requestedCatalogProductId,
      });
      return {
        catalogProductId: resolvedCatalogProductId,
        creatorAuthUserId: 'creator-auth-user',
        productId: 'product_123',
        provider: 'gumroad',
        providerProductRef: 'gumroad-ref',
        displayName: 'Avatar Bundle',
        status: 'active',
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
      const activeEntitlement =
        options.activeEntitlement === true
          ? { catalogProductId: resolvedCatalogProductId }
          : options.activeEntitlement || null;
      return {
        data: activeEntitlement ? [{ id: 'ent_1', ...activeEntitlement }] : [],
        hasMore: false,
      };
    }
    if (reference === apiMock.packageVersions.resolveDownloadableVersion) {
      expect(args).toEqual({
        apiSecret: 'test-convex-secret',
        actor: 'service-actor-binding',
        catalogProductId: resolvedCatalogProductId,
      });
      return options.downloadableVersion ?? null;
    }

    throw new Error(`Unexpected query reference: ${String(reference)}`);
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

  it('returns 401 from buyer downloads without a Better Auth session', async () => {
    const response = await createSignedOutRoutes().downloadBuyerProductAccess(
      downloadRequest(),
      'catalog_123'
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required' });
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('returns 503 to an entitled buyer when downloads are not configured', async () => {
    mockDownloadAccess({ activeEntitlement: true });

    const response = await createRoutes({
      deliveryBaseUrl: undefined,
      deliveryHmacKey: undefined,
    }).downloadBuyerProductAccess(downloadRequest(), 'catalog_123');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Downloads are not configured' });
    expect(convexQueryMock).not.toHaveBeenCalledWith(
      apiMock.packageVersions.resolveDownloadableVersion,
      expect.anything()
    );
  });

  it('returns 403 from buyer downloads without an active entitlement', async () => {
    mockDownloadAccess({ activeEntitlement: false });

    const response = await createRoutes().downloadBuyerProductAccess(
      downloadRequest(),
      'catalog_123'
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Active entitlement required' });
    expect(convexQueryMock).not.toHaveBeenCalledWith(
      apiMock.packageVersions.resolveDownloadableVersion,
      expect.anything()
    );
  });

  it('302 redirects an entitled buyer to a short-lived signed READY-version URL', async () => {
    mockDownloadAccess({
      activeEntitlement: true,
      downloadableVersion: { versionId: 'version-ready-123' },
    });
    const beforeRequest = Date.now();

    const response = await createRoutes().downloadBuyerProductAccess(
      downloadRequest(),
      'catalog_123'
    );

    const afterRequest = Date.now();
    expect(response.status).toBe(302);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const location = response.headers.get('Location');
    expect(location).not.toBeNull();
    const deliveryUrl = new URL(location ?? '');
    expect(deliveryUrl.origin).toBe('https://delivery.example.test');
    expect(deliveryUrl.pathname).toBe('/d/version-ready-123');
    const exp = deliveryUrl.searchParams.get('exp') ?? '';
    const sig = deliveryUrl.searchParams.get('sig') ?? '';
    expect(
      await verifyDeliveryUrl({
        versionId: 'version-ready-123',
        key: deliveryHmacKey,
        exp,
        sig,
        now: beforeRequest,
      })
    ).toBe(true);
    const expiryMilliseconds = Number(exp) * 1000;
    expect(expiryMilliseconds).toBeGreaterThanOrEqual(beforeRequest + 5 * 60_000 - 1000);
    expect(expiryMilliseconds).toBeLessThanOrEqual(afterRequest + 5 * 60_000);
  });

  it('resolves a download slug to its catalog product id before the version lookup', async () => {
    mockDownloadAccess({
      activeEntitlement: true,
      downloadableVersion: { versionId: 'version-ready-from-slug' },
      requestedCatalogProductId: 'avatar-bundle',
      resolvedCatalogProductId: 'catalog_resolved_123',
    });

    const response = await createRoutes().downloadBuyerProductAccess(
      downloadRequest(),
      'avatar-bundle'
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/d/version-ready-from-slug');
    expect(convexQueryMock).toHaveBeenCalledWith(
      apiMock.packageVersions.resolveDownloadableVersion,
      expect.objectContaining({ catalogProductId: 'catalog_resolved_123' })
    );
  });

  it('302 redirects for a product-level entitlement without a catalog product id', async () => {
    mockDownloadAccess({
      activeEntitlement: {},
      downloadableVersion: { versionId: 'version-ready-product-level' },
    });

    const response = await createRoutes().downloadBuyerProductAccess(
      downloadRequest(),
      'catalog_123'
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/d/version-ready-product-level');
  });

  it('302 redirects when the matching entitlement belongs to a second linked subject', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          status: 'active',
        };
      }
      if (reference === apiMock.entitlements.listByAuthUser) {
        const query = args as { cursor?: string; scope?: string };
        expect(query.scope).toBe('subject_holder');
        return query.cursor
          ? { data: [{ id: 'ent_2', catalogProductId: 'catalog_123' }], hasMore: false }
          : {
              data: [{ id: 'ent_1', catalogProductId: 'catalog_other' }],
              hasMore: true,
              nextCursor: 'second-linked-subject-page',
            };
      }
      if (reference === apiMock.packageVersions.resolveDownloadableVersion) {
        return { versionId: 'version-ready-second-subject' };
      }
      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const response = await createRoutes().downloadBuyerProductAccess(
      downloadRequest(),
      'catalog_123'
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/d/version-ready-second-subject');
    expect(convexQueryMock).toHaveBeenCalledWith(
      apiMock.entitlements.listByAuthUser,
      expect.objectContaining({ cursor: 'second-linked-subject-page' })
    );
  });

  it('returns 404 to an entitled buyer when no READY version exists', async () => {
    mockDownloadAccess({ activeEntitlement: true, downloadableVersion: null });

    const response = await createRoutes().downloadBuyerProductAccess(
      downloadRequest(),
      'catalog_123'
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Product is not yet published' });
  });

  it('returns product entitlement state for the signed-in buyer', async () => {
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
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          canonicalSlug: 'avatar-bundle',
          thumbnailUrl: 'https://cdn.test/avatar.png',
          status: 'active',
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
        storefrontUrl: 'https://store.test/gumroad/gumroad-ref',
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
      },
    });
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
