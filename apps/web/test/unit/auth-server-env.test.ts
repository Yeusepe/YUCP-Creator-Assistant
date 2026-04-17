import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRequestHeadersMock = vi.fn(() => new Headers());
const deleteCookieMock = vi.fn();
const getConvexAuthTokenMock = vi.fn();
let authRuntimeMock = {
  handler: vi.fn(async () => new Response(null, { status: 204 })),
  getToken: vi.fn(),
  fetchAuthQuery: vi.fn(),
  fetchAuthMutation: vi.fn(),
  fetchAuthAction: vi.fn(),
};

const reactStartSpy = vi.fn(() => authRuntimeMock);

vi.mock('@convex-dev/better-auth/react-start', () => ({
  convexBetterAuthReactStart: reactStartSpy,
}));

vi.mock('@convex-dev/better-auth/utils', () => ({
  getToken: getConvexAuthTokenMock,
}));

vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: getRequestHeadersMock,
  deleteCookie: deleteCookieMock,
}));

describe('auth-server environment resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    deleteCookieMock.mockReset();
    getConvexAuthTokenMock.mockReset();
    authRuntimeMock = {
      handler: vi.fn(async () => new Response(null, { status: 204 })),
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

    const authServer = await import('@/lib/auth-server');
    await authServer.handleAuthRequest(
      new Request('https://verify.creators.yucp.club/api/auth/sign-in')
    );

    expect(reactStartSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        convexUrl: 'https://rare-squid-409.convex.cloud',
        convexSiteUrl: 'https://rare-squid-409.convex.site',
      })
    );
  });

  it('forwards the session and cached convex jwt cookies when fetching the auth token', async () => {
    vi.stubEnv('CONVEX_URL', 'https://rare-squid-409.convex.cloud');
    vi.stubEnv('CONVEX_SITE_URL', 'https://rare-squid-409.convex.site');
    getRequestHeadersMock.mockReturnValue(
      new Headers({
        host: 'verify.creators.yucp.club',
        'x-forwarded-host': 'verify.creators.yucp.club',
        'x-forwarded-proto': 'https',
        'accept-language': 'en-US,en;q=0.9',
        connection: 'keep-alive',
        cookie:
          '__Secure-yucp.session_token=abc; __Secure-yucp.session_data=def; __Secure-yucp.convex_jwt=jwt; ignored_cookie=skip-me',
      })
    );
    getConvexAuthTokenMock.mockResolvedValue({
      isFresh: true,
      token: 'test-jwt-token',
    });

    const authServer = await import('@/lib/auth-server');

    await expect(authServer.getToken()).resolves.toBe('test-jwt-token');

    expect(getConvexAuthTokenMock).toHaveBeenCalledTimes(1);
    expect(getConvexAuthTokenMock).toHaveBeenCalledWith(
      'https://rare-squid-409.convex.site',
      expect.any(Headers),
      expect.objectContaining({
        cookiePrefix: 'yucp',
        jwtCache: expect.objectContaining({
          enabled: true,
          isAuthError: expect.any(Function),
        }),
      })
    );

    const forwardedHeaders = getConvexAuthTokenMock.mock.calls[0][1] as Headers;
    expect(Array.from(forwardedHeaders.keys()).sort()).toEqual([
      'accept',
      'accept-encoding',
      'cookie',
    ]);
    expect(forwardedHeaders.get('accept')).toBe('application/json');
    expect(forwardedHeaders.get('accept-encoding')).toBe('identity');
    expect(forwardedHeaders.get('cookie')).toBe(
      '__Secure-yucp.session_token=abc; __Secure-yucp.session_data=def; __Secure-yucp.convex_jwt=jwt'
    );
    expect(forwardedHeaders.get('host')).toBeNull();
    expect(forwardedHeaders.get('x-forwarded-host')).toBeNull();
    expect(forwardedHeaders.get('x-forwarded-proto')).toBeNull();
    expect(forwardedHeaders.get('connection')).toBeNull();
  });

  it('passes auth requests directly to the official react-start handler', async () => {
    vi.stubEnv('CONVEX_URL', 'https://rare-squid-409.convex.cloud');
    vi.stubEnv('CONVEX_SITE_URL', 'https://rare-squid-409.convex.site');

    const authServer = await import('@/lib/auth-server');

    const request = {
      url: 'https://verify.creators.yucp.club/api/auth/sign-in/social',
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        cookie:
          '__Secure-yucp.session_token=abc; __Secure-yucp.session_data=def; __Secure-yucp.convex_jwt=jwt; yucp_privacy_preferences=keep-me; __rum_sid=trace',
      }),
      body: JSON.stringify({
        provider: 'discord',
        callbackURL: '/dashboard',
      }),
    } as unknown as Request;

    await authServer.handleAuthRequest(request);

    expect(authRuntimeMock.handler).toHaveBeenCalledTimes(1);
    expect(authRuntimeMock.handler).toHaveBeenCalledWith(request);
  });

  it('converts handler POST redirects to JSON redirect payloads', async () => {
    vi.stubEnv('CONVEX_URL', 'https://rare-squid-409.convex.cloud');
    vi.stubEnv('CONVEX_SITE_URL', 'https://rare-squid-409.convex.site');
    authRuntimeMock.handler.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: 'https://rare-squid-409.convex.site/api/auth/callback/discord?code=test',
        },
      })
    );

    const authServer = await import('@/lib/auth-server');

    const response = await authServer.handleAuthRequest(
      new Request('https://verify.creators.yucp.club/api/auth/oauth2/consent', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      redirectTo: 'https://rare-squid-409.convex.site/api/auth/callback/discord?code=test',
    });
  });

  it('logs request metadata and direct Convex probe results when getToken fails', async () => {
    vi.stubEnv('CONVEX_URL', 'https://rare-squid-409.convex.cloud');
    vi.stubEnv('CONVEX_SITE_URL', 'https://rare-squid-409.convex.site');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connectivityError = new Error(
      'Unable to connect. Is the computer able to access the url?'
    );
    getConvexAuthTokenMock.mockRejectedValue(connectivityError);
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

  it('clears stale auth cookies when get-session returns null', async () => {
    vi.stubEnv('CONVEX_URL', 'https://rare-squid-409.convex.cloud');
    vi.stubEnv('CONVEX_SITE_URL', 'https://rare-squid-409.convex.site');
    getRequestHeadersMock.mockReturnValue(
      new Headers({
        cookie:
          '__Secure-yucp.session_token=abc; __Secure-yucp.session_data=def; __Secure-yucp.convex_jwt=jwt; yucp_privacy_preferences=keep-me',
      })
    );

    const fetchMock = vi.fn().mockResolvedValue(new Response('null', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const authServer = await import('@/lib/auth-server');

    await expect(authServer.getSession()).resolves.toEqual({
      isAuthenticated: false,
      userId: null,
      email: null,
      name: null,
      image: null,
    });

    expect(deleteCookieMock).toHaveBeenCalledTimes(3);
    expect(deleteCookieMock).toHaveBeenNthCalledWith(1, '__Secure-yucp.session_token', {
      path: '/',
      secure: true,
    });
    expect(deleteCookieMock).toHaveBeenNthCalledWith(2, '__Secure-yucp.session_data', {
      path: '/',
      secure: true,
    });
    expect(deleteCookieMock).toHaveBeenNthCalledWith(3, '__Secure-yucp.convex_jwt', {
      path: '/',
      secure: true,
    });
  });
});
