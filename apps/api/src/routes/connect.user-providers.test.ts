import { describe, expect, it } from 'bun:test';
import type { Auth } from '../auth';
import { type ConnectConfig, createConnectRoutes } from './connect';

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

const auth = {
  getSession: async () => null,
  getDiscordUserId: async () => null,
  createPolarCheckout: async () => null,
  createPolarPortal: async () => null,
} as unknown as Auth;

describe('GET /api/connect/user/providers', () => {
  it('only exposes hosted verification providers as connectable account links', async () => {
    const routes = createConnectRoutes(auth, testConfig);
    const response = await routes.getUserProviders(
      new Request('http://localhost:3001/api/connect/user/providers')
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      providers: Array<{
        id: string;
      }>;
    };
    const providerIds = body.providers.map((provider) => provider.id);

    expect(providerIds).toContain('gumroad');
    expect(providerIds).not.toContain('jinxxy');
    expect(providerIds).not.toContain('vrchat');
  });

  it('rejects direct buyer-link connect attempts for Jinxxy', async () => {
    const routes = createConnectRoutes(
      {
        ...auth,
        getSession: async () => ({
          user: {
            id: 'user_jinxxy_001',
          },
        }),
      } as unknown as Auth,
      testConfig
    );

    const response = await routes.postUserVerifyStart(
      new Request('http://localhost:3001/api/connect/user/verify/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey: 'jinxxy' }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Provider 'jinxxy' does not support user identity linking",
    });
  });
});
