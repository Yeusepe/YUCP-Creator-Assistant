import { describe, expect, it } from 'bun:test';
import {
  getProviderDescriptor,
  providerIcon,
  resolveCatalogProductUrl,
} from '../src/providerMetadata';

describe('providerIcon', () => {
  it('derives storefront icon filenames from provider-owned descriptor metadata', () => {
    expect(providerIcon('gumroad')).toBe('Gumorad.png');
    expect(providerIcon('jinxxy')).toBe('Jinxxy.png');
    expect(providerIcon('not-a-provider')).toBeNull();
  });
});

describe('resolveCatalogProductUrl', () => {
  it('prefers the provider-supplied product URL over any derived value', () => {
    expect(
      resolveCatalogProductUrl({
        provider: 'gumroad',
        productUrl: 'https://creator.gumroad.com/l/fluffgan',
        canonicalSlug: 'fluffgan',
      })
    ).toBe('https://creator.gumroad.com/l/fluffgan');
  });

  it('derives the Gumroad product URL from the canonical permalink slug', () => {
    expect(
      resolveCatalogProductUrl({
        provider: 'gumroad',
        canonicalSlug: 'fluffgan',
      })
    ).toBe('https://gumroad.com/l/fluffgan');
  });

  it('never builds a Gumroad URL from the provider API product id', () => {
    // Gumroad API ids (e.g. "Dcmv6A==") are not permalinks; gumroad.com/l/{id} 404s.
    expect(
      resolveCatalogProductUrl({
        provider: 'gumroad',
        productUrl: null,
        canonicalSlug: null,
      })
    ).toBeNull();
    expect(resolveCatalogProductUrl({ provider: 'gumroad' })).toBeNull();
  });

  it('returns the Jinxxy API product URL verbatim', () => {
    expect(
      resolveCatalogProductUrl({
        provider: 'jinxxy',
        productUrl: 'https://jinxxy.com/Squishycollars/abie',
      })
    ).toBe('https://jinxxy.com/Squishycollars/abie');
  });

  it('never derives a Jinxxy URL from the item slug or API product id', () => {
    // Real Jinxxy URLs are jinxxy.com/{creator}/{item}; the item slug alone is
    // not routable and the API id never appears in public URLs.
    expect(
      resolveCatalogProductUrl({
        provider: 'jinxxy',
        canonicalSlug: 'abie',
      })
    ).toBeNull();
    expect(resolveCatalogProductUrl({ provider: 'jinxxy' })).toBeNull();
  });

  it('returns the Lemon Squeezy API product URL verbatim and never derives one', () => {
    expect(
      resolveCatalogProductUrl({
        provider: 'lemonsqueezy',
        productUrl: 'https://store.lemonsqueezy.com/checkout/buy/abc123',
        canonicalSlug: 'abc123',
      })
    ).toBe('https://store.lemonsqueezy.com/checkout/buy/abc123');
    // app.lemonsqueezy.com/* is the merchant dashboard, not a buyer-facing page.
    expect(
      resolveCatalogProductUrl({
        provider: 'lemonsqueezy',
        canonicalSlug: 'abc123',
      })
    ).toBeNull();
  });

  it('never derives a VRChat URL', () => {
    expect(
      resolveCatalogProductUrl({
        provider: 'vrchat',
        canonicalSlug: 'prod_00000000-0000-0000-0000-000000000000',
      })
    ).toBeNull();
  });

  it('returns null for unknown providers', () => {
    expect(resolveCatalogProductUrl({ provider: 'not-a-provider', canonicalSlug: 'x' })).toBeNull();
  });

  it('ignores blank values', () => {
    expect(
      resolveCatalogProductUrl({ provider: 'gumroad', productUrl: '  ', canonicalSlug: ' ' })
    ).toBeNull();
  });

  it('rejects product URLs that are not absolute HTTPS storefront links', () => {
    expect(
      resolveCatalogProductUrl({
        provider: 'itchio',
        productUrl: 'javascript:alert(1)',
      })
    ).toBeNull();
    expect(
      resolveCatalogProductUrl({
        provider: 'itchio',
        productUrl: 'http://creator.itch.io/game',
      })
    ).toBeNull();
    expect(
      resolveCatalogProductUrl({
        provider: 'itchio',
        productUrl: '/relative/game',
      })
    ).toBeNull();
  });

  it('falls back to canonical slug derivation when a supplied URL is unsafe', () => {
    expect(
      resolveCatalogProductUrl({
        provider: 'gumroad',
        productUrl: 'javascript:alert(1)',
        canonicalSlug: 'fluffgan',
      })
    ).toBe('https://gumroad.com/l/fluffgan');
  });
});

describe('catalogProductUrlTemplate descriptors', () => {
  it('uses the canonical slug placeholder for derivable providers', () => {
    expect(getProviderDescriptor('gumroad')?.catalogProductUrlTemplate).toBe(
      'https://gumroad.com/l/{slug}'
    );
  });

  it('does not offer URL templates for providers without a derivable public product URL', () => {
    expect(getProviderDescriptor('jinxxy')?.catalogProductUrlTemplate).toBeUndefined();
    expect(getProviderDescriptor('lemonsqueezy')?.catalogProductUrlTemplate).toBeUndefined();
    expect(getProviderDescriptor('vrchat')?.catalogProductUrlTemplate).toBeUndefined();
  });

  it('declares whether a provider catalog sync can supply a public product URL', () => {
    expect(getProviderDescriptor('gumroad')?.catalogProductUrlFromProvider).toBe(true);
    expect(getProviderDescriptor('jinxxy')?.catalogProductUrlFromProvider).toBe(true);
    expect(getProviderDescriptor('lemonsqueezy')?.catalogProductUrlFromProvider).toBe(true);
    expect(getProviderDescriptor('vrchat')?.catalogProductUrlFromProvider).toBeUndefined();
  });
});
