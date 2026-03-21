import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRequestHeadersMock = vi.fn(() => new Headers());
let authRuntimeMock = {
  handler: vi.fn(),
  getToken: vi.fn(),
  fetchAuthQuery: vi.fn(),
  fetchAuthMutation: vi.fn(),
  fetchAuthAction: vi.fn(),
};

const reactStartSpy = vi.fn(() => authRuntimeMock);

vi.mock('@convex-dev/better-auth/react-start', () => ({
  convexBetterAuthReactStart: reactStartSpy,
}));

vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: getRequestHeadersMock,
}));

describe('auth-server environment resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    authRuntimeMock = {
      handler: vi.fn(),
      getToken: vi.fn(),
      fetchAuthQuery: vi.fn(),
      fetchAuthMutation: vi.fn(),
      fetchAuthAction: vi.fn(),
    };
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('derives CONVEX_SITE_URL from CONVEX_URL when the site URL is unset', async () => {
    vi.stubEnv('CONVEX_URL', 'https://rare-squid-409.convex.cloud');
    vi.stubEnv('CONVEX_SITE_URL', '');

    await import('@/lib/auth-server');

    expect(reactStartSpy).toHaveBeenCalledWith({
      convexUrl: 'https://rare-squid-409.convex.cloud',
      convexSiteUrl: 'https://rare-squid-409.convex.site',
    });
  });

  it('logs request metadata and direct Convex probe results when getToken fails', async () => {
    vi.stubEnv('CONVEX_URL', 'https://rare-squid-409.convex.cloud');
    vi.stubEnv('CONVEX_SITE_URL', 'https://rare-squid-409.convex.site');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connectivityError = new Error(
      'Unable to connect. Is the computer able to access the url?'
    );
    authRuntimeMock.getToken.mockRejectedValue(connectivityError);
    getRequestHeadersMock.mockReturnValue(
      new Headers({
        host: 'verify.creators.yucp.club',
        'x-forwarded-host': 'verify.creators.yucp.club',
        'x-forwarded-proto': 'https',
        cookie: 'yucp.session_token=abc; yucp.session_data=def',
      })
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('null', { status: 200 }))
      .mockResolvedValueOnce(
        new Response('{"message":"Unauthorized","code":"UNAUTHORIZED"}', { status: 401 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const authServer = await import('@/lib/auth-server');

    await expect(authServer.getToken()).rejects.toThrow(connectivityError);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[web] Auth token fetch failed',
      expect.objectContaining({
        phase: 'auth-server-getToken',
        convexSiteUrl: 'https://rare-squid-409.convex.site',
        requestHost: 'verify.creators.yucp.club',
        forwardedHost: 'verify.creators.yucp.club',
        forwardedProto: 'https',
        hasCookieHeader: true,
        cookieNames: ['yucp.session_token', 'yucp.session_data'],
        directGetSessionStatus: 200,
        directTokenStatus: 401,
        error: expect.objectContaining({
          message: 'Unable to connect. Is the computer able to access the url?',
        }),
      })
    );
  });
});
