import type { ProviderDescriptorInput } from '../types';

export const discord = {
  providerKey: 'discord',
  label: 'Discord',
  category: 'community',
  status: 'active',
  docsUrl: 'https://discord.com/developers/docs/intro',
  emojiKey: 'Discord',
  addProductDescription: 'Discord role from another server',
  creatorAuthModes: ['oauth'],
  buyerVerificationMethods: ['account_link', 'discord_role'],
  capabilities: ['account_link', 'ownership_verification'],
  setupRequirements: [],
  verificationMethods: ['account_link', 'discord_role'],
  supportsCredentialLogin: false,
} as const satisfies ProviderDescriptorInput;
