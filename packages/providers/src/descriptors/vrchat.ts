import type { ProviderDescriptorInput } from '../types';

export const vrchat = {
  providerKey: 'vrchat',
  label: 'VRChat',
  category: 'virtual_world',
  status: 'active',
  docsUrl: 'https://vrchatapi.github.io',
  emojiKey: 'VRC',
  addProductDescription: 'Avatar from vrchat.com/...',
  creatorAuthModes: ['credentials'],
  buyerVerificationMethods: ['account_link'],
  capabilities: ['account_link', 'ownership_verification', 'catalog_sync'],
  setupRequirements: [],
  verificationMethods: ['account_link'],
  supportsCredentialLogin: true,
  catalogProductUrlTemplate: 'https://vrchat.com/store/listing/{ref}',
  productInput: {
    label: 'VRChat Avatar ID or URL',
    description: 'VRChat Avatar ID (avtr_\u2026) or vrchat.com/home/avatar/avtr_\u2026 URL',
    placeholder: 'avtr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    requiresConnection: false,
  },
} as const satisfies ProviderDescriptorInput;
