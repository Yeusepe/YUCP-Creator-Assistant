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
