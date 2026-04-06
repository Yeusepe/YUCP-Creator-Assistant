import type { ProviderDescriptorInput } from '../types';

export const jinxxy = {
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
  supportsCredentialLogin: false,
  catalogProductUrlTemplate: 'https://jinxxy.app/products/{ref}',
  licenseKey: {
    inputLabel: 'License Key',
    placeholder: 'Enter your license key',
  },
  supportsCollab: true,
  collabCredential: {
    label: 'Jinxxy API Key',
    placeholder: 'Paste the API key the creator shared with you',
  },
} as const satisfies ProviderDescriptorInput;
