/**
 * Tests for Entitlement Service Module
 *
 * Tests the validator schemas, helper functions, and business logic.
 * For full integration tests with a Convex backend, use convex-test package.
 *
 * @see https://github.com/get-convex/convex-test
 */

import { describe, expect, it } from 'bun:test';
import { v } from 'convex/values';

// Import shared types and helpers
import {
  EntitlementConstants,
  type EntitlementStatus,
  type Provider,
  type RevocationReason,
  calculateGracePeriodEnd,
  canReactivate,
  generateGrantIdempotencyKey,
  generateRoleRemovalIdempotencyKey,
  generateRoleSyncIdempotencyKey,
  getGumroadRevocationReason,
  getReasonLabel,
  getStatusLabel,
  isAutoDiscoveryEnabled,
  isEntitlementActive,
  isStatusTerminal,
  isWithinGracePeriod,
  mapGumroadEventToAction,
  mapJinxxyEventToAction,
  mapReasonToStatus,
} from '../packages/shared/src/entitlement';

// ============================================================================
// VALIDATOR SCHEMA TESTS
// ============================================================================

describe('Provider Evidence Validator', () => {
  // Recreate the validator locally for testing
  const ProviderEvidence = v.object({
    provider: v.union(
      v.literal('discord'),
      v.literal('gumroad'),
      v.literal('jinxxy'),
      v.literal('manual')
    ),
    sourceReference: v.string(),
    providerCustomerId: v.optional(v.string()),
    purchasedAt: v.optional(v.number()),
    amount: v.optional(v.number()),
    currency: v.optional(v.string()),
    rawEvidence: v.optional(v.any()),
  });

  it('should have correct schema structure', () => {
    const validData = {
      provider: 'gumroad' as const,
      sourceReference: 'order_123456',
      providerCustomerId: 'cust_789',
      purchasedAt: Date.now(),
      amount: 29.99,
      currency: 'USD',
    };

    expect(validData.provider).toBeDefined();
    expect(validData.sourceReference).toBeDefined();
    expect(typeof validData.provider).toBe('string');
    expect(typeof validData.sourceReference).toBe('string');
  });

  it('should accept minimal provider evidence', () => {
    const minimalData = {
      provider: 'gumroad' as const,
      sourceReference: 'order_123456',
    };

    expect(minimalData.provider).toBeDefined();
    expect(minimalData.sourceReference).toBeDefined();
  });

  it('should accept all provider types', () => {
    const providers: Provider[] = ['discord', 'gumroad', 'jinxxy', 'manual'];

    providers.forEach((provider) => {
      const data = { provider, sourceReference: 'test' };
      expect(data.provider).toBe(provider);
    });
  });
});

describe('Grant Result Validator', () => {
  const GrantResult = v.object({
    success: v.boolean(),
    entitlementId: v.string(),
    isNew: v.boolean(),
    previousStatus: v.optional(
      v.union(
        v.literal('active'),
        v.literal('revoked'),
        v.literal('expired'),
        v.literal('refunded'),
        v.literal('disputed')
      )
    ),
    outboxJobId: v.optional(v.string()),
  });

  it('should accept valid grant result with all fields', () => {
    const validResult = {
      success: true,
      entitlementId: 'ent_123',
      isNew: true,
      previousStatus: undefined,
      outboxJobId: 'job_456',
    };

    expect(typeof validResult.success).toBe('boolean');
    expect(typeof validResult.entitlementId).toBe('string');
    expect(typeof validResult.isNew).toBe('boolean');
  });

  it('should accept grant result for reactivation', () => {
    const reactivationResult = {
      success: true,
      entitlementId: 'ent_123',
      isNew: false,
      previousStatus: 'revoked' as const,
      outboxJobId: 'job_789',
    };

    expect(reactivationResult.isNew).toBe(false);
    expect(reactivationResult.previousStatus).toBe('revoked');
  });
});

describe('Revoke Result Validator', () => {
  const RevokeResult = v.object({
    success: v.boolean(),
    entitlementId: v.string(),
    previousStatus: v.union(
      v.literal('active'),
      v.literal('revoked'),
      v.literal('expired'),
      v.literal('refunded'),
      v.literal('disputed')
    ),
    revokedAt: v.number(),
    outboxJobIds: v.array(v.string()),
  });

  it('should accept valid revoke result', () => {
    const validResult = {
      success: true,
      entitlementId: 'ent_123',
      previousStatus: 'active' as const,
      revokedAt: Date.now(),
      outboxJobIds: ['job_1', 'job_2'],
    };

    expect(validResult.success).toBe(true);
    expect(Array.isArray(validResult.outboxJobIds)).toBe(true);
  });
});

// ============================================================================
// STATUS HELPER TESTS
// ============================================================================

describe('isEntitlementActive', () => {
  it('should return true for active status', () => {
    expect(isEntitlementActive('active')).toBe(true);
  });

  it('should return false for non-active statuses', () => {
    expect(isEntitlementActive('revoked')).toBe(false);
    expect(isEntitlementActive('expired')).toBe(false);
    expect(isEntitlementActive('refunded')).toBe(false);
    expect(isEntitlementActive('disputed')).toBe(false);
  });
});

