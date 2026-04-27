import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ConnectConfig } from '../providers/types';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const convexMutationMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => undefined
);
const convexActionMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => undefined
);
const loggerErrorMock = mock(() => undefined);

const apiMock = {
  packageRegistry: {
    getBuyerAccessContextByCatalogProductId:
      'packageRegistry.getBuyerAccessContextByCatalogProductId',
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

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: convexActionMock,
  }),
}));

mock.module('../lib/logger', () => ({
  logger: {
    error: loggerErrorMock,
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

mock.module('../lib/apiActor', () => ({
  createAuthUserActorBinding: async () => 'actor-binding',
}));

mock.module('@yucp/providers/providerMetadata', () => ({
  buildCatalogProductUrl: (provider: string, ref: string) =>
    `https://store.test/${provider}/${ref}`,
  getProviderDescriptor: (provider: string) =>
    provider === 'gumroad'
      ? {
          buyerVerificationMethods: ['account_link', 'license_key'],
        }
      : null,
  providerLabel: (provider: string) => (provider === 'gumroad' ? 'Gumroad' : provider),
}));

mock.module('@yucp/shared', () => ({
  getSafeRelativeRedirectTarget: (value?: string) =>
    typeof value === 'string' && value.startsWith('/') ? value : null,
}));

mock.module('@yucp/shared/crypto', () => ({
  sha256Base64Url: async () => 'hashed-code-challenge',
}));

mock.module('../verification/hostedIntents', () => ({
  normalizeHostedVerificationRequirements: (requirements: unknown) => requirements,
  mapHostedVerificationIntentResponse: (intent: { id: string }, frontendBaseUrl: string) => ({
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

function createRoutes() {
  return createConnectUserProductAccessRoutes({
    auth: {
      getSession: async () => ({
        user: {
          id: 'buyer-auth-user',
        },
      }),
    } as never,
    config: testConfig,
  });
}

describe('connect user product access routes', () => {
  beforeEach(() => {
    convexQueryMock.mockReset();
    convexMutationMock.mockReset();
    convexActionMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('returns buyer access state for the signed-in buyer and exposes the dedicated access path', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
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
          backstagePackages: [
            {
              packageId: 'com.yucp.avatar.bundle',
              displayName: 'Avatar Bundle',
              latestPublishedVersion: '1.2.0',
              repositoryVisibility: 'hidden',
            },
          ],
        };
      }
      if (reference === apiMock.entitlements.listByAuthUser) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          authUserId: 'buyer-auth-user',
          productId: 'product_123',
          status: 'active',
          limit: 20,
        });
        return {
          data: [{ id: 'ent_1', catalogProductId: 'catalog_123' }],
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
    await expect(response.json()).resolves.toEqual({
      product: {
        catalogProductId: 'catalog_123',
        displayName: 'Avatar Bundle',
        canonicalSlug: 'avatar-bundle',
        thumbnailUrl: 'https://cdn.test/avatar.png',
        provider: 'gumroad',
        providerLabel: 'Gumroad',
        storefrontUrl: 'https://store.test/gumroad/gumroad-ref',
        accessPagePath: '/access/catalog_123',
        packagePreview: [
          {
            packageId: 'com.yucp.avatar.bundle',
            packageName: null,
            displayName: 'Avatar Bundle',
            defaultChannel: null,
            latestPublishedVersion: '1.2.0',
            latestPublishedAt: null,
            repositoryVisibility: 'hidden',
          },
        ],
      },
      accessState: {
        hasActiveEntitlement: true,
        requiresVerification: false,
        hasPublishedPackages: true,
      },
    });
  });

  it('creates a hosted verification intent with a flow-scoped machine fingerprint when the caller sends an unsafe return path', async () => {
    let createdMachineFingerprint: string | null = null;

    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          status: 'active',
          backstagePackages: [
            {
              packageId: 'com.yucp.avatar.bundle',
              displayName: 'Avatar Bundle',
              repositoryVisibility: 'hidden',
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
        packageId: 'com.yucp.avatar.bundle',
        packageName: 'Avatar Bundle',
        returnUrl: 'http://localhost:3000/access/catalog_123',
        idempotencyKey: 'buyer-access:catalog_123:%2Faccess%2Fcatalog_123',
      });
      expect((args as { machineFingerprint: string }).machineFingerprint).toMatch(
        /^buyer-access-web:[0-9a-f]{32}$/
      );
      createdMachineFingerprint = (args as { machineFingerprint: string }).machineFingerprint;
      expect((args as { requirements: Array<{ kind: string }> }).requirements).toEqual([
        expect.objectContaining({ kind: 'existing_entitlement' }),
        expect.objectContaining({ kind: 'buyer_provider_link' }),
        expect.objectContaining({ kind: 'manual_license' }),
      ]);
      return { intentId: 'intent_123' };
    });
    convexActionMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference !== apiMock.verificationIntents.getVerificationIntent) {
        throw new Error(`Unexpected action reference: ${String(reference)}`);
      }

      expect(args).toEqual({
        apiSecret: 'test-convex-secret',
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
    await expect(response.json()).resolves.toEqual({
      verificationUrl: 'http://localhost:3000/verify/purchase?intent=intent_123',
    });
    expect(response.headers.get('Set-Cookie')).toContain(
      `yucp_buyer_access_machine=${createdMachineFingerprint}`
    );
  });

  it('reuses the existing buyer access machine fingerprint for the same product access flow', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog_123',
          creatorAuthUserId: 'creator-auth-user',
          productId: 'product_123',
          provider: 'gumroad',
          providerProductRef: 'gumroad-ref',
          displayName: 'Avatar Bundle',
          status: 'active',
          backstagePackages: [
            {
              packageId: 'com.yucp.avatar.bundle',
              displayName: 'Avatar Bundle',
              repositoryVisibility: 'hidden',
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
        idempotencyKey: 'buyer-access:catalog_123:%2Faccount%2Flicenses',
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
});
