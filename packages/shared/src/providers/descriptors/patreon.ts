import type { ProviderDescriptorInput } from '../types';

export const patreon = {
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
  supportsCredentialLogin: false,
} as const satisfies ProviderDescriptorInput;
