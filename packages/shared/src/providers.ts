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
  compatibility?: {
    legacyConnectRoutes?: string[];
    legacyWebhookRoutes?: string[];
  };
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
    addProductDescription: 'Sold on gumroad.com',
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
    compatibility: {
      legacyConnectRoutes: ['/api/connect/gumroad/begin', '/api/connect/gumroad/callback'],
      legacyWebhookRoutes: ['/webhooks/gumroad/:authUserId'],
    },
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
    compatibility: {
      legacyConnectRoutes: ['/api/connect/jinxxy/webhook-config', '/api/connect/jinxxy-store'],
      legacyWebhookRoutes: ['/webhooks/jinxxy/:authUserId'],
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
      helpText:
        'Found on the product edit page in Payhip under License Keys → Developer section.',
    },
    compatibility: {
      legacyWebhookRoutes: ['/webhooks/payhip/:authUserId'],
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
    capabilities: ['account_link', 'ownership_verification'],
    setupRequirements: [],
    verificationMethods: ['account_link'],
    supportsDisconnect: true,
    supportsCredentialLogin: true,
    supportsOAuth: false,
    supportsWebhook: false,
    supportsLicenseVerify: false,
    supportsTestMode: false,
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
