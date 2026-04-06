import { ALL_DESCRIPTOR_INPUTS } from './descriptors';
import type { ProviderDescriptor, ProviderDescriptorInput, ProviderKey } from './types';

function buildDescriptor(input: ProviderDescriptorInput): ProviderDescriptor {
  return {
    ...input,
    supportsOAuth: input.creatorAuthModes.includes('oauth'),
    supportsDisconnect: input.creatorAuthModes.some((mode) => mode !== 'none'),
    supportsWebhook: input.capabilities.includes('webhooks'),
    supportsLicenseVerify: input.capabilities.includes('license_verification'),
    supportsTestMode: input.capabilities.includes('test_mode'),
  };
}

export const PROVIDER_REGISTRY: readonly ProviderDescriptor[] =
  ALL_DESCRIPTOR_INPUTS.map(buildDescriptor);

export const PROVIDER_REGISTRY_BY_KEY = Object.freeze(
  Object.fromEntries(PROVIDER_REGISTRY.map((provider) => [provider.providerKey, provider]))
) as Record<ProviderKey, ProviderDescriptor>;

export const PROVIDER_KEYS = Object.freeze(
  PROVIDER_REGISTRY.map((provider) => provider.providerKey)
) as readonly ProviderKey[];

export const ACTIVE_PROVIDER_KEYS = Object.freeze(
  PROVIDER_REGISTRY.filter((provider) => provider.status === 'active').map(
    (provider) => provider.providerKey
  )
) as readonly ProviderKey[];

export const LICENSE_PROVIDER_KEYS = Object.freeze(
  PROVIDER_REGISTRY.filter((provider) => provider.supportsLicenseVerify).map(
    (provider) => provider.providerKey
  )
) as readonly ProviderKey[];

export const WEBHOOK_PROVIDER_KEYS = Object.freeze(
  PROVIDER_REGISTRY.filter((provider) => provider.supportsWebhook).map(
    (provider) => provider.providerKey
  )
) as readonly ProviderKey[];

export const COMMERCE_PROVIDER_KEYS = Object.freeze(
  PROVIDER_REGISTRY.filter(
    (provider) => provider.category === 'commerce' || provider.category === 'manual'
  ).map((provider) => provider.providerKey)
) as readonly ProviderKey[];

export const PER_PRODUCT_CREDENTIAL_PROVIDER_KEYS = Object.freeze(
  PROVIDER_REGISTRY.filter((provider) => provider.perProductCredential != null).map(
    (provider) => provider.providerKey
  )
) as readonly ProviderKey[];

export const CATALOG_SYNC_PROVIDER_KEYS = Object.freeze(
  PROVIDER_REGISTRY.filter((provider) => provider.capabilities.includes('catalog_sync')).map(
    (provider) => provider.providerKey
  )
) as readonly ProviderKey[];

export function getProviderDescriptor(providerKey: string): ProviderDescriptor | undefined {
  return PROVIDER_REGISTRY_BY_KEY[providerKey as ProviderKey];
}

export function providerLabel(providerKey: string): string {
  return getProviderDescriptor(providerKey)?.label ?? providerKey;
}

export function buildCatalogProductUrl(providerKey: string, productRef: string): string | null {
  const descriptor = getProviderDescriptor(providerKey);
  if (!descriptor?.catalogProductUrlTemplate) {
    return null;
  }
  return descriptor.catalogProductUrlTemplate.replace('{ref}', productRef);
}
