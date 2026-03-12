/**
 * Tenant Scoping Helpers
 *
 * Type utilities and helper functions for working with tenant-scoped data.
 * All tenant-scoped tables should use these types and helpers for consistency.
 */

import type { ProviderKey } from '../packages/shared/src/providers';
import type { Id } from './_generated/dataModel';

// ============================================================================
// TENANT-SCOPED TABLE TYPES
// ============================================================================

/** Tables that require tenantId for tenant isolation */
export type TenantScopedTable =
  | 'tenants'
  | 'bindings'
  | 'verification_sessions'
  | 'entitlements'
  | 'guild_links'
  | 'role_rules'
  | 'unity_installations'
  | 'runtime_assertions'
  | 'outbox_jobs'
  | 'audit_events'
  | 'product_catalog';

/** Tables that are platform-level (no tenantId) */
export type PlatformTable =
  | 'subjects'
  | 'external_accounts'
  | 'provider_customers'
  | 'catalog_product_links'
  | 'webhook_events';

// ============================================================================
// TENANT ID TYPE
// ============================================================================

/** Strongly-typed tenant ID for use in queries and mutations */
export type TenantId = Id<'tenants'>;

// ============================================================================
// TENANT-SCOPED DOCUMENT TYPES
// ============================================================================

/**
 * Base type for documents that are tenant-scoped.
 * All tenant-scoped documents have a tenantId field.
 */
export interface TenantScopedDocument {
  tenantId: TenantId;
  createdAt: number;
  updatedAt: number;
}

/**
 * Documents that optionally have tenantId (like audit_events).
 * Platform-level events may not have a tenant context.
 */
export interface OptionallyTenantScopedDocument {
  tenantId?: TenantId;
  createdAt: number;
}

// ============================================================================
// QUERY HELPER TYPES
// ============================================================================

/**
 * Index names for tenant-scoped queries.
 * These are the standard index patterns used across tenant-scoped tables.
 */
export type TenantIndexPattern =
  | 'by_tenant'
  | 'by_tenant_subject'
  | 'by_tenant_status'
  | 'by_tenant_guild'
  | 'by_tenant_product'
  | 'by_tenant_type';

/**
 * Standard query filter for tenant isolation.
 * Use this to ensure queries are always scoped to a tenant.
 */
export interface TenantQueryFilter {
  tenantId: TenantId;
}

/**
 * Query filter with subject for tenant+subject scoped data.
 */
export interface TenantSubjectQueryFilter extends TenantQueryFilter {
  subjectId: Id<'subjects'>;
}

/**
 * Query filter with status for tenant+status scoped data.
 */
export interface TenantStatusQueryFilter extends TenantQueryFilter {
  status: string;
}

// ============================================================================
// PLATFORM-LEVEL QUERY TYPES
// ============================================================================

/**
 * Index names for platform-level queries.
 */
export type PlatformIndexPattern =
  | 'by_discord_user'
  | 'by_auth_user'
  | 'by_provider_user'
  | 'by_email_hash'
  | 'by_url_hash'
  | 'by_jti'
  | 'by_status';

// ============================================================================
// PROVIDER TYPES
// ============================================================================

/** Provider types for type-safe provider handling */
export type Provider = ProviderKey;

/** Commerce providers (those that can have provider_customers) */
export type CommerceProvider = Extract<
  ProviderKey,
  'gumroad' | 'jinxxy' | 'lemonsqueezy' | 'manual' | 'patreon' | 'fourthwall' | 'itchio' | 'payhip'
>;

// ============================================================================
// STATUS TYPES
// ============================================================================

export type SubjectStatus = 'active' | 'suspended' | 'quarantined' | 'deleted';

export type BindingStatus = 'pending' | 'active' | 'revoked' | 'transferred' | 'quarantined';

export type EntitlementStatus = 'active' | 'revoked' | 'expired' | 'refunded' | 'disputed';

export type VerificationSessionStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type UnityInstallationStatus = 'active' | 'revoked' | 'quarantined';

export type RuntimeAssertionStatus = 'valid' | 'expired' | 'revoked';

export type OutboxJobStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'dead_letter';

// ============================================================================
// POLICY TYPES
// ============================================================================

/**
 * Policy configuration for a tenant.
 * Controls verification, binding, and entitlement behavior.
 */
export interface TenantPolicy {
  maxBindingsPerProduct?: number;
  allowTransfer?: boolean;
  transferCooldownHours?: number;
  allowSharedUse?: boolean;
  maxUnityInstallations?: number;
  autoVerifyOnJoin?: boolean;
  revocationBehavior?: string;
  gracePeriodHours?: number;
  requireFullProductLinkSetOnSetup?: boolean;
  allowCatalogLinkResolution?: boolean;
  manualReviewRequired?: boolean;
  discordRoleFreshnessMinutes?: number;
  allowCatalogBackedVerification?: boolean;
  autoDiscoverSupportedProductsForRememberedPurchaser?: boolean;
}

/**
 * Policy decision result from the policy engine.
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

// ============================================================================
// AUDIT TYPES
// ============================================================================

/** Actor types for audit events */
export type AuditActorType = 'subject' | 'system' | 'admin';

/** Audit event types - matches the schema literal union */
export type AuditEventType =
  | 'verification.session.created'
  | 'verification.session.completed'
  | 'verification.provider.completed'
  | 'binding.created'
  | 'binding.activated'
  | 'binding.revoked'
  | 'binding.transferred'
  | 'entitlement.granted'
  | 'entitlement.revoked'
  | 'discord.role.sync.requested'
  | 'discord.role.sync.completed'
  | 'unity.assertion.issued'
  | 'unity.assertion.revoked'
  | 'secret.accessed'
  | 'creator.policy.updated'
  | 'tenant.created'
  | 'tenant.updated'
  | 'guild.linked'
  | 'guild.unlinked'
  | 'subject.status.updated';

// ============================================================================
// HELPER FUNCTIONS (for use in Convex functions)
// ============================================================================

/**
 * Type guard to check if a document has a tenantId.
 * Useful for filtering audit events that may or may not be tenant-scoped.
 */
export function hasTenantId(doc: unknown): doc is { tenantId: TenantId } {
  return (
    typeof doc === 'object' &&
    doc !== null &&
    'tenantId' in doc &&
    typeof (doc as { tenantId: unknown }).tenantId === 'string'
  );
}

/**
 * Creates a tenant query filter object.
 * Use this to ensure consistent filter structure.
 */
export function tenantFilter(tenantId: TenantId): TenantQueryFilter {
  return { tenantId };
}

/**
 * Creates a tenant+subject query filter object.
 */
export function tenantSubjectFilter(
  tenantId: TenantId,
  subjectId: Id<'subjects'>
): TenantSubjectQueryFilter {
  return { tenantId, subjectId };
}
