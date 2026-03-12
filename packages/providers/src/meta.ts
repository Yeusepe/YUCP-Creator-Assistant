import {
  LICENSE_PROVIDER_KEYS,
  PROVIDER_REGISTRY,
  PROVIDER_REGISTRY_BY_KEY,
  type ProviderDescriptor,
  type ProviderKey,
  providerLabel,
} from '@yucp/shared';

export interface ProviderMeta {
  id: ProviderKey;
  label: string;
  emojiKey: string;
  addProductDescription: string;
  supportsLicenseVerify: boolean;
  supportsWebhook: boolean;
  supportsOAuth: boolean;
  supportsCredentialLogin: boolean;
  supportsDisconnect: boolean;
  docsUrl: string;
  category: ProviderDescriptor['category'];
  status: ProviderDescriptor['status'];
  creatorAuthModes: ProviderDescriptor['creatorAuthModes'];
  buyerVerificationMethods: ProviderDescriptor['buyerVerificationMethods'];
  capabilities: ProviderDescriptor['capabilities'];
  setupRequirements: ProviderDescriptor['setupRequirements'];
}

export const PROVIDER_META = Object.fromEntries(
  PROVIDER_REGISTRY.map((provider) => [
    provider.providerKey,
    {
      id: provider.providerKey,
      label: provider.label,
      emojiKey: provider.emojiKey,
      addProductDescription: provider.addProductDescription,
      supportsLicenseVerify: provider.supportsLicenseVerify,
      supportsWebhook: provider.supportsWebhook,
      supportsOAuth: provider.supportsOAuth,
      supportsCredentialLogin: provider.supportsCredentialLogin,
      supportsDisconnect: provider.supportsDisconnect,
      docsUrl: provider.docsUrl,
      category: provider.category,
      status: provider.status,
      creatorAuthModes: provider.creatorAuthModes,
      buyerVerificationMethods: provider.buyerVerificationMethods,
      capabilities: provider.capabilities,
      setupRequirements: provider.setupRequirements,
    } satisfies ProviderMeta,
  ])
) as unknown as Record<ProviderKey, ProviderMeta>;

export const LICENSE_PROVIDERS = [...LICENSE_PROVIDER_KEYS];

export { PROVIDER_REGISTRY, PROVIDER_REGISTRY_BY_KEY, providerLabel };
