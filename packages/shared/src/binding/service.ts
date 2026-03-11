/**
 * Binding Service Types and Business Logic
 *
 * This module provides types and business rules for the binding service.
 * Bindings link a YUCP subject to their provider identity within a tenant context.
 *
 * Business Rules:
 * - A provider account can only have ONE active ownership binding per tenant
 * - Transfer requires cooldown period (default 24 hours)
 * - Quarantine blocks new grants until reviewed
 * - Revocation cascades to entitlements
 */

// ============================================================================
// TYPES
// ============================================================================

/** Binding types - defines the nature of the subject-provider relationship */
export type BindingType = 'ownership' | 'verification' | 'manual_override';

/** Binding status lifecycle */
export type BindingStatus =
  | 'pending' // Created but not yet active
  | 'active' // Currently valid and in use
  | 'revoked' // Soft-deleted with reason
  | 'transferred' // Moved to new subject
  | 'quarantined'; // Marked for review, blocked

/** Actor types for binding operations */
export type BindingActorType = 'subject' | 'system' | 'admin';

/**
 * Policy configuration for binding operations
 * These come from the tenant's policy settings
 */
export interface BindingPolicy {
  /** Maximum bindings per product (default: 1) */
  maxBindingsPerProduct?: number;
  /** Whether transfers are allowed (default: true) */
  allowTransfer?: boolean;
  /** Cooldown period in hours before transfer is allowed (default: 24) */
  transferCooldownHours?: number;
  /** Whether shared use is allowed (default: false) */
  allowSharedUse?: boolean;
}

/**
 * Default binding policy values
 */
export const DEFAULT_BINDING_POLICY: Required<BindingPolicy> = {
  maxBindingsPerProduct: 1,
  allowTransfer: true,
  transferCooldownHours: 24,
  allowSharedUse: false,
};

/**
 * Input for activating a binding
 */
export interface ActivateBindingInput {
  tenantId: string;
  subjectId: string;
  externalAccountId: string;
  bindingType: BindingType;
  createdBy?: string;
  reason?: string;
}

/**
 * Input for revoking a binding
 */
export interface RevokeBindingInput {
  bindingId: string;
  reason: string;
  revokedBy?: string;
}

/**
 * Input for transferring a binding
 */
export interface TransferBindingInput {
  bindingId: string;
  newSubjectId: string;
  transferredBy?: string;
  reason?: string;
}

/**
 * Input for quarantining a binding
 */
export interface QuarantineBindingInput {
  bindingId: string;
  reason: string;
  quarantinedBy?: string;
}

/**
 * Result of binding activation
 */
export interface BindingActivationResult {
  success: boolean;
  bindingId: string;
  isNew: boolean;
  previousStatus?: BindingStatus;
  conflict?: {
    existingBindingId: string;
    message: string;
  };
}

/**
 * Result of binding revocation
 */
export interface BindingRevocationResult {
  success: boolean;
  bindingId: string;
  entitlementsRevoked: number;
  previousStatus: BindingStatus;
}

/**
 * Result of binding transfer
 */
export interface BindingTransferResult {
  success: boolean;
  oldBindingId: string;
  newBindingId?: string;
  cooldownRemaining?: number; // milliseconds remaining
  error?: string;
}

/**
 * Result of binding quarantine
 */
export interface BindingQuarantineResult {
  success: boolean;
  bindingId: string;
  previousStatus: BindingStatus;
}

/**
 * Binding lookup result
 */
