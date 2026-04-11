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
  buyerVerificationMethods: ['account_link', 'license_key'],
  capabilities: [
    'account_link',
    'catalog_sync',
    'ownership_verification',
    'reconciliation',
    'license_verification',
    'orders',
  ],
  setupRequirements: ['oauth_client'],
  verificationMethods: ['account_link', 'license_key'],
  supportsCredentialLogin: false,
  supportsBuyerOAuthLink: true,
  collabCredential: {
    label: 'itch.io API Key',
    placeholder: 'Paste the itch.io API key the creator shared with you',
  },
  collabLinkModes: ['api'],
  supportsAutoDiscovery: true,
  licenseKey: {
    inputLabel: 'Download Key',
    placeholder: 'YWKse5jeAeuZ8w3a5qO2b2PId1sChw2B9b637w6z',
  },
  productInput: {
    label: 'itch.io Game ID',
    description: 'Select a game from your connected itch.io account.',
    placeholder: '123456',
    requiresConnection: true,
  },
} as const satisfies ProviderDescriptorInput;
