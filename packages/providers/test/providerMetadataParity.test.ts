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
});
