/**
 * YUCP Creator Assistant - Convex Application Schema
 *
 * This schema defines all tables for the multi-tenant creator verification platform.
 *
 * Tenant-scoped tables (require tenantId):
 * - tenants, bindings, verification_sessions, entitlements, guild_links,
 *   role_rules, unity_installations, runtime_assertions, outbox_jobs, audit_events
 *
 * Platform-level tables (no tenantId):
 * - subjects, external_accounts, provider_customers, catalog_product_links, webhook_events
 *
 * Mixed-ownership:
 * - product_catalog (has tenantId for owner, but globally queryable for catalog resolution)
 */

import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// ============================================================================
// ENUM-LIKE LITERALS
// ============================================================================

/** Provider types supported by the platform */
const Provider = v.union(
  v.literal('discord'),
  v.literal('gumroad'),
  v.literal('jinxxy'),
  v.literal('manual'),
);

/** Subject status values */
const SubjectStatus = v.union(
  v.literal('active'),
  v.literal('suspended'),
  v.literal('quarantined'),
  v.literal('deleted'),
);

/** External account status values */
const ExternalAccountStatus = v.union(
  v.literal('active'),
  v.literal('disconnected'),
  v.literal('revoked'),
);

/** Provider customer status values */
const ProviderCustomerStatus = v.union(
  v.literal('active'),
  v.literal('inactive'),
  v.literal('disputed'),
);

/** Product catalog status values */
const ProductCatalogStatus = v.union(
  v.literal('active'),
  v.literal('deprecated'),
  v.literal('hidden'),
);

/** Catalog product link kinds */
const LinkKind = v.union(
  v.literal('storefront'),
  v.literal('direct_product'),
  v.literal('checkout'),
  v.literal('mirror'),
  v.literal('documentation'),
);

/** Catalog product link status */
const CatalogLinkStatus = v.union(
  v.literal('active'),
  v.literal('deprecated'),
  v.literal('redirected'),
);

/** Binding types */
const BindingType = v.union(
  v.literal('ownership'),
  v.literal('verification'),
  v.literal('manual_override'),
);

/** Binding status values */
const BindingStatus = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('revoked'),
  v.literal('transferred'),
  v.literal('quarantined'),
);

/** Verification session modes */
const VerificationMode = v.union(
  v.literal('gumroad'),
  v.literal('discord_role'),
  v.literal('jinxxy'),
  v.literal('manual'),
);

/** Verification session status */
const VerificationSessionStatus = v.union(
  v.literal('pending'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('expired'),
  v.literal('cancelled'),
);

/** Entitlement status values */
const EntitlementStatus = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('expired'),
  v.literal('refunded'),
  v.literal('disputed'),
);

/** Guild link status */
const GuildLinkStatus = v.union(
  v.literal('active'),
  v.literal('uninstalled'),
  v.literal('suspended'),
);

/** Unity installation status */
const UnityInstallationStatus = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('quarantined'),
);

/** Runtime assertion status */
const RuntimeAssertionStatus = v.union(
  v.literal('valid'),
  v.literal('expired'),
  v.literal('revoked'),
);

/** Download route role logic */
const DownloadRoleLogic = v.union(
  v.literal('all'),
  v.literal('any'),
);

/** Download artifact status */
const DownloadArtifactStatus = v.union(
  v.literal('active'),
  v.literal('deleted'),
  v.literal('failed'),
);

const DownloadArtifactSourceMode = v.union(
  v.literal('reply'),
  v.literal('webhook'),
);

