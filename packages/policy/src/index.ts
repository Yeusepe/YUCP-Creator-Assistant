/**
 * @yucp/policy - Policy Engine for YUCP
 *
 * Provides policy evaluation for entitlement operations including:
 * - Binding limits and transfer controls
 * - Grace periods and revocation behavior
 * - Auto-verification and catalog-backed verification rules
 * - Remediation instructions for denied requests
 *
 * Default policy is STRICT:
 * - 1 seat per product
 * - No transfers
 * - No friend sharing
 * - Manual review required
 *
 * @example
 * ```ts
 * import { evaluatePolicy, STRICT_DEFAULT_POLICY } from '@yucp/policy';
 *
 * const decision = evaluatePolicy(STRICT_DEFAULT_POLICY, {
 *   tenantId: 'tenant-123',
 *   subjectId: 'user-456',
 *   productId: 'product-789',
 *   currentBindingCount: 0,
 *   currentUnityInstallations: 0,
 *   isTransfer: false,
 *   inDiscordServer: true,
 *   hasCatalogVerification: true,
 *   isRememberedPurchaser: false,
 *   timestamp: Date.now(),
 * });
 *
 * if (decision.allow) {
 *   // Proceed with binding
 * } else {
 *   // Show remediation instructions
 *   console.log(decision.remediation);
 * }
 * ```
 */

// Engine exports
export {
  evaluatePolicy,
  evaluateBindingPolicy,
  evaluateTransferPolicy,
  shouldAutoVerify,
  getRevocationTiming,
  shouldUseCatalogBackedVerification,
  shouldAutoDiscoverProducts,
  isDiscordRoleSyncNeeded,
  getPolicySummary,
  type PolicyConfig,
  type PolicyContext,
  type PolicyDecision,
  type PolicyVersion,
  type Remediation,
  type RevocationBehavior,
} from './engine';

// Defaults exports
export {
  CURRENT_POLICY_VERSION,
  STRICT_DEFAULT_POLICY,
  PERMISSIVE_POLICY,
  mergeWithDefaults,
  validatePolicyConfig,
  isStrictDefault,
} from './defaults';
