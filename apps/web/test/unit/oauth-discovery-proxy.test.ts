import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

describe('proxyOAuthAuthorizationServerMetadata', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site');
    vi.stubEnv('CONVEX_URL', '');
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('proxies the manual OAuth discovery document from Convex', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ issuer: 'https://example.convex.site/api/auth' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=15, stale-while-revalidate=15, stale-if-error=86400',
        },
      })
    );

    const { proxyOAuthAuthorizationServerMetadata } = await import('@/lib/server/oauthDiscovery');

    const response = await proxyOAuthAuthorizationServerMetadata(
      new Request('http://localhost:3000/.well-known/oauth-authorization-server/api/auth', {
        headers: { accept: 'application/json' },
      })
    );

    const [url, init] = mockFetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(
      'https://example.convex.site/.well-known/oauth-authorization-server/api/auth'
    );
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('max-age=15');
    await expect(response.json()).resolves.toEqual({
      issuer: 'https://example.convex.site/api/auth',
    });
  });

  it('returns 503 when the Convex site URL is unavailable', async () => {
    vi.stubEnv('CONVEX_SITE_URL', '');
    vi.stubEnv('CONVEX_URL', '');

    const { proxyOAuthAuthorizationServerMetadata } = await import('@/lib/server/oauthDiscovery');

    const response = await proxyOAuthAuthorizationServerMetadata(
      new Request('http://localhost:3000/.well-known/oauth-authorization-server/api/auth')
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'CONVEX_SITE_URL is required',
    });
  });
});
