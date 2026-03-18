import type { ProviderDescriptorInput } from '../types';

export const lemonsqueezy = {
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
  supportsCredentialLogin: true,
  catalogProductUrlTemplate: 'https://app.lemonsqueezy.com/products/{ref}',
  supportsCollab: true,
  collabCredential: {
    label: 'Lemon Squeezy API Key',
    placeholder: 'Paste your Lemon Squeezy API key\u2026',
  },
} as const satisfies ProviderDescriptorInput;