export interface BindingLookup {
  bindingId: string;
  tenantId: string;
  subjectId: string;
  externalAccountId: string;
  bindingType: BindingType;
  status: BindingStatus;
  createdBy?: string;
  reason?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// BUSINESS RULES
// ============================================================================

/**
 * Check if transfer is allowed based on cooldown period
 * @param lastTransferTime - Timestamp of the last transfer (or binding creation)
 * @param cooldownHours - Cooldown period in hours
 * @returns true if transfer is allowed, false otherwise
 */
export function isTransferAllowed(
  lastTransferTime: number,
  cooldownHours: number = DEFAULT_BINDING_POLICY.transferCooldownHours
): boolean {
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  return Date.now() - lastTransferTime >= cooldownMs;
}

/**
 * Calculate remaining cooldown time
 * @param lastTransferTime - Timestamp of the last transfer (or binding creation)
 * @param cooldownHours - Cooldown period in hours
 * @returns Remaining cooldown in milliseconds, or 0 if no cooldown
 */
export function calculateRemainingCooldown(
  lastTransferTime: number,
  cooldownHours: number = DEFAULT_BINDING_POLICY.transferCooldownHours
): number {
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const elapsed = Date.now() - lastTransferTime;
  const remaining = cooldownMs - elapsed;
  return remaining > 0 ? remaining : 0;
}

/**
 * Check if binding is in an active state
 */
export function isBindingActive(status: BindingStatus): boolean {
  return status === 'active';
}

/**
 * Check if binding can be modified
 * Only pending and active bindings can be modified
 */
export function canModifyBinding(status: BindingStatus): boolean {
  return status === 'pending' || status === 'active';
}

/**
 * Check if binding can be transferred
 */
export function canTransferBinding(status: BindingStatus, policy: BindingPolicy): boolean {
  if (!isBindingActive(status)) {
    return false;
  }
  if (policy.allowTransfer === false) {
    return false;
  }
  return true;
}

/**
 * Get effective policy with defaults applied
 */
export function getEffectivePolicy(policy?: BindingPolicy): Required<BindingPolicy> {
  return {
    ...DEFAULT_BINDING_POLICY,
    ...policy,
  };
}

/**
 * Generate audit event metadata for binding operations
 */
export function createBindingAuditMetadata(
  operation: 'activate' | 'revoke' | 'transfer' | 'quarantine',
  bindingId: string,
  details: Record<string, unknown>
): Record<string, unknown> {
  return {
    operation,
    bindingId,
    timestamp: Date.now(),
    ...details,
  };
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate binding type
 */
export function isValidBindingType(type: string): type is BindingType {
  return ['ownership', 'verification', 'manual_override'].includes(type);
}

/**
 * Validate binding status
 */
export function isValidBindingStatus(status: string): status is BindingStatus {
  return ['pending', 'active', 'revoked', 'transferred', 'quarantined'].includes(status);
}

/**
 * Validate activate binding input
 */
export function validateActivateInput(input: ActivateBindingInput): string[] {
  const errors: string[] = [];

  if (!input.tenantId) {
    errors.push('tenantId is required');
  }
  if (!input.subjectId) {
    errors.push('subjectId is required');
  }
  if (!input.externalAccountId) {
    errors.push('externalAccountId is required');
  }
  if (!isValidBindingType(input.bindingType)) {
    errors.push(`Invalid bindingType: ${input.bindingType}`);
  }

  return errors;
}

/**
 * Validate revoke binding input
 */
export function validateRevokeInput(input: RevokeBindingInput): string[] {
  const errors: string[] = [];

  if (!input.bindingId) {
    errors.push('bindingId is required');
  }
  if (!input.reason || input.reason.trim() === '') {
    errors.push('reason is required for revocation');
  }

  return errors;
}

/**
 * Validate transfer binding input
 */
export function validateTransferInput(input: TransferBindingInput): string[] {
  const errors: string[] = [];

  if (!input.bindingId) {
    errors.push('bindingId is required');
  }
  if (!input.newSubjectId) {
    errors.push('newSubjectId is required');
  }

  return errors;
}

/**
 * Validate quarantine binding input
 */
export function validateQuarantineInput(input: QuarantineBindingInput): string[] {
  const errors: string[] = [];

  if (!input.bindingId) {
    errors.push('bindingId is required');
  }
  if (!input.reason || input.reason.trim() === '') {
    errors.push('reason is required for quarantine');
  }

  return errors;
}
