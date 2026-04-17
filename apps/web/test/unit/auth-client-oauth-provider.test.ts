import { describe, expect, it, vi } from 'vitest';

const { createAuthClientMock, convexClientMock, oauthProviderClientMock, polarClientMock } =
  vi.hoisted(() => ({
    createAuthClientMock: vi.fn((options: unknown) => ({
      options,
    })),
    convexClientMock: vi.fn(() => ({
      id: 'convex-client',
    })),
    oauthProviderClientMock: vi.fn(() => ({
      id: 'oauth-provider-client',
    })),
    polarClientMock: vi.fn(() => ({
      id: 'polar-client',
    })),
  }));

vi.mock('better-auth/react', () => ({
  createAuthClient: createAuthClientMock,
}));

vi.mock('@convex-dev/better-auth/client/plugins', () => ({
  convexClient: convexClientMock,
}));

vi.mock('@better-auth/oauth-provider/client', () => ({
  oauthProviderClient: oauthProviderClientMock,
}));

vi.mock('@polar-sh/better-auth/client', () => ({
  polarClient: polarClientMock,
}));

describe('auth client', () => {
  it('registers the oauth provider client plugin', async () => {
    const { authClient } = await import('@/lib/auth-client');

    expect(authClient).toEqual({
      options: {
        plugins: [{ id: 'convex-client' }, { id: 'oauth-provider-client' }, { id: 'polar-client' }],
      },
    });
    expect(createAuthClientMock).toHaveBeenCalledTimes(1);
    expect(oauthProviderClientMock).toHaveBeenCalledTimes(1);
    expect(polarClientMock).toHaveBeenCalledTimes(1);
  });
});
