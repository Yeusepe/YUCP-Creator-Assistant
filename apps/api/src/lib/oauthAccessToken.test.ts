import { beforeEach, describe, expect, it, mock } from 'bun:test';

let verifyBearerTokenImpl: (token: string, options: unknown) => Promise<unknown>;

const verifyBearerTokenMock = mock((token: string, options: unknown) =>
  verifyBearerTokenImpl(token, options)
);

mock.module('better-auth/oauth2', () => ({
  verifyBearerToken: verifyBearerTokenMock,
}));

const { verifyBetterAuthAccessToken } = await import('./oauthAccessToken');

describe('verifyBetterAuthAccessToken', () => {
  const debug = mock(() => {});
  const warn = mock(() => {});
  const options = {
    audience: 'yucp-public-api',
    convexSiteUrl: 'https://test.convex.site',
    logger: { debug, warn },
    logContext: 'OAuth token verification failed',
  };

  beforeEach(() => {
    verifyBearerTokenMock.mockClear();
    debug.mockClear();
    warn.mockClear();
    verifyBearerTokenImpl = async () => ({ sub: 'user_123', scope: 'profile:read' });
  });

  it('uses the Better Auth 1.7 bearer-token verifier', async () => {
    const result = await verifyBetterAuthAccessToken('valid-token', options);

    expect(result).toEqual({
      ok: true,
      token: {
        sub: 'user_123',
        scope: 'profile:read',
        grantedScopes: ['profile:read'],
      },
    });
    expect(verifyBearerTokenMock).toHaveBeenCalledTimes(1);
  });

  it('logs expected invalid-token verifier failures at debug instead of warn', async () => {
    verifyBearerTokenImpl = async () => {
      const error = new Error('no applicable key found in the JSON Web Key Set');
      error.name = 'JWKSNoMatchingKey';
      throw error;
    };

    const result = await verifyBetterAuthAccessToken('bad-token', options);

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps unexpected verifier failures at warn', async () => {
    verifyBearerTokenImpl = async () => {
      const error = new Error('network timeout while fetching jwks');
      error.name = 'TypeError';
      throw error;
    };

    const result = await verifyBetterAuthAccessToken('bad-token', options);

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });
});
