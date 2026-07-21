import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../../../../convex/auth';

const ORIGINAL_ENV = { ...process.env };
const TEST_CONVEX_SITE_HOST = 'example.convex.site';
const TEST_CONVEX_DEPLOYMENT_HOST = 'example.convex.cloud';

const offlineConvexFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : input);

  if (url.hostname === TEST_CONVEX_SITE_HOST) {
    return Response.json(null);
  }

  if (url.hostname === TEST_CONVEX_DEPLOYMENT_HOST) {
    return Response.json({ status: 'success', value: null });
  }

  throw new Error(`Unexpected outbound request in Convex auth unit test: ${url.origin}`);
});

async function createTestAuth() {
  process.env.BETTER_AUTH_SECRET = 'test-secret-123456789012345678901234';
  process.env.CONVEX_SITE_URL = 'https://example.convex.site';
  process.env.CONVEX_URL = 'https://example.convex.cloud';
  process.env.FRONTEND_URL = 'http://localhost:3000';
  process.env.SITE_URL = 'http://localhost:3000';
  delete process.env.DISCORD_CLIENT_ID;
  delete process.env.DISCORD_CLIENT_SECRET;

  return createAuth({} as never);
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  offlineConvexFetch.mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(offlineConvexFetch);
  vi.spyOn(window, 'fetch').mockImplementation(offlineConvexFetch);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('Convex Better Auth endpoints', () => {
  it('redacts sensitive URL components when rejecting unexpected outbound requests', async () => {
    await expect(
      offlineConvexFetch(
        'https://test-user:test-password@unexpected.example/private?token=test-token#account'
      )
    ).rejects.toMatchObject({
      message: 'Unexpected outbound request in Convex auth unit test: https://unexpected.example',
    });
  });

  it('does not emit the deprecated oidc-provider warning on session requests', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const auth = await createTestAuth();

      const response = await auth.handler(
        new Request('http://localhost:3000/api/auth/get-session')
      );

      expect(response.status).toBe(200);
      expect(
        warnSpy.mock.calls.some((call) =>
          call.some(
            (arg) =>
              typeof arg === 'string' && arg.includes('The "oidc-provider" plugin is deprecated')
          )
        )
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('serves /api/auth/convex/token instead of returning 404', async () => {
    const auth = await createTestAuth();

    const health = await auth.handler(new Request('http://localhost:3000/api/auth/ok'));
    expect(health.status).toBe(200);

    const response = await auth.handler(new Request('http://localhost:3000/api/auth/convex/token'));

    expect(response.status).toBe(401);
  });

  it('exposes OAuth discovery metadata from the Better Auth server API', async () => {
    const auth = await createTestAuth();
    const { oauthProviderAuthServerMetadata } = await import('@better-auth/oauth-provider');

    const response = await oauthProviderAuthServerMetadata(auth)(
      new Request('http://localhost:3000/.well-known/oauth-authorization-server/api/auth')
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      issuer: 'https://example.convex.site/api/auth',
      code_challenge_methods_supported: ['S256'],
    });
  });
});
