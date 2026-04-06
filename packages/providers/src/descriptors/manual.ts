import type { ProviderDescriptorInput } from '../types';

export const manual = {
  providerKey: 'manual',
  label: 'Manual License',
  category: 'manual',
  status: 'active',
  docsUrl: 'https://example.invalid/manual',
  emojiKey: 'PersonKey',
  addProductDescription: 'Manually issued license key',
  creatorAuthModes: ['none'],
  buyerVerificationMethods: ['manual'],
  capabilities: ['license_verification'],
  setupRequirements: [],
  verificationMethods: ['manual'],
  supportsCredentialLogin: false,
} as const satisfies ProviderDescriptorInput;
