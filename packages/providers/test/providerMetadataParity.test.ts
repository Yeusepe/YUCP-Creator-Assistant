import { describe, expect, it } from 'bun:test';
import { SHARED_PROVIDER_KEYS } from '../../shared/src/providerKeys';
import {
  CATALOG_SYNC_PROVIDER_KEYS,
  getProviderDescriptor,
  PROVIDER_KEYS,
  PROVIDER_REGISTRY,
  PROVIDER_REGISTRY_BY_KEY,
} from '../src/providerMetadata';

describe('provider metadata parity', () => {
  it('keeps the shared provider key vocabulary aligned with provider metadata', () => {
    expect(PROVIDER_KEYS).toEqual(SHARED_PROVIDER_KEYS);
    expect(CATALOG_SYNC_PROVIDER_KEYS).toEqual(
      PROVIDER_REGISTRY.filter((provider) => provider.capabilities.includes('catalog_sync')).map(
        (provider) => provider.providerKey
      )
    );
  });

  it('resolves providers by key', () => {
    for (const provider of PROVIDER_REGISTRY) {
      expect(getProviderDescriptor(provider.providerKey)).toEqual(provider);
      expect(PROVIDER_REGISTRY_BY_KEY[provider.providerKey]).toEqual(provider);
    }
  });

  it('keeps itch.io mapped to the custom ItchIo emoji', () => {
    expect(getProviderDescriptor('itchio')?.emojiKey).toBe('ItchIo');
  });

  it('advertises itch.io buyer verification through account linking only', () => {
    expect(getProviderDescriptor('itchio')).toMatchObject({
      buyerVerificationMethods: ['account_link'],
      verificationMethods: ['account_link'],
      supportsBuyerOAuthLink: true,
      supportsLicenseVerify: false,
    });
  });

  it('keeps itch.io account-link capability flags aligned with its descriptor metadata', () => {
    const descriptor = getProviderDescriptor('itchio');
    expect(descriptor).toBeDefined();
    expect(descriptor?.capabilities).toEqual(
      expect.arrayContaining(['account_link', 'catalog_sync', 'orders', 'ownership_verification'])
    );
    expect(descriptor?.buyerVerificationMethods.includes('account_link')).toBe(true);
    expect(descriptor?.buyerVerificationMethods.includes('license_key')).toBe(false);
    expect(descriptor?.supportsBuyerOAuthLink).toBe(
      descriptor?.buyerVerificationMethods.includes('account_link')
    );
    expect(descriptor?.supportsLicenseVerify).toBe(
      descriptor?.capabilities.includes('license_verification') ?? false
    );
  });
});
