/**
 * Tests for Policy Engine
 */

import { describe, expect, it } from 'bun:test';
import {
  CURRENT_POLICY_VERSION,
  PERMISSIVE_POLICY,
  STRICT_DEFAULT_POLICY,
  isStrictDefault,
  mergeWithDefaults,
  validatePolicyConfig,
} from '../defaults';
import {
  type PolicyConfig,
  type PolicyContext,
  evaluateBindingPolicy,
  evaluatePolicy,
  evaluateTransferPolicy,
  getPolicySummary,
  getRevocationTiming,
  isDiscordRoleSyncNeeded,
  shouldAutoDiscoverProducts,
  shouldAutoVerify,
  shouldUseCatalogBackedVerification,
} from '../engine';

// Helper to create a valid context that should pass all checks
function createMockContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    authUserId: 'user_test123',
    subjectId: 'user-456',
    productId: 'product-789',
    currentBindingCount: 0,
    currentUnityInstallations: 0,
    isTransfer: false,
    inDiscordServer: true,
    hasCatalogVerification: true,
    isRememberedPurchaser: true, // Set to true to bypass manual review
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Policy Defaults', () => {
  describe('STRICT_DEFAULT_POLICY', () => {
    it('should have strict binding limits', () => {
      expect(STRICT_DEFAULT_POLICY.maxBindingsPerProduct).toBe(1);
      expect(STRICT_DEFAULT_POLICY.maxUnityInstallations).toBe(1);
    });

    it('should disable transfers by default', () => {
      expect(STRICT_DEFAULT_POLICY.allowTransfer).toBe(false);
    });

    it('should disable shared use by default', () => {
      expect(STRICT_DEFAULT_POLICY.allowSharedUse).toBe(false);
    });

    it('should require manual review by default', () => {
      expect(STRICT_DEFAULT_POLICY.manualReviewRequired).toBe(true);
    });

    it('should disable auto-verify by default', () => {
      expect(STRICT_DEFAULT_POLICY.autoVerifyOnJoin).toBe(false);
    });

    it('should use immediate revocation by default', () => {
      expect(STRICT_DEFAULT_POLICY.revocationBehavior).toBe('immediate');
      expect(STRICT_DEFAULT_POLICY.gracePeriodHours).toBe(0);
    });
  });

  describe('PERMISSIVE_POLICY', () => {
    it('should allow multiple bindings', () => {
      expect(PERMISSIVE_POLICY.maxBindingsPerProduct).toBe(5);
    });

    it('should allow transfers', () => {
      expect(PERMISSIVE_POLICY.allowTransfer).toBe(true);
    });

    it('should allow shared use', () => {
      expect(PERMISSIVE_POLICY.allowSharedUse).toBe(true);
    });
  });

  describe('mergeWithDefaults', () => {
    it('should return strict defaults when no custom policy provided', () => {
      const result = mergeWithDefaults();
      expect(result).toEqual(STRICT_DEFAULT_POLICY);
    });

    it('should merge custom values with defaults', () => {
      const result = mergeWithDefaults({ maxBindingsPerProduct: 3 });
      expect(result.maxBindingsPerProduct).toBe(3);
      expect(result.allowTransfer).toBe(false); // default
    });

    it('should override all defaults when custom values provided', () => {
      const customPolicy: Partial<PolicyConfig> = {
        maxBindingsPerProduct: 10,
        allowTransfer: true,
        allowSharedUse: true,
        manualReviewRequired: false,
      };
      const result = mergeWithDefaults(customPolicy);
      expect(result.maxBindingsPerProduct).toBe(10);
      expect(result.allowTransfer).toBe(true);
      expect(result.allowSharedUse).toBe(true);
      expect(result.manualReviewRequired).toBe(false);
    });
  });

  describe('validatePolicyConfig', () => {
    it('should return no errors for valid config', () => {
      const errors = validatePolicyConfig({ maxBindingsPerProduct: 5 });
      expect(errors).toHaveLength(0);
    });

    it('should error on maxBindingsPerProduct < 1', () => {
      const errors = validatePolicyConfig({ maxBindingsPerProduct: 0 });
      expect(errors).toContain('maxBindingsPerProduct must be at least 1');
    });

    it('should error on maxBindingsPerProduct > 100', () => {
      const errors = validatePolicyConfig({ maxBindingsPerProduct: 101 });
      expect(errors).toContain('maxBindingsPerProduct cannot exceed 100');
    });

    it('should error on maxUnityInstallations < 1', () => {
      const errors = validatePolicyConfig({ maxUnityInstallations: 0 });
      expect(errors).toContain('maxUnityInstallations must be at least 1');
    });

    it('should error on maxUnityInstallations > 10', () => {
      const errors = validatePolicyConfig({ maxUnityInstallations: 11 });
      expect(errors).toContain('maxUnityInstallations cannot exceed 10');
    });

    it('should error on negative transferCooldownHours', () => {
      const errors = validatePolicyConfig({ transferCooldownHours: -1 });
      expect(errors).toContain('transferCooldownHours cannot be negative');
    });

    it('should error on transferCooldownHours > 168', () => {
      const errors = validatePolicyConfig({ transferCooldownHours: 169 });
      expect(errors).toContain('transferCooldownHours cannot exceed 168 (1 week)');
    });

    it('should error on gracePeriodHours < 0', () => {
      const errors = validatePolicyConfig({ gracePeriodHours: -1 });
      expect(errors).toContain('gracePeriodHours cannot be negative');
    });

    it('should error on gracePeriodHours > 720', () => {
      const errors = validatePolicyConfig({ gracePeriodHours: 721 });
      expect(errors).toContain('gracePeriodHours cannot exceed 720 (30 days)');
    });

    it('should error on discordRoleFreshnessMinutes < 5', () => {
      const errors = validatePolicyConfig({ discordRoleFreshnessMinutes: 4 });
      expect(errors).toContain('discordRoleFreshnessMinutes must be at least 5');
    });

    it('should error on discordRoleFreshnessMinutes > 1440', () => {
      const errors = validatePolicyConfig({ discordRoleFreshnessMinutes: 1441 });
      expect(errors).toContain('discordRoleFreshnessMinutes cannot exceed 1440 (24 hours)');
    });

    it('should error on invalid revocationBehavior', () => {
      const errors = validatePolicyConfig({
        revocationBehavior: 'invalid' as 'immediate',
      });
      expect(errors).toContain(
        'revocationBehavior must be "immediate", "grace_period", or "manual"'
      );
    });
  });

  describe('isStrictDefault', () => {
    it('should return true for strict default config', () => {
      expect(isStrictDefault(STRICT_DEFAULT_POLICY)).toBe(true);
    });

    it('should return false for permissive config', () => {
      expect(isStrictDefault(PERMISSIVE_POLICY)).toBe(false);
    });
  });
});

