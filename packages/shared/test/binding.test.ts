/**
 * Binding Service Tests
 *
 * Tests for binding activation, revocation, transfer, quarantine, and lookup operations.
 */

import { describe, expect, it } from 'bun:test';
import {
  type BindingPolicy,
  type BindingStatus,
  DEFAULT_BINDING_POLICY,
  calculateRemainingCooldown,
  canModifyBinding,
  canTransferBinding,
  getEffectivePolicy,
  isBindingActive,
  isTransferAllowed,
  isValidBindingStatus,
  isValidBindingType,
  validateActivateInput,
  validateQuarantineInput,
  validateRevokeInput,
  validateTransferInput,
} from '../src/binding';

describe('Binding Service', () => {
  describe('isTransferAllowed', () => {
    it('should return true when cooldown has elapsed', () => {
      const lastTransferTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      expect(isTransferAllowed(lastTransferTime, 24)).toBe(true);
    });

    it('should return false when cooldown has not elapsed', () => {
      const lastTransferTime = Date.now() - 23 * 60 * 60 * 1000; // 23 hours ago
      expect(isTransferAllowed(lastTransferTime, 24)).toBe(false);
    });

    it('should return true when exactly at cooldown boundary', () => {
      const lastTransferTime = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
      expect(isTransferAllowed(lastTransferTime, 24)).toBe(true);
    });

    it('should use default cooldown when not specified', () => {
      const lastTransferTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      expect(isTransferAllowed(lastTransferTime)).toBe(true);
    });
  });

  describe('calculateRemainingCooldown', () => {
    it('should return remaining cooldown in milliseconds', () => {
      const lastTransferTime = Date.now() - 23 * 60 * 60 * 1000; // 23 hours ago
      const remaining = calculateRemainingCooldown(lastTransferTime, 24);

      // Should be approximately 1 hour remaining
      expect(remaining).toBeGreaterThan(59 * 60 * 1000);
      expect(remaining).toBeLessThan(61 * 60 * 1000);
    });

    it('should return 0 when cooldown has elapsed', () => {
      const lastTransferTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      expect(calculateRemainingCooldown(lastTransferTime, 24)).toBe(0);
    });

    it('should return 0 when exactly at boundary', () => {
      const lastTransferTime = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
      expect(calculateRemainingCooldown(lastTransferTime, 24)).toBe(0);
    });
  });

  describe('isBindingActive', () => {
    it('should return true for active status', () => {
      expect(isBindingActive('active')).toBe(true);
    });

    it('should return false for non-active statuses', () => {
      expect(isBindingActive('pending')).toBe(false);
      expect(isBindingActive('revoked')).toBe(false);
      expect(isBindingActive('transferred')).toBe(false);
      expect(isBindingActive('quarantined')).toBe(false);
    });
  });

  describe('canModifyBinding', () => {
    it('should return true for pending and active statuses', () => {
      expect(canModifyBinding('pending')).toBe(true);
      expect(canModifyBinding('active')).toBe(true);
    });

    it('should return false for other statuses', () => {
      expect(canModifyBinding('revoked')).toBe(false);
      expect(canModifyBinding('transferred')).toBe(false);
      expect(canModifyBinding('quarantined')).toBe(false);
    });
  });

  describe('canTransferBinding', () => {
    const defaultPolicy: BindingPolicy = {
      allowTransfer: true,
      transferCooldownHours: 24,
    };

    it('should return true for active binding with transfer allowed', () => {
      expect(canTransferBinding('active', defaultPolicy)).toBe(true);
    });

    it('should return false for non-active binding', () => {
      expect(canTransferBinding('pending', defaultPolicy)).toBe(false);
      expect(canTransferBinding('revoked', defaultPolicy)).toBe(false);
      expect(canTransferBinding('transferred', defaultPolicy)).toBe(false);
      expect(canTransferBinding('quarantined', defaultPolicy)).toBe(false);
    });

    it('should return false when transfer is not allowed by policy', () => {
      const noTransferPolicy: BindingPolicy = {
        allowTransfer: false,
      };
      expect(canTransferBinding('active', noTransferPolicy)).toBe(false);
    });
  });

  describe('getEffectivePolicy', () => {
    it('should return default policy when no policy provided', () => {
      const policy = getEffectivePolicy();
      expect(policy).toEqual(DEFAULT_BINDING_POLICY);
    });

    it('should merge provided policy with defaults', () => {
      const partialPolicy: BindingPolicy = {
        maxBindingsPerProduct: 5,
      };
      const effective = getEffectivePolicy(partialPolicy);

      expect(effective.maxBindingsPerProduct).toBe(5);
      expect(effective.allowTransfer).toBe(DEFAULT_BINDING_POLICY.allowTransfer);
      expect(effective.transferCooldownHours).toBe(DEFAULT_BINDING_POLICY.transferCooldownHours);
      expect(effective.allowSharedUse).toBe(DEFAULT_BINDING_POLICY.allowSharedUse);
    });

    it('should override all defaults when full policy provided', () => {
      const fullPolicy: BindingPolicy = {
        maxBindingsPerProduct: 10,
        allowTransfer: false,
        transferCooldownHours: 48,
        allowSharedUse: true,
      };
      const effective = getEffectivePolicy(fullPolicy);

      expect(effective).toEqual(fullPolicy as Required<BindingPolicy>);
    });
  });

  describe('isValidBindingType', () => {
    it('should return true for valid binding types', () => {
      expect(isValidBindingType('ownership')).toBe(true);
      expect(isValidBindingType('verification')).toBe(true);
      expect(isValidBindingType('manual_override')).toBe(true);
    });

    it('should return false for invalid binding types', () => {
      expect(isValidBindingType('invalid')).toBe(false);
      expect(isValidBindingType('')).toBe(false);
      expect(isValidBindingType('Ownership')).toBe(false); // case sensitive
    });
  });

  describe('isValidBindingStatus', () => {
    it('should return true for valid binding statuses', () => {
      expect(isValidBindingStatus('pending')).toBe(true);
      expect(isValidBindingStatus('active')).toBe(true);
      expect(isValidBindingStatus('revoked')).toBe(true);
      expect(isValidBindingStatus('transferred')).toBe(true);
      expect(isValidBindingStatus('quarantined')).toBe(true);
    });

    it('should return false for invalid binding statuses', () => {
      expect(isValidBindingStatus('invalid')).toBe(false);
      expect(isValidBindingStatus('')).toBe(false);
      expect(isValidBindingStatus('Active')).toBe(false); // case sensitive
    });
  });

  describe('validateActivateInput', () => {
    it('should return no errors for valid input', () => {
      const input = {
        authUserId: 'user_test123',
        subjectId: 'subject123',
        externalAccountId: 'external123',
        bindingType: 'ownership' as const,
      };
      expect(validateActivateInput(input)).toEqual([]);
    });

    it('should return errors for missing required fields', () => {
      const input = {
        authUserId: '',
        subjectId: '',
        externalAccountId: '',
        bindingType: 'invalid' as never,
      };
      const errors = validateActivateInput(input);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors).toContain('authUserId is required');
      expect(errors).toContain('subjectId is required');
      expect(errors).toContain('externalAccountId is required');
      expect(errors.some((e: string) => e.includes('Invalid bindingType'))).toBe(true);
    });
  });

  describe('validateRevokeInput', () => {
    it('should return no errors for valid input', () => {
      const input = {
        bindingId: 'binding123',
        reason: 'No longer needed',
      };
      expect(validateRevokeInput(input)).toEqual([]);
    });

    it('should return errors for missing bindingId', () => {
      const input = {
        bindingId: '',
        reason: 'Test reason',
      };
      const errors = validateRevokeInput(input);
      expect(errors).toContain('bindingId is required');
    });

    it('should return errors for missing reason', () => {
      const input = {
        bindingId: 'binding123',
        reason: '',
      };
      const errors = validateRevokeInput(input);
      expect(errors).toContain('reason is required for revocation');
    });

    it('should return errors for whitespace-only reason', () => {
      const input = {
        bindingId: 'binding123',
        reason: '   ',
      };
      const errors = validateRevokeInput(input);
      expect(errors).toContain('reason is required for revocation');
    });
  });

  describe('validateTransferInput', () => {
    it('should return no errors for valid input', () => {
      const input = {
        bindingId: 'binding123',
        newSubjectId: 'subject456',
      };
      expect(validateTransferInput(input)).toEqual([]);
    });

    it('should return errors for missing required fields', () => {
      const input = {
        bindingId: '',
        newSubjectId: '',
      };
      const errors = validateTransferInput(input);

      expect(errors).toContain('bindingId is required');
      expect(errors).toContain('newSubjectId is required');
    });
  });

  describe('validateQuarantineInput', () => {
    it('should return no errors for valid input', () => {
      const input = {
        bindingId: 'binding123',
        reason: 'Suspicious activity detected',
      };
      expect(validateQuarantineInput(input)).toEqual([]);
    });

    it('should return errors for missing bindingId', () => {
      const input = {
        bindingId: '',
        reason: 'Test reason',
      };
      const errors = validateQuarantineInput(input);
      expect(errors).toContain('bindingId is required');
    });

    it('should return errors for missing reason', () => {
      const input = {
        bindingId: 'binding123',
        reason: '',
      };
      const errors = validateQuarantineInput(input);
      expect(errors).toContain('reason is required for quarantine');
    });
  });
});
