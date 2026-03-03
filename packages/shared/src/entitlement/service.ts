/**
 * Entitlement Service - Shared Types and Logic
 *
 * This module provides shared types, validators, and business logic
 * for the entitlement service that can be used across the monorepo.
 *
 * Key concepts:
 * - Entitlement: A creator-approved right derived from provider evidence
 * - Provider Evidence: Purchase/subscription data from commerce providers
 * - Policy Snapshot: Version of tenant policy at grant time
 * - Outbox Jobs: Async side effects for role sync, notifications
 */

// ============================================================================
// TYPES
// ============================================================================

/** Provider types supported by the platform */
export type Provider = 'discord' | 'gumroad' | 'jinxxy' | 'manual';

/** Commerce providers (those that can have provider_customers) */
export type CommerceProvider = 'gumroad' | 'jinxxy' | 'manual';

/** Entitlement status values */
export type EntitlementStatus =
  | 'active'
  | 'revoked'
  | 'expired'
  | 'refunded'
  | 'disputed';

/** Terminal entitlement statuses (cannot be reactivated without new evidence) */
export const TERMINAL_STATUSES: EntitlementStatus[] = ['refunded', 'disputed'];

/** Active-like statuses that indicate valid entitlement */
export const ACTIVE_STATUSES: EntitlementStatus[] = ['active'];

/** Revocation reason types */
export type RevocationReason =
  | 'refund'
  | 'dispute'
  | 'expiration'
  | 'manual'
  | 'transfer'
  | 'policy_violation';

/** Provider evidence for granting entitlements */
export interface ProviderEvidence {
  /** Provider that supplied the evidence */
  provider: Provider;
  /** Reference to the source (order ID, license key, etc.) */
  sourceReference: string;
  /** Optional link to provider customer memory */
  providerCustomerId?: string;
  /** When the purchase occurred */
  purchasedAt?: number;
  /** Purchase amount */
  amount?: number;
  /** Currency code */
  currency?: string;
  /** Raw evidence data for audit */
  rawEvidence?: unknown;
}

/** Entitlement grant request */
export interface GrantEntitlementRequest {
  /** Tenant to grant within */
  tenantId: string;
  /** Subject to grant to */
  subjectId: string;
  /** Product being entitled */
  productId: string;
  /** Provider evidence */
  evidence: ProviderEvidence;
  /** Optional catalog product link */
  catalogProductId?: string;
  /** Correlation ID for tracing */
  correlationId?: string;
}

/** Entitlement revoke request */
export interface RevokeEntitlementRequest {
  /** Entitlement to revoke */
  entitlementId: string;
  /** Reason for revocation */
  reason: RevocationReason;
  /** Additional details */
  details?: string;
  /** Correlation ID for tracing */
  correlationId?: string;
}

/** Result of granting an entitlement */
export interface GrantEntitlementResult {
  success: boolean;
  entitlementId: string;
  isNew: boolean;
  previousStatus?: EntitlementStatus;
  outboxJobId?: string;
  error?: string;
}

/** Result of revoking an entitlement */
export interface RevokeEntitlementResult {
  success: boolean;
  entitlementId: string;
  previousStatus: EntitlementStatus;
  revokedAt: number;
  outboxJobIds: string[];
  error?: string;
}

/** Entitlement document shape */
export interface Entitlement {
  _id: string;
  _creationTime: number;
  tenantId: string;
  subjectId: string;
  productId: string;
  sourceProvider: Provider;
  sourceReference: string;
  providerCustomerId?: string;
  catalogProductId?: string;
  status: EntitlementStatus;
  policySnapshotVersion?: number;
  grantedAt: number;
  revokedAt?: number;
  updatedAt: number;
}

/** Outbox job types for entitlement side effects */
export type EntitlementOutboxJobType =
  | 'role_sync'
  | 'role_removal'
  | 'entitlement_refresh'
  | 'notification'
  | 'creator_alert';

/** Role sync job payload */
export interface RoleSyncPayload {
  subjectId: string;
  entitlementId: string;
  discordUserId?: string;
}

/** Role removal job payload */
export interface RoleRemovalPayload {
  subjectId: string;
  entitlementId: string;
  guildId: string;
  roleId: string;
  discordUserId?: string;
}

// ============================================================================
// VALIDATORS
// ============================================================================

/**
 * Check if an entitlement status is active.
 */
