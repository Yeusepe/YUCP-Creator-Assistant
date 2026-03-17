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

export interface ProviderDescriptor {
  providerKey: ProviderKey;
  label: string;
  category: ProviderCategory;
  status: ProviderStatus;
  docsUrl: string;
  emojiKey: string;
  addProductDescription: string;
  creatorAuthModes: ProviderAuthMode[];
  buyerVerificationMethods: VerificationMethodKey[];
  capabilities: ProviderCapabilityKey[];
  setupRequirements: SetupRequirementKey[];
  verificationMethods: VerificationMethodKey[];
  supportsDisconnect: boolean;
  supportsCredentialLogin: boolean;
  supportsOAuth: boolean;
  supportsWebhook: boolean;
  supportsLicenseVerify: boolean;
  supportsTestMode: boolean;
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
   * Only present if supportsLicenseVerify is true AND the provider uses typed license keys.
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
     * Set to false for providers whose productInput works without a dashboard connection
     * (e.g. VRChat — you can add an avatar by ID before connecting the creator session).
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

export const PROVIDER_REGISTRY = [
  {
    providerKey: 'discord',
    label: 'Discord',
    category: 'community',
    status: 'active',
    docsUrl: 'https://discord.com/developers/docs/intro',
    emojiKey: 'Discord',
    addProductDescription: 'Discord role from another server',
    creatorAuthModes: ['oauth'],
    buyerVerificationMethods: ['account_link', 'discord_role'],
    capabilities: ['account_link', 'ownership_verification'],
    setupRequirements: [],
    verificationMethods: ['account_link', 'discord_role'],
    supportsDisconnect: true,
    supportsCredentialLogin: false,
    supportsOAuth: true,
    supportsWebhook: false,
    supportsLicenseVerify: false,
    supportsTestMode: false,
  },
  {
    providerKey: 'gumroad',
    label: 'Gumroad',
    category: 'commerce',
    status: 'active',
    docsUrl: 'https://gumroad.com/api',
    emojiKey: 'Gumorad',
    addProductDescription: 'Pick a product from your connected Gumroad store',
    productInput: {
      label: 'Gumroad Product URL or ID',
      description: 'URL (gumroad.com/l/abc123) or product ID',
      placeholder: 'https://gumroad.com/l/abc123 or abc123',
    },
    creatorAuthModes: ['oauth'],
    buyerVerificationMethods: ['license_key', 'account_link', 'oauth'],
    capabilities: [
      'account_link',
      'catalog_sync',
      'webhooks',
      'reconciliation',
      'license_verification',
      'orders',
      'refunds',
    ],
    setupRequirements: ['oauth_client', 'webhook_secret'],
    verificationMethods: ['license_key', 'oauth'],
    supportsDisconnect: true,
    supportsCredentialLogin: false,
    supportsOAuth: true,
    supportsWebhook: true,
    supportsLicenseVerify: true,
    supportsTestMode: false,
    supportsAutoDiscovery: true,
    catalogProductUrlTemplate: 'https://gumroad.com/l/{ref}',
  },
  {
    providerKey: 'jinxxy',
    label: 'Jinxxy',
    category: 'commerce',
    status: 'active',
    docsUrl: 'https://api.creators.jinxxy.com/docs',
    emojiKey: 'Jinxxy',
    addProductDescription: 'Sold on jinxxy.com',
    creatorAuthModes: ['api_key'],
    buyerVerificationMethods: ['license_key', 'account_link'],
    capabilities: [
      'account_link',
      'catalog_sync',
      'webhooks',
      'reconciliation',
      'license_verification',
      'orders',
      'refunds',
    ],
    setupRequirements: ['api_key', 'webhook_secret'],
    verificationMethods: ['license_key'],
    supportsDisconnect: true,
    supportsCredentialLogin: false,
    supportsOAuth: false,
    supportsWebhook: true,
    supportsLicenseVerify: true,
    supportsTestMode: false,
    catalogProductUrlTemplate: 'https://jinxxy.app/products/{ref}',
    supportsCollab: true,
    collabCredential: {
      label: 'Jinxxy API Key',
      placeholder: 'Paste the API key the creator shared with you',
    },
  },
  {
    providerKey: 'lemonsqueezy',
    label: 'Lemon Squeezy',
    category: 'commerce',
    status: 'active',
    docsUrl: 'https://docs.lemonsqueezy.com/api',
    emojiKey: 'LemonSqueezy',
    addProductDescription: 'Sold on lemonsqueezy.com',
    creatorAuthModes: ['api_token'],
    buyerVerificationMethods: ['license_key', 'account_link'],
    capabilities: [
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
    ],
    setupRequirements: ['api_token', 'store_selection', 'test_mode_toggle'],
    verificationMethods: ['license_key'],
    supportsDisconnect: true,
    supportsCredentialLogin: true,
    supportsOAuth: false,
    supportsWebhook: true,
    supportsLicenseVerify: true,
    supportsTestMode: true,
    catalogProductUrlTemplate: 'https://app.lemonsqueezy.com/products/{ref}',
    supportsCollab: true,
    collabCredential: {
      label: 'Lemon Squeezy API Key',
      placeholder: 'Paste your Lemon Squeezy API key…',
    },
  },
  {
    providerKey: 'manual',
    label: 'Manual License',
    category: 'manual',
    status: 'active',
    docsUrl: 'https://example.invalid/manual',
    emojiKey: 'PersonKey',
    addProductDescription: 'Manually issued license key',
    creatorAuthModes: ['none'],
    buyerVerificationMethods: ['manual'],
    capabilities: ['license_verification'],
    setupRequirements: [],
    verificationMethods: ['manual'],
    supportsDisconnect: false,
    supportsCredentialLogin: false,
    supportsOAuth: false,
    supportsWebhook: false,
    supportsLicenseVerify: true,
    supportsTestMode: false,
  },
  {
    providerKey: 'patreon',
    label: 'Patreon',
    category: 'commerce',
    status: 'planned',
    docsUrl: 'https://docs.patreon.com',
    emojiKey: 'ClapStars',
    addProductDescription: 'Membership sold on patreon.com',
    creatorAuthModes: ['oauth'],
    buyerVerificationMethods: ['account_link', 'oauth'],
    capabilities: ['account_link', 'subscriptions', 'webhooks', 'reconciliation'],
    setupRequirements: ['oauth_client'],
    verificationMethods: ['oauth'],
    supportsDisconnect: true,
    supportsCredentialLogin: false,
    supportsOAuth: true,
    supportsWebhook: true,
    supportsLicenseVerify: false,
    supportsTestMode: false,
  },
  {
    providerKey: 'fourthwall',
    label: 'Fourthwall',
    category: 'commerce',
    status: 'planned',
    docsUrl: 'https://docs.fourthwall.com',
    emojiKey: 'Bag',
    addProductDescription: 'Sold on fourthwall.com',
    creatorAuthModes: ['api_token'],
    buyerVerificationMethods: ['account_link'],
    capabilities: [
      'account_link',
      'catalog_sync',
      'webhooks',
      'reconciliation',
      'orders',
      'refunds',
    ],
    setupRequirements: ['api_token'],
    verificationMethods: ['account_link'],
    supportsDisconnect: true,
    supportsCredentialLogin: true,
    supportsOAuth: false,
    supportsWebhook: true,
    supportsLicenseVerify: false,
    supportsTestMode: false,
  },
  {
    providerKey: 'itchio',
    label: 'itch.io',
    category: 'commerce',
    status: 'planned',
    docsUrl: 'https://itch.io/docs/api/serverside',
    emojiKey: 'GiftCard',
    addProductDescription: 'Sold on itch.io',
    creatorAuthModes: ['api_key'],
    buyerVerificationMethods: ['account_link'],
    capabilities: ['account_link', 'catalog_sync', 'reconciliation', 'orders'],
    setupRequirements: ['api_key'],
    verificationMethods: ['account_link'],
    supportsDisconnect: true,
    supportsCredentialLogin: true,
    supportsOAuth: false,
    supportsWebhook: false,
    supportsLicenseVerify: false,
    supportsTestMode: false,
  },
  {
    providerKey: 'payhip',
    label: 'Payhip',
    category: 'commerce',
    status: 'active',
    // Webhook doc: https://help.payhip.com/article/115-webhooks
    // License key doc: https://help.payhip.com/article/317-software-license-keys-new
    docsUrl: 'https://help.payhip.com/category/48-developer',
    emojiKey: 'CreditCard',
    addProductDescription: 'Sold on payhip.com',
    creatorAuthModes: ['api_key'],
    buyerVerificationMethods: ['license_key', 'account_link'],
    // Note: no separate webhook_secret — Payhip signature = SHA256(apiKey), derived from api_key
    capabilities: [
      'account_link',
      'webhooks',
      'reconciliation',
      'license_verification',
      'orders',
      'refunds',
    ],
    setupRequirements: ['api_key', 'webhook_endpoint'],
    verificationMethods: ['license_key'],
    supportsDisconnect: true,
    supportsCredentialLogin: true,
    supportsOAuth: false,
    supportsWebhook: true,
    supportsLicenseVerify: true,
    supportsTestMode: false,
    perProductCredential: {
      credentialKeyPrefix: 'product_key:',
      credentialLabel: 'Product Secret Key',
      productIdLabel: 'Product Permalink',
      productIdPlaceholder: 'e.g. RGsF',
      helpText: 'Found on the product edit page in Payhip under License Keys → Developer section.',
    },
  },
  {
    providerKey: 'vrchat',
    label: 'VRChat',
    category: 'virtual_world',
    status: 'active',
    docsUrl: 'https://vrchatapi.github.io',
    emojiKey: 'VRC',
    addProductDescription: 'Avatar from vrchat.com/...',
    creatorAuthModes: ['credentials'],
    buyerVerificationMethods: ['account_link'],
    capabilities: ['account_link', 'ownership_verification', 'catalog_sync'],
    setupRequirements: [],
    verificationMethods: ['account_link'],
    supportsDisconnect: true,
    supportsCredentialLogin: true,
    supportsOAuth: false,
    supportsWebhook: false,
    supportsLicenseVerify: false,
    supportsTestMode: false,
    catalogProductUrlTemplate: 'https://vrchat.com/store/listing/{ref}',
    productInput: {
      label: 'VRChat Avatar ID or URL',
      description: 'VRChat Avatar ID (avtr_…) or vrchat.com/home/avatar/avtr_… URL',
      placeholder: 'avtr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      requiresConnection: false,
    },
  },
] as const satisfies readonly ProviderDescriptor[];

export const PROVIDER_REGISTRY_BY_KEY = Object.fromEntries(
  PROVIDER_REGISTRY.map((provider) => [provider.providerKey, provider])
) as unknown as Record<ProviderKey, ProviderDescriptor>;

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

export function getProviderDescriptor(providerKey: string): ProviderDescriptor | undefined {
  return PROVIDER_REGISTRY_BY_KEY[providerKey as ProviderKey];
}

export function providerLabel(providerKey: string): string {
  return getProviderDescriptor(providerKey)?.label ?? providerKey;
}

/** Returns providers that require a per-product credential for license verification. */
export const PER_PRODUCT_CREDENTIAL_PROVIDER_KEYS = (
  PROVIDER_REGISTRY as readonly ProviderDescriptor[]
)
  .filter((provider) => provider.perProductCredential != null)
  .map((provider) => provider.providerKey);

/** Returns providers that support catalog sync (have the 'catalog_sync' capability). */
export const CATALOG_SYNC_PROVIDER_KEYS = (PROVIDER_REGISTRY as readonly ProviderDescriptor[])
  .filter((p) => p.capabilities.includes('catalog_sync'))
  .map((p) => p.providerKey);

/**
 * Build the canonical URL for a catalog product entry.
 * Returns null if the provider has no URL template (e.g. discord_role, payhip).
 */
export function buildCatalogProductUrl(
  providerKey: string,
  productRef: string
): string | null {
  const descriptor = getProviderDescriptor(providerKey);
  if (!descriptor?.catalogProductUrlTemplate) return null;
  return descriptor.catalogProductUrlTemplate.replace('{ref}', productRef);
}
