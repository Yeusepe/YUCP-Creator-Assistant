/**
 * Policy Engine - Core Evaluation Logic
 *
 * Evaluates policy decisions for entitlement operations including:
 * - Binding limits
 * - Transfer controls
 * - Grace periods
 * - Auto-verification
 * - Catalog-backed verification rules
 *
 * All deny decisions include remediation instructions.
 */

import { CURRENT_POLICY_VERSION, mergeWithDefaults } from './defaults';

// ============================================================================
// TYPES
// ============================================================================

/** Policy version number type */
export type PolicyVersion = number;

/** Revocation behavior options */
export type RevocationBehavior = 'immediate' | 'grace_period' | 'manual';

/**
 * Full policy configuration for a tenant/product
 */
export interface PolicyConfig {
  /** Maximum bindings/entitlements per product (default: 1) */
  maxBindingsPerProduct: number;

  /** Whether ownership transfers are allowed */
  allowTransfer: boolean;

  /** Cooldown period in hours before transfer is allowed */
  transferCooldownHours: number;

  /** Whether shared use (friend sharing) is allowed */
  allowSharedUse: boolean;

  /** Maximum Unity installations per entitlement */
  maxUnityInstallations: number;

  /** Whether to auto-verify on Discord join */
  autoVerifyOnJoin: boolean;

  /** How to handle revocations */
  revocationBehavior: RevocationBehavior;

  /** Grace period in hours before revocation takes effect */
  gracePeriodHours: number;

  /** Require full product link set on setup */
  requireFullProductLinkSetOnSetup: boolean;

  /** Allow catalog link resolution */
  allowCatalogLinkResolution: boolean;

  /** Whether manual review is required */
  manualReviewRequired: boolean;

  /** Discord role freshness in minutes */
  discordRoleFreshnessMinutes: number;

  /** Allow catalog-backed verification */
  allowCatalogBackedVerification: boolean;

  /** Auto-discover supported products for remembered purchasers */
  autoDiscoverSupportedProductsForRememberedPurchaser: boolean;
}

/**
 * Context for policy evaluation
 */
export interface PolicyContext {
  /** Auth user ID of the creator */
  authUserId: string;

  /** Subject ID (user) */
  subjectId: string;

  /** Product ID being evaluated */
  productId: string;

  /** Current number of bindings for this product */
  currentBindingCount: number;

  /** Current number of Unity installations */
  currentUnityInstallations: number;

  /** Whether this is a transfer request */
  isTransfer: boolean;

  /** Time of last transfer (if any) */
  lastTransferTime?: number;

  /** Whether the user is in the Discord server */
  inDiscordServer: boolean;

  /** Whether catalog verification is available */
  hasCatalogVerification: boolean;

  /** Whether the purchaser is remembered */
  isRememberedPurchaser: boolean;

  /** Current timestamp for evaluation */
  timestamp: number;
}

/**
 * Remediation instruction for denied requests
 */
export interface Remediation {
  /** Action identifier */
  action: string;

  /** Optional URL for remediation */
  url?: string;

  /** Human-readable message */
  message: string;
}

/**
 * Result of policy evaluation
 */
export interface PolicyDecision {
  /** Whether the request is allowed */
  allow: boolean;

  /** Reasons for the decision */
  reasons: string[];

  /** Remediation instructions if denied */
  remediation?: Remediation[];

  /** Policy version at time of decision (for snapshot) */
  snapshotVersion: PolicyVersion;
}

// ============================================================================
// REMEDIATION MESSAGES
// ============================================================================

const REMEDIATION_MESSAGES = {
  BINDING_LIMIT_EXCEEDED: {
    action: 'contact_creator',
    message:
      'You have reached the maximum number of seats for this product. Contact the creator to request additional seats or transfer your existing seat.',
  },
  TRANSFER_DISABLED: {
    action: 'contact_creator',
    message: 'Transfers are not allowed for this product. Each purchase is bound to a single user.',
  },
  TRANSFER_COOLDOWN: {
    action: 'wait',
    message:
      'You must wait before transferring this license again. Please try again after the cooldown period expires.',
  },
  SHARED_USE_DISABLED: {
    action: 'purchase_own_license',
    message: 'Shared use is not permitted. Each user must have their own license for this product.',
  },
  UNITY_INSTALLATION_LIMIT: {
    action: 'deactivate_other_installations',
    message:
      'You have reached the maximum number of Unity installations. Deactivate another installation or contact the creator.',
  },
  MANUAL_REVIEW_REQUIRED: {
    action: 'wait_for_review',
    message:
      'Your request requires manual review by the creator. You will be notified once approved.',
  },
  CATALOG_VERIFICATION_REQUIRED: {
    action: 'link_purchase',
    message: 'Please link your purchase from a supported marketplace to verify your entitlement.',
  },
} as const;