/** Outbox job status */
const OutboxJobStatus = v.union(
  v.literal('pending'),
  v.literal('in_progress'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('dead_letter'),
);

/** Outbox job types */
const OutboxJobType = v.union(
  v.literal('role_sync'),
  v.literal('role_removal'),
  v.literal('entitlement_refresh'),
  v.literal('revocation'),
  v.literal('notification'),
  v.literal('creator_alert'),
  v.literal('retroactive_rule_sync'),
);

/** Webhook event status */
const WebhookEventStatus = v.union(
  v.literal('pending'),
  v.literal('processed'),
  v.literal('failed'),
  v.literal('duplicate'),
);

/** Purchase fact lifecycle status */
const PurchaseFactLifecycleStatus = v.union(
  v.literal('active'),
  v.literal('refunded'),
  v.literal('disputed'),
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
);

// ============================================================================
// TENANT-SCOPED TABLES
// ============================================================================

/**
 * Tenants - Creator organizations or configured communities
 * Owner of the tenant scope for all tenant-specific data.
 */
const tenants = defineTable({
  // Human-readable name for the tenant
  name: v.string(),
  // Discord user ID of the tenant owner
  ownerDiscordUserId: v.string(),
  // Better Auth user ID of the owner
  ownerAuthUserId: v.string(),
  // Optional slug for URL-friendly identification
  slug: v.optional(v.string()),
  // Tenant status
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
        v.union(v.literal('block'), v.literal('notify'), v.literal('allow')),
      ),
      duplicateVerificationNotifyChannelId: v.optional(v.string()),
      suspiciousAccountBehavior: v.optional(
        v.union(v.literal('quarantine'), v.literal('notify'), v.literal('revoke')),
      ),
      suspiciousNotifyChannelId: v.optional(v.string()),
      enableDiscordRoleFromOtherServers: v.optional(v.boolean()),
      allowedSourceGuildIds: v.optional(v.array(v.string())),
      allowMismatchedEmails: v.optional(v.boolean()),
    }),
  ),
  // Metadata
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_owner_discord', ['ownerDiscordUserId'])
  .index('by_owner_auth', ['ownerAuthUserId'])
  .index('by_slug', ['slug'])
  .index('by_status', ['status']);

/**
 * Bindings - Relationship between a subject and an external account
 * Links a YUCP subject to their provider identity within a tenant context.
 */
