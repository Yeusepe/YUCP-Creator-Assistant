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
});
