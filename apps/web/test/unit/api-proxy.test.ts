import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

const mockGetToken = vi.fn<() => Promise<string | undefined>>();
vi.mock('@/lib/auth-server', () => ({
  getToken: mockGetToken,
}));

describe('proxyApiRequest', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetToken.mockReset();
    mockGetToken.mockResolvedValue(undefined);
    vi.stubEnv('INTERNAL_RPC_SHARED_SECRET', 'test-secret-value');
    vi.stubEnv('API_BASE_URL', 'http://localhost:3001');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('forwards Better Auth session cookies to the API proxy target', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyApiRequest } = await import('@/lib/server/api-proxy');

    await proxyApiRequest({
      url: 'http://localhost:3000/api/connect/oauth-apps?authUserId=user_123',
      method: 'GET',
      headers: new Headers({
        cookie:
          'yucp.session_token=session-cookie; yucp.session_data=cached-session; yucp_setup_session=setup-cookie; analytics_cookie=ignore-me',
      }),
    } as Request);

    const call = mockFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as [string, RequestInit];
    const headers = new Headers(init.headers);

    expect(headers.get('Cookie')).toBe(
      'yucp.session_token=session-cookie; yucp.session_data=cached-session; yucp_setup_session=setup-cookie'
    );
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('X-Auth-Token')).toBeNull();
    expect(headers.get('X-Internal-Service-Secret')).toBe('test-secret-value');
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('forwards the VRChat connect pending cookie on 2FA submissions', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyApiRequest } = await import('@/lib/server/api-proxy');

    await proxyApiRequest({
      url: 'http://localhost:3000/api/connect/vrchat/session',
      method: 'POST',
      headers: new Headers({
        cookie: 'yucp_vrchat_connect_pending=some-pending-uuid; other_cookie=ignore-me',
        'content-type': 'application/json',
      }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Request);

    const call = mockFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as [string, RequestInit];
    const headers = new Headers(init.headers);

    const cookieHeader = headers.get('Cookie');
    // The 2FA pending cookie must reach the API server, without it, readConnectPendingState
    // returns null and the handler returns "Two-factor session expired"
    expect(cookieHeader, 'yucp_vrchat_connect_pending must be forwarded to the API').not.toBeNull();
    expect(cookieHeader).toContain('yucp_vrchat_connect_pending=some-pending-uuid');
    // Unrelated cookies must be stripped
    expect(cookieHeader).not.toContain('other_cookie');
    expect(headers.get('X-Auth-Token')).toBeNull();
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('forwards Backstage media metadata headers to the API proxy target', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: 'icon' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyApiRequest } = await import('@/lib/server/api-proxy');

    await proxyApiRequest({
      url: 'http://localhost:3000/api/packages/com.yucp.song/backstage/media?kind=icon',
      method: 'POST',
      headers: new Headers({
        'content-type': 'image/png',
        'x-yucp-file-name': encodeURIComponent('icon.png'),
        'x-yucp-media-kind': 'icon',
        'x-yucp-source-path': 'Assets/YUCP/icon.png',
      }),
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    } as unknown as Request);

    const call = mockFetch.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as [string, RequestInit];
    const headers = new Headers(init.headers);

    expect(headers.get('X-YUCP-File-Name')).toBe(encodeURIComponent('icon.png'));
    expect(headers.get('X-YUCP-Media-Kind')).toBe('icon');
    expect(headers.get('X-YUCP-Source-Path')).toBe('Assets/YUCP/icon.png');
  });

  it('rejects oversized proxied request bodies before fetching the API target', async () => {
    const { proxyApiRequest } = await import('@/lib/server/api-proxy');

    const response = await proxyApiRequest({
      url: 'http://localhost:3000/api/connect/user/accounts',
      method: 'POST',
      headers: new Headers({
        'content-length': String(17 * 1024 * 1024),
        'content-type': 'application/json',
      }),
      body: null,
      arrayBuffer: () => {
        throw new Error('oversized body should be rejected before buffering');
      },
    } as unknown as Request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Request body too large',
      limitBytes: 16777216,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('applies the generic proxy body limit to the retired Backstage upload route', async () => {
    const { proxyApiRequest } = await import('@/lib/server/api-proxy');

    const response = await proxyApiRequest({
      url: 'http://localhost:3000/api/packages/com.yucp.song/backstage/upload',
      method: 'POST',
      headers: new Headers({
        'content-length': String(17 * 1024 * 1024),
        'content-type': 'application/zip',
      }),
      body: null,
      arrayBuffer: () => {
        throw new Error('oversized body should be rejected before buffering');
      },
    } as unknown as Request);

    expect(response.status).toBe(413);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('times out hung upstream API fetches with a controlled response', async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementationOnce((_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        return Promise.reject(
          Object.assign(new Error('missing abort signal'), { code: 'MISSING_SIGNAL' })
        );
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const { proxyApiRequest } = await import('@/lib/server/api-proxy');

    const responsePromise = proxyApiRequest(
      new Request('http://localhost:3000/api/connect/user/accounts', {
        method: 'GET',
      })
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const response = await responsePromise;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: 'Upstream API request timed out',
      code: 'UPSTREAM_TIMEOUT',
    });
  });

  it('gives Backstage publish requests a longer upstream timeout than normal API requests', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyApiRequest } = await import('@/lib/server/api-proxy');

    await proxyApiRequest(
      new Request('http://localhost:3000/api/connect/user/accounts', { method: 'GET' })
    );
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 30_000);

    await proxyApiRequest(
      new Request('http://localhost:3000/api/packages/com.yucp.song/backstage/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    );
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 130_000);
  });

  it('converts upstream fetch resets into a controlled 502 response instead of throwing', async () => {
    mockFetch.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('read ECONNRESET'), {
          code: 'ECONNRESET',
          syscall: 'read',
        }),
      })
    );

    const { proxyApiRequest } = await import('@/lib/server/api-proxy');

    const response = await proxyApiRequest({
      url: 'http://localhost:3000/api/connect/user/accounts',
      method: 'GET',
      headers: new Headers(),
    } as Request);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Upstream API request failed',
      code: 'ECONNRESET',
    });
  });

  it('does not mint SSR auth tokens for browser API proxy requests', async () => {
    mockGetToken.mockResolvedValueOnce('viewer-token-that-should-not-be-used');
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyApiRequest } = await import('@/lib/server/api-proxy');

    const response = await proxyApiRequest({
      url: 'http://localhost:3000/api/packages?includeArchived=true',
      method: 'GET',
      headers: new Headers({
        cookie: 'yucp.session_token=session-cookie',
      }),
    } as Request);

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockGetToken).not.toHaveBeenCalled();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Cookie')).toBe('yucp.session_token=session-cookie');
    expect(headers.get('X-Auth-Token')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: 'Authentication required',
    });
  });
});
