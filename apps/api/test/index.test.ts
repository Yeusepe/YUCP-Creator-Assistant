/**
 * API server integration tests.
 *
 * These checks verify the backend routes that still belong in the Bun API after
 * the TanStack UI cutover.
 */
// Source: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/09-Testing_for_Clickjacking

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestServer, type TestServerHandle } from './helpers/testServer';
import { type BuiltApiApp, buildApp } from './support/buildApp';

const FRONTEND_ORIGIN = 'http://localhost:3000';

const LEGACY_PAGE_REDIRECTS = [
  ['collab-invite.html', '/collab-invite', '/collab-invite'],
  ['connect.html', '/connect', '/connect'],
  ['dashboard.html', '/dashboard', '/dashboard'],
  ['discord-role-setup.html', '/discord-role-setup', '/setup/discord-role'],
  ['jinxxy-setup.html', '/jinxxy-setup', '/setup/jinxxy'],
  ['lemonsqueezy-setup.html', '/lemonsqueezy-setup', '/setup/lemonsqueezy'],
  ['oauth-consent.html', '/oauth/consent', '/oauth/consent'],
  ['oauth-error.html', '/oauth/error', '/oauth/error'],
  ['oauth-login.html', '/oauth/login', '/oauth/login'],
  ['payhip-setup.html', '/payhip-setup', '/setup/payhip'],
  ['privacypolicy.html', '/legal/privacy-policy', '/legal/privacy-policy'],
  ['sign-in.html', '/sign-in', '/sign-in'],
  ['termsofservice.html', '/legal/terms-of-service', '/legal/terms-of-service'],
  ['verify-error.html', '/verify-error', '/verify/error'],
  ['verify-success.html', '/verify-success', '/verify/success'],
  ['vrchat-verify.html', '/vrchat-verify', '/setup/vrchat'],
] as const;

const LEGACY_FILE_URL_REDIRECTS = [
  ['/collab-invite.html', '/collab-invite'],
  ['/dashboard.html', '/dashboard'],
  ['/discord-role-setup.html', '/setup/discord-role'],
  ['/jinxxy-setup.html', '/setup/jinxxy'],
  ['/lemonsqueezy-setup.html', '/setup/lemonsqueezy'],
  ['/payhip-setup.html', '/setup/payhip'],
  ['/verify-error.html', '/verify/error'],
  ['/verify-success.html', '/verify/success'],
  ['/vrchat-verify.html', '/setup/vrchat'],
] as const;

const LEGACY_FILE_URL_FALLBACKS = [
  '/connect.html',
  '/oauth-consent.html',
  '/oauth-error.html',
  '/oauth-login.html',
  '/privacypolicy.html',
  '/sign-in-redirect.html',
  '/sign-in.html',
  '/termsofservice.html',
] as const;

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