describe('Policy Engine', () => {
  describe('evaluatePolicy', () => {
    it('should allow when all conditions pass', () => {
      const context = createMockContext();
      const decision = evaluatePolicy({}, context);

      expect(decision.allow).toBe(true);
      expect(decision.reasons).toHaveLength(0);
      expect(decision.remediation).toBeUndefined();
      expect(decision.snapshotVersion).toBe(CURRENT_POLICY_VERSION);
    });

    it('should deny when binding limit exceeded', () => {
      const context = createMockContext({ currentBindingCount: 1 });
      const decision = evaluatePolicy({}, context);

      expect(decision.allow).toBe(false);
      expect(decision.reasons).toContain('Binding limit exceeded');
      expect(decision.remediation).toBeDefined();
      expect(decision.remediation?.length).toBeGreaterThan(0);
    });

    it('should deny when Unity installation limit exceeded', () => {
      const context = createMockContext({ currentUnityInstallations: 1 });
      const decision = evaluatePolicy({}, context);

      expect(decision.allow).toBe(false);
      expect(decision.reasons).toContain('Unity installation limit exceeded');
    });

    it('should deny transfer when disabled', () => {
      const context = createMockContext({ isTransfer: true });
      const decision = evaluatePolicy({}, context);

      expect(decision.allow).toBe(false);
      expect(decision.reasons).toContain('Transfer not allowed by policy');
    });

    it('should allow transfer when enabled and cooldown passed', () => {
      const context = createMockContext({
        isTransfer: true,
        lastTransferTime: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      });
      const decision = evaluatePolicy({ allowTransfer: true }, context);

      expect(decision.allow).toBe(true);
    });

    it('should deny when catalog verification required but missing', () => {
      const context = createMockContext({
        hasCatalogVerification: false,
        isRememberedPurchaser: true,
      });
      const decision = evaluatePolicy(
        {
          requireFullProductLinkSetOnSetup: true,
          allowCatalogBackedVerification: false,
        },
        context
      );
      expect(decision.allow).toBe(false);
      expect(decision.reasons).toContain('Catalog verification required');
    });

    it('should deny transfer during cooldown', () => {
      const context = createMockContext({
        isTransfer: true,
        lastTransferTime: Date.now() - 1 * 60 * 60 * 1000, // 1 hour ago
      });
      const decision = evaluatePolicy({ allowTransfer: true, transferCooldownHours: 24 }, context);

      expect(decision.allow).toBe(false);
      expect(decision.reasons[0]).toContain('Transfer cooldown not expired');
    });

    it('should deny when shared use not allowed', () => {
      const context = createMockContext({ currentBindingCount: 1 });
      const decision = evaluatePolicy({}, context);

      expect(decision.allow).toBe(false);
      expect(decision.reasons).toContain('Shared use not allowed');
    });

    it('should allow shared use when enabled', () => {
      const context = createMockContext({ currentBindingCount: 1 });
      const decision = evaluatePolicy({ allowSharedUse: true, maxBindingsPerProduct: 5 }, context);

      expect(decision.allow).toBe(true);
    });

    it('should require manual review for non-remembered purchasers', () => {
      const context = createMockContext({ isRememberedPurchaser: false });
      const decision = evaluatePolicy({}, context);

      expect(decision.allow).toBe(false);
      expect(decision.reasons).toContain('Manual review required');
    });

    it('should skip manual review for remembered purchasers', () => {
      const context = createMockContext({ isRememberedPurchaser: true });
      const decision = evaluatePolicy({}, context);

      expect(decision.allow).toBe(true);
    });

    it('should include remediation with action and message', () => {
      const context = createMockContext({ currentBindingCount: 1 });
      const decision = evaluatePolicy({}, context);

      expect(decision.remediation).toBeDefined();
      const remediation = decision.remediation?.[0];
      expect(remediation).toBeDefined();
      if (!remediation) {
        throw new Error('Expected remediation to be defined');
      }
      expect(remediation.action).toBeDefined();
      expect(remediation.message).toBeDefined();
    });
  });

  describe('evaluateBindingPolicy', () => {
    it('should evaluate as non-transfer request', () => {
      const context = createMockContext();
      const decision = evaluateBindingPolicy({}, context);

      expect(decision.allow).toBe(true);
    });
  });

  describe('evaluateTransferPolicy', () => {
    it('should evaluate as transfer request', () => {
      const context = createMockContext();
      const decision = evaluateTransferPolicy({}, context);

      expect(decision.allow).toBe(false); // transfers disabled by default
      expect(decision.reasons).toContain('Transfer not allowed by policy');
    });
  });

  describe('shouldAutoVerify', () => {
    it('should return false when autoVerifyOnJoin disabled', () => {
      const result = shouldAutoVerify({}, createMockContext());
      expect(result).toBe(false);
    });

    it('should return false when user not in Discord server', () => {
      const context = createMockContext({ inDiscordServer: false });
      const result = shouldAutoVerify({ autoVerifyOnJoin: true }, context);
      expect(result).toBe(false);
    });

    it('should return true when all conditions met', () => {
      const context = createMockContext({ inDiscordServer: true });
      const result = shouldAutoVerify({ autoVerifyOnJoin: true }, context);
      expect(result).toBe(true);
    });

    it('should return false when no catalog verification', () => {
      const context = createMockContext({
        inDiscordServer: true,
        hasCatalogVerification: false,
      });
      const result = shouldAutoVerify({ autoVerifyOnJoin: true }, context);
      expect(result).toBe(false);
    });

    it('should return true with catalog-backed verification', () => {
      const context = createMockContext({
        inDiscordServer: true,
        hasCatalogVerification: false,
        isRememberedPurchaser: true,
      });
      const result = shouldAutoVerify(
        { autoVerifyOnJoin: true, allowCatalogBackedVerification: true },
        context
      );
      expect(result).toBe(true);
    });
  });

  describe('getRevocationTiming', () => {
    it('should return immediate for immediate behavior', () => {
      const result = getRevocationTiming({ revocationBehavior: 'immediate' }, Date.now());
      expect(result.immediate).toBe(true);
      expect(result.effectiveAt).toBeNull();
    });

    it('should return delayed for grace_period behavior', () => {
      const revokedAt = Date.now();
      const result = getRevocationTiming(
        { revocationBehavior: 'grace_period', gracePeriodHours: 24 },
        revokedAt
      );
      expect(result.immediate).toBe(false);
      expect(result.effectiveAt).toBe(revokedAt + 24 * 60 * 60 * 1000);
    });

    it('should return no automatic for manual behavior', () => {
      const result = getRevocationTiming({ revocationBehavior: 'manual' }, Date.now());
      expect(result.immediate).toBe(false);
      expect(result.effectiveAt).toBeNull();
    });
  });

  describe('shouldUseCatalogBackedVerification', () => {
    it('should return false when disabled', () => {
      const result = shouldUseCatalogBackedVerification(
        {},
        { hasCatalogVerification: false, isRememberedPurchaser: true }
      );
      expect(result).toBe(false);
    });

    it('should return false when direct verification exists', () => {
      const result = shouldUseCatalogBackedVerification(
        { allowCatalogBackedVerification: true },
        { hasCatalogVerification: true, isRememberedPurchaser: true }
      );
      expect(result).toBe(false);
    });

    it('should return true when enabled and remembered purchaser', () => {
      const result = shouldUseCatalogBackedVerification(
        { allowCatalogBackedVerification: true },
        { hasCatalogVerification: false, isRememberedPurchaser: true }
      );
      expect(result).toBe(true);
    });

    it('should return false when not remembered purchaser', () => {
      const result = shouldUseCatalogBackedVerification(
        { allowCatalogBackedVerification: true },
        { hasCatalogVerification: false, isRememberedPurchaser: false }
      );
      expect(result).toBe(false);
    });
  });

  describe('shouldAutoDiscoverProducts', () => {
    it('should return false when disabled', () => {
      const result = shouldAutoDiscoverProducts({}, { isRememberedPurchaser: true });
      expect(result).toBe(false);
    });

    it('should return true when enabled and remembered', () => {
      const result = shouldAutoDiscoverProducts(
        { autoDiscoverSupportedProductsForRememberedPurchaser: true },
        { isRememberedPurchaser: true }
      );
      expect(result).toBe(true);
    });

    it('should return false when not remembered', () => {
      const result = shouldAutoDiscoverProducts(
        { autoDiscoverSupportedProductsForRememberedPurchaser: true },
        { isRememberedPurchaser: false }
      );
      expect(result).toBe(false);
    });
  });

  describe('isDiscordRoleSyncNeeded', () => {
    it('should return true when sync is stale', () => {
      const lastSync = Date.now() - 61 * 60 * 1000; // 61 minutes ago
      const result = isDiscordRoleSyncNeeded({}, lastSync);
      expect(result).toBe(true);
    });

    it('respects explicit currentTime parameter', () => {
      const lastSync = 1000;
      const currentTime = 2000;
      const result = isDiscordRoleSyncNeeded(
        { discordRoleFreshnessMinutes: 60 },
        lastSync,
        currentTime
      );
      expect(result).toBe(false);
    });

    it('should return false when sync is fresh', () => {
      const lastSync = Date.now() - 30 * 60 * 1000; // 30 minutes ago
      const result = isDiscordRoleSyncNeeded({}, lastSync);
      expect(result).toBe(false);
    });

    it('should respect custom freshness minutes', () => {
      const lastSync = Date.now() - 30 * 60 * 1000; // 30 minutes ago
      const result = isDiscordRoleSyncNeeded({ discordRoleFreshnessMinutes: 15 }, lastSync);
      expect(result).toBe(true);
    });
  });

  describe('getPolicySummary', () => {
    it('should return summary of key policy settings', () => {
      const summary = getPolicySummary({ maxBindingsPerProduct: 5 });
      expect(summary.maxBindings).toBe(5);
      expect(summary.transferAllowed).toBe(false);
      expect(summary.sharedUseAllowed).toBe(false);
    });
  });
});