const bindings = defineTable({
  // Tenant scope
  tenantId: v.id('tenants'),
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
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_subject', ['tenantId', 'subjectId'])
  .index('by_tenant_external', ['tenantId', 'externalAccountId'])
  .index('by_subject', ['subjectId'])
  .index('by_external_account', ['externalAccountId'])
  .index('by_tenant_status', ['tenantId', 'status']);

/**
 * Verification Sessions - Short-lived flow state for OAuth and verification UX
 * Tracks the state of ongoing verification attempts.
 */
const verification_sessions = defineTable({
  // Tenant scope
  tenantId: v.id('tenants'),
  // Subject (null until OAuth callback completes)
  subjectId: v.optional(v.id('subjects')),
  // Verification mode being used
  mode: VerificationMode,
  // Product being verified (if applicable)
  productId: v.optional(v.id('product_catalog')),
  // OAuth state parameter
  state: v.string(),
  // PKCE verifier hash for security
  pkceVerifierHash: v.optional(v.string()),
  // PKCE verifier (plaintext, short-lived, used once at token exchange)
  pkceVerifier: v.optional(v.string()),
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
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_state', ['tenantId', 'state'])
  .index('by_subject', ['subjectId'])
  .index('by_status_expires', ['status', 'expiresAt'])
  .index('by_nonce', ['nonce']);

/**
 * Entitlements - Creator-approved rights derived from provider evidence
 * Represents what a subject is entitled to within a tenant.
 */
const entitlements = defineTable({
  // Tenant scope
  tenantId: v.id('tenants'),
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
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_subject', ['tenantId', 'subjectId'])
  .index('by_tenant_product', ['tenantId', 'productId'])
  .index('by_subject', ['subjectId'])
  .index('by_provider_customer', ['providerCustomerId'])
  .index('by_catalog_product', ['catalogProductId'])
  .index('by_tenant_status', ['tenantId', 'status']);

/**
 * Guild Links - Per-tenant guild configuration and bot install state
 * Links a tenant to a Discord guild.
 */
const guild_links = defineTable({
  // Tenant scope
  tenantId: v.id('tenants'),
  // Discord guild ID
  discordGuildId: v.string(),
  // Who installed the bot
  installedByAuthUserId: v.string(),
  // Whether the bot is present in the guild
  botPresent: v.boolean(),
  // Command scope state for slash commands
  commandScopeState: v.optional(
    v.object({
      registered: v.boolean(),
      registeredAt: v.optional(v.number()),
    }),
  ),
  // Current status
  status: GuildLinkStatus,
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_tenant', ['tenantId'])
  .index('by_discord_guild', ['discordGuildId'])
  .index('by_status', ['status']);

/**
 * Role Rules - Desired role outcomes based on entitlements and policy
 * Maps products to Discord roles within a guild.
 */
const role_rules = defineTable({
  // Tenant scope
  tenantId: v.id('tenants'),
  // Discord guild ID (denormalized for queries)
  guildId: v.string(),
  // Reference to guild link
  guildLinkId: v.id('guild_links'),
  // Product this rule applies to
  productId: v.string(),
  // Optional catalog product reference
  catalogProductId: v.optional(v.id('product_catalog')),
  // Discord role ID to assign
  verifiedRoleId: v.string(),
  // Whether to remove the role on entitlement revoke
  removeOnRevoke: v.boolean(),
  // Priority for multiple role rules
  priority: v.number(),
  // Whether this rule is enabled
  enabled: v.boolean(),
  // Discord cross-server: upstream guild to check membership
  sourceGuildId: v.optional(v.string()),
  // Discord cross-server: role ID user must have in source guild
  requiredRoleId: v.optional(v.string()),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_guild', ['tenantId', 'guildId'])
  .index('by_guild_link', ['guildLinkId'])
  .index('by_product', ['productId'])
  .index('by_catalog_product', ['catalogProductId'])
  .index('by_source_guild', ['sourceGuildId']);

/**
 * Download Routes - Per-guild capture/archive rules for Liened Downloads.
 * Routes qualifying attachments from source locations into private archive locations.
 */
const download_routes = defineTable({
  tenantId: v.id('tenants'),
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
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_guild', ['tenantId', 'guildId'])
  .index('by_guild_source_channel', ['guildId', 'sourceChannelId'])
  .index('by_guild_archive_channel', ['guildId', 'archiveChannelId'])
  .index('by_guild_link', ['guildLinkId']);

/**
 * Download Artifacts - Archived mirrored files plus gating metadata.
 * One record per archived download post / file set.
 */
const download_artifacts = defineTable({
  tenantId: v.id('tenants'),
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
    }),
  ),
  status: DownloadArtifactStatus,
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_guild', ['tenantId', 'guildId'])
  .index('by_route', ['routeId'])
  .index('by_source_message', ['sourceMessageId'])
  .index('by_archive_message', ['archiveMessageId'])
  .index('by_status', ['status']);

/**
 * Unity Installations - Signals for Unity runtime usage
 * Tracks Unity client installations for device binding.
 */
const unity_installations = defineTable({
  // Tenant scope
  tenantId: v.id('tenants'),
  // Subject who owns this installation
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
        v.literal('multiple_subjects'),
      ),
    ),
  ),
  // App version at last check-in
  appVersion: v.optional(v.string()),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_subject', ['tenantId', 'subjectId'])
  .index('by_subject', ['subjectId'])
  .index('by_fingerprint', ['deviceFingerprintHash'])
  .index('by_tenant_status', ['tenantId', 'status']);

/**
 * Runtime Assertions - Issued Unity assertions for audit and replay tracking
 * Tracks JWT assertions issued to Unity clients.
 */
const runtime_assertions = defineTable({
  // JWT ID (unique identifier)
  jti: v.string(),
  // Tenant scope
  tenantId: v.id('tenants'),
  // Subject who received this assertion
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
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_subject', ['tenantId', 'subjectId'])
  .index('by_subject', ['subjectId'])
  .index('by_installation', ['installationId'])
  .index('by_status_expires', ['status', 'expiresAt']);

/**
 * Outbox Jobs - Guaranteed side-effect queue
 * Ensures reliable delivery of role sync, notifications, etc.
 */
const outbox_jobs = defineTable({
  // Tenant scope
  tenantId: v.id('tenants'),
  // Type of job
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
  .index('by_tenant', ['tenantId'])
  .index('by_status', ['status'])
  .index('by_status_next_retry', ['status', 'nextRetryAt'])
  .index('by_idempotency', ['idempotencyKey'])
  .index('by_tenant_type', ['tenantId', 'jobType'])
  .index('by_guild_user', ['targetGuildId', 'targetDiscordUserId']);

/**
 * Audit Events - Security and support trail
 * Records all security-sensitive operations.
 */
const audit_events = defineTable({
  // Tenant scope (null for platform-level events)
  tenantId: v.optional(v.id('tenants')),
  // Type of event
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
  .index('by_tenant', ['tenantId'])
  .index('by_event_type', ['eventType'])
  .index('by_tenant_event', ['tenantId', 'eventType'])
  .index('by_subject', ['subjectId'])
  .index('by_actor', ['actorType', 'actorId'])
  .index('by_correlation', ['correlationId'])
  .index('by_created', ['createdAt']);

/**
 * Product Catalog - Global registry of products
 * Has tenantId for the owning creator, but globally queryable.
 */
const product_catalog = defineTable({
  // Creator who owns this product entry
  tenantId: v.id('tenants'),
  // Local product identifier
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
  .index('by_tenant', ['tenantId'])
  .index('by_provider_ref', ['provider', 'providerProductRef'])
  .index('by_slug', ['canonicalSlug'])
  .index('by_status', ['status']);

/**
 * Purchase Facts - Canonical purchase layer for automatic verification
 * Stores raw purchase data from webhooks; entitlements are projected from these.
 * Uniqueness: (tenantId, provider, externalOrderId, externalLineItemId?) when provider exposes line items.
 */
const purchase_facts = defineTable({
  tenantId: v.id('tenants'),
  provider: v.union(v.literal('gumroad'), v.literal('jinxxy')),
  externalOrderId: v.string(),
  externalLineItemId: v.optional(v.string()),
  externalLicenseId: v.optional(v.string()),
  buyerEmailNormalized: v.optional(v.string()),
  buyerEmailHash: v.optional(v.string()),
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
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_provider_order', ['tenantId', 'provider', 'externalOrderId'])
  .index('by_tenant_product', ['tenantId', 'providerProductId'])
  .index('by_email_hash', ['buyerEmailHash'])
  .index('by_subject', ['subjectId']);

/**
 * Provider Connections - Per-tenant creator credentials and webhook config
 * Gumroad: OAuth tokens, resource subscriptions; Jinxxy: API key, webhook secret.
 */
const provider_connections = defineTable({
  tenantId: v.id('tenants'),
  provider: v.union(v.literal('gumroad'), v.literal('jinxxy')),
  // Human-readable label for multi-store support (e.g. "Main Store", "VRChat Assets")
  label: v.optional(v.string()),
  // Whether this is a creator setup connection or verification connection
  connectionType: v.optional(v.union(v.literal('setup'), v.literal('verification'))),
  // Connection status
  status: v.optional(v.union(v.literal('active'), v.literal('disconnected'), v.literal('error'))),
  gumroadAccessTokenEncrypted: v.optional(v.string()),
  gumroadRefreshTokenEncrypted: v.optional(v.string()),
  gumroadUserId: v.optional(v.string()),
  webhookConfigured: v.boolean(),
  resourceSubscriptionIds: v.optional(v.array(v.string())),
  jinxxyApiKeyEncrypted: v.optional(v.string()),
  webhookSecretRef: v.optional(v.string()),
  gumroadWebhookSecretRef: v.optional(v.string()),
  webhookEndpoint: v.optional(v.string()),
  lastSuccessfulBackfillAt: v.optional(v.number()),
  lastSeenOrderId: v.optional(v.string()),
  lastWebhookAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_provider', ['tenantId', 'provider'])
  .index('by_tenant_provider_label', ['tenantId', 'provider', 'label']);

// ============================================================================
// PLATFORM-LEVEL TABLES (no tenantId)
// ============================================================================

/**
 * Subjects - Canonical user identity within YUCP
 * Global identity that spans all tenants.
 */
const subjects = defineTable({
  // Primary Discord user ID
  primaryDiscordUserId: v.string(),
  // Better Auth user ID (linked from auth system)
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
    }),
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
  // Normalized email for purchase→subject linking (lowercase, trimmed)
  normalizedEmail: v.optional(v.string()),
  // SHA-256 hash of normalized email for matching without storing plaintext
  emailHash: v.optional(v.string()),
  // Provider-specific metadata
  providerMetadata: v.optional(
    v.object({
      email: v.optional(v.string()),
      avatarUrl: v.optional(v.string()),
      profileUrl: v.optional(v.string()),
      rawData: v.optional(v.any()),
    }),
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
 * NO tenantId - this is platform-level data.
 */
const provider_customers = defineTable({
  // Provider type
  provider: v.union(v.literal('gumroad'), v.literal('jinxxy'), v.literal('manual')),
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
    }),
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
 * NO tenantId - links are global, but reference the submitting tenant.
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
  // Tenant who submitted this link
  submittedByTenantId: v.id('tenants'),
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
  // Provider's event ID for deduplication
  providerEventId: v.string(),
  // Event type from provider
  eventType: v.string(),
  // Raw payload (stored for replay/debugging)
  rawPayload: v.any(),
  // Signature verification status
  signatureValid: v.boolean(),
  // Processing status
  status: WebhookEventStatus,
  // Error message if processing failed
  errorMessage: v.optional(v.string()),
  // Related tenant (if determined from payload)
  tenantId: v.optional(v.id('tenants')),
  // Related subject (if determined from payload)
  subjectId: v.optional(v.id('subjects')),
  // Related entitlement (if determined from payload)
  entitlementId: v.optional(v.id('entitlements')),
  // Timestamps
  receivedAt: v.number(),
  processedAt: v.optional(v.number()),
})
  .index('by_provider_event', ['provider', 'providerEventId'])
  .index('by_provider', ['provider'])
  .index('by_status', ['status'])
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_provider_event', ['tenantId', 'provider', 'providerEventId'])
  .index('by_received', ['receivedAt']);

/**
 * Manual License Status
 */
const ManualLicenseStatus = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('expired'),
  v.literal('exhausted'),
);

/**
 * Manual Licenses - Creator-generated license keys for products
 * Stores hashed license keys for secure validation.
 */
const manual_licenses = defineTable({
  // Tenant scope
  tenantId: v.id('tenants'),
  // SHA-256 hash of the license key (never store plaintext)
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
  .index('by_tenant', ['tenantId'])
  .index('by_tenant_product', ['tenantId', 'productId'])
  .index('by_license_key_hash', ['licenseKeyHash'])
  .index('by_tenant_status', ['tenantId', 'status'])
  .index('by_expires', ['expiresAt']);

/**
 * Tenant Provider Config - Per-tenant provider credentials
 * Jinxxy API keys are per-creator; Gumroad uses global env.
 */
const tenant_provider_config = defineTable({
  // Tenant scope
  tenantId: v.id('tenants'),
  // Encrypted Jinxxy API key (caller encrypts before storage)
  jinxxyApiKeyEncrypted: v.optional(v.string()),
  // Timestamps
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index('by_tenant', ['tenantId']);

/**
 * Collaborator Invites - Single-use invite tokens for cross-creator API key sharing
 * Allows a server owner to invite another creator to share Jinxxy credentials.
 */
const collaborator_invites = defineTable({
  ownerTenantId: v.id('tenants'),
  /** SHA-256 hex of raw invite token (never stored plaintext) */
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
})
  .index('by_token_hash', ['tokenHash'])
  .index('by_owner', ['ownerTenantId'])
  .index('by_owner_status', ['ownerTenantId', 'status'])
  .index('by_target_discord_user', ['targetDiscordUserId']);

/**
 * Collaborator Connections - Active collaborator API key sharing relationships
 * Created when a collaborator accepts an invite.
 */
const collaborator_connections = defineTable({
  ownerTenantId: v.id('tenants'),
  inviteId: v.id('collaborator_invites'),
  provider: v.literal('jinxxy'),
  jinxxyApiKeyEncrypted: v.optional(v.string()),
  /** Encrypted webhook signing secret; null for api-type connections */
  webhookSecretRef: v.optional(v.string()),
  /** null for api-type connections */
  webhookEndpoint: v.optional(v.string()),
  webhookConfigured: v.boolean(),
  linkType: v.union(v.literal('account'), v.literal('api')),
  status: v.union(v.literal('active'), v.literal('paused'), v.literal('disconnected')),
  collaboratorDiscordUserId: v.string(),
  collaboratorDisplayName: v.string(),
  createdAt: v.number(),
})
  .index('by_owner', ['ownerTenantId'])
  .index('by_invite', ['inviteId'])
  .index('by_owner_status', ['ownerTenantId', 'status'])
  .index('by_owner_provider', ['ownerTenantId', 'provider'])
  .index('by_collaborator_discord', ['collaboratorDiscordUserId']);

// ============================================================================
// SCHEMA EXPORT
// ============================================================================

export default defineSchema({
  // Tenant-scoped tables
  tenants,
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
  tenant_provider_config,
  purchase_facts,
  provider_connections,
  collaborator_invites,
  collaborator_connections,

  // Platform-level tables
  subjects,
  external_accounts,
  provider_customers,
  catalog_product_links,
  webhook_events,
});
