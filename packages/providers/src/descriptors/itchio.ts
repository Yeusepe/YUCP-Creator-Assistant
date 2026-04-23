import type { ProviderDescriptorInput } from '../types';

export const itchio = {
  providerKey: 'itchio',
  label: 'itch.io',
  category: 'commerce',
  status: 'active',
  docsUrl: 'https://itch.io/docs/api/serverside',
  emojiKey: 'ItchIo',
  addProductDescription: 'Pick a game from your connected itch.io account',
  creatorAuthModes: ['oauth'],
  buyerVerificationMethods: ['account_link'],
  capabilities: ['account_link', 'catalog_sync', 'ownership_verification', 'orders'],
  setupRequirements: ['oauth_client'],
  verificationMethods: ['account_link'],
  supportsCredentialLogin: false,
  supportsBuyerOAuthLink: true,
  collabCredential: {
    label: 'itch.io API Key',
    placeholder: 'Paste the itch.io API key the creator shared with you',
  },
  collabLinkModes: ['api'],
  supportsAutoDiscovery: true,
} as const satisfies ProviderDescriptorInput;
