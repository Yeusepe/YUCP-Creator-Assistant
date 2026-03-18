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

/**
 * Describes a per-product credential required by a provider (e.g. Payhip's product-secret-key).
 * When present on a ProviderDescriptor, the bot and dashboard will collect this credential
 * alongside the product ID so that license verification works immediately.
 */
export interface PerProductCredentialDescriptor {
  /** Prefix used when storing in provider_credentials.credentialKey, e.g. "product_key:" */
  credentialKeyPrefix: string;
  /** UI label for the secret key input, e.g. "Product Secret Key" */
  credentialLabel: string;
  /** UI label for the product identifier input, e.g. "Product Permalink" */
  productIdLabel: string;
  /** Placeholder shown in the product ID input, e.g. "e.g. RGsF" */
  productIdPlaceholder: string;
  /** Short help text explaining where to find the key */
  helpText: string;
}

/**
 * Lean input type for defining a provider descriptor.
 * Boolean convenience flags (supportsOAuth, supportsWebhook, etc.) are NOT included here;
 * they are computed by the registry builder from capabilities and creatorAuthModes.
 *
 * The one exception is `supportsCredentialLogin` which captures a UI-level distinction
 * (whether the dashboard connect flow uses a credential input) that cannot be reliably
 * derived from creatorAuthModes alone.
 */
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

  /**
   * Whether the dashboard connect flow uses a credential input (API key / token / password)
   * rather than an OAuth redirect. Cannot be reliably derived from creatorAuthModes alone
   * because some api_key providers (e.g. Jinxxy) use a different connect flow.
   */
  supportsCredentialLogin: boolean;

  /** When set, this provider requires a per-product credential for license verification. */
  perProductCredential?: PerProductCredentialDescriptor;
  /** When true, this provider can be added as a collab store source */
  supportsCollab?: boolean;
  /** Config for the manual collab add credential modal (only when supportsCollab is true) */
  collabCredential?: {
    /** Modal input label, e.g. "Jinxxy API Key" */
    label: string;
    /** Modal input placeholder */
    placeholder?: string;
  };
  /**
   * License key input config for the verification modal.
   * Only present if the provider supports license_verification AND uses typed license keys.
   */
  licenseKey?: {
    /** Modal input label, e.g. "License Key (XXXX-XXXX-XXXX-XXXX)" */
    inputLabel: string;
    /** Modal input placeholder, e.g. "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX" */
    placeholder: string;
  };
  /**
   * Product ID/URL input config for the product add flow.
   * The label and description are shown in the step-2 modal for typing in a product.
   */
  productInput?: {
    /** Step label for the text input, e.g. "Gumroad Product URL or ID" */
    label: string;
    /** Description/help text, e.g. "URL (gumroad.com/l/abc123) or product ID" */
    description: string;
    /** Optional placeholder for the input field */
    placeholder?: string;
    /**
     * When false, this product-input entry is always shown in the product-add menu
     * regardless of whether the provider is connected. Defaults to true.
     */
    requiresConnection?: boolean;
  };
  /**
   * URL template for a catalog product link.
   * The placeholder `{ref}` is replaced with the provider product ref at runtime.
   * Only set for providers with `catalog_sync` capability.
   * Example: "https://gumroad.com/l/{ref}"
   */
  catalogProductUrlTemplate?: string;
  /**
   * Whether this provider supports automatic purchase discovery (backfill from sales API).
   * Only true for providers with the `reconciliation` capability that expose a sales list API.
   */
  supportsAutoDiscovery?: boolean;
}

/**
 * Full provider descriptor with computed convenience booleans.
 * Consumers read this type. The booleans are derived at registry-build time from
 * capabilities and creatorAuthModes so they can never drift out of sync.
 */
export interface ProviderDescriptor extends ProviderDescriptorInput {
  /** Derived: creatorAuthModes.includes('oauth') */
  supportsOAuth: boolean;
  /** Derived: capabilities.includes('webhooks') */
  supportsWebhook: boolean;
  /** Derived: capabilities.includes('license_verification') */
  supportsLicenseVerify: boolean;
  /** Derived: capabilities.includes('test_mode') */
  supportsTestMode: boolean;
  /** Derived: creatorAuthModes.some(m => m !== 'none') */
  supportsDisconnect: boolean;
}
