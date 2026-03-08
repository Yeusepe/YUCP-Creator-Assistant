import { v } from 'convex/values';

/** All providers — matches the Provider union in schema */
export const ProviderV = v.union(
  v.literal('discord'),
  v.literal('gumroad'),
  v.literal('jinxxy'),
  v.literal('manual'),
  v.literal('vrchat'),
);

/** Providers with purchasable catalog products (license-bearing) */
export const LicenseProviderV = v.union(
  v.literal('gumroad'),
  v.literal('jinxxy'),
  v.literal('vrchat'),
);

/** Providers that send webhooks */
export const WebhookProviderV = v.union(
  v.literal('gumroad'),
  v.literal('jinxxy'),
);

/** Providers that can have provider_customers rows */
export const CustomerProviderV = v.union(
  v.literal('gumroad'),
  v.literal('jinxxy'),
  v.literal('manual'),
  v.literal('vrchat'),
);

/** Verification session modes (discord_role is a mode, not a provider ID) */
export const VerificationModeV = v.union(
  v.literal('gumroad'),
  v.literal('discord_role'),
  v.literal('jinxxy'),
  v.literal('manual'),
  v.literal('vrchat'),
);
