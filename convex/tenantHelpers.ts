/**
 * Creator Scoping Helpers
 *
 * Type utilities and helper functions for working with creator-scoped data.
 * All creator-scoped tables use authUserId (Better Auth user ID string) for isolation.
 */

import type { ProviderKey } from '../packages/shared/src/providers';
import type { Id } from './_generated/dataModel';

// ============================================================================
// CREATOR-SCOPED TABLE TYPES
// ============================================================================

/** Tables that require authUserId for creator isolation */
export type CreatorScopedTable =
  | 'creator_profiles'
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

/** Tables that are platform-level (no authUserId) */
export type PlatformTable =
  | 'subjects'
  | 'external_accounts'
  | 'provider_customers'
  | 'catalog_product_links'
  | 'webhook_events';

// ============================================================================
// AUTH USER ID TYPE
// ============================================================================

/** Better Auth user ID — primary creator identity */
export type AuthUserId = string;

// ============================================================================
// CREATOR-SCOPED DOCUMENT TYPES
// ============================================================================

/**
 * Base type for documents that are creator-scoped.
 * All creator-scoped documents have an authUserId field.
 */
export interface CreatorScopedDocument {
  authUserId: AuthUserId;
  createdAt: number;
  updatedAt: number;
}

/**
 * Documents that optionally have authUserId (like audit_events).
 * Platform-level events may not have a creator context.
 */
export interface OptionallyCreatorScopedDocument {
  authUserId?: AuthUserId;
  createdAt: number;
}

// ============================================================================
// QUERY HELPER TYPES
// ============================================================================

/**
 * Index names for creator-scoped queries.
 */
export type CreatorIndexPattern =
  | 'by_auth_user'
  | 'by_auth_user_subject'
  | 'by_auth_user_status'
  | 'by_auth_user_guild'
  | 'by_auth_user_product'
  | 'by_auth_user_type';

/**
 * Standard query filter for creator isolation.
 */
export interface CreatorQueryFilter {
  authUserId: AuthUserId;
}

/**
 * Query filter with subject for creator+subject scoped data.
 */
export interface CreatorSubjectQueryFilter extends CreatorQueryFilter {
  subjectId: Id<'subjects'>;
}

/**
 * Query filter with status for creator+status scoped data.
 */
export interface CreatorStatusQueryFilter extends CreatorQueryFilter {
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
 * Policy configuration for a creator.
 * Controls verification, binding, and entitlement behavior.
 */
export interface CreatorPolicy {
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
  | 'creator.created'
  | 'creator.updated'
  | 'guild.linked'
  | 'guild.unlinked'
  | 'subject.status.updated';

// ============================================================================
// HELPER FUNCTIONS (for use in Convex functions)
// ============================================================================

/**
 * Type guard to check if a document has an authUserId.
 */
export function hasAuthUserId(doc: unknown): doc is { authUserId: AuthUserId } {
  return (
    typeof doc === 'object' &&
    doc !== null &&
    'authUserId' in doc &&
    typeof (doc as { authUserId: unknown }).authUserId === 'string'
  );
}

/**
 * Creates a creator query filter object.
 */
export function creatorFilter(authUserId: AuthUserId): CreatorQueryFilter {
  return { authUserId };
}

/**
 * Creates a creator+subject query filter object.
 */
export function creatorSubjectFilter(
  authUserId: AuthUserId,
  subjectId: Id<'subjects'>
): CreatorSubjectQueryFilter {
  return { authUserId, subjectId };
}

// ============================================================================
// BACKWARD COMPATIBILITY ALIASES (remove after full migration)
// ============================================================================

/** @deprecated Use AuthUserId */
export type TenantId = AuthUserId;
/** @deprecated Use CreatorScopedDocument */
export type TenantScopedDocument = CreatorScopedDocument;
/** @deprecated Use CreatorQueryFilter */
export type TenantQueryFilter = CreatorQueryFilter;
/** @deprecated Use creatorFilter */
export const tenantFilter = creatorFilter;
/** @deprecated Use creatorSubjectFilter */
export const tenantSubjectFilter = creatorSubjectFilter;
/** @deprecated Use CreatorPolicy */
export type TenantPolicy = CreatorPolicy;
/** @deprecated Use hasAuthUserId */
export const hasTenantId = hasAuthUserId;
