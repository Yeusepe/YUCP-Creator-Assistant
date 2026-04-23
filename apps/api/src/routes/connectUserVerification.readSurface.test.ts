import { beforeEach, describe, expect, it, mock } from 'bun:test';
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

const buyerLink = {
  id: 'buyer-link-itchio-1',
  provider: 'itchio',
  label: 'itch.io account',
  status: 'active',
  providerUserId: 'buyer_b_user_id',
  providerUsername: 'buyer-b',
  verificationMethod: 'account_link',
  linkedAt: 1,
  lastValidatedAt: 2,
  expiresAt: null,
  createdAt: 1,
  updatedAt: 2,
};

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
    convexMutationMock.mockResolvedValue(undefined);
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference !== apiMock.subjects.listBuyerProviderLinksForAuthUser) {
        throw new Error(`Unexpected query reference: ${String(reference)}`);
      }

      return (args as { authUserId: string }).authUserId === 'buyer_auth_user_B' ? [buyerLink] : [];
    });
  });

  it('shows buyer B link for buyer B while creator A stays empty even if buyer authUserId is requested', async () => {
    const creatorRoutes = createRoutes('creator_auth_user_A');
    const creatorResponse = await creatorRoutes.getUserAccounts(
      new Request('http://localhost:3001/api/connect/user/accounts?authUserId=buyer_auth_user_B')
    );

    expect(creatorResponse.status).toBe(200);
    await expect(creatorResponse.json()).resolves.toEqual({
      connections: [],
    });
    expect(convexMutationMock).toHaveBeenNthCalledWith(
      1,
      apiMock.subjects.reconcileBuyerProviderLinksForAuthUser,
      {
        apiSecret: 'test-convex-secret',
        authUserId: 'creator_auth_user_A',
      }
    );
    expect(convexQueryMock).toHaveBeenNthCalledWith(
      1,
      apiMock.subjects.listBuyerProviderLinksForAuthUser,
      {
        apiSecret: 'test-convex-secret',
        authUserId: 'creator_auth_user_A',
      }
    );

    const buyerRoutes = createRoutes('buyer_auth_user_B');
    const buyerResponse = await buyerRoutes.getUserAccounts(
      new Request('http://localhost:3001/api/connect/user/accounts')
    );

    expect(buyerResponse.status).toBe(200);
    await expect(buyerResponse.json()).resolves.toEqual({
      connections: [
        {
          id: 'buyer-link-itchio-1',
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
    expect(convexMutationMock).toHaveBeenNthCalledWith(
      2,
      apiMock.subjects.reconcileBuyerProviderLinksForAuthUser,
      {
        apiSecret: 'test-convex-secret',
        authUserId: 'buyer_auth_user_B',
      }
    );
    expect(convexQueryMock).toHaveBeenNthCalledWith(
      2,
      apiMock.subjects.listBuyerProviderLinksForAuthUser,
      {
        apiSecret: 'test-convex-secret',
        authUserId: 'buyer_auth_user_B',
      }
    );
  });
});

describe('DELETE /api/connect/user/accounts', () => {
  beforeEach(() => {
    convexQueryMock.mockReset();
    convexMutationMock.mockReset();
    loggerErrorMock.mockReset();
    convexMutationMock.mockResolvedValue({ success: true });
  });

  it('disconnects the signed-in user account link through the revoke mutation', async () => {
    const routes = createRoutes('buyer_auth_user_B');
    const response = await routes.deleteUserAccount(
      new Request('http://localhost:3001/api/connect/user/accounts?id=buyer-link-itchio-1', {
        method: 'DELETE',
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(convexMutationMock).toHaveBeenCalledWith(apiMock.subjects.revokeBuyerProviderLink, {
      apiSecret: 'test-convex-secret',
      authUserId: 'buyer_auth_user_B',
      linkId: 'buyer-link-itchio-1',
    });
  });
});
