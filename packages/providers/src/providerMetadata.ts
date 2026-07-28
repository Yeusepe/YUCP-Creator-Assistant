import { ALL_DESCRIPTOR_INPUTS } from './descriptors';
import type { ProviderDescriptor, ProviderDescriptorInput, ProviderKey } from './types';

function buildDescriptor(input: ProviderDescriptorInput): ProviderDescriptor {
  return {
    ...input,
    supportsOAuth: input.creatorAuthModes.includes('oauth'),
    supportsBuyerOAuthLink: input.supportsBuyerOAuthLink ?? false,
    supportsCollab: input.collabCredential != null,
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

export function providerIcon(providerKey: string): string | null {
  const iconKey = getProviderDescriptor(providerKey)?.emojiKey.trim();
  return iconKey ? `${iconKey}.png` : null;
}

/**
 * Resolve the public storefront URL for a catalog product.
 *
 * Priority: the URL supplied by the provider API at sync time (the only
 * trustworthy source for providers whose public URLs are not derivable),
 * then template derivation from the product's canonical slug. Returns null
 * when neither exists; callers must treat null as "no public link" rather
 * than fabricating one. The provider API product id (`providerProductRef`)
 * is intentionally not an input: it is not a URL-safe public identifier
 * (e.g. Gumroad API ids are not permalinks).
 */
export function resolveCatalogProductUrl(input: {
  provider: string;
  productUrl?: string | null;
  canonicalSlug?: string | null;
}): string | null {
  const productUrl = input.productUrl?.trim();
  if (productUrl) {
    try {
      const parsed = new URL(productUrl);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
        return productUrl;
      }
    } catch {
      // Fall through to canonical-slug derivation when the provider URL is malformed.
    }
  }
  const canonicalSlug = input.canonicalSlug?.trim();
  if (!canonicalSlug) {
    return null;
  }
  const template = getProviderDescriptor(input.provider)?.catalogProductUrlTemplate;
  if (!template) {
    return null;
  }
  const derivedUrl = template.replace('{slug}', canonicalSlug);
  try {
    const parsed = new URL(derivedUrl);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? derivedUrl : null;
  } catch {
    return null;
  }
}
