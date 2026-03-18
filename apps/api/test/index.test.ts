/**
 * API server integration tests — Phase 6.1
 *
 * Tests that the server starts correctly, mounts all routes, and returns
 * the expected responses for basic sanity checks. These are NOT smoke tests
 * because they assert real HTTP behaviour (status codes, response shapes,
 * content types) and will catch route-mounting regressions.
 */
// Source: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/09-Testing_for_Clickjacking
// Source: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
// Source: https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Auth } from '../src/auth';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

function expectHtmlSecurityHeaders(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';
  const contentSecurityPolicy = response.headers.get('content-security-policy') ?? '';
  expect(contentType).toContain('text/html');
  expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
  expect(contentSecurityPolicy).toContain("object-src 'none'");
  expect(contentSecurityPolicy).toContain("base-uri 'none'");
  expect(contentSecurityPolicy).toContain("form-action 'self'");
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
}

describe('API server — route mounting', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------
  it('GET /health returns { status: "ok" }', async () => {
    const res = await server.fetch('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
    expect(typeof body.timestamp).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Static assets
  // -------------------------------------------------------------------------
  it('GET /tokens.css returns CSS with correct content-type', async () => {
    const res = await server.fetch('/tokens.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('dashboard browser assets are served with the expected content types', async () => {
    const dashboardCss = await server.fetch('/dashboard.css');
    expect(dashboardCss.status).toBe(200);
    expect(dashboardCss.headers.get('content-type')).toContain('text/css');

    const dashboardScript = await server.fetch('/assets/dashboard/main.js');
    expect(dashboardScript.status).toBe(200);
    expect(dashboardScript.headers.get('content-type')).toContain('application/javascript');
  });

  // -------------------------------------------------------------------------
  // Browser page hardening
  // -------------------------------------------------------------------------
  it('browser-facing HTML routes return CSP, framing, and MIME hardening headers', async () => {
    for (const path of [
      '/connect',
      '/sign-in',
      '/dashboard',
      '/oauth/consent?client_id=test-app&scope=verification:read&consent_code=abc',
      '/verify-success',
      '/verify-error',
    ]) {
      const res = await server.fetch(path);
      expect(res.status).toBe(200);
      expectHtmlSecurityHeaders(res);
    }
  });

  it('GET /dashboard without auth serves sign-in-redirect without coupling auth to guild selection', async () => {
    // When an unauthenticated user visits /dashboard?guild_id=X (from bot /setup start),
    // the server must serve sign-in-redirect.html (not a 302) so that client-side JS
    // can exchange #token=... or #s=... hash-fragment tokens for cookies BEFORE the
    // OAuth redirect. Hash fragments are lost during 302 redirects.
    const res = await server.fetch('/dashboard?guild_id=test-guild-123');
    expect(res.status).toBe(200);
    expectHtmlSecurityHeaders(res);
    const html = await res.text();
    // The sign-in-redirect.html page contains the bootstrap exchange logic
    expect(html).toContain('exchangeBootstrapTokens');
    expect(html).toContain('/api/connect/bootstrap');
    // It must contain the injected sign-in URL pointing at Discord OAuth
    expect(html).toContain('/api/auth/sign-in/discord');
    // Auth should land on generic dashboard first. Guild onboarding is a separate flow.
    expect(html).toContain('callbackURL=http%3A%2F%2Flocalhost%3A0%2Fdashboard');
    expect(html).not.toContain('guild_id=test-guild-123');
  });

  it('GET /sign-in rejects open redirect targets from browser-rendered OAuth links', async () => {
    const res = await server.fetch('/sign-in?redirectTo=//evil.example/%2Fsteal');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('evil.example');
    expect(html).toContain('redirectTo%3D%252Fdashboard');
  });

  it('GET /oauth/consent safely encodes browser-rendered params used in HTML and inline JS', async () => {
    const clientIdPayload = `phase8"><img src=x onerror="globalThis.__phase8Client=1">`;
    const scopePayload = `verification:read <img src=x onerror="globalThis.__phase8Scope=1">`;
    const consentCodePayload = `abc'</script><script>globalThis.__phase8Code=1</script>`;
    const query = new URLSearchParams({
      client_id: clientIdPayload,
      scope: scopePayload,
      consent_code: consentCodePayload,
    });

    const res = await server.fetch(`/oauth/consent?${query.toString()}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain(clientIdPayload);
    expect(html).not.toContain(scopePayload);
    expect(html).not.toContain(consentCodePayload);
    expect(html).toContain('&lt;img src=x onerror=');
    expect(html).toContain('&quot;globalThis.__phase8Client=1&quot;');
    expect(html).not.toContain("const CONSENT_CODE   = 'abc");
  });

  it('GET /api/auth/sign-in/discord allows the local proxied frontend origin and redirects to Discord', async () => {
    const authRequests: Array<{ url: string; body: { provider: string; callbackURL: string } }> =
      [];
    const bridgeServer = await startTestServer({
      baseUrl: 'http://localhost:3101',
      frontendUrl: 'http://localhost:3000',
      authFetch: async (input, init) => {
        authRequests.push({
          url: input.toString(),
          body: JSON.parse(String(init?.body)) as { provider: string; callbackURL: string },
        });
        return new Response(
          JSON.stringify({
            url: 'https://discord.com/api/oauth2/authorize?client_id=test-discord-client-id&redirect_uri=https%3A%2F%2Frare-squid-409.convex.site%2Fapi%2Fauth%2Fcallback%2Fdiscord&scope=identify+email',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      },
    });

    try {
      const callbackURL = encodeURIComponent(
        'http://localhost:3000/sign-in?redirectTo=%2Fdashboard'
      );
      const res = await bridgeServer.fetch(`/api/auth/sign-in/discord?callbackURL=${callbackURL}`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('https://discord.com/api/oauth2/authorize');
      expect(authRequests).toHaveLength(1);
      expect(authRequests[0]).toEqual({
        url: 'http://localhost:3210/api/auth/sign-in/social',
        body: {
          provider: 'discord',
          callbackURL: 'http://localhost:3000/sign-in?redirectTo=%2Fdashboard',
        },
      });
    } finally {
      bridgeServer.stop();
    }
  });

  it('GET /api/auth/sign-in/discord rejects callback origins outside the configured browser allowlist', async () => {
    const authRequests: string[] = [];
    const bridgeServer = await startTestServer({
      baseUrl: 'http://localhost:3101',
      frontendUrl: 'http://localhost:3000',
      authFetch: async (input) => {
        authRequests.push(input.toString());
        return new Response(JSON.stringify({ url: 'https://discord.com/api/oauth2/authorize' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    try {
      const callbackURL = encodeURIComponent(
        'https://evil.example/sign-in?redirectTo=%2Fdashboard'
      );
      const res = await bridgeServer.fetch(`/api/auth/sign-in/discord?callbackURL=${callbackURL}`);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'callbackURL origin is not allowed',
      });
      expect(authRequests).toHaveLength(0);
    } finally {
      bridgeServer.stop();
    }
  });

  it('GET /api/auth/sign-in/discord/start computes a same-origin callback URL from a safe relative returnTo path', async () => {
    const authRequests: Array<{ url: string; body: { provider: string; callbackURL: string } }> =
      [];
    const bridgeServer = await startTestServer({
      baseUrl: 'http://localhost:3101',
      frontendUrl: 'http://localhost:3000',
      authFetch: async (input, init) => {
        authRequests.push({
          url: input.toString(),
          body: JSON.parse(String(init?.body)) as { provider: string; callbackURL: string },
        });
        return new Response(
          JSON.stringify({
            url: 'https://discord.com/api/oauth2/authorize?client_id=test-discord-client-id',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      },
    });

    try {
      const returnTo = encodeURIComponent('/sign-in?redirectTo=%2Fdashboard%3Fguild_id%3D123');
      const res = await bridgeServer.fetch(`/api/auth/sign-in/discord/start?returnTo=${returnTo}`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('https://discord.com/api/oauth2/authorize');
      expect(authRequests).toHaveLength(1);
      expect(authRequests[0]).toEqual({
        url: 'http://localhost:3210/api/auth/sign-in/social',
        body: {
          provider: 'discord',
          callbackURL: 'http://localhost:3000/sign-in?redirectTo=%2Fdashboard',
        },
      });
    } finally {
      bridgeServer.stop();
    }
  });

  it('POST /api/auth/exchange-ott sets browser cookies after a successful OTT exchange', async () => {
    const authServer = await startTestServer({
      auth: {
        getSession: async () => null,
        getDiscordUserId: async () => null,
        signOut: async () => ({ ok: false, setCookieHeaders: [] as string[] }),
        exchangeOTT: async () => ({
          session: {
            session: {
              id: 'session_123',
              token: 'token_123',
              expiresAt: Date.now() + 60_000,
            },
            user: {
              id: 'user_123',
              email: 'test@example.com',
              name: 'Test User',
              image: null,
            },
          },
          setCookieHeaders: [
            'yucp_session_token=session_123; Path=/; HttpOnly; SameSite=Strict',
            'yucp_csrf_token=csrf_123; Path=/; HttpOnly; SameSite=Strict',
          ],
        }),
      } as unknown as Auth,
    });

    try {
      const res = await authServer.fetch('/api/auth/exchange-ott', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'ott_123' }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('yucp_session_token=session_123');
      expect(setCookie).toContain('yucp_csrf_token=csrf_123');
    } finally {
      authServer.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Webhook routes — mounted (not 404)
  // -------------------------------------------------------------------------
  it('GET /webhooks/gumroad/:id → 405 (wrong method, no Convex call needed)', async () => {
    // Method check happens before any Convex query, so this works without a backend
    const res = await server.fetch('/webhooks/gumroad/any-route-id', {
      method: 'GET',
    });
    expect(res.status).toBe(405);
  });

  it('POST /webhooks/gumroad/:id with old timestamp → 403 replay protection (no Convex call)', async () => {
    // sale_timestamp check happens before the Convex connection lookup,
    // so this tests replay protection without needing a real Convex backend.
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const params = new URLSearchParams({
      sale_id: 'sale_test_123',
      refunded: 'false',
      sale_timestamp: oldTimestamp,
    });
    const res = await server.fetch('/webhooks/gumroad/any-route-id', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    expect(res.status).toBe(403);
  });

  it('POST /webhooks/unknownprovider/id → 404', async () => {
    const res = await server.fetch('/webhooks/unknownprovider/any-id', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Public API — mounted (route exists)
  // -------------------------------------------------------------------------
  it('POST /api/public/verification/check with no body → 4xx (route mounted)', async () => {
    // This confirms the public route is mounted. Without a Convex backend,
    // it will fail processing — but 4xx/5xx is better than 404 (not mounted).
    const res = await server.fetch('/api/public/verification/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).not.toBe(404);
  });

  // -------------------------------------------------------------------------
  // Connect routes — auth-guarded
  // -------------------------------------------------------------------------
  it('GET /api/connect/status (no session) → 401 or 302, not 404', async () => {
    const res = await server.fetch('/api/connect/status');
    expect([302, 401]).toContain(res.status);
  });

  it('POST /api/connect/complete (no session) → 401 or 302, not 404', async () => {
    const res = await server.fetch('/api/connect/complete', { method: 'POST' });
    expect([302, 401]).toContain(res.status);
  });

  // -------------------------------------------------------------------------
  // Collab routes — auth-guarded
  // -------------------------------------------------------------------------
  it('POST /api/collab/invite (no session) → 401, not 404', async () => {
    const res = await server.fetch('/api/collab/invite', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------
  it('GET /api/nonexistent → 404', async () => {
    const res = await server.fetch('/api/nonexistent-route-that-should-not-exist');
    expect(res.status).toBe(404);
  });
});
