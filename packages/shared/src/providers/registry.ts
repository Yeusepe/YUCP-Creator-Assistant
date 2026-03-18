import { ALL_DESCRIPTOR_INPUTS } from './descriptors';
import type { ProviderDescriptor, ProviderDescriptorInput, ProviderKey } from './types';

/** Compute the derived boolean flags from capabilities and creatorAuthModes. */
function buildDescriptor(input: ProviderDescriptorInput): ProviderDescriptor {
  return {
    ...input,
    supportsOAuth: input.creatorAuthModes.includes('oauth'),
    supportsDisconnect: input.creatorAuthModes.some((m) => m !== 'none'),
    supportsWebhook: input.capabilities.includes('webhooks'),
    supportsLicenseVerify: input.capabilities.includes('license_verification'),
    supportsTestMode: input.capabilities.includes('test_mode'),
  };
}

/**
 * The assembled provider registry. Each entry is built from a per-provider
 * descriptor file with derived boolean flags computed automatically.
 */
export const PROVIDER_REGISTRY: readonly ProviderDescriptor[] =
  ALL_DESCRIPTOR_INPUTS.map(buildDescriptor);

export const PROVIDER_REGISTRY_BY_KEY = Object.fromEntries(
  PROVIDER_REGISTRY.map((provider) => [provider.providerKey, provider])
) as Record<ProviderKey, ProviderDescriptor>;

export const ACTIVE_PROVIDER_KEYS = PROVIDER_REGISTRY.filter(
  (provider) => provider.status === 'active'
).map((provider) => provider.providerKey);

export const LICENSE_PROVIDER_KEYS = PROVIDER_REGISTRY.filter(
  (provider) => provider.supportsLicenseVerify
).map((provider) => provider.providerKey);

export const WEBHOOK_PROVIDER_KEYS = PROVIDER_REGISTRY.filter(
  (provider) => provider.supportsWebhook
).map((provider) => provider.providerKey);

export const COMMERCE_PROVIDER_KEYS = PROVIDER_REGISTRY.filter(
  (provider) => provider.category === 'commerce' || provider.category === 'manual'
).map((provider) => provider.providerKey);

/** Providers that require a per-product credential for license verification. */
export const PER_PRODUCT_CREDENTIAL_PROVIDER_KEYS = PROVIDER_REGISTRY.filter(
  (provider) => provider.perProductCredential != null
).map((provider) => provider.providerKey);

/** Providers that support catalog sync (have the 'catalog_sync' capability). */
export const CATALOG_SYNC_PROVIDER_KEYS = PROVIDER_REGISTRY.filter((p) =>
  p.capabilities.includes('catalog_sync')
).map((p) => p.providerKey);
