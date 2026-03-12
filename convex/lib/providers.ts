import { v } from 'convex/values';

/**
 * The shared registry is the source of truth in TypeScript. Convex validators stay string-based
 * so widening provider sets does not destabilize the existing schema/type surface.
 */
export const ProviderV = v.string();
export const LicenseProviderV = v.string();
export const WebhookProviderV = v.string();
export const CustomerProviderV = v.string();
export const VerificationMethodV = v.string();
export const VerificationModeV = VerificationMethodV;