export function isEntitlementActive(status: EntitlementStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * Check if an entitlement status is terminal (cannot be reactivated).
 */
export function isStatusTerminal(status: EntitlementStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Check if an entitlement can be reactivated.
 */
export function canReactivate(status: EntitlementStatus): boolean {
  return !isStatusTerminal(status) && status !== 'active';
}

/**
 * Map revocation reason to entitlement status.
 */
export function mapReasonToStatus(
  reason: RevocationReason,
): EntitlementStatus {
  switch (reason) {
    case 'refund':
      return 'refunded';
    case 'dispute':
      return 'disputed';
    case 'expiration':
      return 'expired';
    default:
      return 'revoked';
  }
}

/**
 * Get human-readable status label.
 */
export function getStatusLabel(status: EntitlementStatus): string {
  const labels: Record<EntitlementStatus, string> = {
    active: 'Active',
    revoked: 'Revoked',
    expired: 'Expired',
    refunded: 'Refunded',
    disputed: 'Disputed',
  };
  return labels[status];
}

/**
 * Get human-readable reason label.
 */
export function getReasonLabel(reason: RevocationReason): string {
  const labels: Record<RevocationReason, string> = {
    refund: 'Refund',
    dispute: 'Chargeback/Dispute',
    expiration: 'Expired',
    manual: 'Manual Revocation',
    transfer: 'Ownership Transfer',
    policy_violation: 'Policy Violation',
  };
  return labels[reason];
}

// ============================================================================
// IDEMPOTENCY KEY GENERATORS
// ============================================================================

/**
 * Generate an idempotency key for role sync jobs.
 */
export function generateRoleSyncIdempotencyKey(
  tenantId: string,
  subjectId: string,
  entitlementId: string,
  timestamp?: number,
): string {
  return `role_sync:${tenantId}:${subjectId}:${entitlementId}:${timestamp ?? Date.now()}`;
}

/**
 * Generate an idempotency key for role removal jobs.
 */
export function generateRoleRemovalIdempotencyKey(
  tenantId: string,
  subjectId: string,
  guildId: string,
  productId: string,
  timestamp?: number,
): string {
  return `role_removal:${tenantId}:${subjectId}:${guildId}:${productId}:${timestamp ?? Date.now()}`;
}

/**
 * Generate an idempotency key for entitlement grants.
 */
export function generateGrantIdempotencyKey(
  tenantId: string,
  subjectId: string,
  sourceReference: string,
): string {
  return `grant:${tenantId}:${subjectId}:${sourceReference}`;
}

// ============================================================================
// POLICY SNAPSHOT
// ============================================================================

/**
 * Tenant policy configuration for entitlements.
 */
export interface EntitlementPolicy {
  maxBindingsPerProduct?: number;
  allowTransfer?: boolean;
  transferCooldownHours?: number;
  allowSharedUse?: boolean;
  maxUnityInstallations?: number;
  autoVerifyOnJoin?: boolean;
  revocationBehavior?: 'immediate' | 'grace_period' | 'manual';
  gracePeriodHours?: number;
  requireFullProductLinkSetOnSetup?: boolean;
  allowCatalogLinkResolution?: boolean;
  manualReviewRequired?: boolean;
  discordRoleFreshnessMinutes?: number;
  allowCatalogBackedVerification?: boolean;
  autoDiscoverSupportedProductsForRememberedPurchaser?: boolean;
}

/**
 * Policy decision result.
 */
export interface PolicyDecision {
  allow: boolean;
  reasons: string[];
  remediation?: Array<{
    action: string;
    url?: string;
    message: string;
  }>;
  snapshotVersion: number;
}

/**
 * Check if auto-discovery is enabled for a tenant.
 */
export function isAutoDiscoveryEnabled(policy?: EntitlementPolicy): boolean {
  return policy?.autoDiscoverSupportedProductsForRememberedPurchaser ?? false;
}

/**
 * Calculate grace period end time.
 */
export function calculateGracePeriodEnd(
  revokedAt: number,
  gracePeriodHours?: number,
): number | null {
  if (!gracePeriodHours) {
    return null;
  }
  return revokedAt + gracePeriodHours * 60 * 60 * 1000;
}

/**
 * Check if an entitlement is within grace period.
 */
export function isWithinGracePeriod(
  revokedAt: number,
  gracePeriodHours?: number,
): boolean {
  const gracePeriodEnd = calculateGracePeriodEnd(revokedAt, gracePeriodHours);
  if (!gracePeriodEnd) {
    return false;
  }
  return Date.now() < gracePeriodEnd;
}

// ============================================================================
// AUDIT EVENTS
// ============================================================================

/** Entitlement audit event types */
export type EntitlementAuditEventType =
  | 'entitlement.granted'
  | 'entitlement.revoked'
  | 'discord.role.sync.requested';

/** Audit event metadata for entitlement grants */
export interface EntitlementGrantedMetadata {
  productId: string;
  sourceProvider: Provider;
  sourceReference: string;
  policySnapshotVersion?: number;
  catalogProductId?: string;
  reactivated?: boolean;
  previousStatus?: EntitlementStatus;
}

/** Audit event metadata for entitlement revocations */
export interface EntitlementRevokedMetadata {
  productId: string;
  reason: RevocationReason;
  details?: string;
  previousStatus: EntitlementStatus;
  newStatus: EntitlementStatus;
}

// ============================================================================
// WEBHOOK PROCESSING HELPERS
// ============================================================================

/** Gumroad webhook event types */
export type GumroadEventType =
  | 'sale'
  | 'refund'
  | 'dispute'
  | 'cancellation'
  | 'subscription_updated';

/** Jinxxy webhook event types */
export type JinxxyEventType =
  | 'purchase'
  | 'refund'
  | 'transfer';

/**
 * Map Gumroad event type to entitlement action.
 */
export function mapGumroadEventToAction(
  eventType: GumroadEventType,
): 'grant' | 'revoke' | 'update' | 'none' {
  switch (eventType) {
    case 'sale':
    case 'subscription_updated':
      return 'grant';
    case 'refund':
    case 'dispute':
    case 'cancellation':
      return 'revoke';
    default:
      return 'none';
  }
}

/**
 * Map Jinxxy event type to entitlement action.
 */
export function mapJinxxyEventToAction(
  eventType: JinxxyEventType,
): 'grant' | 'revoke' | 'update' | 'none' {
  switch (eventType) {
    case 'purchase':
      return 'grant';
    case 'refund':
      return 'revoke';
    case 'transfer':
      return 'update';
    default:
      return 'none';
  }
}

/**
 * Determine revocation reason from Gumroad event.
 */
export function getGumroadRevocationReason(
  eventType: GumroadEventType,
): RevocationReason | null {
  switch (eventType) {
    case 'refund':
      return 'refund';
    case 'dispute':
      return 'dispute';
    case 'cancellation':
      return 'expiration';
    default:
      return null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const EntitlementConstants = {
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
} as const;
