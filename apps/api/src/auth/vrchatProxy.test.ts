import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createAuth } from './index';

const originalFetch = globalThis.fetch;
const originalInternalSecret = process.env.INTERNAL_SERVICE_AUTH_SECRET;

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.INTERNAL_SERVICE_AUTH_SECRET = originalInternalSecret;
});

describe('VRChat BetterAuth proxy helpers', () => {
  it('signs internal VRChat session persistence requests and extracts response cookies', async () => {
    process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-secret';

    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://test.convex.site/api/auth/sign-in/vrchat/session');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(
        '{"authToken":"auth-cookie","twoFactorAuthToken":"2fa-cookie","vrchatUser":{"displayName":"User","id":"usr_123","username":"user"}}'
      );

      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toBe('foo=bar');
      expect(headers.get('x-yucp-internal-auth-ts')).toBeTruthy();
      expect(headers.get('x-yucp-internal-auth-sig')).toBeTruthy();

      const responseHeaders = new Headers();
      responseHeaders.append(
        'set-better-auth-cookie',
        '__Secure-yucp.session_token=session; Path=/; HttpOnly'
      );

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: responseHeaders,
      });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const auth = createAuth({
      baseUrl: 'http://localhost:3001',
      convexSiteUrl: 'https://test.convex.site',
    });

    const result = await auth.persistVrchatSession(
      { id: 'usr_123', username: 'user', displayName: 'User' },
      { authToken: 'auth-cookie', twoFactorAuthToken: '2fa-cookie' },
      'foo=bar'
    );

    expect(result.browserSetCookies).toHaveLength(1);
    expect(result.betterAuthCookieHeader).toContain('__Secure-yucp.session_token=session');
  });
});
