export const SHARED_PROVIDER_KEYS = [
  'discord',
  'gumroad',
  'jinxxy',
  'lemonsqueezy',
  'manual',
  'patreon',
  'fourthwall',
  'itchio',
  'payhip',
  'vrchat',
] as const;

export type ProviderKey = (typeof SHARED_PROVIDER_KEYS)[number];
