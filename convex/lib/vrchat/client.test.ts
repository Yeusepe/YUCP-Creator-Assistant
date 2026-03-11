import { afterEach, describe, expect, it, mock } from 'bun:test';
import { VrchatWebClient } from './client';
import { buildCookieHeader, parseSetCookie, splitSetCookieHeader } from './cookie';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('vrchat cookie helpers', () => {
  it('parses cookies with expires and max-age values', () => {
    const parsed = parseSetCookie('auth=abc; Path=/; Max-Age=120; HttpOnly');
    expect(parsed.name).toBe('auth');
    expect(parsed.value).toBe('abc');
    expect(parsed.options.path).toBe('/');
    expect(parsed.expires).toBeGreaterThan(Date.now());
  });

  it('splits combined set-cookie headers safely', () => {
    const cookies = splitSetCookieHeader(
      'auth=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly, twoFactorAuth=xyz; Path=/; HttpOnly'
    );
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('auth=abc');
    expect(cookies[1]).toContain('twoFactorAuth=xyz');
  });

  it('builds cookie headers with auth and optional 2fa tokens', () => {
    expect(buildCookieHeader({ authToken: 'abc' })).toBe('auth=abc');
    expect(buildCookieHeader({ authToken: 'abc', twoFactorAuthToken: 'xyz' })).toBe(
      'auth=abc; twoFactorAuth=xyz'
    );
  });
});

describe('VrchatWebClient', () => {
  it('uses VRChat basic auth semantics for login', async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(
        `Basic ${btoa(`${encodeURIComponent('user@example.com')}:${encodeURIComponent('p@ss word')}`)}`
      );

      const responseHeaders = new Headers();
      responseHeaders.append('set-cookie', 'auth=auth-token; Path=/; HttpOnly');
      return new Response(JSON.stringify({ id: 'usr_123', displayName: 'Display' }), {
        status: 200,
        headers: responseHeaders,
      });
    });

    // Some test mocks don't have all properties of the real `fetch` function (like `preconnect`).
    // Cast through unknown to satisfy TypeScript, while preserving runtime behavior.
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatWebClient();
    const result = await client.login('user@example.com', 'p@ss word');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.session.authToken).toBe('auth-token');
      expect(result.user.id).toBe('usr_123');
    }
  });

  it('paginates licensed avatars until exhausted', async () => {
    const calls: string[] = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      calls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toBe('auth=auth-token; twoFactorAuth=two-factor');

      if (url.endsWith('/auth/user')) {
        return new Response(JSON.stringify({ id: 'usr_123', displayName: 'Display' }), {
          status: 200,
        });
      }

      if (url.includes('offset=0')) {
        return new Response(
          JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: `avtr_${index}` }))),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify([{ id: 'avtr_100' }]), { status: 200 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new VrchatWebClient();
    const ownership = await client.getOwnershipFromSession({
      authToken: 'auth-token',
      twoFactorAuthToken: 'two-factor',
    });

    expect(ownership).not.toBeNull();
    expect(ownership?.ownedAvatarIds).toHaveLength(101);
    expect(calls.filter((entry) => entry.includes('/avatars/licensed'))).toHaveLength(2);
  });
});
