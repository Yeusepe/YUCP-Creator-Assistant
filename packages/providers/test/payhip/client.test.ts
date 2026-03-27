/**
 * PayhipApiClient unit tests
 *
 * Tests for fetchProductName, which resolves a human-readable product name
 * from a Payhip permalink via the iframely metadata API.
 *
 * Reference: https://iframely.com/iframely?uri=https://payhip.com/b/{permalink}&meta=true
 * The iframely response includes a `meta.title` field with the product name.
 * This bypasses Cloudflare's bot protection on payhip.com/b/{permalink}.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { PayhipApiClient } from '../../src/payhip/client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Minimal iframely JSON response (matches the real shape from
// https://iframely.com/iframely?uri=https://payhip.com/b/KZFw0&meta=true)
function makeIframelyResponse(title: string | null): string {
  if (title === null) {
    return JSON.stringify({ meta: {}, links: [], rel: [] });
  }
  return JSON.stringify({
    meta: { title, medium: 'product', site: 'Payhip' },
    links: [],
    rel: [],
  });
}

function mockFetchWithJson(body: string, status = 200): void {
  globalThis.fetch = mock(async (_url: string, _init?: RequestInit) => {
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('PayhipApiClient.fetchProductName', () => {
  it('extracts the product name from iframely meta.title', async () => {
    mockFetchWithJson(makeIframelyResponse('This is a test'));

    const client = new PayhipApiClient();
    const name = await client.fetchProductName('KZFw0');

    expect(name).toBe('This is a test');
  });

  it('returns null when iframely meta.title is absent', async () => {
    mockFetchWithJson(makeIframelyResponse(null));

    const client = new PayhipApiClient();
    const name = await client.fetchProductName('KZFw0');

    expect(name).toBeNull();
  });

  it('returns null on a non-OK HTTP response', async () => {
    mockFetchWithJson('', 403);

    const client = new PayhipApiClient();
    const name = await client.fetchProductName('nonexistent');

    expect(name).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network failure');
    }) as unknown as typeof fetch;

    const client = new PayhipApiClient();
    const name = await client.fetchProductName('KZFw0');

    expect(name).toBeNull();
  });

  it('calls the iframely endpoint with the correct URI for the permalink', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(makeIframelyResponse('Test Product'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new PayhipApiClient();
    await client.fetchProductName('RGsF');

    expect(calls).toHaveLength(1);
    const [calledUrl, calledInit] = calls[0] as [string, RequestInit];
    expect(calledUrl).toContain('iframely.com/iframely');
    expect(calledUrl).toContain(encodeURIComponent('https://payhip.com/b/RGsF'));
    expect((calledInit?.headers as Record<string, string>)?.Origin).toBe(
      'https://debug.iframely.com'
    );
  });
});
