import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  BUYER_PROVIDER_LINK_SURFACE_MATRIX,
  createBuyerProviderLinkRecord,
  createBuyerProviderLinkStore,
} from '../../../../packages/shared/test/buyerProviderLinkInvariantMatrix';
import type { ConnectConfig } from '../providers/types';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => [] as unknown[]);
const convexMutationMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => undefined
);
const loggerErrorMock = mock(() => undefined);

const apiMock = {
  subjects: {
    reconcileBuyerProviderLinksForAuthUser: 'subjects.reconcileBuyerProviderLinksForAuthUser',
    listBuyerProviderLinksForAuthUser: 'subjects.listBuyerProviderLinksForAuthUser',
    revokeBuyerProviderLink: 'subjects.revokeBuyerProviderLink',
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
  }),
}));

mock.module('../lib/logger', () => ({
  logger: {
    error: loggerErrorMock,
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

mock.module('../lib/observability', () => ({
  withApiSpan: async (
    _name: string,
    _attributes: Record<string, unknown>,
    callback: () => Promise<unknown>
  ) => callback(),
}));

mock.module('../providers/display', () => ({
  getConnectedAccountProviderDisplay: (provider: string) => ({
    label: provider === 'itchio' ? 'itch.io' : provider,
    icon: provider === 'itchio' ? 'Itchio.png' : null,
    color: provider === 'itchio' ? '#fa5c5c' : null,
    description: 'Linked provider',
  }),
  listDashboardProviderDisplays: () => [
    {
      key: 'gumroad',
      setupExperience: 'automatic',
      setupHint: 'Connect Gumroad',
      label: 'Gumroad',
      icon: 'Gumroad.png',
      iconBg: '#ff90e8',
      quickStartBg: '#fff5fd',
      quickStartBorder: '#f9a8d4',
      serverTileHint: 'Connect your Gumroad store',
      connectPath: '/api/connect/gumroad/begin',
      connectParamStyle: 'snakeCase',
    },
    {
      key: 'itchio',
      setupExperience: 'automatic',
      setupHint: 'Connect itch.io',
      label: 'itch.io',
      icon: 'Itchio.png',
      iconBg: '#fa5c5c',
      quickStartBg: '#fff1f1',
      quickStartBorder: '#fca5a5',
      serverTileHint: 'Connect your itch.io account',
      connectPath: '/api/connect/itchio/begin',
      connectParamStyle: 'snakeCase',
    },
    {
      key: 'jinxxy',
      setupExperience: 'automatic',
      setupHint: 'Connect Jinxxy',
      label: 'Jinxxy',
      icon: 'Jinxxy.png',
      iconBg: '#8b5cf6',
      quickStartBg: '#f5f3ff',
      quickStartBorder: '#c4b5fd',
      serverTileHint: 'Connect your Jinxxy store',
      connectPath: '/api/connect/jinxxy/begin',
      connectParamStyle: 'snakeCase',
    },
    {
      key: 'lemonsqueezy',
      setupExperience: 'automatic',
      setupHint: 'Connect Lemon Squeezy',
      label: 'Lemon Squeezy',
      icon: 'LemonSqueezy.png',
      iconBg: '#f59e0b',
      quickStartBg: '#fffbeb',
      quickStartBorder: '#fcd34d',
      serverTileHint: 'Connect your Lemon Squeezy store',
      connectPath: '/api/connect/lemonsqueezy/begin',
      connectParamStyle: 'snakeCase',
    },
    {
      key: 'payhip',
      setupExperience: 'manual',
      setupHint: 'Connect Payhip',
      label: 'Payhip',
      icon: 'Payhip.png',
      iconBg: '#0f766e',
      quickStartBg: '#f0fdfa',
      quickStartBorder: '#5eead4',
      serverTileHint: 'Connect your Payhip store',
      connectPath: '/setup/payhip?mode=connect',
      connectParamStyle: 'snakeCase',
    },
    {
      key: 'vrchat',
      setupExperience: 'guided',
      setupHint: 'Connect VRChat',
      label: 'VRChat',
      icon: 'VRChat.png',
      iconBg: '#2563eb',
      quickStartBg: '#eff6ff',
      quickStartBorder: '#93c5fd',
      serverTileHint: 'Connect your VRChat account',
      connectPath: '/setup/vrchat?mode=connect',
      connectParamStyle: 'snakeCase',
    },
  ],
  listHostedVerificationProviderDisplays: () => [],
}));

const { createConnectUserVerificationRoutes } = await import('./connectUserVerification');

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

const ACCOUNT_SURFACE_PROVIDER_MATRIX = [
  {
    provider: 'itchio',
    label: 'itch.io account',
    providerUserId: 'buyer_itchio_user',
    providerUsername: 'buyer-itch',
    verificationMethod: 'account_link',
    expectedDisplay: {
      label: 'itch.io',
      icon: 'Itchio.png',
      color: '#fa5c5c',
      description: 'Linked provider',
    },
  },
  {
    provider: 'gumroad',
    label: 'Gumroad account',
    providerUserId: 'buyer_gumroad_user',
    providerUsername: 'buyer-gumroad',
    verificationMethod: 'oauth',
    expectedDisplay: {
      label: 'gumroad',
      icon: null,
      color: null,
      description: 'Linked provider',
    },
  },
  {
    provider: 'gumroad',
    label: 'Gumroad account link',
    providerUserId: 'buyer_gumroad_account_link_user',
    providerUsername: 'buyer-gumroad-account-link',
    verificationMethod: 'account_link',
    expectedDisplay: {
      label: 'gumroad',
      icon: null,
      color: null,
      description: 'Linked provider',
    },
  },
  {
    provider: 'vrchat',
    label: 'VRChat account',
    providerUserId: 'buyer_vrchat_user',
    providerUsername: 'buyer-vrchat',
    verificationMethod: 'account_link',
    expectedDisplay: {
      label: 'vrchat',
      icon: null,
      color: null,
      description: 'Linked provider',
    },
  },
] as const;

const ACCOUNT_SURFACE_RECORD_SHAPES = [
  {
    name: 'current',
    includeProviderUsername: true,
    includeVerificationMethod: true,
    includeLastValidatedAt: true,
    includeExpiresAt: true,
  },
  {
    name: 'legacy',
    includeProviderUsername: false,
    includeVerificationMethod: false,
    includeLastValidatedAt: false,
    includeExpiresAt: false,
  },
] as const;

const ACCOUNT_SURFACE_VISIBLE_STATUS_MATRIX = BUYER_PROVIDER_LINK_SURFACE_MATRIX.filter(
  (entry) => entry.expectVisible
);

function createRoutes(sessionUserId: string) {
  return createConnectUserVerificationRoutes({
    auth: {
      getSession: async () => ({
        user: {
          id: sessionUserId,
        },
      }),
    } as never,
    config: testConfig,
    isTenantOwnedBySessionUser: async () => false,
  });
}

describe('GET /api/connect/user/accounts', () => {
  beforeEach(() => {
    convexQueryMock.mockReset();
    convexMutationMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('isolates account-link reads and revokes to the signed-in owner', async () => {
    const store = createBuyerProviderLinkStore([createBuyerProviderLinkRecord()]);
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference !== apiMock.subjects.listBuyerProviderLinksForAuthUser) {
        throw new Error(`Unexpected query reference: ${String(reference)}`);
      }

      return store.listBuyerProviderLinks((args as { authUserId: string }).authUserId);
    });
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.subjects.reconcileBuyerProviderLinksForAuthUser) {
        return { reconciledCount: 0 };
      }

      if (reference === apiMock.subjects.revokeBuyerProviderLink) {
        return {
          success: store.revoke(
            (args as { authUserId: string }).authUserId,
            (args as { linkId: string }).linkId
          ),
        };
      }

      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });

    const creatorRoutes = createRoutes('creator_auth_user_A');
    const creatorResponse = await creatorRoutes.getUserAccounts(
      new Request('http://localhost:3001/api/connect/user/accounts')
    );

    expect(creatorResponse.status).toBe(200);
    await expect(creatorResponse.json()).resolves.toEqual({
      connections: [],
    });
    expect(convexMutationMock).not.toHaveBeenCalled();
    expect(store.snapshot()[0]?.status).toBe('active');

    const creatorDisconnect = await creatorRoutes.deleteUserAccount(
      new Request('http://localhost:3001/api/connect/user/accounts?id=buyer-link-active-1', {
        method: 'DELETE',
      })
    );
    expect(creatorDisconnect.status).toBe(404);
    await expect(creatorDisconnect.json()).resolves.toEqual({
      error: 'Account link not found',
    });
    expect(store.snapshot()[0]?.status).toBe('active');

    const buyerRoutes = createRoutes('buyer_auth_user_B');
    const buyerResponse = await buyerRoutes.getUserAccounts(
      new Request('http://localhost:3001/api/connect/user/accounts')
    );

    expect(buyerResponse.status).toBe(200);
    await expect(buyerResponse.json()).resolves.toEqual({
      connections: [
        {
          id: 'buyer-link-active-1',
          provider: 'itchio',
          label: 'itch.io account',
          connectionType: 'verification',
          status: 'active',
          webhookConfigured: false,
          hasApiKey: false,
          hasAccessToken: false,
          providerUserId: 'buyer_b_user_id',
          providerUsername: 'buyer-b',
          verificationMethod: 'account_link',
          providerDisplay: {
            label: 'itch.io',
            icon: 'Itchio.png',
            color: '#fa5c5c',
            description: 'Linked provider',
          },
          linkedAt: 1,
          lastValidatedAt: 2,
          expiresAt: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });

    const buyerDisconnect = await buyerRoutes.deleteUserAccount(
      new Request('http://localhost:3001/api/connect/user/accounts?id=buyer-link-active-1', {
        method: 'DELETE',
      })
    );
    expect(buyerDisconnect.status).toBe(200);
    await expect(buyerDisconnect.json()).resolves.toEqual({ success: true });
    expect(store.snapshot()[0]?.status).toBe('revoked');

    const buyerAfterDisconnect = await buyerRoutes.getUserAccounts(
      new Request('http://localhost:3001/api/connect/user/accounts')
    );
    expect(buyerAfterDisconnect.status).toBe(200);
    await expect(buyerAfterDisconnect.json()).resolves.toEqual({
      connections: [],
    });
  });

  it('reconciles buyer provider links only when refresh=1 is requested', async () => {
    const store = createBuyerProviderLinkStore([
      createBuyerProviderLinkRecord({
        authUserId: 'buyer_auth_user_B',
      }),
    ]);
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference !== apiMock.subjects.listBuyerProviderLinksForAuthUser) {
        throw new Error(`Unexpected query reference: ${String(reference)}`);
      }

      return store.listBuyerProviderLinks((args as { authUserId: string }).authUserId);
    });
    convexMutationMock.mockImplementation(async (reference: unknown) => {
      if (reference !== apiMock.subjects.reconcileBuyerProviderLinksForAuthUser) {
        throw new Error(`Unexpected mutation reference: ${String(reference)}`);
      }

      return { reconciledCount: 0 };
    });

    const routes = createRoutes('buyer_auth_user_B');
    const response = await routes.getUserAccounts(
      new Request('http://localhost:3001/api/connect/user/accounts?refresh=1')
    );

    expect(response.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.subjects.reconcileBuyerProviderLinksForAuthUser,
      {
        apiSecret: 'test-convex-secret',
        authUserId: 'buyer_auth_user_B',
      }
    );
  });

  for (const matrixCase of BUYER_PROVIDER_LINK_SURFACE_MATRIX) {
    it(`maps ${matrixCase.name}`, async () => {
      const store = createBuyerProviderLinkStore([
        createBuyerProviderLinkRecord({
          status: matrixCase.status,
        }),
      ]);
      convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
        if (reference !== apiMock.subjects.listBuyerProviderLinksForAuthUser) {
          throw new Error(`Unexpected query reference: ${String(reference)}`);
        }

        return store.listBuyerProviderLinks((args as { authUserId: string }).authUserId);
      });
      convexMutationMock.mockImplementation(async (reference: unknown) => {
        if (reference === apiMock.subjects.reconcileBuyerProviderLinksForAuthUser) {
          return { reconciledCount: 0 };
        }

        throw new Error(`Unexpected mutation reference: ${String(reference)}`);
      });

      const routes = createRoutes('buyer_auth_user_B');
      const response = await routes.getUserAccounts(
        new Request('http://localhost:3001/api/connect/user/accounts')
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        connections: matrixCase.expectVisible
          ? [
              {
                id: `buyer-link-${matrixCase.status}-1`,
                provider: 'itchio',
                label: 'itch.io account',
                connectionType: 'verification',
                status: matrixCase.status,
                webhookConfigured: false,
                hasApiKey: false,
                hasAccessToken: false,
                providerUserId: 'buyer_b_user_id',
                providerUsername: 'buyer-b',
                verificationMethod: 'account_link',
                providerDisplay: {
                  label: 'itch.io',
                  icon: 'Itchio.png',
                  color: '#fa5c5c',
                  description: 'Linked provider',
                },
                linkedAt: 1,
                lastValidatedAt: 2,
                expiresAt: matrixCase.status === 'expired' ? 2 : null,
                createdAt: 1,
                updatedAt: 2,
              },
            ]
          : [],
      });
    });
  }

  for (const statusCase of ACCOUNT_SURFACE_VISIBLE_STATUS_MATRIX) {
    for (const providerCase of ACCOUNT_SURFACE_PROVIDER_MATRIX) {
      for (const recordShape of ACCOUNT_SURFACE_RECORD_SHAPES) {
        it(`maps ${providerCase.provider} ${providerCase.verificationMethod} ${recordShape.name} records when link status is ${statusCase.status}`, async () => {
          const recordId = `buyer-link-${providerCase.provider}-${statusCase.status}-${recordShape.name}`;
          const expectedExpiresAt = recordShape.includeExpiresAt
            ? statusCase.status === 'expired'
              ? 30
              : 300
            : null;
          const store = createBuyerProviderLinkStore([
            createBuyerProviderLinkRecord({
              id: recordId,
              status: statusCase.status,
              provider: providerCase.provider,
              label: providerCase.label,
              providerUserId: providerCase.providerUserId,
              providerUsername: recordShape.includeProviderUsername
                ? providerCase.providerUsername
                : null,
              verificationMethod: recordShape.includeVerificationMethod
                ? providerCase.verificationMethod
                : null,
              lastValidatedAt: recordShape.includeLastValidatedAt ? 20 : null,
              expiresAt: expectedExpiresAt,
            }),
          ]);
          convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
            if (reference !== apiMock.subjects.listBuyerProviderLinksForAuthUser) {
              throw new Error(`Unexpected query reference: ${String(reference)}`);
            }

            return store.listBuyerProviderLinks((args as { authUserId: string }).authUserId);
          });
          convexMutationMock.mockImplementation(async (reference: unknown) => {
            if (reference === apiMock.subjects.reconcileBuyerProviderLinksForAuthUser) {
              return { reconciledCount: 0 };
            }

            throw new Error(`Unexpected mutation reference: ${String(reference)}`);
          });

          const routes = createRoutes('buyer_auth_user_B');
          const response = await routes.getUserAccounts(
            new Request('http://localhost:3001/api/connect/user/accounts')
          );

          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toEqual({
            connections: [
              {
                id: recordId,
                provider: providerCase.provider,
                label: providerCase.label,
                connectionType: 'verification',
                status: statusCase.status,
                webhookConfigured: false,
                hasApiKey: false,
                hasAccessToken: false,
                providerUserId: providerCase.providerUserId,
                providerUsername: recordShape.includeProviderUsername
                  ? providerCase.providerUsername
                  : null,
                verificationMethod: recordShape.includeVerificationMethod
                  ? providerCase.verificationMethod
                  : null,
                providerDisplay: providerCase.expectedDisplay,
                linkedAt: 1,
                lastValidatedAt: recordShape.includeLastValidatedAt ? 20 : null,
                expiresAt: expectedExpiresAt,
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          });
        });
      }
    }
  }
});

describe('DELETE /api/connect/user/accounts', () => {
  beforeEach(() => {
    convexQueryMock.mockReset();
    convexMutationMock.mockReset();
    loggerErrorMock.mockReset();
    convexMutationMock.mockResolvedValue({ success: true });
  });

  it('disconnects the signed-in user account link through the revoke mutation', async () => {
    convexMutationMock.mockResolvedValue({ success: true });
    const routes = createRoutes('buyer_auth_user_B');
    const response = await routes.deleteUserAccount(
      new Request('http://localhost:3001/api/connect/user/accounts?id=buyer-link-active-1', {
        method: 'DELETE',
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(convexMutationMock).toHaveBeenCalledWith(apiMock.subjects.revokeBuyerProviderLink, {
      apiSecret: 'test-convex-secret',
      authUserId: 'buyer_auth_user_B',
      linkId: 'buyer-link-active-1',
    });
  });
});
