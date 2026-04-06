import { afterEach, describe, expect, it } from 'bun:test';
import { buildCookie, clearCookie, getCookieValue, SETUP_SESSION_COOKIE } from './browserSessions';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
    return;
  }
  process.env.NODE_ENV = originalNodeEnv;
});

describe('browserSessions', () => {
  it('reads cookie values from request headers', () => {
    const request = new Request('http://example.com', {
      headers: {
        cookie: `other=1; ${SETUP_SESSION_COOKIE}=opaque.token=value; last=2`,
      },
    });

    expect(getCookieValue(request, SETUP_SESSION_COOKIE)).toBe('opaque.token=value');
  });

  it('marks cookies as secure for forwarded https requests in development', () => {
    process.env.NODE_ENV = 'development';

    const request = new Request('http://example.com', {
      headers: {
        'x-forwarded-proto': 'https',
      },
    });

    const cookie = buildCookie('session', 'value', request, { maxAgeSeconds: 60 });

    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=60');
  });

  it('supports scoped cookie paths for build and clear helpers', () => {
    const request = new Request('https://example.com/api/connect/vrchat');

    const cookie = buildCookie('session', 'value', request, {
      path: '/api/connect/vrchat',
      maxAgeSeconds: 300,
    });
    const cleared = clearCookie('session', request, { path: '/api/connect/vrchat' });

    expect(cookie).toContain('Path=/api/connect/vrchat');
    expect(cookie).toContain('Max-Age=300');
    expect(cleared).toContain('Path=/api/connect/vrchat');
    expect(cleared).toContain('Max-Age=0');
  });
});
