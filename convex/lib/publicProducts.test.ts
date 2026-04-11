import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  fetchLiveProviderProductsForSources,
  resolveLiveProductsApiBaseUrl,
} from './publicProducts';

describe('resolveLiveProductsApiBaseUrl', () => {
  it('requires API_BASE_URL instead of falling back to SITE_URL', () => {
    expect(
      resolveLiveProductsApiBaseUrl({
        API_BASE_URL: undefined,
        SITE_URL: 'https://creators.test.example',
      })
    ).toBe('');
  });

  it('normalizes a configured API_BASE_URL', () => {
    expect(
      resolveLiveProductsApiBaseUrl({
        API_BASE_URL: 'https://api.creators.yucp.club/',
      })
    ).toBe('https://api.creators.yucp.club');
  });
});

describe('fetchLiveProviderProductsForSources', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('skips live fetches when API_BASE_URL is not configured even if SITE_URL is set', async () => {
    const fetchMock = mock(async () => {
      throw new Error('fetch should not be called');
    });
    const warnMock = mock(() => {});

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const products = await fetchLiveProviderProductsForSources({
      env: {
        SITE_URL: 'https://creators.test.example',
        CONVEX_API_SECRET: 'test-convex-api-secret',
      },
      sources: [{ authUserId: 'auth-user-1', owner: null }],
      providerKeys: ['jinxxy'],
      fetchImpl: globalThis.fetch,
      warn: warnMock,
    });

    expect(products).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(warnMock).toHaveBeenCalledWith(
      '[products] live provider fetch skipped because API_BASE_URL is missing or invalid'
    );
  });

  it('uses API_BASE_URL and continues after certificate-style provider fetch failures', async () => {
    const warnMock = mock(() => {});
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/jinxxy/products')) {
        throw new Error('unexpected EOF (Invalid certificate verification context)');
      }
      if (url.endsWith('/api/lemonsqueezy/products')) {
        return new Response(
          JSON.stringify({
            products: [{ id: 'prod_live_1', name: 'Live Product 1', collaboratorName: 'Collab A' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const products = await fetchLiveProviderProductsForSources({
      env: {
        API_BASE_URL: 'https://api.creators.yucp.club/',
        SITE_URL: 'https://creators.test.example',
        CONVEX_API_SECRET: 'test-convex-api-secret',
      },
      sources: [{ authUserId: 'auth-user-1', owner: null }],
      providerKeys: ['jinxxy', 'lemonsqueezy'],
      fetchImpl: fetchMock as unknown as typeof fetch,
      warn: warnMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.creators.yucp.club/api/jinxxy/products');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.creators.yucp.club/api/lemonsqueezy/products'
    );
    expect(warnMock).toHaveBeenCalledWith(
      '[products] live provider fetch failed for jinxxy at https://api.creators.yucp.club/api/jinxxy/products',
      expect.any(Error)
    );
    expect(products).toEqual([
      {
        productId: '',
        displayName: 'Live Product 1',
        providers: [{ provider: 'lemonsqueezy', providerProductRef: 'prod_live_1' }],
        owner: 'Collab A',
        configured: false,
        live: true,
      },
    ]);
  });
});