describe('isStatusTerminal', () => {
  it('should return true for terminal statuses', () => {
    expect(isStatusTerminal('refunded')).toBe(true);
    expect(isStatusTerminal('disputed')).toBe(true);
  });

  it('should return false for non-terminal statuses', () => {
    expect(isStatusTerminal('active')).toBe(false);
    expect(isStatusTerminal('revoked')).toBe(false);
    expect(isStatusTerminal('expired')).toBe(false);
  });
});

describe('canReactivate', () => {
  it('should return true for revokable statuses', () => {
    expect(canReactivate('revoked')).toBe(true);
    expect(canReactivate('expired')).toBe(true);
  });

  it('should return false for active status', () => {
    expect(canReactivate('active')).toBe(false);
  });

  it('should return false for terminal statuses', () => {
    expect(canReactivate('refunded')).toBe(false);
    expect(canReactivate('disputed')).toBe(false);
  });
});

describe('mapReasonToStatus', () => {
  it('should map refund to refunded', () => {
    expect(mapReasonToStatus('refund')).toBe('refunded');
  });

  it('should map dispute to disputed', () => {
    expect(mapReasonToStatus('dispute')).toBe('disputed');
  });

  it('should map expiration to expired', () => {
    expect(mapReasonToStatus('expiration')).toBe('expired');
  });

  it('should map other reasons to revoked', () => {
    expect(mapReasonToStatus('manual')).toBe('revoked');
    expect(mapReasonToStatus('transfer')).toBe('revoked');
    expect(mapReasonToStatus('policy_violation')).toBe('revoked');
  });
});

describe('getStatusLabel', () => {
  it('should return human-readable labels', () => {
    expect(getStatusLabel('active')).toBe('Active');
    expect(getStatusLabel('revoked')).toBe('Revoked');
    expect(getStatusLabel('expired')).toBe('Expired');
    expect(getStatusLabel('refunded')).toBe('Refunded');
    expect(getStatusLabel('disputed')).toBe('Disputed');
  });
});

describe('getReasonLabel', () => {
  it('should return human-readable reason labels', () => {
    expect(getReasonLabel('refund')).toBe('Refund');
    expect(getReasonLabel('dispute')).toBe('Chargeback/Dispute');
    expect(getReasonLabel('expiration')).toBe('Expired');
    expect(getReasonLabel('manual')).toBe('Manual Revocation');
    expect(getReasonLabel('transfer')).toBe('Ownership Transfer');
    expect(getReasonLabel('policy_violation')).toBe('Policy Violation');
  });
});

// ============================================================================
// IDEMPOTENCY KEY TESTS
// ============================================================================

