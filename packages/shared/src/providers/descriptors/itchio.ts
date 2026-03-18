import type { ProviderDescriptorInput } from '../types';

export const itchio = {
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
  supportsCredentialLogin: true,
} as const satisfies ProviderDescriptorInput;
