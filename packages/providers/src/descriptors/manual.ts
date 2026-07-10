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
  buyerVerificationMethods: ['manual', 'license_key'],
  capabilities: ['license_verification'],
  setupRequirements: [],
  verificationMethods: ['manual', 'license_key'],
  supportsCredentialLogin: false,
  licenseKey: {
    inputLabel: 'Manual License Key',
    placeholder: 'Enter the license key from your creator',
  },
} as const satisfies ProviderDescriptorInput;
