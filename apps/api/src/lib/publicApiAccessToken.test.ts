import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PUBLIC_API_AUDIENCE } from '@yucp/shared';

let verificationOptions: Record<string, unknown> | undefined;

const verifyBetterAuthAccessTokenMock = mock(
  async (_token: string, options: Record<string, unknown>) => {
    verificationOptions = options;
    return {
      ok: true as const,
      token: {
        sub: 'buyer-1',
        grantedScopes: ['products:read'],
      },
    };
  }
);

mock.module('./oauthAccessToken', () => ({
  verifyBetterAuthAccessToken: verifyBetterAuthAccessTokenMock,
}));

const { verifyPublicApiAccessToken } = await import('./publicApiAccessToken');

describe('verifyPublicApiAccessToken', () => {
  beforeEach(() => {
    verificationOptions = undefined;
    verifyBetterAuthAccessTokenMock.mockClear();
  });

  it('verifies the URI audience issued for the public API resource', async () => {
    await verifyPublicApiAccessToken('access-token', {
      convexSiteUrl: 'https://auth.example.test',
      logger: {
        debug() {},
        warn() {},
      },
      logContext: 'Public API token verification failed',
      requiredScopes: ['products:read'],
    });

    expect(verifyBetterAuthAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(verificationOptions?.audience).toBe(PUBLIC_API_AUDIENCE);
  });
});