// ============================================================================
// POLICY ENGINE
// ============================================================================

/**
 * Evaluate a policy request against the configuration
 *
 * @param config - Policy configuration (partial, will merge with defaults)
 * @param context - Evaluation context with current state
 * @returns Policy decision with allow/deny and remediation
 */
export function evaluatePolicy(
  config: Partial<PolicyConfig>,
  context: PolicyContext
): PolicyDecision {
  const effectiveConfig = mergeWithDefaults(config);
  const reasons: string[] = [];
  const remediation: Remediation[] = [];

  // Check binding limit
  if (context.currentBindingCount >= effectiveConfig.maxBindingsPerProduct) {
    reasons.push('Binding limit exceeded');
    remediation.push({
      ...REMEDIATION_MESSAGES.BINDING_LIMIT_EXCEEDED,
      url: generateSupportUrl(context),
    });
  }

  // Check Unity installation limit
  if (context.currentUnityInstallations >= effectiveConfig.maxUnityInstallations) {
    reasons.push('Unity installation limit exceeded');
    remediation.push(REMEDIATION_MESSAGES.UNITY_INSTALLATION_LIMIT);
  }

  // Check transfer restrictions
  if (context.isTransfer) {
    if (!effectiveConfig.allowTransfer) {
      reasons.push('Transfer not allowed by policy');
      remediation.push(REMEDIATION_MESSAGES.TRANSFER_DISABLED);
    } else if (context.lastTransferTime && effectiveConfig.transferCooldownHours > 0) {
      const cooldownMs = effectiveConfig.transferCooldownHours * 60 * 60 * 1000;
      const timeSinceLastTransfer = context.timestamp - context.lastTransferTime;

      if (timeSinceLastTransfer < cooldownMs) {
        const remainingHours = Math.ceil((cooldownMs - timeSinceLastTransfer) / (60 * 60 * 1000));
        reasons.push(`Transfer cooldown not expired (${remainingHours}h remaining)`);
        remediation.push({
          ...REMEDIATION_MESSAGES.TRANSFER_COOLDOWN,
          message: `${REMEDIATION_MESSAGES.TRANSFER_COOLDOWN.message} Approximately ${remainingHours} hours remaining.`,
        });
      }
    }
  }

  // Check shared use
  if (context.currentBindingCount > 0 && !effectiveConfig.allowSharedUse) {
    reasons.push('Shared use not allowed');
    remediation.push(REMEDIATION_MESSAGES.SHARED_USE_DISABLED);
  }

  // Check manual review requirement
  if (effectiveConfig.manualReviewRequired && !context.isRememberedPurchaser) {
    reasons.push('Manual review required');
    remediation.push(REMEDIATION_MESSAGES.MANUAL_REVIEW_REQUIRED);
  }

  // Check catalog verification requirement
  if (
    effectiveConfig.requireFullProductLinkSetOnSetup &&
    !context.hasCatalogVerification &&
    !effectiveConfig.allowCatalogBackedVerification
  ) {
    reasons.push('Catalog verification required');
    remediation.push(REMEDIATION_MESSAGES.CATALOG_VERIFICATION_REQUIRED);
  }

  // Build decision
  const allow = reasons.length === 0;

  return {
    allow,
    reasons,
    remediation: allow ? undefined : remediation,
    snapshotVersion: CURRENT_POLICY_VERSION,
  };
}

/**
 * Evaluate if a transfer is allowed
 */
export function evaluateTransferPolicy(
  config: Partial<PolicyConfig>,
  context: Omit<PolicyContext, 'isTransfer'> & { lastTransferTime?: number }
): PolicyDecision {
  return evaluatePolicy(config, { ...context, isTransfer: true });
}

