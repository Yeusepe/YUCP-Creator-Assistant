import { describe, expect, it, vi } from 'vitest';

const {
  createAuthClientMock,
  convexClientMock,
  emailOtpClientMock,
  oauthProviderClientMock,
  passkeyClientMock,
  polarClientMock,
  twoFactorClientMock,
} = vi.hoisted(() => ({
  createAuthClientMock: vi.fn((options: unknown) => ({
    options,
  })),
  convexClientMock: vi.fn(() => ({
    id: 'convex-client',
  })),
  emailOtpClientMock: vi.fn(() => ({
    id: 'email-otp-client',
  })),
  oauthProviderClientMock: vi.fn(() => ({
    id: 'oauth-provider-client',
  })),
  polarClientMock: vi.fn(() => ({
    id: 'polar-client',
  })),
  passkeyClientMock: vi.fn(() => ({
    id: 'passkey-client',
  })),
  twoFactorClientMock: vi.fn(() => ({
    id: 'two-factor-client',
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

vi.mock('@better-auth/passkey/client', () => ({
  passkeyClient: passkeyClientMock,
}));

vi.mock('better-auth/client/plugins', () => ({
  emailOTPClient: emailOtpClientMock,
  twoFactorClient: twoFactorClientMock,
}));

describe('auth client', () => {
  it('registers every authentication method supported by the current sign-in and security flows', async () => {
    const { authClient } = await import('@/lib/auth-client');

    expect(authClient).toEqual({
      options: {
        plugins: [
          { id: 'convex-client' },
          { id: 'oauth-provider-client' },
          { id: 'polar-client' },
          { id: 'email-otp-client' },
          { id: 'two-factor-client' },
          { id: 'passkey-client' },
        ],
      },
    });
    expect(createAuthClientMock).toHaveBeenCalledTimes(1);
    expect(oauthProviderClientMock).toHaveBeenCalledTimes(1);
    expect(polarClientMock).toHaveBeenCalledTimes(1);
    expect(emailOtpClientMock).toHaveBeenCalledTimes(1);
    expect(twoFactorClientMock).toHaveBeenCalledTimes(1);
    expect(passkeyClientMock).toHaveBeenCalledTimes(1);
  });
});
