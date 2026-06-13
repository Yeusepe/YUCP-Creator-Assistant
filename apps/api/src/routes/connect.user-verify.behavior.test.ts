import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ConnectConfig } from '../providers/types';
import { createTestLogger } from '../testSupport/loggerMock';

const convexQueryMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => null
);
const convexMutationMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => undefined
);
const convexActionMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => undefined
);
const loggerErrorMock = mock(() => undefined);
const loggerWarnMock = mock(() => undefined);

const apiMock = {
  authViewer: {
    getDiscordUserIdByAuthUser: 'authViewer.getDiscordUserIdByAuthUser',
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
  logger: createTestLogger({
    error: loggerErrorMock,
    info: mock(() => undefined),
    warn: loggerWarnMock,
  }),
}));

mock.module('../lib/observability', () => ({
  withApiSpan: async (
    _name: string,
    _attributes: Record<string, unknown>,
    callback: () => Promise<unknown>
  ) => callback(),
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

function createRoutes() {
  return createConnectUserVerificationRoutes({
    auth: {
      getSession: async () => ({
        user: {
          id: 'buyer_auth_user_B',
        },
      }),
    } as never,
    config: testConfig,
    isTenantOwnedBySessionUser: async () => false,
  });
}

describe('POST /api/connect/user/verify/start', () => {
  beforeEach(() => {
    convexQueryMock.mockReset();
    convexMutationMock.mockReset();
    convexActionMock.mockReset();
    loggerErrorMock.mockReset();
    loggerWarnMock.mockReset();
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference !== apiMock.authViewer.getDiscordUserIdByAuthUser) {
        throw new Error(`Unexpected query reference: ${String(reference)}`);
      }

      expect(args).toEqual({
        apiSecret: 'test-convex-secret',
        authUserId: 'buyer_auth_user_B',
      });
      return 'discord_user_123';
    });
  });

  it('builds an account-link verification redirect that preserves the signed-in auth user and safe return path', async () => {
    const routes = createRoutes();

    const response = await routes.postUserVerifyStart(
      new Request('http://localhost:3001/api/connect/user/verify/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: 'itchio',
          returnUrl: '/account/connections?tab=buyer-links',
        }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { redirectUrl: string };
    const redirectUrl = new URL(body.redirectUrl, testConfig.frontendBaseUrl);

    expect(redirectUrl.pathname).toBe('/api/verification/begin');
    expect(redirectUrl.searchParams.get('authUserId')).toBe('buyer_auth_user_B');
    expect(redirectUrl.searchParams.get('mode')).toBe('itchio');
    expect(redirectUrl.searchParams.get('verificationMethod')).toBe('account_link');
    expect(redirectUrl.searchParams.get('redirectUri')).toBe(
      'http://localhost:3000/account/connections?tab=buyer-links'
    );
    expect(redirectUrl.searchParams.get('discordUserId')).toBe('discord_user_123');
  });

  it('falls back to the account connections page when the caller sends an unsafe return URL', async () => {
    const routes = createRoutes();

    const response = await routes.postUserVerifyStart(
      new Request('http://localhost:3001/api/connect/user/verify/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: 'itchio',
          returnUrl: 'https://evil.example/phishing',
        }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { redirectUrl: string };
    const redirectUrl = new URL(body.redirectUrl, testConfig.frontendBaseUrl);

    expect(redirectUrl.searchParams.get('redirectUri')).toBe(
      'http://localhost:3000/account/connections'
    );
  });

  it('rejects providers that do not support buyer identity linking', async () => {
    const routes = createRoutes();

    const response = await routes.postUserVerifyStart(
      new Request('http://localhost:3001/api/connect/user/verify/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey: 'vrchat',
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Provider 'vrchat' does not support user identity linking",
    });
  });
});
