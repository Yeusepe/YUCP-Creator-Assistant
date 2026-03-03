/**
 * Policy Defaults - Strict Default Configuration
 *
 * Default policy is STRICT:
 * - 1 seat per product (no friend sharing)
 * - No transfers allowed
 * - No shared use
 * - 1 Unity installation max
 * - Manual review required
 * - No auto-verify on join
 */

import type { PolicyConfig, PolicyVersion } from './engine';

/**
 * Current policy version - increment when making breaking changes
 */
export const CURRENT_POLICY_VERSION: PolicyVersion = 1;

/**
 * Strict default policy configuration
 *
 * This is the baseline policy applied when no custom policy is set.
 * It enforces strict single-seat, single-device usage.
 */
export const STRICT_DEFAULT_POLICY: Required<PolicyConfig> = {
  // Instance limits
  maxBindingsPerProduct: 1,
  maxUnityInstallations: 1,

  // Transfer controls - disabled by default
  allowTransfer: false,
  transferCooldownHours: 24,

  // Shared use - disabled (no friend sharing)
  allowSharedUse: false,

  // Auto-verification - disabled by default
  autoVerifyOnJoin: false,

  // Revocation behavior
  revocationBehavior: 'immediate',
  gracePeriodHours: 0,

  // Setup requirements
  requireFullProductLinkSetOnSetup: true,
  allowCatalogLinkResolution: true,

  // Review requirements
  manualReviewRequired: true,

  // Discord integration
  discordRoleFreshnessMinutes: 60,

  // Catalog-backed verification
  allowCatalogBackedVerification: false,
  autoDiscoverSupportedProductsForRememberedPurchaser: false,
};

/**
 * Permissive policy preset (for testing or specific use cases)
 * This is NOT the default and should be explicitly enabled
 */
export const PERMISSIVE_POLICY: Required<PolicyConfig> = {
  maxBindingsPerProduct: 5,
  maxUnityInstallations: 3,
  allowTransfer: true,
  transferCooldownHours: 0,
  allowSharedUse: true,
  autoVerifyOnJoin: true,
  revocationBehavior: 'grace_period',
  gracePeriodHours: 72,
  requireFullProductLinkSetOnSetup: false,
  allowCatalogLinkResolution: true,
  manualReviewRequired: false,
  discordRoleFreshnessMinutes: 120,
  allowCatalogBackedVerification: true,
  autoDiscoverSupportedProductsForRememberedPurchaser: true,
};

/**
 * Merge custom policy with defaults
 * Ensures all fields are populated with strict defaults for any missing values
 */
export function mergeWithDefaults(customPolicy?: Partial<PolicyConfig>): Required<PolicyConfig> {
  if (!customPolicy) {
    return { ...STRICT_DEFAULT_POLICY };
  }

  return {
    ...STRICT_DEFAULT_POLICY,
    ...customPolicy,
  };
}

/**
 * Validate a policy configuration
 * Returns an array of validation errors, empty if valid
 */
export function validatePolicyConfig(config: Partial<PolicyConfig>): string[] {
  const errors: string[] = [];

  if (config.maxBindingsPerProduct !== undefined) {
    if (config.maxBindingsPerProduct < 1) {
      errors.push('maxBindingsPerProduct must be at least 1');
    }
    if (config.maxBindingsPerProduct > 100) {
      errors.push('maxBindingsPerProduct cannot exceed 100');
    }
  }

  if (config.maxUnityInstallations !== undefined) {
    if (config.maxUnityInstallations < 1) {
      errors.push('maxUnityInstallations must be at least 1');
    }
    if (config.maxUnityInstallations > 10) {
      errors.push('maxUnityInstallations cannot exceed 10');
    }
  }

  if (config.transferCooldownHours !== undefined) {
    if (config.transferCooldownHours < 0) {
      errors.push('transferCooldownHours cannot be negative');
    }
    if (config.transferCooldownHours > 168) {
      errors.push('transferCooldownHours cannot exceed 168 (1 week)');
    }
  }

  if (config.gracePeriodHours !== undefined) {
    if (config.gracePeriodHours < 0) {
      errors.push('gracePeriodHours cannot be negative');
    }
    if (config.gracePeriodHours > 720) {
      errors.push('gracePeriodHours cannot exceed 720 (30 days)');
    }
  }

  if (config.discordRoleFreshnessMinutes !== undefined) {
    if (config.discordRoleFreshnessMinutes < 5) {
      errors.push('discordRoleFreshnessMinutes must be at least 5');
    }
    if (config.discordRoleFreshnessMinutes > 1440) {
      errors.push('discordRoleFreshnessMinutes cannot exceed 1440 (24 hours)');
    }
  }

  if (
    config.revocationBehavior !== undefined &&
    !['immediate', 'grace_period', 'manual'].includes(config.revocationBehavior)
  ) {
    errors.push('revocationBehavior must be "immediate", "grace_period", or "manual"');
  }

  return errors;
}

/**
 * Check if a policy is the strict default
 */
export function isStrictDefault(config: PolicyConfig): boolean {
  return (
    config.maxBindingsPerProduct === STRICT_DEFAULT_POLICY.maxBindingsPerProduct &&
    config.allowTransfer === STRICT_DEFAULT_POLICY.allowTransfer &&
    config.allowSharedUse === STRICT_DEFAULT_POLICY.allowSharedUse &&
    config.manualReviewRequired === STRICT_DEFAULT_POLICY.manualReviewRequired
  );
}