describe('API server, production app harness', () => {
  let app: BuiltApiApp;

  beforeAll(() => {
    app = buildApp({ frontendUrl: FRONTEND_ORIGIN });
  });

  afterAll(() => app.dispose());

  it('boots and serves health with optional delivery and VPM variables unset', async () => {
    expect(process.env.DELIVERY_HMAC_KEY).toBeUndefined();
    expect(process.env.DELIVERY_BASE_URL).toBeUndefined();
    expect(process.env.VPM_BASE_URL).toBeUndefined();
    expect(process.env.VPM_PUBLIC_INDEX_URL).toBeUndefined();
    expect(process.env.VPM_TOKEN_KEY).toBeUndefined();

    const res = await app.fetch('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
    expect(typeof body.timestamp).toBe('string');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('mounts VPM routes while optional delivery configuration is unset', async () => {
    const mintResponse = await app.fetch('/api/vpm/repo-token', { method: 'POST' });
    expect(mintResponse.status).toBe(401);
    await expect(mintResponse.json()).resolves.toEqual({ error: 'Authentication required' });

    const indexResponse = await app.fetch('/api/vpm/invalid-token/index.json');
    expect(indexResponse.status).toBe(503);
    await expect(indexResponse.json()).resolves.toEqual({
      error: 'VPM delivery is not configured',
    });
  });

  it('GET /v1/keys serves the importer trust bootstrap on the API host', async () => {
    const res = await app.fetch('/v1/keys');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as {
      keys?: Array<{
        kty?: string;
        crv?: string;
        kid?: string;
        x?: string;
      }>;
    };

    expect(body.keys?.length).toBeGreaterThan(0);
    expect(body.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kty: 'OKP',
          crv: 'Ed25519',
          kid: expect.any(String),
          x: expect.any(String),
        }),
      ])
    );
    for (const key of body.keys ?? []) {
      expect(key).not.toHaveProperty('d');
      expect(key).not.toHaveProperty('seed');
      expect(key).not.toHaveProperty('privateKey');
    }
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /api/public/v2/openapi.json is mounted through the v2 router', async () => {
    const res = await app.fetch('/api/public/v2/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('yucp-version')).toBe('2025-03-01');

    const body = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(body.openapi).toBe('3.1.0');
    expect(body.paths).toHaveProperty('/verification/check');
  });

  it('mounts the buyer download route through the API dispatcher', async () => {
    const response = await app.fetch('/api/access/catalog-product-123/download', {
      method: 'POST',
    });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({ error: 'Method not allowed' });
  });

  it('keeps every migrated page route on its prior frontend redirect', async () => {
    for (const [deletedFile, path, destination] of LEGACY_PAGE_REDIRECTS) {
      const response = await app.fetch(`${path}?source=${deletedFile}`, { redirect: 'manual' });
      expect(response.status, deletedFile).toBe(302);
      expect(response.headers.get('location'), deletedFile).toBe(
        `${FRONTEND_ORIGIN}${destination}?source=${deletedFile}`
      );
    }
  });

  it('keeps every deleted HTML filename URL on its prior response', async () => {
    for (const [path, destination] of LEGACY_FILE_URL_REDIRECTS) {
      const response = await app.fetch(path, { redirect: 'manual' });
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toBe(`${FRONTEND_ORIGIN}${destination}`);
    }

    for (const path of LEGACY_FILE_URL_FALLBACKS) {
      const response = await app.fetch(path);
      expect(response.status, path).toBe(404);
      expectHtmlSecurityHeaders(response);
      await expect(response.text()).resolves.toContain('Page not found');
    }
  });

  it('still serves every live asset class and the styled 404 fallback', async () => {
    for (const [path, contentType] of [
      ['/tokens.css', 'text/css'],
      ['/loading.css', 'text/css'],
      ['/Icons/favicon.ico', 'image/x-icon'],
      ['/assets/site/site.css', 'text/css'],
    ] as const) {
      const response = await app.fetch(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain(contentType);
    }

    const fallback = await app.fetch('/unknown-page-after-frontend-cleanup');
    expect(fallback.status).toBe(404);
    expectHtmlSecurityHeaders(fallback);
    await expect(fallback.text()).resolves.toContain('Page not found');
  });

  it('serves the externally embedded Sign in as Creator asset kit', async () => {
    for (const path of [
      '/assets/buttons/SignInAsCreator.html',
      '/assets/buttons/maskedgradient.jpg',
    ]) {
      const response = await app.fetch(path);
      expect(response.status, path).toBe(200);
    }
  });

  it('rejects overlapping buildApp instances while handler state is module-scoped', () => {
    let overlappingApp: BuiltApiApp | undefined;

    try {
      expect(() => {
        overlappingApp = buildApp();
      }).toThrow(
        'buildApp only supports one app per test worker while handler state is module-scoped'
      );
    } finally {
      overlappingApp?.dispose();
    }
  });

  it('rejects a second buildApp lifetime after dispose while handler state is module-scoped', () => {
    app.dispose();
    expect(() => buildApp()).toThrow(
      'buildApp only supports one app per test worker while handler state is module-scoped'
    );
  });
});

describe('API server, route mounting', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('legacy browser routes fail closed on the API origin with hardening headers', async () => {
    for (const [, path] of LEGACY_PAGE_REDIRECTS) {
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
