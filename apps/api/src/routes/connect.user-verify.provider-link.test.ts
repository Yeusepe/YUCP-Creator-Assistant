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
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => ({
    success: true,
  })
);

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    verificationIntents: {
      verifyIntentWithBuyerProviderLink: 'verificationIntents.verifyIntentWithBuyerProviderLink',
    },
  },
  internal: {},
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: convexActionMock,
  }),
}));

mock.module('../lib/observability', () => ({
  withApiSpan: async (
    _name: string,
    _attributes: Record<string, unknown>,
    callback: () => Promise<unknown>
  ) => callback(),
}));

mock.module('../lib/logger', () => ({
  logger: createTestLogger({
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  }),
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

describe('POST /api/connect/user/verification/:intentId/verify-provider-link', () => {
  beforeEach(() => {
    convexQueryMock.mockReset();
    convexMutationMock.mockReset();
    convexActionMock.mockReset();
    convexActionMock.mockResolvedValue({ success: true });
  });

  it('routes hosted buyer-provider-link verification through the public Convex action instead of provider-specific API-side internal calls', async () => {
    const routes = createConnectUserVerificationRoutes({
      auth: {
        getSession: async () => ({
          user: {
            id: 'buyer-auth-user',
          },
        }),
      } as never,
      config: testConfig,
      isTenantOwnedBySessionUser: async () => false,
    });

    const response = await routes.postUserVerificationProviderLink(
      new Request(
        'http://localhost:3001/api/connect/user/verification/intent_123/verify-provider-link',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            methodKey: 'gumroad-link',
          }),
        }
      ),
      'intent_123'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(convexActionMock).toHaveBeenCalledWith(
      'verificationIntents.verifyIntentWithBuyerProviderLink',
      {
        apiSecret: 'test-convex-secret',
        authUserId: 'buyer-auth-user',
        intentId: 'intent_123',
        methodKey: 'gumroad-link',
      }
    );
  });
});
