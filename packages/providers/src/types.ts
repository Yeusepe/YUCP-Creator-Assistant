export const PROVIDER_KEYS = [
  'discord',
  'gumroad',
  'jinxxy',
  'lemonsqueezy',
  'manual',
  'patreon',
  'fourthwall',
  'itchio',
  'payhip',
  'vrchat',
] as const;

export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export const RUNTIME_PROVIDER_KEYS = [
  'gumroad',
  'itchio',
  'jinxxy',
  'lemonsqueezy',
  'patreon',
  'payhip',
  'vrchat',
] as const;

export type RuntimeProviderKey = (typeof RUNTIME_PROVIDER_KEYS)[number];

export const PROVIDER_CATEGORIES = [
  'commerce',
  'community',
  'identity',
  'manual',
  'virtual_world',
] as const;

export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

export const PROVIDER_STATUSES = ['active', 'planned', 'inactive'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const PROVIDER_AUTH_MODES = [
  'oauth',
  'api_key',
  'api_token',
  'credentials',
  'none',
] as const;
export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODES)[number];

export const COLLAB_LINK_MODES = ['api', 'account'] as const;
export type CollabLinkMode = (typeof COLLAB_LINK_MODES)[number];

export const VERIFICATION_METHOD_KEYS = [
  'account_link',
  'license_key',
  'oauth',
  'discord_role',
  'manual',
  'none',
] as const;
export type VerificationMethodKey = (typeof VERIFICATION_METHOD_KEYS)[number];

export const PROVIDER_CAPABILITY_KEYS = [
  'account_link',
  'catalog_sync',
  'tier_catalog',
  'tier_entitlements',
  'webhooks',
  'managed_webhooks',
  'reconciliation',
  'license_verification',
  'subscriptions',
  'orders',
  'refunds',
  'test_mode',
  'ownership_verification',
] as const;
export type ProviderCapabilityKey = (typeof PROVIDER_CAPABILITY_KEYS)[number];

export const SETUP_REQUIREMENT_KEYS = [
  'oauth_client',
  'api_key',
  'api_token',
  'webhook_secret',
  'webhook_endpoint',
  'store_selection',
  'test_mode_toggle',
  'product_mapping',
] as const;
export type SetupRequirementKey = (typeof SETUP_REQUIREMENT_KEYS)[number];

export interface PerProductCredentialDescriptor {
  credentialKeyPrefix: string;
  credentialLabel: string;
  productIdLabel: string;
  productIdPlaceholder: string;
  helpText: string;
}

export interface ProviderDescriptorInput {
  providerKey: ProviderKey;
  label: string;
  category: ProviderCategory;
  status: ProviderStatus;
  docsUrl: string;
  emojiKey: string;
  addProductDescription: string;
  creatorAuthModes: readonly ProviderAuthMode[];
  buyerVerificationMethods: readonly VerificationMethodKey[];
  capabilities: readonly ProviderCapabilityKey[];
  setupRequirements: readonly SetupRequirementKey[];
  verificationMethods: readonly VerificationMethodKey[];
  supportsCredentialLogin: boolean;
  supportsBuyerOAuthLink?: boolean;
  perProductCredential?: PerProductCredentialDescriptor;
  collabCredential?: {
    label: string;
    placeholder?: string;
  };
  collabLinkModes?: readonly CollabLinkMode[];
  licenseKey?: {
    inputLabel: string;
    placeholder: string;
  };
  productInput?: {
    label: string;
    description: string;
    placeholder?: string;
    requiresConnection?: boolean;
  };
  /**
   * Public product URL template containing a `{slug}` placeholder, filled with
   * the product's canonical slug (never the provider API product id). Omit when
   * the provider has no slug-derivable public URL; those providers must supply
   * the real URL via `ProductRecord.productUrl` at sync time.
   */
  catalogProductUrlTemplate?: string;
  /**
   * True when catalog synchronization can return a trustworthy public URL in
   * `ProductRecord.productUrl`. Remediation uses this to distinguish products
   * that need re-sync from providers that intentionally have no public page.
   */
  catalogProductUrlFromProvider?: boolean;
  supportsAutoDiscovery?: boolean;
}

export interface ProviderDescriptor extends ProviderDescriptorInput {
  supportsOAuth: boolean;
  supportsBuyerOAuthLink: boolean;
  supportsWebhook: boolean;
  supportsLicenseVerify: boolean;
  supportsTestMode: boolean;
  supportsDisconnect: boolean;
  supportsCollab: boolean;
}
