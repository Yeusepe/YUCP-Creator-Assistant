/**
 * PayhipApiClient unit tests
 *
 * Tests for fetchProductName, which scrapes the public Payhip product page
 * to resolve a human-readable name from a product permalink.
 *
 * Reference: https://payhip.com/b/{permalink}
 * The page embeds a JSON-LD block with "name" and an og:title meta tag.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { PayhipApiClient } from '../../src/payhip/client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Minimal Payhip product page HTML (matches the real shape from https://payhip.com/b/KZFw0)
function makeProductPage(opts: {
  ldJsonName?: string;
  ogTitle?: string;
  malformedLdJson?: boolean;
  omitLdJson?: boolean;
  omitOgTitle?: boolean;
}): string {
  const ldJsonBlock = opts.omitLdJson
    ? ''
    : opts.malformedLdJson
      ? `<script type="application/ld+json">{ invalid json }</script>`
      : `<script type="application/ld+json">
            {
                "@context": "https:\\/\\/schema.org\\/",
                "@type": "Product",
                "name": "${opts.ldJsonName ?? 'Test Product'}",
                "description": ""
            }</script>`;

  const ogTitleBlock = opts.omitOgTitle
    ? ''
    : `<meta property="og:title" content="${opts.ogTitle ?? 'Test Product'}"/>`;

  return `<!DOCTYPE html>
<html>
<head>
  <title>${opts.ldJsonName ?? opts.ogTitle ?? 'Test Product'} - Payhip</title>
  ${ldJsonBlock}
  ${ogTitleBlock}
</head>
<body></body>
</html>`;
}

function mockFetchWithHtml(html: string, status = 200): void {
  globalThis.fetch = mock(async (_url: string, _init?: RequestInit) => {
    return new Response(html, {
      status,
      headers: { 'Content-Type': 'text/html' },
    });
  }) as unknown as typeof fetch;
}

describe('PayhipApiClient.fetchProductName', () => {
  it('extracts the product name from JSON-LD structured data', async () => {
    mockFetchWithHtml(makeProductPage({ ldJsonName: 'This is a test' }));

    const client = new PayhipApiClient();
    const name = await client.fetchProductName('KZFw0');

    expect(name).toBe('This is a test');
  });

  it('falls back to og:title when JSON-LD is absent', async () => {
    mockFetchWithHtml(makeProductPage({ omitLdJson: true, ogTitle: 'My Fallback Product' }));

    const client = new PayhipApiClient();
    const name = await client.fetchProductName('KZFw0');

    expect(name).toBe('My Fallback Product');
  });

  it('falls back to og:title when JSON-LD is malformed', async () => {
    mockFetchWithHtml(
      makeProductPage({ malformedLdJson: true, ogTitle: 'Product From OG Title' })
    );

    const client = new PayhipApiClient();
    const name = await client.fetchProductName('KZFw0');

    expect(name).toBe('Product From OG Title');
  });

  it('prefers JSON-LD over og:title when both are present', async () => {
    mockFetchWithHtml(
      makeProductPage({ ldJsonName: 'From JSON-LD', ogTitle: 'From OG Title' })
    );

    const client = new PayhipApiClient();
    const name = await client.fetchProductName('KZFw0');

    expect(name).toBe('From JSON-LD');
  });

  it('returns null when neither JSON-LD name nor og:title are present', async () => {
    mockFetchWithHtml(makeProductPage({ omitLdJson: true, omitOgTitle: true }));

    const client = new PayhipApiClient();
    const name = await client.fetchProductName('KZFw0');

    expect(name).toBeNull();
  });

  it('returns null on a non-OK HTTP response', async () => {
    mockFetchWithHtml('', 404);

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

  it('constructs the correct product page URL from the permalink', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      calls.push(url);
      return new Response(makeProductPage({ ldJsonName: 'Test' }), {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }) as unknown as typeof fetch;

    const client = new PayhipApiClient();
    await client.fetchProductName('RGsF');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://payhip.com/b/RGsF');
  });
});
