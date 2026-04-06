import type { ProviderDescriptorInput } from '../types';

export const fourthwall = {
  providerKey: 'fourthwall',
  label: 'Fourthwall',
  category: 'commerce',
  status: 'planned',
  docsUrl: 'https://docs.fourthwall.com',
  emojiKey: 'Bag',
  addProductDescription: 'Sold on fourthwall.com',
  creatorAuthModes: ['api_token'],
  buyerVerificationMethods: ['account_link'],
  capabilities: ['account_link', 'catalog_sync', 'webhooks', 'reconciliation', 'orders', 'refunds'],
  setupRequirements: ['api_token'],
  verificationMethods: ['account_link'],
  supportsCredentialLogin: true,
} as const satisfies ProviderDescriptorInput;
