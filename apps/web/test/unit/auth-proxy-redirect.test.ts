/**
 * Tests for the auth proxy redirect handling in the /api/auth/* route.
 *
 * Background: @convex-dev/better-auth/react-start's handler fetches Convex with
 * redirect:'manual' and passes 3xx responses straight through to TanStack Start.
 * When the browser's fetch() (default redirect:'follow') receives a 302 from
 * POST /api/auth/oauth2/consent, it follows the entire redirect chain silently
 * (Convex callback → Unity loopback server). The consent page never sees the
 * redirect target and falls back to window.location.reload(), creating the loop.
 *
 * The fix: POST redirect responses must be converted to JSON { redirectTo } so
 * the JS client can navigate programmatically.  This mirrors the exact same
 * pattern already used by the Bun API proxy (apps/api/src/index.ts).
 */

import { describe, expect, it } from 'vitest';
import { convertPostRedirectToJson } from '@/lib/auth-server';

describe('convertPostRedirectToJson', () => {
  it('converts a POST 302 response to JSON { redirectTo }', async () => {
    const callbackUrl =
      'https://rare-squid-409.convex.site/api/yucp/oauth/callback?code=abc123&state=WaqyXx3I';
    const redirect302 = new Response(null, {
      status: 302,
      headers: { location: callbackUrl },
    });

    const result = convertPostRedirectToJson('POST', redirect302);

    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body).toEqual({ redirectTo: callbackUrl });
  });

  it('converts a POST 301 response to JSON { redirectTo }', async () => {
    const redirect301 = new Response(null, {
      status: 301,
      headers: { location: 'https://example.com/moved' },
    });

    const result = convertPostRedirectToJson('POST', redirect301);

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ redirectTo: 'https://example.com/moved' });
  });

  it('passes GET 302 through unchanged (browser handles it natively)', () => {
    const redirect302 = new Response(null, {
      status: 302,
      headers: { location: 'https://discord.com/auth' },
    });

    const result = convertPostRedirectToJson('GET', redirect302);

    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe('https://discord.com/auth');
  });

  it('passes non-redirect POST responses through unchanged', async () => {
    const ok = new Response(JSON.stringify({ token: 'abc' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const result = convertPostRedirectToJson('POST', ok);

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ token: 'abc' });
  });

  it('sets cache-control: no-store on the JSON redirect response', async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/callback' },
    });

    const result = convertPostRedirectToJson('POST', redirect);

    expect(result.headers.get('cache-control')).toBe('no-store');
  });

  it('uses empty string for redirectTo when Location header is missing', async () => {
    const redirectNoLocation = new Response(null, { status: 302 });

    const result = convertPostRedirectToJson('POST', redirectNoLocation);

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ redirectTo: '' });
  });
});