/**
 * Evaluate if a new binding is allowed
 */
export function evaluateBindingPolicy(
  config: Partial<PolicyConfig>,
  context: Omit<PolicyContext, 'isTransfer'>
): PolicyDecision {
  return evaluatePolicy(config, { ...context, isTransfer: false });
}

/**
 * Check if auto-verification should proceed
 */
export function shouldAutoVerify(
  config: Partial<PolicyConfig>,
  context: Pick<PolicyContext, 'inDiscordServer' | 'hasCatalogVerification'>
): boolean {
  const effectiveConfig = mergeWithDefaults(config);

  if (!effectiveConfig.autoVerifyOnJoin) {
    return false;
  }

  if (!context.inDiscordServer) {
    return false;
  }

  // Auto-verify requires catalog verification or catalog-backed verification
  if (!context.hasCatalogVerification && !effectiveConfig.allowCatalogBackedVerification) {
    return false;
  }

  return true;
}

/**
 * Check if a revocation should be immediate or delayed
 */
export function getRevocationTiming(
  config: Partial<PolicyConfig>,
  revokedAt: number
): { immediate: boolean; effectiveAt: number | null } {
  const effectiveConfig = mergeWithDefaults(config);

  if (effectiveConfig.revocationBehavior === 'immediate') {
    return { immediate: true, effectiveAt: null };
  }

  if (
    effectiveConfig.revocationBehavior === 'grace_period' &&
    effectiveConfig.gracePeriodHours > 0
  ) {
    const effectiveAt = revokedAt + effectiveConfig.gracePeriodHours * 60 * 60 * 1000;
    return { immediate: false, effectiveAt };
  }

  // Manual review required - no automatic revocation
  return { immediate: false, effectiveAt: null };
}

/**
 * Check if catalog-backed verification should be used
 */
export function shouldUseCatalogBackedVerification(
  config: Partial<PolicyConfig>,
  context: Pick<PolicyContext, 'hasCatalogVerification' | 'isRememberedPurchaser'>
): boolean {
  const effectiveConfig = mergeWithDefaults(config);

  if (!effectiveConfig.allowCatalogBackedVerification) {
    return false;
  }

  // If direct catalog verification exists, prefer that
  if (context.hasCatalogVerification) {
    return false;
  }

  return context.isRememberedPurchaser;
}

/**
 * Check if auto-discovery should be enabled
 */
export function shouldAutoDiscoverProducts(
  config: Partial<PolicyConfig>,
  context: Pick<PolicyContext, 'isRememberedPurchaser'>
): boolean {
  const effectiveConfig = mergeWithDefaults(config);

  return (
    effectiveConfig.autoDiscoverSupportedProductsForRememberedPurchaser &&
    context.isRememberedPurchaser
  );
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Generate a support URL for the creator
 */
function generateSupportUrl(context: Pick<PolicyContext, 'authUserId'>): string {
  return `https://support.yucp.io/t/${context.authUserId}`;
}

/**
 * Check if Discord role sync is needed based on freshness
 */
export function isDiscordRoleSyncNeeded(
  config: Partial<PolicyConfig>,
  lastSyncTime: number,
  currentTime: number = Date.now()
): boolean {
  const effectiveConfig = mergeWithDefaults(config);
  const freshnessMs = effectiveConfig.discordRoleFreshnessMinutes * 60 * 1000;
  return currentTime - lastSyncTime > freshnessMs;
}

/**
 * Get policy summary for logging/debugging
 */
export function getPolicySummary(config: Partial<PolicyConfig>): Record<string, unknown> {
  const effectiveConfig = mergeWithDefaults(config);
  return {
    maxBindings: effectiveConfig.maxBindingsPerProduct,
    maxInstallations: effectiveConfig.maxUnityInstallations,
    transferAllowed: effectiveConfig.allowTransfer,
    sharedUseAllowed: effectiveConfig.allowSharedUse,
    autoVerify: effectiveConfig.autoVerifyOnJoin,
    manualReview: effectiveConfig.manualReviewRequired,
    revocationBehavior: effectiveConfig.revocationBehavior,
  };
}
