import type { ProviderDescriptorInput } from '../types';

export const gumroad = {
  providerKey: 'gumroad',
  label: 'Gumroad',
  category: 'commerce',
  status: 'active',
  docsUrl: 'https://gumroad.com/api',
  emojiKey: 'Gumorad',
  addProductDescription: 'Pick a product from your connected Gumroad store',
  creatorAuthModes: ['oauth'],
  buyerVerificationMethods: ['license_key', 'account_link', 'oauth'],
  capabilities: [
    'account_link',
    'catalog_sync',
    'tier_catalog',
    'webhooks',
    'reconciliation',
    'license_verification',
    'orders',
    'refunds',
  ],
  setupRequirements: ['oauth_client', 'webhook_secret'],
  verificationMethods: ['license_key', 'oauth'],
  supportsCredentialLogin: false,
  supportsBuyerOAuthLink: true,
  supportsAutoDiscovery: true,
  catalogProductUrlTemplate: 'https://gumroad.com/l/{ref}',
  productInput: {
    label: 'Gumroad Product URL or ID',
    description: 'URL (gumroad.com/l/abc123) or product ID',
    placeholder: 'https://gumroad.com/l/abc123 or abc123',
  },
  licenseKey: {
    inputLabel: 'License Key (XXXX-XXXX-XXXX-XXXX)',
    placeholder: 'XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX',
  },
} as const satisfies ProviderDescriptorInput;
