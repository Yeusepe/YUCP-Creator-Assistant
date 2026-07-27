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

  it('streams a forensics archive above the generic proxy limit without buffering it', async () => {
    const bodyBytes = new TextEncoder().encode('bounded-stream-body');
    const requestBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bodyBytes);
        controller.close();
      },
    });
    mockFetch.mockImplementationOnce(async (_input, init) => {
      const forwardedBytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      expect(forwardedBytes).toEqual(bodyBytes);
      return Response.json({ lookupStatus: 'no_candidate_assets' });
    });

    const { proxyApiRequest } = await import('@/lib/server/api-proxy');
    const response = await proxyApiRequest({
      url: 'http://localhost:3000/api/forensics/lookup',
      method: 'POST',
      headers: new Headers({
        'content-length': String(20 * 1024 * 1024),
        'content-type': 'multipart/form-data; boundary=test-boundary',
      }),
      body: requestBody,
      arrayBuffer: () => {
        throw new Error('forensics body must not be buffered');
      },
    } as unknown as Request);

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
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
      url: 'http://localhost:3000/api/connect/user/accounts',
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
