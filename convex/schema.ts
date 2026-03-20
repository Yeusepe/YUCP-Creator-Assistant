/**
 * YUCP Creator Assistant - Convex Application Schema
 *
 * This schema defines all tables for the creator verification platform.
 *
 * Creator-scoped tables (require authUserId — Better Auth user ID):
 * - creator_profiles, bindings, verification_sessions, entitlements, guild_links,
 *   role_rules, unity_installations, runtime_assertions, outbox_jobs, audit_events
 *
 * Platform-level tables (no authUserId):
 * - subjects, external_accounts, provider_customers, catalog_product_links, webhook_events
 *
 * Mixed-ownership:
 * - product_catalog (has authUserId for owner, but globally queryable for catalog resolution)
 */

import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { CustomerProviderV, ProviderV, VerificationModeV } from './lib/providers';

// ============================================================================
// ENUM-LIKE LITERALS
// ============================================================================

/** Provider types supported by the platform */
const Provider = ProviderV;

/** Subject status values */
const SubjectStatus = v.union(
  v.literal('active'),
  v.literal('suspended'),
  v.literal('quarantined'),
  v.literal('deleted')
);

/** External account status values */
const ExternalAccountStatus = v.union(
  v.literal('active'),
  v.literal('disconnected'),
  v.literal('revoked')
);

/** Provider customer status values */
const ProviderCustomerStatus = v.union(
  v.literal('active'),
  v.literal('inactive'),
  v.literal('disputed')
);

/** Product catalog status values */
const ProductCatalogStatus = v.union(
  v.literal('active'),
  v.literal('deprecated'),
  v.literal('hidden')
);

/** Catalog product link kinds */
const LinkKind = v.union(
  v.literal('storefront'),
  v.literal('direct_product'),
  v.literal('checkout'),
  v.literal('mirror'),
  v.literal('documentation')
);

/** Catalog product link status */
const CatalogLinkStatus = v.union(
  v.literal('active'),
  v.literal('deprecated'),
  v.literal('redirected')
);

/** Binding types */
const BindingType = v.union(
  v.literal('ownership'),
  v.literal('verification'),
  v.literal('manual_override')
);

/** Binding status values */
const BindingStatus = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('revoked'),
  v.literal('transferred'),
  v.literal('quarantined')
);

/** Verification session modes */
const VerificationMode = VerificationModeV;

/** Verification session status */
const VerificationSessionStatus = v.union(
  v.literal('pending'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('expired'),
  v.literal('cancelled')
);

/** Entitlement status values */
const EntitlementStatus = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('expired'),
  v.literal('refunded'),
  v.literal('disputed')
);

/** Guild link status */
const GuildLinkStatus = v.union(
  v.literal('active'),
  v.literal('uninstalled'),
  v.literal('suspended')
);

/** Unity installation status */
const UnityInstallationStatus = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('quarantined')
);

/** Runtime assertion status */
const RuntimeAssertionStatus = v.union(
  v.literal('valid'),
  v.literal('expired'),
  v.literal('revoked')
);

/** Download route role logic */
const DownloadRoleLogic = v.union(v.literal('all'), v.literal('any'));

/** Download artifact status */
const DownloadArtifactStatus = v.union(
  v.literal('active'),
  v.literal('deleted'),
  v.literal('failed')
);

const DownloadArtifactSourceMode = v.union(v.literal('reply'), v.literal('webhook'));

/** Outbox job status */
const OutboxJobStatus = v.union(
  v.literal('pending'),
  v.literal('in_progress'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('dead_letter')
);

/** Outbox job types */
const OutboxJobType = v.union(
  v.literal('role_sync'),
  v.literal('role_removal'),
  v.literal('entitlement_refresh'),
  v.literal('revocation'),
  v.literal('notification'),
  v.literal('creator_alert'),
  v.literal('retroactive_rule_sync')
);

/** Webhook event status */
const WebhookEventStatus = v.union(
  v.literal('pending'),
  v.literal('processed'),
  v.literal('failed'),
  v.literal('duplicate')
);

const ProviderConnectionStatus = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('degraded'),
  v.literal('disconnected'),
  v.literal('error')
);

const ProviderCredentialKind = v.union(
  v.literal('api_key'),
  v.literal('api_token'),
  v.literal('oauth_access_token'),
  v.literal('oauth_refresh_token'),
  v.literal('webhook_secret'),
  v.literal('remote_webhook'),
  v.literal('store_selector')
);

const ProviderCredentialStatus = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('expired'),
  v.literal('invalid'),
  v.literal('rotated'),
  v.literal('revoked')
);

const ProviderCapabilityStatus = v.union(
  v.literal('pending'),
  v.literal('available'),
  v.literal('configured'),
  v.literal('active'),
  v.literal('degraded'),
  v.literal('unsupported')
);

const ProviderTransactionStatus = v.union(
  v.literal('pending'),
  v.literal('paid'),
  v.literal('refunded'),
  v.literal('partial_refund'),
  v.literal('disputed'),
  v.literal('failed'),
  v.literal('cancelled')
);

const ProviderMembershipStatus = v.union(
  v.literal('trialing'),
  v.literal('active'),
  v.literal('paused'),
  v.literal('past_due'),
  v.literal('cancelled'),
  v.literal('expired')
);

const ProviderLicenseStatus = v.union(
  v.literal('active'),
  v.literal('inactive'),
  v.literal('expired'),
  v.literal('revoked'),
  v.literal('disabled')
);

const EntitlementEvidenceStatus = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('revoked'),
  v.literal('superseded')
);

/** Purchase fact lifecycle status */
const PurchaseFactLifecycleStatus = v.union(
  v.literal('active'),
  v.literal('refunded'),
  v.literal('cancelled'),
  v.literal('disputed')
);

/** Audit event types */
const AuditEventType = v.union(
  v.literal('verification.session.created'),
  v.literal('verification.session.completed'),
  v.literal('verification.provider.completed'),
  v.literal('binding.created'),
  v.literal('binding.activated'),
  v.literal('binding.revoked'),
  v.literal('binding.transferred'),
  v.literal('entitlement.granted'),
  v.literal('entitlement.revoked'),
  v.literal('discord.role.sync.requested'),
  v.literal('discord.role.sync.completed'),
  v.literal('discord.role.removal.completed'),
  v.literal('unity.assertion.issued'),
  v.literal('unity.assertion.revoked'),
  v.literal('secret.accessed'),
  v.literal('creator.policy.updated'),
  v.literal('tenant.created'),
  v.literal('tenant.updated'),
  v.literal('guild.linked'),
  v.literal('guild.unlinked'),
  v.literal('subject.status.updated'),
  v.literal('subject.suspicious.marked'),
  v.literal('subject.suspicious.cleared'),
  v.literal('public.api_key.created'),
  v.literal('public.api_key.revoked'),
  v.literal('collaborator.invite.created'),
  v.literal('collaborator.invite.accepted'),
  v.literal('collaborator.invite.revoked'),
  v.literal('collaborator.connection.added'),
  v.literal('collaborator.connection.removed')
);

