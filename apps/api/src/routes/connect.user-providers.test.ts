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
  it('exposes the full hosted verification provider display list', async () => {
    const routes = createConnectRoutes(auth, testConfig);
    const response = await routes.getUserProviders(
      new Request('http://localhost:3001/api/connect/user/providers')
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      providers: Array<{
        id: string;
        icon: string | null;
        color: string | null;
      }>;
    };
    const providerIds = body.providers.map((provider) => provider.id);

    // OAuth marketplace providers
    expect(providerIds).toContain('gumroad');
    expect(providerIds).toContain('itchio');

    // Verification-only OAuth providers (no marketplace plugin, but OAuth buyer identity)
    expect(providerIds).toContain('discord');

    // Non-OAuth hosted verification providers still need display metadata for the purchase page.
    expect(providerIds).toContain('jinxxy');
    expect(providerIds).toContain('lemonsqueezy');
    expect(providerIds).toContain('payhip');
    expect(providerIds).toContain('vrchat');

    // Discord should carry icon and color so the purchase page can display it
    const discord = body.providers.find((p) => p.id === 'discord');
    expect(discord?.icon).toBe('Discord.png');
    expect(discord?.color).toBe('#5865F2');

    const jinxxy = body.providers.find((p) => p.id === 'jinxxy');
    expect(jinxxy?.icon).toBe('Jinxxy.png');
    expect(jinxxy?.color).toBe('#9146FF');
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
