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
 *   authUserId: 'user_abc123',
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

// Defaults exports
export {
  CURRENT_POLICY_VERSION,
  isStrictDefault,
  mergeWithDefaults,
  PERMISSIVE_POLICY,
  STRICT_DEFAULT_POLICY,
  validatePolicyConfig,
} from './defaults';
// Engine exports
export {
  evaluateBindingPolicy,
  evaluatePolicy,
  evaluateTransferPolicy,
  getPolicySummary,
  getRevocationTiming,
  isDiscordRoleSyncNeeded,
  type PolicyConfig,
  type PolicyContext,
  type PolicyDecision,
  type PolicyVersion,
  type Remediation,
  type RevocationBehavior,
  shouldAutoDiscoverProducts,
  shouldAutoVerify,
  shouldUseCatalogBackedVerification,
} from './engine';