// ============================================================================
// TENANT-SCOPED TABLES
// ============================================================================

/**
 * Creator Profiles - Creator identity and settings
 * Root owner of all creator-scoped data. Keyed by Better Auth user ID.
 */
const creator_profiles = defineTable({
  // Better Auth user ID — primary identity (unique per creator)
  authUserId: v.string(),
  // Human-readable name for the creator
  name: v.string(),
  // Discord user ID of the creator
  ownerDiscordUserId: v.string(),
  // Optional slug for URL-friendly identification
  slug: v.optional(v.string()),
  // Creator status
  status: SubjectStatus,
  // Policy configuration snapshot
  policy: v.optional(
    v.object({
      maxBindingsPerProduct: v.optional(v.number()),
      allowTransfer: v.optional(v.boolean()),
      transferCooldownHours: v.optional(v.number()),
      allowSharedUse: v.optional(v.boolean()),
      maxUnityInstallations: v.optional(v.number()),
      autoVerifyOnJoin: v.optional(v.boolean()),
      revocationBehavior: v.optional(v.string()),
      gracePeriodHours: v.optional(v.number()),
      requireFullProductLinkSetOnSetup: v.optional(v.boolean()),
      allowCatalogLinkResolution: v.optional(v.boolean()),
      manualReviewRequired: v.optional(v.boolean()),
      discordRoleFreshnessMinutes: v.optional(v.number()),
      allowCatalogBackedVerification: v.optional(v.boolean()),
      autoDiscoverSupportedProductsForRememberedPurchaser: v.optional(v.boolean()),
      // Discord slash commands onboarding config
      logChannelId: v.optional(v.string()),
      verificationScope: v.optional(v.union(v.literal('account'), v.literal('license'))),
      shareVerificationWithServers: v.optional(v.boolean()),
      shareVerificationScope: v.optional(v.string()),
      duplicateVerificationBehavior: v.optional(
        v.union(v.literal('block'), v.literal('notify'), v.literal('allow'))
      ),
      duplicateVerificationNotifyChannelId: v.optional(v.string()),
      suspiciousAccountBehavior: v.optional(
        v.union(v.literal('quarantine'), v.literal('notify'), v.literal('revoke'))
      ),
      suspiciousNotifyChannelId: v.optional(v.string()),
      announcementsChannelId: v.optional(v.string()),
      enableDiscordRoleFromOtherServers: v.optional(v.boolean()),
      allowedSourceGuildIds: v.optional(v.array(v.string())),
      allowMismatchedEmails: v.optional(v.boolean()),
    })
  ),
  // Metadata
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_discord_user', ['ownerDiscordUserId'])
  .index('by_slug', ['slug'])
  .index('by_status', ['status']);

/**
 * Bindings - Relationship between a subject and an external account
 * Links a YUCP subject to their provider identity within a creator context.
 */
const bindings = defineTable({
  // Creator scope (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  // The subject being bound
  subjectId: v.id('subjects'),
  // The external account being bound
  externalAccountId: v.id('external_accounts'),
  // Type of binding
  bindingType: BindingType,
  // Current status
  status: BindingStatus,
  // Who created this binding
  createdBy: v.optional(v.id('subjects')),
  // Reason for binding (especially for manual overrides)
  reason: v.optional(v.string()),
  // Version for optimistic concurrency
  version: v.number(),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_subject', ['authUserId', 'subjectId'])
  .index('by_auth_user_external', ['authUserId', 'externalAccountId'])
  .index('by_subject', ['subjectId'])
  .index('by_external_account', ['externalAccountId'])
  .index('by_auth_user_status', ['authUserId', 'status']);

/**
 * Verification Sessions - Short-lived flow state for OAuth and verification UX
 * Tracks the state of ongoing verification attempts.
 */
const verification_sessions = defineTable({
  // Creator scope (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  // Subject (null until OAuth callback completes)
  subjectId: v.optional(v.id('subjects')),
  // Verification mode being used
  mode: VerificationMode,
  // Generic provider identity for capability-driven flows
  providerKey: v.optional(Provider),
  // Canonical verification method for capability-driven flows
  verificationMethod: v.optional(VerificationMode),
  // Product being verified (if applicable)
  productId: v.optional(v.id('product_catalog')),
  // OAuth state parameter
  state: v.string(),
  // PKCE verifier hash for security
  pkceVerifierHash: v.optional(v.string()),
  // Redirect URI for the flow (OAuth callback)
  redirectUri: v.string(),
  // Where to send user after verification completes
  successRedirectUri: v.optional(v.string()),
  // Discord user ID when verification started from Discord (for Gumroad→Discord link)
  discordUserId: v.optional(v.string()),
  // Nonce for Unity integration
  nonce: v.optional(v.string()),
  // Installation hint from Unity
  installationHint: v.optional(v.string()),
  // Session expiration
  expiresAt: v.number(),
  // Current status
  status: VerificationSessionStatus,
  // Error message if failed
  errorMessage: v.optional(v.string()),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_state', ['authUserId', 'state'])
  .index('by_subject', ['subjectId'])
  .index('by_status_expires', ['status', 'expiresAt'])
  .index('by_nonce', ['nonce']);

/**
 * Entitlements - Creator-approved rights derived from provider evidence
 * Represents what a subject is entitled to within a creator context.
 */
const entitlements = defineTable({
  // Creator scope (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  // Subject who holds the entitlement
  subjectId: v.id('subjects'),
  // Product reference (local product ID)
  productId: v.string(),
  // Provider that granted this entitlement
  sourceProvider: Provider,
  // Reference to the source evidence
  sourceReference: v.string(),
  // Optional link to provider customer memory
  providerCustomerId: v.optional(v.id('provider_customers')),
  // Optional link to catalog product
  catalogProductId: v.optional(v.id('product_catalog')),
  // Current status
  status: EntitlementStatus,
  // Policy version at time of grant
  policySnapshotVersion: v.optional(v.number()),
  // Timestamps
  grantedAt: v.number(),
  revokedAt: v.optional(v.number()),
  updatedAt: v.number(),
  // Computed from policy: grantedAt + gracePeriodHours; used for expiration checks
  expiresAt: v.optional(v.number()),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_subject', ['authUserId', 'subjectId'])
  .index('by_auth_user_product', ['authUserId', 'productId'])
  .index('by_subject', ['subjectId'])
  .index('by_provider_customer', ['providerCustomerId'])
  .index('by_catalog_product', ['catalogProductId'])
  .index('by_auth_user_status', ['authUserId', 'status']);

/**
 * Guild Links - Per-creator guild configuration and bot install state
 * Links a creator to a Discord guild.
 */
const guild_links = defineTable({
  // Creator scope (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy fields from tenant-first architecture
  tenantId: v.optional(v.any()),
  installedByTenantId: v.optional(v.any()),
  // Discord guild ID
  discordGuildId: v.string(),
  // Human-readable guild name (optional, populated when bot installs)
  discordGuildName: v.optional(v.string()),
  // Discord guild icon hash (optional, for CDN URL)
  discordGuildIcon: v.optional(v.string()),
  // Who installed the bot
  installedByAuthUserId: v.string(),
  // Whether the bot is present in the guild
  botPresent: v.boolean(),
  // Command scope state for slash commands
  commandScopeState: v.optional(
    v.object({
      registered: v.boolean(),
      registeredAt: v.optional(v.number()),
    })
  ),
  // Current status
  status: GuildLinkStatus,
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_discord_guild', ['discordGuildId'])
  .index('by_status', ['status']);

/**
 * Role Rules - Desired role outcomes based on entitlements and policy
 * Maps products to Discord roles within a guild.
 */
const role_rules = defineTable({
  // Creator scope (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  // Discord guild ID (denormalized for queries)
  guildId: v.string(),
  // Reference to guild link
  guildLinkId: v.id('guild_links'),
  // Product this rule applies to
  productId: v.string(),
  // Optional catalog product reference
  catalogProductId: v.optional(v.id('product_catalog')),
  // Discord role ID to assign (backward compat; use verifiedRoleIds when multiple)
  verifiedRoleId: v.string(),
  // Multiple Discord role IDs to assign when verified
  verifiedRoleIds: v.optional(v.array(v.string())),
  // Whether to remove the role on entitlement revoke
  removeOnRevoke: v.boolean(),
  // Priority for multiple role rules
  priority: v.number(),
  // Whether this rule is enabled
  enabled: v.boolean(),
  // Discord cross-server: upstream guild to check membership
  sourceGuildId: v.optional(v.string()),
  // Discord cross-server: role ID user must have in source guild (backward compat)
  requiredRoleId: v.optional(v.string()),
  // Discord cross-server: multiple role IDs user must have in source guild
  requiredRoleIds: v.optional(v.array(v.string())),
  // Match mode for requiredRoleIds: 'any' = at least one, 'all' = every role
  requiredRoleMatchMode: v.optional(v.union(v.literal('any'), v.literal('all'))),
  // Human-readable name for discord_role products — set at add time, avoids repeated Discord API calls
  displayName: v.optional(v.string()),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_guild', ['authUserId', 'guildId'])
  .index('by_guild_link', ['guildLinkId'])
  .index('by_product', ['productId'])
  .index('by_catalog_product', ['catalogProductId'])
  .index('by_source_guild', ['sourceGuildId']);

/**
 * Download Routes - Per-guild capture/archive rules for Liened Downloads.
 * Routes qualifying attachments from source locations into private archive locations.
 */
const download_routes = defineTable({
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  guildId: v.string(),
  guildLinkId: v.id('guild_links'),
  sourceChannelId: v.string(),
  archiveChannelId: v.string(),
  messageTitle: v.string(),
  messageBody: v.string(),
  requiredRoleIds: v.array(v.string()),
  roleLogic: DownloadRoleLogic,
  allowedExtensions: v.array(v.string()),
  enabled: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_guild', ['authUserId', 'guildId'])
  .index('by_guild_source_channel', ['guildId', 'sourceChannelId'])
  .index('by_guild_archive_channel', ['guildId', 'archiveChannelId'])
  .index('by_guild_link', ['guildLinkId']);

/**
 * Download Artifacts - Archived mirrored files plus gating metadata.
 * One record per archived download post / file set.
 */
const download_artifacts = defineTable({
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  guildId: v.string(),
  routeId: v.id('download_routes'),
  sourceChannelId: v.string(),
  sourceMessageId: v.string(),
  sourceMessageUrl: v.string(),
  sourceAuthorId: v.string(),
  archiveChannelId: v.string(),
  archiveMessageId: v.string(),
  archiveThreadId: v.optional(v.string()),
  sourceRelayMessageId: v.optional(v.string()),
  sourceDeliveryMode: v.optional(DownloadArtifactSourceMode),
  requiredRoleIds: v.array(v.string()),
  roleLogic: DownloadRoleLogic,
  files: v.array(
    v.object({
      filename: v.string(),
      url: v.string(),
      size: v.optional(v.number()),
      contentType: v.optional(v.string()),
      extension: v.string(),
    })
  ),
  status: DownloadArtifactStatus,
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_guild', ['authUserId', 'guildId'])
  .index('by_route', ['routeId'])
  .index('by_source_message', ['sourceMessageId'])
  .index('by_archive_message', ['archiveMessageId'])
  .index('by_status', ['status']);

/**
 * Unity Installations - Signals for Unity runtime usage
 * Tracks Unity client installations for device binding.
 */
const unity_installations = defineTable({
  // Creator scope (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  subjectId: v.id('subjects'),
  // Hashed device fingerprint
  deviceFingerprintHash: v.string(),
  // First time this installation was seen
  firstSeenAt: v.number(),
  // Most recent activity
  lastSeenAt: v.number(),
  // Current status
  status: UnityInstallationStatus,
  // Risk flags for fraud detection
  riskFlags: v.optional(
    v.array(
      v.union(
        v.literal('unusual_frequency'),
        v.literal('geo_mismatch'),
        v.literal('fingerprint_change'),
        v.literal('multiple_subjects')
      )
    )
  ),
  // App version at last check-in
  appVersion: v.optional(v.string()),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_subject', ['authUserId', 'subjectId'])
  .index('by_subject', ['subjectId'])
  .index('by_fingerprint', ['deviceFingerprintHash'])
  .index('by_auth_user_status', ['authUserId', 'status']);

/**
 * Runtime Assertions - Issued Unity assertions for audit and replay tracking
 * Tracks JWT assertions issued to Unity clients.
 */
const runtime_assertions = defineTable({
  // JWT ID (unique identifier)
  jti: v.string(),
  // Creator scope (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  subjectId: v.id('subjects'),
  // Installation this assertion is bound to
  installationId: v.optional(v.id('unity_installations')),
  // Intended audience
  audience: v.string(),
  // Product(s) covered by this assertion
  productIds: v.array(v.string()),
  // Key ID used to sign
  kid: v.optional(v.string()),
  // When issued
  issuedAt: v.number(),
  // When it expires
  expiresAt: v.number(),
  // Current status
  status: RuntimeAssertionStatus,
  // Reason for revocation if applicable
  revocationReason: v.optional(v.string()),
})
  .index('by_jti', ['jti'])
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_subject', ['authUserId', 'subjectId'])
  .index('by_subject', ['subjectId'])
  .index('by_installation', ['installationId'])
  .index('by_status_expires', ['status', 'expiresAt']);

/**
 * Outbox Jobs - Guaranteed side-effect queue
 * Ensures reliable delivery of role sync, notifications, etc.
 */
const outbox_jobs = defineTable({
  // Creator scope (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  jobType: OutboxJobType,
  // Job payload
  payload: v.any(),
  // Current status
  status: OutboxJobStatus,
  // Idempotency key for deduplication
  idempotencyKey: v.string(),
  // Target Discord guild (if applicable)
  targetGuildId: v.optional(v.string()),
  // Target Discord user (if applicable)
  targetDiscordUserId: v.optional(v.string()),
  // Number of retry attempts
  retryCount: v.number(),
  // Maximum retries allowed
  maxRetries: v.number(),
  // Next retry time (with jitter)
  nextRetryAt: v.optional(v.number()),
  // Error from last attempt
  lastError: v.optional(v.string()),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_status', ['status'])
  .index('by_status_next_retry', ['status', 'nextRetryAt'])
  .index('by_idempotency', ['idempotencyKey'])
  .index('by_auth_user_type', ['authUserId', 'jobType'])
  .index('by_guild_user', ['targetGuildId', 'targetDiscordUserId']);

/**
 * Audit Events - Security and support trail
 * Records all security-sensitive operations.
 */
const audit_events = defineTable({
  // Creator scope — null for platform-level events
  authUserId: v.optional(v.string()),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  eventType: AuditEventType,
  // Actor who performed the action (subject or system)
  actorType: v.union(v.literal('subject'), v.literal('system'), v.literal('admin')),
  actorId: v.optional(v.string()),
  // Subject affected (if applicable)
  subjectId: v.optional(v.id('subjects')),
  // External account affected (if applicable)
  externalAccountId: v.optional(v.id('external_accounts')),
  // Entitlement affected (if applicable)
  entitlementId: v.optional(v.id('entitlements')),
  // Additional event data
  metadata: v.optional(v.any()),
  // IP address of the actor
  ipAddress: v.optional(v.string()),
  // User agent of the actor
  userAgent: v.optional(v.string()),
  // Correlation ID for tracing
  correlationId: v.optional(v.string()),
  // Timestamp
  createdAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_event_type', ['eventType'])
  .index('by_auth_user_event', ['authUserId', 'eventType'])
  .index('by_subject', ['subjectId'])
  .index('by_actor', ['actorType', 'actorId'])
  .index('by_correlation', ['correlationId'])
  .index('by_created', ['createdAt']);

/**
 * Product Catalog - Global registry of products
 * Has authUserId for the owning creator, but globally queryable.
 */
const product_catalog = defineTable({
  // Creator who owns this product entry (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  productId: v.string(),
  // Provider this product is from
  provider: Provider,
  // Provider's product reference (e.g., Gumroad product ID)
  providerProductRef: v.string(),
  // URL-friendly identifier
  canonicalSlug: v.optional(v.string()),
  // Human-readable name for display (e.g. Jinxxy product name)
  displayName: v.optional(v.string()),
  // Alternative names/identifiers
  aliases: v.optional(v.array(v.string())),
  // Current status
  status: ProductCatalogStatus,
  // Whether this product supports auto-discovery
  supportsAutoDiscovery: v.boolean(),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_provider_ref', ['provider', 'providerProductRef'])
  .index('by_slug', ['canonicalSlug'])
  .index('by_status', ['status']);

/**
 * Purchase Facts - Canonical purchase layer for automatic verification
 * Stores raw purchase data from webhooks; entitlements are projected from these.
 * Uniqueness: (authUserId, provider, externalOrderId, externalLineItemId?) when provider exposes line items.
 */
const purchase_facts = defineTable({
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  provider: Provider,
  externalOrderId: v.string(),
  externalLineItemId: v.optional(v.string()),
  externalLicenseId: v.optional(v.string()),
  buyerEmailHash: v.optional(v.string()),
  // AES-256-GCM encrypted normalized buyer email (HKDF purpose: 'purchase-buyer-email')
  buyerEmailEncrypted: v.optional(v.string()),
  providerUserId: v.optional(v.string()),
  providerProductId: v.string(),
  providerProductVersionId: v.optional(v.string()),
  paymentStatus: v.string(),
  lifecycleStatus: PurchaseFactLifecycleStatus,
  purchasedAt: v.number(),
  updatedAtProvider: v.optional(v.number()),
  rawSourceEventId: v.optional(v.id('webhook_events')),
  subjectId: v.optional(v.id('subjects')),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_provider_order', ['authUserId', 'provider', 'externalOrderId'])
  .index('by_auth_user_product', ['authUserId', 'providerProductId'])
  .index('by_email_hash', ['buyerEmailHash'])
  .index('by_provider_user', ['provider', 'providerUserId'])
  .index('by_subject', ['subjectId']);

/**
 * Provider Connections - Per-creator credentials and webhook config.
 * All credentials are stored in the generic provider_credentials table.
 */
const provider_connections = defineTable({
  // Owner identity — Better Auth user ID of the creator.
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  provider: Provider,
  providerKey: v.optional(Provider),
  // Human-readable label for multi-store support (e.g. "Main Store", "VRChat Assets")
  label: v.optional(v.string()),
  // Whether this is a creator setup connection or verification connection
  connectionType: v.optional(v.union(v.literal('setup'), v.literal('verification'))),
  // Connection status
  status: v.optional(ProviderConnectionStatus),
  authMode: v.optional(v.string()),
  externalShopId: v.optional(v.string()),
  externalShopName: v.optional(v.string()),
  installedBySubjectId: v.optional(v.id('subjects')),
  lastHealthcheckAt: v.optional(v.number()),
  lastSyncAt: v.optional(v.number()),
  webhookConfigured: v.boolean(),
  webhookSecretRef: v.optional(v.string()),
  webhookEndpoint: v.optional(v.string()),
  remoteWebhookId: v.optional(v.string()),
  remoteWebhookSecretRef: v.optional(v.string()),
  webhookRouteToken: v.optional(v.string()),
  testMode: v.optional(v.boolean()),
  metadata: v.optional(v.any()),
  lastSuccessfulBackfillAt: v.optional(v.number()),
  lastSeenOrderId: v.optional(v.string()),
  lastWebhookAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_provider', ['authUserId', 'provider'])
  .index('by_auth_user_provider_key', ['authUserId', 'providerKey'])
  .index('by_auth_user_provider_label', ['authUserId', 'provider', 'label'])
  .index('by_webhook_route_token', ['webhookRouteToken']);

const provider_credentials = defineTable({
  providerConnectionId: v.id('provider_connections'),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  providerKey: Provider,
  credentialKey: v.string(),
  kind: ProviderCredentialKind,
  status: ProviderCredentialStatus,
  encryptedValue: v.optional(v.string()),
  metadata: v.optional(v.any()),
  expiresAt: v.optional(v.number()),
  lastValidatedAt: v.optional(v.number()),
  lastRotatedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_connection', ['providerConnectionId'])
  .index('by_connection_key', ['providerConnectionId', 'credentialKey']);

const provider_connection_capabilities = defineTable({
  providerConnectionId: v.id('provider_connections'),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  providerKey: Provider,
  capabilityKey: v.string(),
  status: ProviderCapabilityStatus,
  requiredCredentialKeys: v.array(v.string()),
  lastCheckedAt: v.optional(v.number()),
  errorCode: v.optional(v.string()),
  errorSummary: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_connection', ['providerConnectionId'])
  .index('by_connection_capability', ['providerConnectionId', 'capabilityKey']);

const provider_catalog_mappings = defineTable({
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  providerConnectionId: v.optional(v.id('provider_connections')),
  providerKey: Provider,
  catalogProductId: v.optional(v.id('product_catalog')),
  localProductId: v.optional(v.string()),
  externalStoreId: v.optional(v.string()),
  externalProductId: v.optional(v.string()),
  externalVariantId: v.optional(v.string()),
  externalPriceId: v.optional(v.string()),
  externalSku: v.optional(v.string()),
  displayName: v.optional(v.string()),
  status: v.union(v.literal('active'), v.literal('archived'), v.literal('error')),
  metadata: v.optional(v.any()),
  lastSyncedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_connection', ['providerConnectionId'])
  .index('by_catalog_product', ['catalogProductId'])
  .index('by_external_variant', ['providerKey', 'externalVariantId'])
  .index('by_auth_user_provider', ['authUserId', 'providerKey']);

const provider_transactions = defineTable({
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  providerConnectionId: v.id('provider_connections'),
  providerKey: Provider,
  externalTransactionId: v.string(),
  externalOrderNumber: v.optional(v.string()),
  externalOrderItemId: v.optional(v.string()),
  externalStoreId: v.optional(v.string()),
  externalProductId: v.optional(v.string()),
  externalVariantId: v.optional(v.string()),
  externalCustomerId: v.optional(v.string()),
  customerEmail: v.optional(v.string()),
  customerEmailHash: v.optional(v.string()),
  currency: v.optional(v.string()),
  amountSubtotal: v.optional(v.number()),
  amountTotal: v.optional(v.number()),
  status: ProviderTransactionStatus,
  purchasedAt: v.optional(v.number()),
  refundedAt: v.optional(v.number()),
  rawWebhookEventId: v.optional(v.id('webhook_events')),
  metadata: v.optional(v.any()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_connection', ['providerConnectionId'])
  .index('by_external_id', ['providerKey', 'externalTransactionId'])
  .index('by_auth_user_provider', ['authUserId', 'providerKey'])
  .index('by_customer_email_hash', ['customerEmailHash']);

const provider_memberships = defineTable({
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  providerConnectionId: v.id('provider_connections'),
  providerKey: Provider,
  externalMembershipId: v.string(),
  externalTransactionId: v.optional(v.string()),
  externalProductId: v.optional(v.string()),
  externalVariantId: v.optional(v.string()),
  externalCustomerId: v.optional(v.string()),
  customerEmail: v.optional(v.string()),
  customerEmailHash: v.optional(v.string()),
  status: ProviderMembershipStatus,
  startedAt: v.optional(v.number()),
  renewsAt: v.optional(v.number()),
  endsAt: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
  rawWebhookEventId: v.optional(v.id('webhook_events')),
  metadata: v.optional(v.any()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_connection', ['providerConnectionId'])
  .index('by_external_id', ['providerKey', 'externalMembershipId'])
  .index('by_auth_user_provider', ['authUserId', 'providerKey']);

const provider_licenses = defineTable({
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  providerConnectionId: v.id('provider_connections'),
  providerKey: Provider,
  externalLicenseId: v.string(),
  externalTransactionId: v.optional(v.string()),
  externalProductId: v.optional(v.string()),
  externalVariantId: v.optional(v.string()),
  externalCustomerId: v.optional(v.string()),
  customerEmail: v.optional(v.string()),
  customerEmailHash: v.optional(v.string()),
  licenseKeyHash: v.optional(v.string()),
  shortKey: v.optional(v.string()),
  status: ProviderLicenseStatus,
  issuedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  lastValidatedAt: v.optional(v.number()),
  revokedAt: v.optional(v.number()),
  rawWebhookEventId: v.optional(v.id('webhook_events')),
  metadata: v.optional(v.any()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_connection', ['providerConnectionId'])
  .index('by_external_id', ['providerKey', 'externalLicenseId'])
  .index('by_license_key_hash', ['licenseKeyHash'])
  .index('by_auth_user_provider', ['authUserId', 'providerKey']);

const entitlement_evidence = defineTable({
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  subjectId: v.optional(v.id('subjects')),
  providerKey: Provider,
  providerConnectionId: v.optional(v.id('provider_connections')),
  transactionId: v.optional(v.id('provider_transactions')),
  membershipId: v.optional(v.id('provider_memberships')),
  licenseId: v.optional(v.id('provider_licenses')),
  sourceReference: v.string(),
  evidenceType: v.string(),
  status: EntitlementEvidenceStatus,
  productId: v.optional(v.string()),
  catalogProductId: v.optional(v.id('product_catalog')),
  rawWebhookEventId: v.optional(v.id('webhook_events')),
  metadata: v.optional(v.any()),
  observedAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user_subject', ['authUserId', 'subjectId'])
  .index('by_source_reference', ['providerKey', 'sourceReference'])
  .index('by_license', ['licenseId'])
  .index('by_transaction', ['transactionId']);

/**
 * Creator OAuth Apps - creator mappings for OAuth clients stored by Better Auth.
 * Better Auth owns the client + secret records; this table maps those clients to creators.
 * clientSecretHash is retained as an optional legacy field for older rows.
 */
const creator_oauth_apps = defineTable({
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  name: v.string(),
  clientId: v.string(),
  clientSecretHash: v.optional(v.string()),
  redirectUris: v.array(v.string()),
  scopes: v.array(v.string()),
  createdByAuthUserId: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_client_id', ['clientId']);

// ============================================================================
// PLATFORM-LEVEL TABLES (no authUserId)
// ============================================================================

/**
 * Subjects - Canonical user identity within YUCP
 * Global identity that spans all tenants.
 */
const subjects = defineTable({
  // Primary Discord user ID
  primaryDiscordUserId: v.string(),
  // Better Auth user ID (linked from auth system, optional for Discord-only subjects)
  authUserId: v.optional(v.string()),
  // Current status
  status: SubjectStatus,
  // Display name (cached from Discord)
  displayName: v.optional(v.string()),
  // Avatar URL (cached from Discord)
  avatarUrl: v.optional(v.string()),
  // Suspicious account flags (piracy, double license, etc.)
  flags: v.optional(
    v.object({
      suspicious: v.optional(v.boolean()),
      reason: v.optional(v.string()),
      flaggedAt: v.optional(v.number()),
      flaggedBy: v.optional(v.string()),
    })
  ),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_discord_user', ['primaryDiscordUserId'])
  .index('by_auth_user', ['authUserId'])
  .index('by_status', ['status']);

/**
 * External Accounts - Normalized provider identity records
 * Global records for provider-specific user identities.
 */
const external_accounts = defineTable({
  // Provider type
  provider: Provider,
  // Provider's user ID
  providerUserId: v.string(),
  // Provider's username (may change)
  providerUsername: v.optional(v.string()),
  // SHA-256 hash of normalized email for matching without storing plaintext
  emailHash: v.optional(v.string()),
  // AES-256-GCM encrypted normalized email (HKDF purpose: 'external-account-email')
  normalizedEmailEncrypted: v.optional(v.string()),
  // Provider-specific metadata — PII fields are encrypted at rest
  providerMetadata: v.optional(
    v.object({
      // AES-256-GCM encrypted email (HKDF purpose: 'external-account-metadata-email')
      emailEncrypted: v.optional(v.string()),
      avatarUrl: v.optional(v.string()),
      profileUrl: v.optional(v.string()),
      // AES-256-GCM encrypted JSON-stringified rawData (HKDF purpose: 'external-account-raw-data')
      rawDataEncrypted: v.optional(v.string()),
    })
  ),
  // Encrypted Discord OAuth2 access token (for proactive guild member checks)
  discordAccessTokenEncrypted: v.optional(v.string()),
  // Token expiry timestamp (Discord tokens expire after ~7 days)
  discordTokenExpiresAt: v.optional(v.number()),
  // Encrypted refresh token for silent renewal
  discordRefreshTokenEncrypted: v.optional(v.string()),
  // When this account was last validated
  lastValidatedAt: v.optional(v.number()),
  // Current status
  status: ExternalAccountStatus,
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_provider_user', ['provider', 'providerUserId'])
  .index('by_provider', ['provider'])
  .index('by_status', ['status'])
  .index('by_email_hash', ['emailHash']);

/**
 * Provider Customers - Platform-level purchaser memory
 * Remembers verified purchaser identity for faster future verifications.
 * NO authUserId - this is platform-level data.
 */
const provider_customers = defineTable({
  // Provider type
  provider: CustomerProviderV,
  // Provider's customer/user ID (nullable if not available)
  providerUserId: v.optional(v.string()),
  // Hashed normalized email for matching
  normalizedEmailHash: v.optional(v.string()),
  // Hashed normalized username for matching
  normalizedUsernameHash: v.optional(v.string()),
  // Privacy-safe display hints
  displayHints: v.optional(
    v.object({
      emailPrefix: v.optional(v.string()),
      usernamePrefix: v.optional(v.string()),
    })
  ),
  // Current status
  status: ProviderCustomerStatus,
  // When this customer was last observed
  lastObservedAt: v.number(),
  // Confidence level of the identity match
  confidence: v.union(v.literal('high'), v.literal('medium'), v.literal('low')),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_provider_user', ['provider', 'providerUserId'])
  .index('by_email_hash', ['normalizedEmailHash'])
  .index('by_username_hash', ['normalizedUsernameHash'])
  .index('by_status', ['status']);

/**
 * Catalog Product Links - Normalized sale links for product resolution
 * Allows later creators to resolve products by pasting a known link.
 * NO authUserId - links are global, but reference the submitting creator.
 */
const catalog_product_links = defineTable({
  // The catalog product this link belongs to
  catalogProductId: v.id('product_catalog'),
  // Provider this link is for
  provider: Provider,
  // Original URL as submitted
  originalUrl: v.string(),
  // Normalized URL for matching
  normalizedUrl: v.string(),
  // Hash of normalized URL for exact matching
  urlHash: v.string(),
  // Type of link
  linkKind: LinkKind,
  // Current status
  status: CatalogLinkStatus,
  // Creator who submitted this link (Better Auth user ID)
  submittedByAuthUserId: v.optional(v.string()),
  // @deprecated Legacy field from tenant-first architecture
  submittedByTenantId: v.optional(v.any()),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_catalog_product', ['catalogProductId'])
  .index('by_url_hash', ['urlHash'])
  .index('by_provider', ['provider'])
  .index('by_status', ['status']);

/**
 * Webhook Events - Raw inbound webhooks and dedupe state
 * Platform-level ingestion of provider webhooks.
 */
const webhook_events = defineTable({
  // Provider that sent the webhook
  provider: Provider,
  providerKey: v.optional(Provider),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  providerConnectionId: v.optional(v.id('provider_connections')),
  // Provider's event ID for deduplication
  providerEventId: v.string(),
  // Event type from provider
  eventType: v.string(),
  // Raw payload (stored for replay/debugging)
  rawPayload: v.any(),
  // Signature verification status: true if the event's body-bound signature (HMAC) was verified.
  // Note: Gumroad Ping has no body signature; its authenticity comes from the private
  // webhookRouteToken. Use `verificationMethod` to distinguish security models.
  signatureValid: v.boolean(),
  // How the event was authenticated:
  //   'hmac'        – body-bound HMAC verified (Jinxxy, LemonSqueezy)
  //   'static-key'  – static key hash checked (Payhip: SHA256(apiKey), not body-bound)
  //   'route-token' – authenticated by a private random URL token (Gumroad Ping)
  // When absent, falls back to the legacy `signatureValid` boolean alone.
  verificationMethod: v.optional(
    v.union(v.literal('hmac'), v.literal('static-key'), v.literal('route-token'))
  ),
  // Processing status
  status: WebhookEventStatus,
  // Error message if processing failed
  errorMessage: v.optional(v.string()),
  // Related creator user ID. Resolved from route; falls back to routeId for unknown connections.
  authUserId: v.string(),
  // Related subject (if determined from payload)
  subjectId: v.optional(v.id('subjects')),
  // Related entitlement (if determined from payload)
  entitlementId: v.optional(v.id('entitlements')),
  canonicalEventType: v.optional(v.string()),
  // Timestamps
  receivedAt: v.number(),
  processedAt: v.optional(v.number()),
})
  .index('by_provider_event', ['provider', 'providerEventId'])
  .index('by_provider', ['provider'])
  .index('by_status', ['status'])
  .index('by_auth_user', ['authUserId'])
  .index('by_connection_event', ['providerConnectionId', 'providerEventId'])
  .index('by_auth_user_provider_event', ['authUserId', 'provider', 'providerEventId'])
  .index('by_received', ['receivedAt']);

/**
 * Manual License Status
 */
const ManualLicenseStatus = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('expired'),
  v.literal('exhausted')
);

/**
 * Manual Licenses - Creator-generated license keys for products
 * Stores hashed license keys for secure validation.
 */
const manual_licenses = defineTable({
  // Creator scope (Better Auth user ID)
  authUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  tenantId: v.optional(v.any()),
  licenseKeyHash: v.string(),
  // Product this license is for
  productId: v.string(),
  // Optional catalog product reference
  catalogProductId: v.optional(v.id('product_catalog')),
  // Maximum number of uses (null = unlimited)
  maxUses: v.optional(v.number()),
  // Current usage count
  currentUses: v.number(),
  // Current status
  status: ManualLicenseStatus,
  // Optional expiration timestamp
  expiresAt: v.optional(v.number()),
  // Optional notes from creator
  notes: v.optional(v.string()),
  // Optional buyer email for record keeping
  buyerEmail: v.optional(v.string()),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_product', ['authUserId', 'productId'])
  .index('by_license_key_hash', ['licenseKeyHash'])
  .index('by_auth_user_status', ['authUserId', 'status'])
  .index('by_expires', ['expiresAt']);

/**
 * Collaborator Invites - Single-use invite tokens for cross-creator API key sharing
 * Allows a server owner to invite another creator to share Jinxxy credentials.
 */
const collaborator_invites = defineTable({
  ownerAuthUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  ownerTenantId: v.optional(v.any()),
  tokenHash: v.string(),
  status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('revoked')),
  /** Guild name shown to collaborator on consent page */
  ownerDisplayName: v.string(),
  ownerGuildId: v.optional(v.string()),
  /** Discord ID of the user who accepted (set at accept time via OAuth, not at creation) */
  targetDiscordUserId: v.optional(v.string()),
  /** Discord display name of the user who accepted */
  targetDiscordDisplayName: v.optional(v.string()),
  expiresAt: v.number(),
  createdAt: v.number(),
  usedAt: v.optional(v.number()),
  /** Commerce provider for this invite (e.g. 'jinxxy', 'lemonsqueezy'). Defaults to 'jinxxy' for legacy records. */
  providerKey: v.optional(v.string()),
})
  .index('by_token_hash', ['tokenHash'])
  .index('by_owner', ['ownerAuthUserId'])
  .index('by_owner_status', ['ownerAuthUserId', 'status'])
  .index('by_target_discord_user', ['targetDiscordUserId']);

/**
 * Collaborator Connections - Active collaborator API key sharing relationships
 * Created when a collaborator accepts an invite or is manually added.
 */
const collaborator_connections = defineTable({
  ownerAuthUserId: v.string(),
  // @deprecated Legacy field from tenant-first architecture
  ownerTenantId: v.optional(v.any()),
  inviteId: v.optional(v.id('collaborator_invites')),
  /** Commerce provider for this connection (e.g. 'jinxxy', 'lemonsqueezy') */
  provider: v.string(),
  /** Generic encrypted credential (API key) for all providers */
  credentialEncrypted: v.optional(v.string()),
  /** Encrypted webhook signing secret; null for api-type connections */
  webhookSecretRef: v.optional(v.string()),
  /** null for api-type connections */
  webhookEndpoint: v.optional(v.string()),
  webhookConfigured: v.boolean(),
  linkType: v.union(v.literal('account'), v.literal('api')),
  status: v.union(v.literal('active'), v.literal('paused'), v.literal('disconnected')),
  /** Discord user ID for invite flow; manual:{provider_user_id} for manual adds */
  collaboratorDiscordUserId: v.string(),
  collaboratorDisplayName: v.string(),
  /** Discord avatar hash (e.g. "a_abc123…" for animated, plain hex for static). Server-validated. */
  collaboratorAvatarHash: v.optional(v.string()),
  /** 'invite' when created via invite link; 'manual' when added by admin. Optional for backward compat. */
  source: v.optional(v.union(v.literal('invite'), v.literal('manual'))),
  /** Discord user ID of admin who ran the manual add (audit) */
  addedByDiscordUserId: v.optional(v.string()),
  createdAt: v.number(),
})
  .index('by_owner', ['ownerAuthUserId'])
  .index('by_invite', ['inviteId'])
  .index('by_owner_status', ['ownerAuthUserId', 'status'])
  .index('by_owner_provider', ['ownerAuthUserId', 'provider'])
  .index('by_collaborator_discord', ['collaboratorDiscordUserId']);

/**
 * Admin Notifications - Short-lived real-time dashboard toasts
 * Created by the Discord bot to surface events to the creator dashboard.
 * Auto-expires after 60 seconds; cleaned up by cron.
 */
const admin_notifications = defineTable({
  /** Creator scope (Better Auth user ID) */
  authUserId: v.string(),
  /** Discord guild where the event happened */
  guildId: v.string(),
  /** Toast type — maps directly to useToast() variants */
  type: v.union(
    v.literal('success'),
    v.literal('error'),
    v.literal('warning'),
    v.literal('info')
  ),
  /** Short headline */
  title: v.string(),
  /** Optional body text */
  message: v.optional(v.string()),
  /** Unix ms when this notification should be considered expired */
  expiresAt: v.number(),
  /** Unix ms when the dashboard marked this seen (null = unseen) */
  seenAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_unseen', ['authUserId', 'seenAt'])
  .index('by_expires', ['expiresAt']);

// ============================================================================
// SCHEMA EXPORT
// ============================================================================

// ============================================================================
// YUCP CERTIFICATE AUTHORITY TABLES
// ============================================================================

const YucpCertStatus = v.union(v.literal('active'), v.literal('revoked'), v.literal('expired'));

/** Issued YUCP publisher certificates (schemaVersion 2+, identity-anchored) */
const yucp_certificates = defineTable({
  /** Stable publisher UUID; reused across key rotations */
  publisherId: v.string(),
  publisherName: v.string(),
  /** Better Auth user ID of the cert owner (stable across provider reconnects) */
  yucpUserId: v.string(),
  /** Discord user ID linked at time of issuance */
  discordUserId: v.optional(v.string()),
  /** Base64-encoded Ed25519 public key (developer's signing key) */
  devPublicKey: v.string(),
  /** Unique per-cert random UUID (nonce) */
  certNonce: v.string(),
  /** Full JSON-serialised { cert, signature } envelope ready for distribution */
  certData: v.string(),
  schemaVersion: v.number(),
  /** Unix ms */
  issuedAt: v.number(),
  /** Unix ms */
  expiresAt: v.number(),
  status: YucpCertStatus,
  revocationReason: v.optional(v.string()),
  revokedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_publisher_id', ['publisherId'])
  .index('by_yucp_user_id', ['yucpUserId'])
  .index('by_dev_public_key', ['devPublicKey'])
  .index('by_cert_nonce', ['certNonce'])
  .index('by_status', ['status']);

/**
 * Package Name Registry, Layer 1 defense.
 * First publisher to sign a packageId owns the namespace.
 * Subsequent signers with a different yucpUserId are rejected.
 */
const package_registry = defineTable({
  /** Unique package namespace identifier (e.g. "com.yucp.mypackage") */
  packageId: v.string(),
  /** Publisher who registered the name first */
  publisherId: v.string(),
  /** Better Auth user ID of the registering creator */
  yucpUserId: v.string(),
  /** Unix ms */
  registeredAt: v.number(),
  /** Populated only on admin-approved ownership transfers */
  transferredFromYucpUserId: v.optional(v.string()),
  transferReason: v.optional(v.string()),
  updatedAt: v.number(),
})
  .index('by_package_id', ['packageId'])
  .index('by_yucp_user_id', ['yucpUserId'])
  .index('by_publisher_id', ['publisherId']);

/**
 * Signing Log, Layer 2 defense.
 * Append-only transparency log: content hash + identity, one entry per (hash, packageId) pair.
 * Same hash signed by a different identity triggers a conflict flag.
 */
const signing_log = defineTable({
  /** archiveSha256 from the Unity PackageManifest */
  contentHash: v.string(),
  packageId: v.string(),
  publisherId: v.string(),
  /** Better Auth user ID of the signer */
  yucpUserId: v.string(),
  certNonce: v.string(),
  packageVersion: v.optional(v.string()),
  /** Unix ms */
  signedAt: v.number(),
  /** Set when the same contentHash was submitted by a different yucpUserId */
  conflictDetected: v.boolean(),
  conflictDetail: v.optional(v.string()),
})
  .index('by_content_hash', ['contentHash'])
  .index('by_package_id', ['packageId'])
  .index('by_yucp_user_id', ['yucpUserId'])
  .index('by_content_and_package', ['contentHash', 'packageId']);

/**
 * Rate-limiting log for certificate issuance.
 * Enforces: 1 certificate per YUCP account per 30 days.
 */
const cert_issuance_log = defineTable({
  /** Better Auth user ID of the cert requester */
  yucpUserId: v.string(),
  /** Unix ms */
  issuedAt: v.number(),
  publisherId: v.string(),
  devPublicKey: v.string(),
})
  .index('by_yucp_user_id', ['yucpUserId'])
  .index('by_issued_at', ['issuedAt']);

/**
 * HTTP rate limit counters for unauthenticated public endpoints.
 * Tracks request counts by (key, windowStart) where key is e.g. "ip:<addr>" or
 * "fingerprint:<hash>". Each window is a fixed-size time bucket (60 s default).
 * Old buckets are cleaned up lazily when a new request comes in.
 */
const http_rate_limits = defineTable({
  /** Opaque rate-limit key: "fingerprint:<hex>" or "ip:<addr>" */
  key: v.string(),
  /** Start of the time window (Unix ms, floored to windowSize) */
  windowStart: v.number(),
  /** Number of requests recorded in this window */
  count: v.number(),
})
  .index('by_key_window', ['key', 'windowStart'])
  .index('by_window_start', ['windowStart']);

/**
 * Short-lived session store for the RFC 8252 loopback OAuth proxy.
 * Maps an OAuth `state` parameter to the original loopback redirect_uri
 * so the callback can forward the code back to the Unity editor process.
 */
const oauth_loopback_sessions = defineTable({
  /** The `state` parameter sent by the Unity client, used as the lookup key */
  oauthState: v.string(),
  /** The original loopback redirect_uri (e.g. http://127.0.0.1:PORT/callback) */
  originalRedirectUri: v.string(),
  /** Unix ms, records when the session was created so TTL can be enforced */
  createdAt: v.number(),
})
  .index('by_oauth_state', ['oauthState'])
  .index('by_created_at', ['createdAt']);

/**
 * Used YUCP JWT nonces — tracks consumed nonces for replay prevention.
 */
const used_nonces = defineTable({
  /** The JWT nonce (jti claim) that was consumed */
  nonce: v.string(),
  /** Creator (authUserId) that consumed the nonce */
  authUserId: v.string(),
  /** When the nonce was consumed (Unix ms) */
  usedAt: v.number(),
}).index('by_nonce', ['nonce']);

// ============================================================================
// PUBLIC API V2 TABLES
// ============================================================================

const WebhookSubscriptionStatus = v.union(
  v.literal('active'),
  v.literal('disabled'),
  v.literal('error')
);

const WebhookDeliveryStatus = v.union(
  v.literal('pending'),
  v.literal('in_progress'),
  v.literal('delivered'),
  v.literal('failed'),
  v.literal('dead_letter')
);

/**
 * Creator Events — platform-emitted events for outbound webhook delivery
 * and the GET /events API endpoint.
 */
const creator_events = defineTable({
  authUserId: v.string(),
  eventType: v.string(),
  resourceType: v.string(),
  resourceId: v.string(),
  data: v.any(),
  createdAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_type', ['authUserId', 'eventType'])
  .index('by_auth_user_resource', ['authUserId', 'resourceId'])
  .index('by_created', ['createdAt']);

/**
 * Webhook Subscriptions — outbound delivery endpoint registrations.
 * Signing secrets are encrypted at rest with HKDF-AES-256-GCM.
 */
const webhook_subscriptions = defineTable({
  authUserId: v.string(),
  url: v.string(),
  events: v.array(v.string()),
  enabled: v.boolean(),
  description: v.optional(v.string()),
  signingSecretEnc: v.string(),
  signingSecretPrefix: v.string(),
  status: WebhookSubscriptionStatus,
  lastDeliveryAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_auth_user_enabled', ['authUserId', 'enabled']);

/**
 * Webhook Deliveries — per-event delivery attempt tracking with retry state.
 */
const webhook_deliveries = defineTable({
  authUserId: v.string(),
  subscriptionId: v.id('webhook_subscriptions'),
  eventId: v.id('creator_events'),
  status: WebhookDeliveryStatus,
  attemptCount: v.number(),
  maxAttempts: v.number(),
  nextRetryAt: v.optional(v.number()),
  lastHttpStatus: v.optional(v.number()),
  lastError: v.optional(v.string()),
  deliveredAt: v.optional(v.number()),
  requestDurationMs: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_auth_user', ['authUserId'])
  .index('by_subscription', ['subscriptionId'])
  .index('by_event', ['eventId'])
  .index('by_status_retry', ['status', 'nextRetryAt'])
  .index('by_subscription_created', ['subscriptionId', 'createdAt']);

export default defineSchema({
  // Creator-scoped tables
  creator_profiles,
  bindings,
  verification_sessions,
  entitlements,
  guild_links,
  role_rules,
  download_routes,
  download_artifacts,
  unity_installations,
  runtime_assertions,
  outbox_jobs,
  audit_events,
  product_catalog,
  manual_licenses,
  purchase_facts,
  provider_connections,
  provider_credentials,
  provider_connection_capabilities,
  provider_catalog_mappings,
  provider_transactions,
  provider_memberships,
  provider_licenses,
  entitlement_evidence,
  creator_oauth_apps,
  collaborator_invites,
  collaborator_connections,

  // Public API v2 tables
  creator_events,
  webhook_subscriptions,
  webhook_deliveries,

  // Platform-level tables
  subjects,
  external_accounts,
  provider_customers,
  catalog_product_links,
  webhook_events,

  // YUCP Certificate Authority tables
  yucp_certificates,
  package_registry,
  signing_log,
  cert_issuance_log,
  oauth_loopback_sessions,
  used_nonces,

  // HTTP rate limiting for unauthenticated public endpoints
  http_rate_limits,

  // Admin notifications — short-lived bot-to-dashboard events
  admin_notifications,
});
