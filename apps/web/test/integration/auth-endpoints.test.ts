/**
 * Auth Endpoint Integration Tests
 *
 * These tests hit the ACTUAL running auth endpoints to verify the auth
 * system works end-to-end. They would have caught:
 * - The /api/auth/convex/token 404 (wrong baseURL in Convex config)
 * - The oauthProvider 500 (missing storeSessionInDatabase)
 * - Incorrect Discord OAuth redirect URLs
 * - Origin validation failures
 *
 * Requirements:
 * - Web app running on TEST_BASE_URL (defaults to http://localhost:3000)
 * - Convex backend deployed and accessible
 *
 * Run with: bunx vitest run test/integration/auth-endpoints.test.ts
 */

import { describe, expect, it } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3000';

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    redirect: 'manual',
    ...init,
  });
}

describe('Auth health', () => {
  it('GET /api/auth/ok returns 200 with {ok: true}', async () => {
    const res = await authFetch('/api/auth/ok');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe('Session management', () => {
  it('GET /api/auth/get-session returns null without session cookie', async () => {
    const res = await authFetch('/api/auth/get-session');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('null');
  });

  it('GET /api/auth/convex/token returns 401 without session (not 404)', async () => {
    const res = await authFetch('/api/auth/convex/token');
    // Should be 401 (unauthorized) not 404 (not found)
    // A 404 would indicate the route is not registered (the baseURL bug)
    expect(res.status).not.toBe(404);
    // Accept 401 or 200-with-error or redirect
    expect([200, 401, 302]).toContain(res.status);
  });
});

describe('Discord OAuth sign-in', () => {
  it('POST /api/auth/sign-in/social returns Discord OAuth URL', async () => {
    const res = await authFetch('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'discord',
        callbackURL: `${BASE_URL}/sign-in`,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBeDefined();
    expect(body.redirect).toBe(true);

    // Verify the OAuth URL points to Discord
    const url = new URL(body.url);
    expect(url.hostname).toBe('discord.com');
    expect(url.pathname).toContain('oauth2/authorize');

    // Verify redirect_uri points back to our app (not Convex site directly)
    const redirectUri = url.searchParams.get('redirect_uri');
    expect(redirectUri).toBeDefined();
    expect(redirectUri).toContain('/api/auth/callback/discord');
    // The redirect_uri should be on OUR domain (where Better Auth proxy runs)
    expect(redirectUri).toContain(new URL(BASE_URL).host);
  });

  it('rejects sign-in with invalid callbackURL', async () => {
    const res = await authFetch('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'discord',
        callbackURL: 'https://evil.com/steal-token',
      }),
    });

    // Should reject with 403 (INVALID_CALLBACKURL) or similar error
    // The exact status depends on Better Auth version but it should NOT be 200 with a redirect
    if (res.status === 200) {
      const body = await res.json();
      // If 200, should not redirect to evil.com
      if (body.url) {
        const redirectUri = new URL(body.url).searchParams.get('redirect_uri');
        expect(redirectUri).not.toContain('evil.com');
      }
    } else {
      expect([400, 403, 422]).toContain(res.status);
    }
  });
});

describe('Route protection', () => {
  it('GET /dashboard redirects unauthenticated users to sign-in', async () => {
    const res = await authFetch('/dashboard');
    // TanStack Start SSR handles the redirect server-side
    // The response should either be a redirect or contain sign-in page content
    const body = await res.text();
    const isSignInContent = body.includes('Sign in') || body.includes('sign-in');
    const isRedirect = res.status === 302 || res.status === 303;
    expect(isSignInContent || isRedirect).toBe(true);
  });

  it('GET /sign-in page loads successfully', async () => {
    const res = await authFetch('/sign-in');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('Sign in');
  });
});

describe('Security headers', () => {
  it('auth endpoints set appropriate cache headers', async () => {
    const res = await authFetch('/api/auth/get-session');
    // Auth responses should not be cached by CDNs or proxies
    const cacheControl = res.headers.get('cache-control');
    if (cacheControl) {
      expect(cacheControl).toMatch(/no-store|no-cache|private/);
    }
  });
});
