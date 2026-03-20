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

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers);

    expect(headers.get('Cookie')).toBe(
      'yucp.session_token=session-cookie; yucp.session_data=cached-session; yucp_setup_session=setup-cookie'
    );
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

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers);

    const cookieHeader = headers.get('Cookie');
    // The 2FA pending cookie must reach the API server — without it, readConnectPendingState
    // returns null and the handler returns "Two-factor session expired"
    expect(cookieHeader, 'yucp_vrchat_connect_pending must be forwarded to the API').not.toBeNull();
    expect(cookieHeader).toContain('yucp_vrchat_connect_pending=some-pending-uuid');
    // Unrelated cookies must be stripped
    expect(cookieHeader).not.toContain('other_cookie');
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
});
