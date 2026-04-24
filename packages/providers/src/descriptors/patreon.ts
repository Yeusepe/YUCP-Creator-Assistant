import type { ProviderDescriptorInput } from '../types';

export const patreon = {
  providerKey: 'patreon',
  label: 'Patreon',
  category: 'commerce',
  status: 'active',
  docsUrl: 'https://docs.patreon.com',
  emojiKey: 'Patreon',
  addProductDescription: 'Pick a campaign from your connected Patreon creator account',
  creatorAuthModes: ['oauth'],
  buyerVerificationMethods: ['account_link'],
  capabilities: ['catalog_sync', 'tier_catalog'],
  setupRequirements: ['oauth_client'],
  verificationMethods: [],
  supportsCredentialLogin: false,
  supportsBuyerOAuthLink: true,
  supportsAutoDiscovery: true,
} as const satisfies ProviderDescriptorInput;
