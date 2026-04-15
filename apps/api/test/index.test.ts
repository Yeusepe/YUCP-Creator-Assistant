/**
 * API server integration tests.
 *
 * These checks verify the backend routes that still belong in the Bun API after
 * the TanStack UI cutover.
 */
// Source: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/09-Testing_for_Clickjacking

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

describe('API server, route mounting', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('GET /health returns { status: "ok" }', async () => {
    const res = await server.fetch('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
    expect(typeof body.timestamp).toBe('string');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('still serves shared static assets that are used outside the migrated creator UI', async () => {
    const res = await server.fetch('/tokens.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('legacy Bun dashboard assets are no longer served', async () => {
    const dashboardCss = await server.fetch('/dashboard.css');
    expect(dashboardCss.status).toBe(404);

    const dashboardScript = await server.fetch('/assets/dashboard/main.js');
    expect(dashboardScript.status).toBe(404);
  });

  it('legacy browser routes fail closed on the API origin with hardening headers', async () => {
    for (const path of [
      '/connect',
      '/sign-in',
      '/dashboard',
      '/oauth/consent?client_id=test-app&scope=verification:read&consent_code=abc',
      '/verify-success',
      '/verify-error',
    ]) {
      const res = await server.fetch(path, { redirect: 'manual' });
      expect(res.status).toBe(404);
      expectHtmlSecurityHeaders(res);
      await expect(res.text()).resolves.toContain(
        'This UI route has moved to the TanStack web app.'
      );
    }
  });

  it('legacy browser routes redirect to the TanStack frontend when a separate frontend origin is configured', async () => {
    const redirectedServer = await startTestServer({
      baseUrl: 'http://localhost:3101',
      frontendUrl: 'http://localhost:3000',
    });

    try {
      const res = await redirectedServer.fetch('/dashboard?guild_id=test-guild-123', {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/dashboard?guild_id=test-guild-123'
      );
    } finally {
      redirectedServer.stop();
    }
  });

  it('GET /webhooks/gumroad/:id returns 405 for the wrong method', async () => {
    const res = await server.fetch('/webhooks/gumroad/any-route-id', {
      method: 'GET',
    });
    expect(res.status).toBe(405);
  });

  it('POST /webhooks/gumroad/:id rejects old timestamps before any Convex lookup', async () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
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

  it('POST /webhooks/unknownprovider/id returns 404', async () => {
    const res = await server.fetch('/webhooks/unknownprovider/any-id', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/public/verification/check is mounted', async () => {
    const res = await server.fetch('/api/public/verification/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).not.toBe(404);
  });

  it('GET /api/connect/status is mounted and auth-guarded', async () => {
    const res = await server.fetch('/api/connect/status');
    expect([302, 401]).toContain(res.status);
  });

  it('POST /api/connect/complete is mounted and auth-guarded', async () => {
    const res = await server.fetch('/api/connect/complete', { method: 'POST' });
    expect([302, 401]).toContain(res.status);
  });

  it('POST /api/collab/invite remains auth-guarded', async () => {
    const res = await server.fetch('/api/collab/invite', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('GET /api/nonexistent returns 404', async () => {
    const res = await server.fetch('/api/nonexistent-route-that-should-not-exist');
    expect(res.status).toBe(404);
  });
});