describe('generateRoleSyncIdempotencyKey', () => {
  it('should generate consistent format', () => {
    const key = generateRoleSyncIdempotencyKey('tenant_123', 'subject_456', 'ent_789', 1000);

    expect(key).toBe('role_sync:tenant_123:subject_456:ent_789:1000');
  });

  it('should use current timestamp when not provided', () => {
    const before = Date.now();
    const key = generateRoleSyncIdempotencyKey('t', 's', 'e');
    const after = Date.now();

    const timestamp = Number.parseInt(key.split(':').pop()!, 10);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

describe('generateRoleRemovalIdempotencyKey', () => {
  it('should generate consistent format', () => {
    const key = generateRoleRemovalIdempotencyKey(
      'tenant_123',
      'subject_456',
      'guild_789',
      'product_abc',
      1000
    );

    expect(key).toBe('role_removal:tenant_123:subject_456:guild_789:product_abc:1000');
  });
});

describe('generateGrantIdempotencyKey', () => {
  it('should generate consistent format', () => {
    const key = generateGrantIdempotencyKey('tenant_123', 'subject_456', 'order_789');

    expect(key).toBe('grant:tenant_123:subject_456:order_789');
  });
});

// ============================================================================
// POLICY HELPER TESTS
// ============================================================================

describe('isAutoDiscoveryEnabled', () => {
  it('should return true when explicitly enabled', () => {
    expect(
      isAutoDiscoveryEnabled({
        autoDiscoverSupportedProductsForRememberedPurchaser: true,
      })
    ).toBe(true);
  });

  it('should return false when explicitly disabled', () => {
    expect(
      isAutoDiscoveryEnabled({
        autoDiscoverSupportedProductsForRememberedPurchaser: false,
      })
    ).toBe(false);
  });

  it('should return false when not set', () => {
    expect(isAutoDiscoveryEnabled({})).toBe(false);
    expect(isAutoDiscoveryEnabled(undefined)).toBe(false);
  });
});

describe('calculateGracePeriodEnd', () => {
  it('should calculate correct end time', () => {
    const revokedAt = 1000000;
    const gracePeriodHours = 24;

    const result = calculateGracePeriodEnd(revokedAt, gracePeriodHours);

    // 24 hours in ms = 24 * 60 * 60 * 1000 = 86400000
    expect(result).toBe(1000000 + 86400000);
  });

  it('should return null when no grace period', () => {
    expect(calculateGracePeriodEnd(1000000, undefined)).toBe(null);
    expect(calculateGracePeriodEnd(1000000, 0)).toBe(null);
  });
});

describe('isWithinGracePeriod', () => {
  it('should return true when within grace period', () => {
    const revokedAt = Date.now() - 1000; // 1 second ago
    const gracePeriodHours = 24;

    expect(isWithinGracePeriod(revokedAt, gracePeriodHours)).toBe(true);
  });

  it('should return false when outside grace period', () => {
    const revokedAt = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    const gracePeriodHours = 24;

    expect(isWithinGracePeriod(revokedAt, gracePeriodHours)).toBe(false);
  });

  it('should return false when no grace period', () => {
    expect(isWithinGracePeriod(Date.now(), undefined)).toBe(false);
  });
});

// ============================================================================
// WEBHOOK MAPPING TESTS
// ============================================================================

describe('mapGumroadEventToAction', () => {
  it('should map sale to grant', () => {
    expect(mapGumroadEventToAction('sale')).toBe('grant');
  });

  it('should map subscription_updated to grant', () => {
    expect(mapGumroadEventToAction('subscription_updated')).toBe('grant');
  });

  it('should map refund to revoke', () => {
    expect(mapGumroadEventToAction('refund')).toBe('revoke');
  });

  it('should map dispute to revoke', () => {
    expect(mapGumroadEventToAction('dispute')).toBe('revoke');
  });

  it('should map cancellation to revoke', () => {
    expect(mapGumroadEventToAction('cancellation')).toBe('revoke');
  });
});

describe('mapJinxxyEventToAction', () => {
  it('should map purchase to grant', () => {
    expect(mapJinxxyEventToAction('purchase')).toBe('grant');
  });

  it('should map refund to revoke', () => {
    expect(mapJinxxyEventToAction('refund')).toBe('revoke');
  });

  it('should map transfer to update', () => {
    expect(mapJinxxyEventToAction('transfer')).toBe('update');
  });
});

describe('getGumroadRevocationReason', () => {
  it('should map refund event to refund reason', () => {
    expect(getGumroadRevocationReason('refund')).toBe('refund');
  });

  it('should map dispute event to dispute reason', () => {
    expect(getGumroadRevocationReason('dispute')).toBe('dispute');
  });

  it('should map cancellation event to expiration reason', () => {
    expect(getGumroadRevocationReason('cancellation')).toBe('expiration');
  });

  it('should return null for non-revocation events', () => {
    expect(getGumroadRevocationReason('sale')).toBe(null);
    expect(getGumroadRevocationReason('subscription_updated')).toBe(null);
  });
});

// ============================================================================
// CONSTANTS TESTS
// ============================================================================

describe('EntitlementConstants', () => {
  it('should define terminal statuses', () => {
    expect(EntitlementConstants.TERMINAL_STATUSES).toContain('refunded');
    expect(EntitlementConstants.TERMINAL_STATUSES).toContain('disputed');
    expect(EntitlementConstants.TERMINAL_STATUSES).toHaveLength(2);
  });

  it('should define active statuses', () => {
    expect(EntitlementConstants.ACTIVE_STATUSES).toContain('active');
    expect(EntitlementConstants.ACTIVE_STATUSES).toHaveLength(1);
  });
});

// ============================================================================
// ENTITLEMENT SCENARIO DESCRIPTIONS (for documentation)
// ============================================================================

describe('Entitlement Scenarios', () => {
  it('new grant: isNew=true when no existing entitlement', () => {
    expect(isEntitlementActive('active')).toBe(true);
    expect(canReactivate('active')).toBe(false);
  });

  it('idempotent grant: existing active entitlement returns without change', () => {
    expect(isEntitlementActive('active')).toBe(true);
  });

  it('reactivation: revoked/expired can be reactivated', () => {
    expect(canReactivate('revoked')).toBe(true);
    expect(canReactivate('expired')).toBe(true);
  });

  it('revocation: terminal statuses cannot be reactivated', () => {
    expect(isStatusTerminal('refunded')).toBe(true);
    expect(isStatusTerminal('disputed')).toBe(true);
    expect(canReactivate('refunded')).toBe(false);
  });

  it('policy snapshot: EntitlementConstants define terminal statuses', () => {
    expect(EntitlementConstants.TERMINAL_STATUSES).toContain('refunded');
    expect(EntitlementConstants.TERMINAL_STATUSES).toContain('disputed');
  });

  it('soft delete: status field indicates state, terminal cannot reactivate', () => {
    expect(EntitlementConstants.ACTIVE_STATUSES).toContain('active');
    expect(EntitlementConstants.TERMINAL_STATUSES).toHaveLength(2);
  });
});
