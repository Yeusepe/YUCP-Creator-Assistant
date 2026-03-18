import { PROVIDER_REGISTRY_BY_KEY } from './registry';
import type { ProviderDescriptor, ProviderKey } from './types';

export function getProviderDescriptor(providerKey: string): ProviderDescriptor | undefined {
  return PROVIDER_REGISTRY_BY_KEY[providerKey as ProviderKey];
}

export function providerLabel(providerKey: string): string {
  return getProviderDescriptor(providerKey)?.label ?? providerKey;
}

/**
 * Build the canonical URL for a catalog product entry.
 * Returns null if the provider has no URL template (e.g. discord_role, payhip).
 */
export function buildCatalogProductUrl(providerKey: string, productRef: string): string | null {
  const descriptor = getProviderDescriptor(providerKey);
  if (!descriptor?.catalogProductUrlTemplate) return null;
  return descriptor.catalogProductUrlTemplate.replace('{ref}', productRef);
}
