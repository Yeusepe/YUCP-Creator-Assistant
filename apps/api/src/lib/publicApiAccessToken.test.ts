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
const verifyBetterAuthAccessRequestMock = mock(
  async (_request: Request, options: Record<string, unknown>) => {
    verificationOptions = options;
    return {
      ok: true as const,
      token: {
        deviceKeyThumbprint: '44'.repeat(32),
        sub: 'buyer-1',
        grantedScopes: ['products:read'],
      },
    };
  }
);

mock.module('./oauthAccessToken', () => ({
  verifyBetterAuthAccessRequest: verifyBetterAuthAccessRequestMock,
  verifyBetterAuthAccessToken: verifyBetterAuthAccessTokenMock,
}));

const { verifyPublicApiAccessRequest, verifyPublicApiAccessToken } = await import(
  './publicApiAccessToken'
);

describe('verifyPublicApiAccessToken', () => {
  beforeEach(() => {
    verificationOptions = undefined;
    verifyBetterAuthAccessTokenMock.mockClear();
    verifyBetterAuthAccessRequestMock.mockClear();
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

  it('verifies a DPoP request against the public API resource audience', async () => {
    const request = new Request('https://api.example.test/api/v2/package-installs/authorizations', {
      method: 'POST',
    });
    await verifyPublicApiAccessRequest(request, {
      convexSiteUrl: 'https://auth.example.test',
      dpopReplayStore: { reserve: async () => true },
      publicResourceBaseUrl: 'https://api.example.test',
      requiredScopes: ['products:read'],
    });

    expect(verifyBetterAuthAccessRequestMock).toHaveBeenCalledTimes(1);
    expect(verificationOptions?.audience).toBe(PUBLIC_API_AUDIENCE);
  });
});
