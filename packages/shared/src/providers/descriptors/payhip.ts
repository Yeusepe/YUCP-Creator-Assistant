import type { ProviderDescriptorInput } from '../types';

export const payhip = {
  providerKey: 'payhip',
  label: 'Payhip',
  category: 'commerce',
  status: 'active',
  // Webhook doc: https://help.payhip.com/article/115-webhooks
  // License key doc: https://help.payhip.com/article/317-software-license-keys-new
  docsUrl: 'https://help.payhip.com/category/48-developer',
  emojiKey: 'Payhip',
  addProductDescription: 'Sold on payhip.com',
  creatorAuthModes: ['api_key'],
  buyerVerificationMethods: ['license_key', 'account_link'],
  // Note: no separate webhook_secret -- Payhip signature = SHA256(apiKey), derived from api_key
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
  supportsCredentialLogin: true,
  perProductCredential: {
    credentialKeyPrefix: 'product_key:',
    credentialLabel: 'Product Secret Key',
    productIdLabel: 'Product Permalink',
    productIdPlaceholder: 'e.g. RGsF',
    helpText:
      'Found on the product edit page in Payhip under License Keys \u2192 Developer section.',
  },
} as const satisfies ProviderDescriptorInput;
