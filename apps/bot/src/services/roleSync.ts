/**
 * Discord Role Sync Engine
 *
 * Listens for entitlement events from Convex outbox and syncs Discord roles.
 * Handles rate limiting, retries, and audit logging.
 *
 * Key responsibilities:
 * - Process role_sync jobs: Add roles based on entitlement grants
 * - Process role_removal jobs: Remove roles on entitlement revocation
 * - Handle Discord API rate limits with exponential backoff
 * - Emit audit events for all role changes
 */

import {
  buildCatalogProductUrl,
  CATALOG_SYNC_PROVIDER_KEYS,
  getProviderDescriptor,
} from '@yucp/providers/providerMetadata';
import type { ProviderKey } from '@yucp/providers/types';
import { createStructuredLogger, type StructuredLogger } from '@yucp/shared';
import { Client, GuildMember, RESTJSONErrorCodes } from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { createBotConvexClient } from '../lib/convexActor';
import { listProviderProducts } from '../lib/internalRpc';
import { sendDashboardNotification } from '../lib/notifications';
import { withBotSpan, withBotStageSpan } from '../lib/observability';
import { canBotManageRole } from '../lib/roleHierarchy';
import {
  buildMigrationEmptyCatalogEventMessage,
  buildMigrationEmptyCatalogReason,
  type SetupCatalogSummary,
  summarizeSetupCatalogResults,
} from '../lib/setupCatalog';
import { buildVerifyPromptMessage, getEnabledProviders } from '../lib/verifyPrompt';
import { buildVerifyPromptAccessPreview } from '../lib/verifyPromptAccess';

type BotConvexClient = {
  // biome-ignore lint/suspicious/noExplicitAny: Convex calls are dynamically dispatched in the bot runtime.
  query: (functionReference: unknown, args?: unknown) => Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: Convex calls are dynamically dispatched in the bot runtime.
  mutation: (functionReference: unknown, args?: unknown) => Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: Convex calls are dynamically dispatched in the bot runtime.
  action: (functionReference: unknown, args?: unknown) => Promise<any>;
};

// ============================================================================
// TYPES (defined locally to avoid Convex import issues)
// ============================================================================

/** Branded ID type for Convex documents */
export type Id<TableName extends string> = string & { __tableName: TableName };

/** Role sync job payload from outbox */
export interface RoleSyncPayload {
  subjectId: Id<'subjects'>;
  entitlementId: Id<'entitlements'>;
  discordUserId?: string;
  /** When set (e.g. guild member add), only sync roles in this guild */
  targetGuildId?: string;
}

/** Role removal job payload from outbox */
export interface RoleRemovalPayload {
  subjectId: Id<'subjects'>;
  entitlementId: Id<'entitlements'>;
  guildId: string;
  roleId: string;
  discordUserId?: string;
}

/** Creator alert job payload (e.g. duplicate verification notify) */
export interface CreatorAlertPayload {
  channelId: string;
  message: string;
  alertType?: string;
}

/** Retroactive rule sync job payload */
export interface RetroactiveRuleSyncPayload {
  authUserId: string;
  productId: string;
}

export interface VerifyPromptRefreshPayload {
  guildId: string;
  guildLinkId: Id<'guild_links'>;
}

export interface SetupApplyPayload {
  setupJobId: Id<'setup_jobs'>;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  verificationMessageMode?: 'reuse_existing' | 'leave_unchanged';
  /** When true, skip the verify prompt creation or reuse step. */
  skipVerifyPrompt?: boolean;
}

export interface SetupGeneratePlanPayload {
  setupJobId: Id<'setup_jobs'>;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  rolePlanMode?: 'create_or_adopt' | 'adopt_only';
}

export interface MigrationAnalyzePayload {
  migrationJobId: Id<'migration_jobs'>;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  mode:
    | 'adopt_existing_roles'
    | 'import_verified_users'
    | 'bridge_from_current_roles'
    | 'cross_server_bridge';
  unmatchedProductBehavior?: 'review' | 'ignore';
  cutoverStyle?: 'switch_when_ready' | 'parallel_run';
  sourceBotKey?: string;
  sourceGuildId?: string;
}

/** Outbox job document type */
export interface OutboxJob {
  _id: Id<'outbox_jobs'>;
  authUserId: string;
  jobType:
    | 'role_sync'
    | 'role_removal'
    | 'creator_alert'
    | 'retroactive_rule_sync'
    | 'migration_analyze'
    | 'setup_apply'
    | 'setup_generate_plan'
    | 'verify_prompt_refresh';
  payload:
    | RoleSyncPayload
    | RoleRemovalPayload
    | CreatorAlertPayload
    | RetroactiveRuleSyncPayload
    | MigrationAnalyzePayload
    | SetupApplyPayload
    | SetupGeneratePlanPayload
    | VerifyPromptRefreshPayload;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'dead_letter';
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: number;
  lastError?: string;
  targetGuildId?: string;
  targetDiscordUserId?: string;
}

/** Role rule document type */
export interface RoleRule {
  _id: Id<'role_rules'>;
  authUserId: string;
  guildId: string;
  productId: string;
  catalogTierId?: Id<'catalog_tiers'>;
  verifiedRoleId: string;
  verifiedRoleIds?: string[];
  removeOnRevoke: boolean;
  enabled: boolean;
  priority: number;
}

/** Subject document type */
export interface Subject {
  _id: Id<'subjects'>;
  primaryDiscordUserId: string;
  displayName?: string;
}

/** Entitlement document type */
export interface Entitlement {
  _id: Id<'entitlements'>;
  authUserId: string;
  subjectId: Id<'subjects'>;
  productId: string;
  status: 'active' | 'revoked' | 'expired' | 'refunded' | 'disputed';
}

interface SetupProduct {
  id: string;
  name: string;
  provider: ProviderKey;
  productUrl?: string;
}

interface ExistingGuildProductRule {
  productId: string;
  displayName: string | null;
  provider?: string;
  verifiedRoleId?: string;
  verifiedRoleIds?: string[];
  enabled?: boolean;
}

function normalizeSetupName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeSetupRoleName(name: string): string {
  return (
    name
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'Verified'
  );
}

function getDefaultRolePlanAction(args: {
  proposedRoleId?: string;
  rolePlanMode?: 'create_or_adopt' | 'adopt_only';
}): 'create_role' | 'adopt_role' | 'skip' {
  if (args.proposedRoleId) {
    return 'adopt_role';
  }
  return args.rolePlanMode === 'adopt_only' ? 'skip' : 'create_role';
}

/** Role sync result */
export interface RoleSyncResult {
  success: boolean;
  guildId: string;
  discordUserId: string;
  rolesAdded: string[];
  rolesRemoved: string[];
  error?: string;
  nonRetriable?: boolean;
}

/** Rate limit info from Discord API */
interface RateLimitInfo {
  resetAt: number;
  remaining: number;
}

// ============================================================================
// RATE LIMIT HANDLER
// ============================================================================

/**
 * Discord rate limit handler with exponential backoff.
 * Tracks rate limits per-route and applies appropriate delays.
 */
export class DiscordRateLimiter {
  private routeLimits: Map<string, RateLimitInfo> = new Map();
  private logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger.child({ component: 'rate_limiter' });
  }

  /**
   * Wait for rate limit if necessary before making a request.
   * @param route - The Discord API route (e.g., 'guilds/123/members/456')
   * @returns Promise that resolves when it's safe to make the request
   */
  async waitForRateLimit(route: string): Promise<void> {
    const limitInfo = this.routeLimits.get(route);
    if (!limitInfo || limitInfo.remaining > 0) {
      return;
    }

    const now = Date.now();
    const waitTime = limitInfo.resetAt - now;

    if (waitTime > 0) {
      this.logger.warn('Rate limit hit, waiting', {
        route,
        waitMs: waitTime,
        resetAt: new Date(limitInfo.resetAt).toISOString(),
      });
      await this.sleep(waitTime);
    }
  }

  /**
   * Update rate limit info from Discord response headers.
   */
  updateFromHeaders(
    route: string,
    headers: {
      'x-ratelimit-reset'?: string;
      'x-ratelimit-remaining'?: string;
    }
  ): void {
    const resetHeader = headers['x-ratelimit-reset'];
    const remainingHeader = headers['x-ratelimit-remaining'];

    if (resetHeader) {
      const resetAt = Number.parseFloat(resetHeader) * 1000; // Convert to ms
      const remaining = remainingHeader ? Number.parseInt(remainingHeader, 10) : 1;

      this.routeLimits.set(route, { resetAt, remaining });
    }
  }

  /**
   * Calculate exponential backoff delay.
   */
  calculateBackoff(retryCount: number, baseDelay = 1000): number {
    const maxDelay = 60000; // 60 seconds max
    const jitter = Math.random() * 0.3 * baseDelay; // Add jitter
    const delay = Math.min(baseDelay * 2 ** retryCount + jitter, maxDelay);
    return Math.floor(delay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// ROLE SYNC SERVICE
// ============================================================================

/**
 * Discord role sync service.
 * Processes outbox jobs and syncs Discord roles based on entitlements.
 */
export class RoleSyncService {
  private readonly logger: StructuredLogger;
  private readonly convexClient: BotConvexClient;
  private readonly discordClient: Client;
  private readonly rateLimiter: DiscordRateLimiter;
  private readonly apiSecret: string;
  private readonly encryptionSecret?: string;
  private isRunning = false;
  private pollIntervalMs: number;

  constructor(options: {
    convexUrl: string;
    apiSecret: string;
    discordClient: Client;
    pollIntervalMs?: number;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    encryptionSecret?: string;
  }) {
    this.logger = createStructuredLogger({
      serviceName: 'role-sync',
      level: options.logLevel ?? 'info',
      jsonOutput: true,
    });

    this.convexClient = createBotConvexClient(options.convexUrl) as unknown as BotConvexClient;
    this.discordClient = options.discordClient;
    this.apiSecret = options.apiSecret;
    this.encryptionSecret = options.encryptionSecret;
    this.rateLimiter = new DiscordRateLimiter(this.logger);
    this.pollIntervalMs = options.pollIntervalMs ?? 5000; // 5 seconds default
  }

  /**
   * Start the role sync service.
   * Begins polling for outbox jobs.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Role sync service already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting role sync service');

    // Start polling loop
    this.pollLoop();
  }

  /**
   * Stop the role sync service.
   */
  stop(): void {
    this.isRunning = false;
    this.logger.info('Stopping role sync service');
  }

  /**
   * Main polling loop for outbox jobs.
   */
  private async pollLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.processPendingJobs();
      } catch (error) {
        this.logger.error('Error in poll loop', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Wait before next poll
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * Process all pending outbox jobs.
   */
  async processPendingJobs(): Promise<number> {
    return withBotStageSpan(
      'outbox.process_pending',
      {
        pollIntervalMs: this.pollIntervalMs,
      },
      async () => {
        const jobs = await this.fetchPendingJobs();

        if (jobs.length === 0) {
          return 0;
        }

        this.logger.info('Processing pending jobs', { count: jobs.length });

        let processedCount = 0;
        for (const job of jobs) {
          try {
            await this.processJob(job);
            processedCount++;
          } catch (error) {
            this.logger.error('Failed to process job', {
              jobId: job._id,
              jobType: job.jobType,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return processedCount;
      }
    );
  }

  /**
   * Process a single outbox job.
   */
  private async processJob(job: OutboxJob): Promise<void> {
    await withBotSpan(
      'discord.role_sync.job',
      {
        authUserId: job.authUserId,
        jobId: job._id,
        jobType: job.jobType,
        retryCount: job.retryCount,
        targetGuildId: job.targetGuildId,
      },
      async () => {
        this.logger.info('Processing job', {
          jobId: job._id,
          jobType: job.jobType,
          retryCount: job.retryCount,
        });

        await this.updateJobStatus(job._id, 'in_progress');

        try {
          if (job.jobType === 'creator_alert') {
            await this.processCreatorAlertJob(job);
            await this.updateJobStatus(job._id, 'completed');
            this.logger.info('Creator alert job completed', { jobId: job._id });
            return;
          }

          if (job.jobType === 'retroactive_rule_sync') {
            await this.processRetroactiveRuleSyncJob(job);
            await this.updateJobStatus(job._id, 'completed');
            this.logger.info('Retroactive rule sync job completed', { jobId: job._id });
            return;
          }

          if (job.jobType === 'setup_generate_plan') {
            await this.processSetupGeneratePlanJob(job);
            await this.updateJobStatus(job._id, 'completed');
            this.logger.info('Setup generate plan job completed', { jobId: job._id });
            return;
          }

          if (job.jobType === 'migration_analyze') {
            await this.processMigrationAnalyzeJob(job);
            await this.updateJobStatus(job._id, 'completed');
            this.logger.info('Migration analyze job completed', { jobId: job._id });
            return;
          }

          if (job.jobType === 'setup_apply') {
            await this.processSetupApplyJob(job);
            await this.updateJobStatus(job._id, 'completed');
            this.logger.info('Setup apply job completed', { jobId: job._id });
            return;
          }

          if (job.jobType === 'verify_prompt_refresh') {
            await this.processVerifyPromptRefreshJob(job);
            await this.updateJobStatus(job._id, 'completed');
            this.logger.info('Verify prompt refresh job completed', { jobId: job._id });
            return;
          }

          let result: RoleSyncResult;

          if (job.jobType === 'role_sync') {
            result = await this.processRoleSyncJob(job);
          } else if (job.jobType === 'role_removal') {
            result = await this.processRoleRemovalJob(job);
          } else {
            throw new Error(`Unknown job type: ${(job as OutboxJob).jobType}`);
          }

          if (result.success) {
            await this.updateJobStatus(job._id, 'completed');
            await this.emitAuditEvent(job, result);

            this.logger.info('Job completed successfully', {
              jobId: job._id,
              rolesAdded: result.rolesAdded,
              rolesRemoved: result.rolesRemoved,
            });

            if (job.jobType === 'role_sync' && result.rolesAdded.length > 0 && result.guildId) {
              const roleCount = result.rolesAdded.length;
              sendDashboardNotification({
                authUserId: job.authUserId,
                guildId: result.guildId,
                type: 'info',
                title: 'Roles synced',
                message: `${roleCount} role${roleCount !== 1 ? 's' : ''} assigned${result.discordUserId ? ` to <@${result.discordUserId}>` : ''}.`,
              });
            }
          } else if (result.nonRetriable) {
            this.logger.warn('Job failed with non-retriable result, skipping retries', {
              jobId: job._id,
              error: result.error ?? 'Unknown error',
            });
            await this.updateJobStatus(job._id, 'dead_letter', result.error ?? 'Unknown error');
          } else {
            await this.handleJobFailure(job, result.error ?? 'Unknown error');
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          // Non-retriable errors (e.g., Missing Permissions) will not resolve by retrying.
          // Skip the retry queue and move directly to the dead letter state.
          if (this.isNonRetriableDiscordError(error)) {
            this.logger.warn('Job failed with non-retriable error, skipping retries', {
              jobId: job._id,
              error: errorMessage,
            });
            await this.updateJobStatus(job._id, 'dead_letter', errorMessage);
          } else {
            await this.handleJobFailure(job, errorMessage);
          }
        }
      }
    );
  }

  /**
   * Process a role sync job (add roles).
   */
  private async processRoleSyncJob(job: OutboxJob): Promise<RoleSyncResult> {
    const payload = job.payload as RoleSyncPayload;
    const discordUserId = payload.discordUserId;

    if (!discordUserId) {
      throw new Error('No Discord user ID in payload');
    }

    // Get entitlement details
    const entitlement = await this.fetchEntitlement(payload.entitlementId);
    if (!entitlement) {
      throw new Error(`Entitlement not found: ${payload.entitlementId}`);
    }

    // Only sync active entitlements
    if (entitlement.status !== 'active') {
      return {
        success: true,
        guildId: '',
        discordUserId,
        rolesAdded: [],
        rolesRemoved: [],
        error: 'Entitlement not active, skipping sync',
      };
    }

    const activeCatalogTierIds = await this.fetchActiveCatalogTierIds(payload.entitlementId);

    // Get all role rules for this product
    let roleRules = await this.fetchRoleRules(job.authUserId, entitlement.productId);
    if (activeCatalogTierIds.length > 0) {
      const activeTierIdSet = new Set(activeCatalogTierIds);
      roleRules = roleRules.filter(
        (rule) => !rule.catalogTierId || activeTierIdSet.has(rule.catalogTierId)
      );
    } else {
      roleRules = roleRules.filter((rule) => !rule.catalogTierId);
    }

    // When targetGuildId is set (e.g. from guild member add), only sync in that guild
    if (payload.targetGuildId) {
      roleRules = roleRules.filter((r) => r.guildId === payload.targetGuildId);
    }

    if (roleRules.length === 0) {
      return {
        success: true,
        guildId: '',
        discordUserId,
        rolesAdded: [],
        rolesRemoved: [],
        error: 'No role rules configured for product',
      };
    }

    const rolesAdded: string[] = [];
    const rolesRemoved: string[] = [];
    const errors: string[] = [];
    let nonRetriable = false;

    // Process each guild's role rules
    for (const rule of roleRules) {
      if (!rule.enabled) {
        continue;
      }

      const roleIds = rule.verifiedRoleIds ?? (rule.verifiedRoleId ? [rule.verifiedRoleId] : []);

      for (const roleId of roleIds) {
        try {
          const result = await this.addRoleToMember(rule.guildId, discordUserId, roleId);

          if (result.added) {
            rolesAdded.push(roleId);
          }

          if (result.error) {
            errors.push(`${rule.guildId}: ${result.error}`);
            nonRetriable = nonRetriable || result.nonRetriable === true;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`${rule.guildId}: ${errorMsg}`);
          this.logger.error('Failed to add role', {
            guildId: rule.guildId,
            roleId,
            error: errorMsg,
          });
        }
      }
    }

    // Determine overall success
    const success = rolesAdded.length > 0 || roleRules.filter((r) => r.enabled).length === 0;

    return {
      success,
      guildId: roleRules[0]?.guildId ?? '',
      discordUserId,
      rolesAdded,
      rolesRemoved,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      nonRetriable,
    };
  }

  /**
   * Process a role removal job.
   */
  private async processRoleRemovalJob(job: OutboxJob): Promise<RoleSyncResult> {
    const payload = job.payload as RoleRemovalPayload;
    const discordUserId = payload.discordUserId;

    if (!discordUserId) {
      throw new Error('No Discord user ID in payload');
    }

    const rolesRemoved: string[] = [];

    try {
      const result = await this.removeRoleFromMember(
        payload.guildId,
        discordUserId,
        payload.roleId
      );

      if (result.removed) {
        rolesRemoved.push(payload.roleId);
      }

      return {
        success: result.removed,
        guildId: payload.guildId,
        discordUserId,
        rolesAdded: [],
        rolesRemoved,
        error: result.error,
        nonRetriable: result.nonRetriable,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        guildId: payload.guildId,
        discordUserId,
        rolesAdded: [],
        rolesRemoved,
        error: errorMsg,
      };
    }
  }

  /**
   * Process creator alert job (e.g. duplicate verification notification).
   */
  private async processCreatorAlertJob(job: OutboxJob): Promise<void> {
    const payload = job.payload as CreatorAlertPayload;
    if (!payload.channelId || !payload.message) {
      throw new Error('Creator alert payload missing channelId or message');
    }

    const channel = await this.discordClient.channels.fetch(payload.channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Channel ${payload.channelId} not found or not text channel`);
    }

    await channel.send({ content: payload.message, allowedMentions: { parse: [] } });
  }

  private async processVerifyPromptRefreshJob(job: OutboxJob): Promise<void> {
    const payload = job.payload as VerifyPromptRefreshPayload;
    if (!payload.guildLinkId || !payload.guildId) {
      throw new Error('Verify prompt refresh payload missing guildLinkId or guildId');
    }

    const link = (await this.convexClient.query(api.guildLinks.getVerifyPromptMessageForBot, {
      apiSecret: this.apiSecret,
      guildLinkId: payload.guildLinkId,
    })) as {
      authUserId: string;
      guildId: string;
      verifyPromptMessage?: {
        channelId: string;
        messageId: string;
        titleOverride?: string;
        descriptionOverride?: string;
        buttonTextOverride?: string;
        color?: number;
        imageUrl?: string;
      };
    } | null;

    if (!link?.verifyPromptMessage) {
      return;
    }

    const providersResult = await this.convexClient.query(
      api.role_rules.getEnabledVerificationProvidersFromProducts,
      {
        apiSecret: this.apiSecret,
        authUserId: link.authUserId,
        guildId: link.guildId,
      }
    );
    const enabledSet = new Set<string>(getEnabledProviders(providersResult));
    const accessPreview = await buildVerifyPromptAccessPreview({
      convex: this.convexClient,
      discordClient: this.discordClient,
      apiSecret: this.apiSecret,
      authUserId: link.authUserId,
      guildId: link.guildId,
    });
    const { embed, row } = buildVerifyPromptMessage(
      enabledSet,
      {
        titleOverride: link.verifyPromptMessage.titleOverride,
        descriptionOverride: link.verifyPromptMessage.descriptionOverride,
        buttonTextOverride: link.verifyPromptMessage.buttonTextOverride,
        color: link.verifyPromptMessage.color,
        imageUrl: link.verifyPromptMessage.imageUrl,
      },
      { accessPreview }
    );

    const channel = await this.discordClient.channels
      .fetch(link.verifyPromptMessage.channelId)
      .catch((error) => {
        if (this.isUnknownDiscordResource(error)) {
          return null;
        }
        throw error;
      });
    if (!channel || !('messages' in channel)) {
      await this.clearVerifyPromptMessage(payload.guildLinkId);
      return;
    }

    const message = await channel.messages
      .fetch(link.verifyPromptMessage.messageId)
      .catch((error) => {
        if (this.isUnknownDiscordResource(error)) {
          return null;
        }
        throw error;
      });
    if (!message) {
      await this.clearVerifyPromptMessage(payload.guildLinkId);
      return;
    }

    try {
      await message.edit({
        embeds: [embed],
        components: [row],
      });
    } catch (error) {
      if (this.isUnknownDiscordResource(error)) {
        await this.clearVerifyPromptMessage(payload.guildLinkId);
        return;
      }
      throw error;
    }
  }

  private async processSetupGeneratePlanJob(job: OutboxJob): Promise<void> {
    const payload = job.payload as SetupGeneratePlanPayload;
    if (!payload.setupJobId || !payload.guildLinkId || !payload.guildId) {
      throw new Error('Setup generate plan payload missing setupJobId, guildLinkId, or guildId');
    }

    const activeGuildLink = await this.convexClient.query(
      api.guildLinks.getVerifyPromptMessageForBot,
      {
        apiSecret: this.apiSecret,
        guildLinkId: payload.guildLinkId,
      }
    );
    if (!activeGuildLink) {
      this.logger.info('Skipping setup plan generation for disconnected guild link', {
        guildId: payload.guildId,
        setupJobId: payload.setupJobId,
        guildLinkId: payload.guildLinkId,
      });
      return;
    }

    const guild = await this.discordClient.guilds.fetch(payload.guildId);
    await guild.roles.fetch();

    const existingRules = (await this.convexClient.query(
      api.role_rules.getByGuildWithProductNames,
      {
        apiSecret: this.apiSecret,
        authUserId: job.authUserId,
        guildId: payload.guildId,
      }
    )) as ExistingGuildProductRule[];

    const products = await this.fetchSetupProducts(job.authUserId);

    const guildRolesSummary = guild.roles.cache
      .filter((r) => !r.managed && r.id !== guild.id && r.name !== '@everyone')
      .map((r) => ({ id: r.id, name: r.name, position: r.position }))
      .sort((a, b) => b.position - a.position);

    let planEntryCount = 0;
    for (const product of products) {
      if (this.matchesExistingGuildRule(existingRules, product)) {
        continue;
      }

      const matchingRole = guild.roles.cache.find((role) => {
        if (role.managed || role.id === guild.id || role.name === '@everyone') return false;
        return normalizeSetupName(role.name) === normalizeSetupName(product.name);
      });

      const action = getDefaultRolePlanAction({
        proposedRoleId: matchingRole?.id,
        rolePlanMode: payload.rolePlanMode,
      });
      const title = `${product.name} (${product.provider})`;

      await this.convexClient.mutation(api.setupJobs.upsertSetupRecommendation, {
        apiSecret: this.apiSecret,
        setupJobId: payload.setupJobId,
        recommendationType: 'role_plan_entry',
        title,
        status: 'proposed',
        detail: matchingRole
          ? `Adopt the existing "${matchingRole.name}" role.`
          : action === 'skip'
            ? `No matching Discord role was found. This product will stay skipped until you choose a role or create one in review.`
            : `Create a new role named "${sanitizeSetupRoleName(product.name)}".`,
        payload: {
          productId: product.id,
          productName: product.name,
          provider: product.provider,
          action,
          proposedRoleName: sanitizeSetupRoleName(product.name),
          ...(matchingRole ? { proposedRoleId: matchingRole.id } : {}),
          availableGuildRoles: guildRolesSummary,
        },
      });
      planEntryCount++;
    }

    await this.convexClient.mutation(api.setupJobs.advanceSetupToReviewExceptions, {
      apiSecret: this.apiSecret,
      setupJobId: payload.setupJobId,
      planEntryCount,
    });

    this.logger.info('Setup generate plan: plan written', {
      setupJobId: payload.setupJobId,
      planEntryCount,
    });
  }

  private async processMigrationAnalyzeJob(job: OutboxJob): Promise<void> {
    const payload = job.payload as MigrationAnalyzePayload;
    if (!payload.migrationJobId || !payload.guildLinkId || !payload.guildId) {
      throw new Error('Migration analyze payload missing migrationJobId, guildLinkId, or guildId');
    }

    try {
      const activeGuildLink = await this.convexClient.query(
        api.guildLinks.getVerifyPromptMessageForBot,
        {
          apiSecret: this.apiSecret,
          guildLinkId: payload.guildLinkId,
        }
      );
      if (!activeGuildLink) {
        this.logger.info('Skipping migration analysis for disconnected guild link', {
          guildId: payload.guildId,
          migrationJobId: payload.migrationJobId,
          guildLinkId: payload.guildLinkId,
        });
        return;
      }

      const guild = await this.discordClient.guilds.fetch(payload.guildId);
      await guild.roles.fetch();

      const catalog = await this.fetchSetupCatalog(job.authUserId);
      const { products } = catalog;
      const guildRolesSummary = guild.roles.cache
        .filter((role) => !role.managed && role.id !== guild.id && role.name !== '@everyone')
        .map((role) => ({ id: role.id, name: role.name, position: role.position }))
        .sort((a, b) => b.position - a.position);

      const matchedRoleIds = new Set<string>();
      let autoMatchedCount = 0;
      let unresolvedCount = 0;
      let ignoredCount = 0;
      const unmatchedProductBehavior = payload.unmatchedProductBehavior ?? 'review';
      const cutoverStyle =
        payload.cutoverStyle ??
        (payload.mode === 'bridge_from_current_roles' || payload.mode === 'cross_server_bridge'
          ? 'parallel_run'
          : 'switch_when_ready');

      for (const product of products) {
        const matchingRole = guildRolesSummary.find(
          (role) =>
            !matchedRoleIds.has(role.id) &&
            normalizeSetupName(role.name) === normalizeSetupName(product.name)
        );

        if (matchingRole) {
          matchedRoleIds.add(matchingRole.id);
          autoMatchedCount++;
          await this.convexClient.mutation(api.setupJobs.upsertMigrationRoleMapping, {
            apiSecret: this.apiSecret,
            migrationJobId: payload.migrationJobId,
            provider: product.provider,
            sourceRoleId: matchingRole.id,
            sourceRoleName: matchingRole.name,
            targetProductId: product.id,
            targetProductName: product.name,
            targetRoleId: matchingRole.id,
            targetRoleName: matchingRole.name,
            matchStrategy: 'exact_name',
            confidence: 1,
            status: 'auto_matched',
            payload: {
              productUrl: product.productUrl,
            },
          });
          continue;
        }

        const unresolvedStatus =
          unmatchedProductBehavior === 'ignore' ? ('ignored' as const) : ('unresolved' as const);
        if (unresolvedStatus === 'ignored') {
          ignoredCount++;
        } else {
          unresolvedCount++;
        }
        await this.convexClient.mutation(api.setupJobs.upsertMigrationRoleMapping, {
          apiSecret: this.apiSecret,
          migrationJobId: payload.migrationJobId,
          provider: product.provider,
          sourceRoleName: `Missing role for ${product.name} (${product.provider})`,
          targetProductId: product.id,
          targetProductName: product.name,
          matchStrategy: 'manual',
          status: unresolvedStatus,
          reviewNote:
            unresolvedStatus === 'ignored'
              ? `No existing Discord role matched "${product.name}" automatically. Ignored for now based on your migration settings.`
              : `No existing Discord role matched "${product.name}" automatically.`,
          payload: {
            availableGuildRoles: guildRolesSummary,
            proposedRoleName: sanitizeSetupRoleName(product.name),
            productUrl: product.productUrl,
          },
        });
      }

      const summary = {
        productCount: products.length,
        guildRoleCount: guildRolesSummary.length,
        autoMatchedCount,
        unresolvedCount,
        ignoredCount,
        unmatchedGuildRoleCount: Math.max(guildRolesSummary.length - matchedRoleIds.size, 0),
        preferences: {
          unmatchedProductBehavior,
          cutoverStyle,
        },
      };
      const nextPhase =
        products.length === 0
          ? 'bridged'
          : unresolvedCount > 0
            ? 'bridged'
            : cutoverStyle === 'parallel_run' || payload.mode === 'bridge_from_current_roles'
              ? 'shadow'
              : 'enforced';
      const blockingReason =
        products.length === 0
          ? buildMigrationEmptyCatalogReason(catalog)
          : unresolvedCount > 0
            ? 'Review the unresolved role matches below before switching from your current bot.'
            : cutoverStyle === 'parallel_run' || payload.mode === 'bridge_from_current_roles'
              ? 'YUCP has matched your existing roles. Keep your current bot installed while you review the results below.'
              : null;

      await Promise.all([
        this.convexClient.mutation(api.setupJobs.upsertMigrationSource, {
          apiSecret: this.apiSecret,
          migrationJobId: payload.migrationJobId,
          sourceKey: 'existing-discord-state',
          sourceType: 'server_export',
          capabilityMode: 'analysis_only',
          status: 'connected',
          displayName: 'Existing Discord state snapshot',
          payload: summary,
        }),
        this.convexClient.mutation(api.setupJobs.appendMigrationEvent, {
          apiSecret: this.apiSecret,
          migrationJobId: payload.migrationJobId,
          phase: 'analyze',
          level: 'info',
          eventType: 'migration.analysis.completed',
          message:
            products.length === 0
              ? buildMigrationEmptyCatalogEventMessage(catalog)
              : `Migration analysis found ${autoMatchedCount} automatic role match${autoMatchedCount === 1 ? '' : 'es'}, ${unresolvedCount} product${unresolvedCount === 1 ? '' : 's'} that still need review, and ${ignoredCount} ignored product${ignoredCount === 1 ? '' : 's'}.`,
          payload: summary,
        }),
        this.convexClient.mutation(api.setupJobs.updateMigrationJobState, {
          apiSecret: this.apiSecret,
          migrationJobId: payload.migrationJobId,
          status: 'waiting_for_user',
          currentPhase: nextPhase,
          blockingReason,
          summary,
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Promise.all([
        this.convexClient.mutation(api.setupJobs.appendMigrationEvent, {
          apiSecret: this.apiSecret,
          migrationJobId: payload.migrationJobId,
          phase: 'analyze',
          level: 'error',
          eventType: 'migration.analysis.failed',
          message: `Migration analysis failed: ${message}`,
          payload: { error: message },
        }),
        this.convexClient.mutation(api.setupJobs.updateMigrationJobState, {
          apiSecret: this.apiSecret,
          migrationJobId: payload.migrationJobId,
          status: 'failed',
          currentPhase: 'analyze',
          blockingReason: message,
        }),
      ]);
      throw error;
    }
  }

  private async processSetupApplyJob(job: OutboxJob): Promise<void> {
    const payload = job.payload as SetupApplyPayload;
    if (!payload.setupJobId || !payload.guildLinkId || !payload.guildId) {
      throw new Error('Setup apply payload missing setupJobId, guildLinkId, or guildId');
    }

    try {
      const activeGuildLink = await this.convexClient.query(
        api.guildLinks.getVerifyPromptMessageForBot,
        {
          apiSecret: this.apiSecret,
          guildLinkId: payload.guildLinkId,
        }
      );
      if (!activeGuildLink) {
        this.logger.info('Skipping setup apply for disconnected guild link', {
          guildId: payload.guildId,
          setupJobId: payload.setupJobId,
          guildLinkId: payload.guildLinkId,
        });
        return;
      }

      const guild = await this.discordClient.guilds.fetch(payload.guildId);
      await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.members.fetchMe()]);
      this.logger.info('Setup apply: guild fetched', {
        guildId: guild.id,
        botHighestRole: guild.members.me?.roles.highest
          ? `${guild.members.me.roles.highest.name} (pos ${guild.members.me.roles.highest.position})`
          : 'none',
        mfaLevel: guild.mfaLevel,
        features: [...guild.features],
      });

      const existingRules = (await this.convexClient.query(
        api.role_rules.getByGuildWithProductNames,
        {
          apiSecret: this.apiSecret,
          authUserId: job.authUserId,
          guildId: payload.guildId,
        }
      )) as ExistingGuildProductRule[];

      let createdRoleCount = 0;
      let adoptedRoleCount = 0;
      let createdRuleCount = 0;
      let reusedVerifyPrompt = false;
      let createdVerifyPrompt = false;

      // Fetch the plan entries written by setup_generate_plan. Fall back to legacy
      // name-matching when no entries exist (e.g., old in-progress jobs).
      const planEntries = (await this.convexClient.query(api.setupJobs.getSetupRolePlanEntries, {
        apiSecret: this.apiSecret,
        setupJobId: payload.setupJobId,
      })) as Array<{
        _id: string;
        title: string;
        status?: 'proposed' | 'applied' | 'dismissed' | 'superseded' | 'requires_attention';
        detail?: string | null;
        payload?: {
          productId: string;
          productName: string;
          provider: string;
          action: 'create_role' | 'adopt_role' | 'skip';
          proposedRoleName: string;
          proposedRoleId?: string;
          appliedRoleId?: string;
          appliedRuleId?: string;
          userOverride?: {
            action: 'create_role' | 'adopt_role' | 'skip';
            targetRoleId?: string;
            targetRoleName?: string;
          };
        };
      }>;

      if (planEntries.length > 0) {
        for (const entry of planEntries) {
          const ep = entry.payload;
          if (!ep) continue;
          const effectiveAction = ep.userOverride?.action ?? ep.action;
          if (effectiveAction === 'skip') continue;
          const product = {
            id: ep.productId,
            name: ep.productName,
            provider: ep.provider as ProviderKey,
          };
          if (this.matchesExistingGuildRule(existingRules, product)) {
            await this.persistSetupRolePlanEntry(entry, payload.setupJobId, {
              ...ep,
              appliedRoleId: ep.appliedRoleId ?? ep.userOverride?.targetRoleId ?? ep.proposedRoleId,
            });
            continue;
          }

          let targetRoleId: string;
          if (effectiveAction === 'adopt_role') {
            const roleId = ep.userOverride?.targetRoleId ?? ep.appliedRoleId ?? ep.proposedRoleId;
            if (!roleId) continue;
            const hierarchyCheck = canBotManageRole(guild, roleId);
            if (!hierarchyCheck.canManage) {
              throw new Error(
                `Cannot adopt role for ${ep.productName}: ${hierarchyCheck.reason ?? 'role hierarchy blocks automation.'}`
              );
            }
            targetRoleId = roleId;
            adoptedRoleCount++;
          } else {
            const roleName = ep.userOverride?.targetRoleName ?? ep.proposedRoleName;
            const persistedRole =
              ep.appliedRoleId && guild.roles.cache.get(ep.appliedRoleId)
                ? guild.roles.cache.get(ep.appliedRoleId)
                : null;
            const role =
              persistedRole ??
              (await guild.roles.create({
                name: roleName,
                reason: 'Automatic setup apply',
              }));
            const hierarchyCheck = canBotManageRole(guild, role.id);
            if (!hierarchyCheck.canManage) {
              if (!persistedRole) {
                await role.delete('Created during setup apply but bot cannot manage it');
              }
              throw new Error(
                `Created a role for ${ep.productName} but the bot cannot manage it: ${hierarchyCheck.reason ?? 'role hierarchy blocks automation.'}`
              );
            }
            if (!persistedRole) {
              await this.persistSetupRolePlanEntry(entry, payload.setupJobId, {
                ...ep,
                appliedRoleId: role.id,
              });
            }
            targetRoleId = role.id;
            if (!persistedRole) {
              createdRoleCount++;
            }
          }

          const descriptor = getProviderDescriptor(ep.provider);
          const catalogProduct = await this.convexClient.mutation(
            api.role_rules.addProductForProvider,
            {
              apiSecret: this.apiSecret,
              authUserId: job.authUserId,
              productId: product.id,
              providerProductRef: product.id,
              provider: product.provider,
              displayName: product.name,
              productUrl: buildCatalogProductUrl(product.provider, product.id) ?? undefined,
              supportsAutoDiscovery: descriptor?.supportsAutoDiscovery ?? false,
            }
          );

          const createdRule = await this.convexClient.mutation(api.role_rules.createRoleRule, {
            apiSecret: this.apiSecret,
            authUserId: job.authUserId,
            guildId: payload.guildId,
            guildLinkId: payload.guildLinkId,
            productId: catalogProduct.productId,
            catalogProductId: catalogProduct.catalogProductId,
            verifiedRoleId: targetRoleId,
          });
          await this.persistSetupRolePlanEntry(
            entry,
            payload.setupJobId,
            {
              ...ep,
              appliedRoleId: targetRoleId,
              appliedRuleId: createdRule.ruleId,
            },
            'applied'
          );
          existingRules.push({
            productId: catalogProduct.productId,
            displayName: product.name,
            provider: product.provider,
            verifiedRoleId: targetRoleId,
            enabled: true,
          });
          createdRuleCount++;
        }
      } else {
        // Legacy fallback: name-match against live product list.
        const products = await this.fetchSetupProducts(job.authUserId);
        for (const product of products) {
          if (this.matchesExistingGuildRule(existingRules, product)) continue;

          const matchingRole = guild.roles.cache.find((role) => {
            if (role.managed || role.id === guild.id || role.name === '@everyone') return false;
            return normalizeSetupName(role.name) === normalizeSetupName(product.name);
          });

          let targetRoleId: string;
          if (matchingRole) {
            const hierarchyCheck = canBotManageRole(guild, matchingRole.id);
            if (!hierarchyCheck.canManage) {
              throw new Error(
                `Cannot adopt the existing "${matchingRole.name}" role for ${product.name}: ${hierarchyCheck.reason ?? 'role hierarchy blocks automation.'}`
              );
            }
            targetRoleId = matchingRole.id;
            adoptedRoleCount++;
          } else {
            const role = await guild.roles.create({
              name: sanitizeSetupRoleName(product.name),
              reason: 'Automatic setup apply',
            });
            const hierarchyCheck = canBotManageRole(guild, role.id);
            if (!hierarchyCheck.canManage) {
              await role.delete('Created during setup apply but bot cannot manage it');
              throw new Error(
                `Created a role for ${product.name} but the bot cannot manage it: ${hierarchyCheck.reason ?? 'role hierarchy blocks automation.'}`
              );
            }
            targetRoleId = role.id;
            createdRoleCount++;
          }

          const descriptor = getProviderDescriptor(product.provider);
          const catalogProduct = await this.convexClient.mutation(
            api.role_rules.addProductForProvider,
            {
              apiSecret: this.apiSecret,
              authUserId: job.authUserId,
              productId: product.id,
              providerProductRef: product.id,
              provider: product.provider,
              displayName: product.name,
              productUrl:
                product.productUrl ??
                buildCatalogProductUrl(product.provider, product.id) ??
                undefined,
              supportsAutoDiscovery: descriptor?.supportsAutoDiscovery ?? false,
            }
          );

          await this.convexClient.mutation(api.role_rules.createRoleRule, {
            apiSecret: this.apiSecret,
            authUserId: job.authUserId,
            guildId: payload.guildId,
            guildLinkId: payload.guildLinkId,
            productId: catalogProduct.productId,
            catalogProductId: catalogProduct.catalogProductId,
            verifiedRoleId: targetRoleId,
          });
          existingRules.push({
            productId: catalogProduct.productId,
            displayName: product.name,
            provider: product.provider,
            verifiedRoleId: targetRoleId,
            enabled: true,
          });
          createdRuleCount++;
        }
      }

      if (!payload.skipVerifyPrompt && payload.verificationMessageMode === 'reuse_existing') {
        this.logger.info('Setup apply: starting verify prompt step', {
          guildId: payload.guildId,
          authUserId: job.authUserId,
        });
        let verifyResult: {
          reused: boolean;
          created: boolean;
          channelId?: string;
          messageId?: string;
        } | null = null;
        let verifyError: string | null = null;
        try {
          verifyResult = await this.ensureSetupVerifyPrompt({
            authUserId: job.authUserId,
            guildLinkId: payload.guildLinkId,
            guildId: payload.guildId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn('Setup apply: verify prompt step failed (non-fatal)', {
            guildId: payload.guildId,
            authUserId: job.authUserId,
            error: msg,
          });
          verifyError = msg;
        }

        if (verifyResult) {
          reusedVerifyPrompt = verifyResult.reused;
          createdVerifyPrompt = verifyResult.created;
          await this.convexClient.mutation(api.setupJobs.upsertSetupRecommendation, {
            apiSecret: this.apiSecret,
            setupJobId: payload.setupJobId,
            recommendationType: reusedVerifyPrompt
              ? 'verify_surface_reuse'
              : 'verify_surface_creation',
            title: reusedVerifyPrompt
              ? 'Reuse the current verify prompt'
              : 'Create a dedicated verify surface',
            status: 'applied',
            detail: reusedVerifyPrompt
              ? 'The saved verify prompt was still valid and has been kept in place.'
              : 'Updated the existing verification prompt in Discord.',
            payload: verifyResult,
          });
        } else {
          await this.convexClient.mutation(api.setupJobs.upsertSetupRecommendation, {
            apiSecret: this.apiSecret,
            setupJobId: payload.setupJobId,
            recommendationType: 'verify_surface_creation',
            title: 'Reconnect your verification message',
            status: 'requires_attention',
            detail:
              `YUCP could not reuse the saved verification message (${verifyError ?? 'unknown error'}). ` +
              'Automatic channel creation is off. Connect an existing verification message again, or create one manually after setup.',
            payload: { error: verifyError },
          });
        }
      } else {
        this.logger.info('Setup apply: leaving verification message unchanged', {
          guildId: payload.guildId,
          authUserId: job.authUserId,
        });
      }

      const now = Date.now();
      await Promise.all([
        this.convexClient.mutation(api.setupJobs.upsertSetupRecommendation, {
          apiSecret: this.apiSecret,
          setupJobId: payload.setupJobId,
          recommendationType: adoptedRoleCount > 0 ? 'role_adoption' : 'role_creation',
          title:
            adoptedRoleCount > 0
              ? 'Reuse existing role rules'
              : 'Create product roles from the recommended plan',
          status: 'applied',
          detail:
            adoptedRoleCount > 0
              ? `Adopted ${adoptedRoleCount} existing Discord role${adoptedRoleCount === 1 ? '' : 's'} and created ${createdRuleCount} product rule${createdRuleCount === 1 ? '' : 's'}.`
              : `Created ${createdRoleCount} Discord role${createdRoleCount === 1 ? '' : 's'} and ${createdRuleCount} product rule${createdRuleCount === 1 ? '' : 's'}.`,
          payload: { adoptedRoleCount, createdRoleCount, createdRuleCount },
        }),
        this.convexClient.mutation(api.setupJobs.upsertSetupStep, {
          apiSecret: this.apiSecret,
          setupJobId: payload.setupJobId,
          stepKey: 'apply-setup',
          phase: 'apply_setup',
          label: 'Apply setup',
          stepKind: 'apply',
          status: 'completed',
          sortOrder: 4,
          blocking: false,
          requiresUserAction: false,
          result: {
            adoptedRoleCount,
            createdRoleCount,
            createdRuleCount,
            reusedVerifyPrompt,
            createdVerifyPrompt,
            completedAt: now,
          },
        }),
        this.convexClient.mutation(api.setupJobs.upsertSetupStep, {
          apiSecret: this.apiSecret,
          setupJobId: payload.setupJobId,
          stepKey: 'shadow-migration',
          phase: 'shadow_migration',
          label: 'Shadow migration',
          stepKind: 'migration',
          status: 'completed',
          sortOrder: 5,
          blocking: false,
          requiresUserAction: false,
          result: { mode: 'automatic_setup' },
        }),
        this.convexClient.mutation(api.setupJobs.upsertSetupStep, {
          apiSecret: this.apiSecret,
          setupJobId: payload.setupJobId,
          stepKey: 'confirm-cutover',
          phase: 'confirm_cutover',
          label: 'Confirm cutover',
          stepKind: 'cutover',
          status: 'completed',
          sortOrder: 6,
          blocking: true,
          requiresUserAction: true,
          result: { mode: 'automatic_setup', completedAutomatically: true },
        }),
        this.convexClient.mutation(api.setupJobs.appendSetupEvent, {
          apiSecret: this.apiSecret,
          setupJobId: payload.setupJobId,
          level: 'success',
          eventType: 'setup.apply.completed',
          message: `Applied automatic setup for ${createdRuleCount} product mapping${createdRuleCount === 1 ? '' : 's'}.`,
          payload: {
            adoptedRoleCount,
            createdRoleCount,
            createdRuleCount,
            reusedVerifyPrompt,
            createdVerifyPrompt,
          },
        }),
        this.convexClient.mutation(api.setupJobs.updateSetupJobState, {
          apiSecret: this.apiSecret,
          setupJobId: payload.setupJobId,
          status: 'completed',
          currentPhase: 'confirm_cutover',
          activeStepKey: 'confirm-cutover',
          blockingReason: null,
          summary: {
            adoptedRoleCount,
            createdRoleCount,
            createdRuleCount,
            reusedVerifyPrompt,
            createdVerifyPrompt,
            appliedAt: now,
          },
        }),
      ]);
    } catch (error) {
      const message = this.translateSetupApplyError(error);
      await Promise.all([
        this.convexClient.mutation(api.setupJobs.upsertSetupStep, {
          apiSecret: this.apiSecret,
          setupJobId: payload.setupJobId,
          stepKey: 'apply-setup',
          phase: 'apply_setup',
          label: 'Apply setup',
          stepKind: 'apply',
          status: 'failed',
          sortOrder: 4,
          blocking: false,
          requiresUserAction: false,
          errorSummary: message,
        }),
        this.convexClient.mutation(api.setupJobs.appendSetupEvent, {
          apiSecret: this.apiSecret,
          setupJobId: payload.setupJobId,
          level: 'error',
          eventType: 'setup.apply.failed',
          message: `Automatic setup failed: ${message}`,
          payload: { error: message },
        }),
        this.convexClient.mutation(api.setupJobs.updateSetupJobState, {
          apiSecret: this.apiSecret,
          setupJobId: payload.setupJobId,
          status: 'failed',
          currentPhase: 'apply_setup',
          activeStepKey: 'apply-setup',
          blockingReason: message,
        }),
      ]);
      throw error;
    }
  }

  /**
   * Process retroactive rule sync job.
   * For all products (including discord_role): creates role_sync jobs for users who already have
   * entitlements. Discord role products grant entitlements when users verify via OAuth ("Use
   * Another Server")-we check their roles via the Discord API with their token. Retroactive sync
   * ensures those verified users get the role in the target guild. We cannot proactively find
   * users who have the role but haven't verified-that requires each user's OAuth token.
   */
  private async processRetroactiveRuleSyncJob(job: OutboxJob): Promise<void> {
    const payload = job.payload as RetroactiveRuleSyncPayload;
    if (!payload.authUserId || !payload.productId) {
      throw new Error('Retroactive rule sync payload missing authUserId or productId');
    }

    const result = (await this.convexClient.mutation(
      api.backgroundSync.processRetroactiveRuleSyncJob,
      {
        apiSecret: this.apiSecret,
        jobId: job._id,
        authUserId: payload.authUserId,
        productId: payload.productId,
      }
    )) as {
      success: boolean;
      roleSyncJobsCreated: number;
      entitlementsFound: number;
      skippedNoDiscordId: number;
      skippedDuplicate: number;
      discordTokenAccounts?: Array<{
        externalAccountId: string;
        providerUserId: string;
        discordAccessTokenEncrypted: string;
        discordTokenExpiresAt?: number;
        discordRefreshTokenEncrypted?: string;
      }>;
    };

    this.logger.info('Retroactive entitlement sync completed', {
      productId: payload.productId,
      roleSyncJobsCreated: result.roleSyncJobsCreated,
      entitlementsFound: result.entitlementsFound,
    });

    // For discord_role products: proactively check guild membership using stored tokens
    if (
      result.discordTokenAccounts &&
      result.discordTokenAccounts.length > 0 &&
      payload.productId.startsWith('discord_role:')
    ) {
      await this.proactiveDiscordRoleCheck(
        payload.authUserId,
        payload.productId,
        result.discordTokenAccounts
      );
    }
  }

  /**
   * Proactively check guild membership for users with stored Discord OAuth tokens.
   * Used during retroactive sync when a new discord_role product is added.
   */
  private async proactiveDiscordRoleCheck(
    authUserId: string,
    productId: string,
    accounts: Array<{
      externalAccountId: string;
      providerUserId: string;
      discordAccessTokenEncrypted: string;
      discordTokenExpiresAt?: number;
    }>
  ): Promise<void> {
    if (!this.encryptionSecret) {
      this.logger.warn('Cannot do proactive discord role check: no encryptionSecret configured');
      return;
    }

    // Parse sourceGuildId and requiredRoleId from productId: "discord_role:<sourceGuildId>:<requiredRoleId>"
    const parts = productId.split(':');
    if (parts.length < 3) {
      this.logger.warn('Invalid discord_role productId format', { productId });
      return;
    }
    const sourceGuildId = parts[1];
    const requiredRoleId = parts[2];

    this.logger.info('Starting proactive discord role check', {
      authUserId,
      productId,
      sourceGuildId,
      requiredRoleId,
      accountCount: accounts.length,
    });

    let granted = 0;
    let skipped = 0;
    let expired = 0;
    let failed = 0;

    for (const account of accounts) {
      try {
        // Check if token is expired
        if (account.discordTokenExpiresAt && Date.now() > account.discordTokenExpiresAt) {
          expired++;
          continue;
        }

        // Decrypt the access token
        const accessToken = await this.decryptToken(
          account.discordAccessTokenEncrypted,
          this.encryptionSecret
        );

        // Check guild membership using the user's OAuth token
        const memberRes = await fetch(
          `https://discord.com/api/v10/users/@me/guilds/${sourceGuildId}/member`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (memberRes.status === 429) {
          const retryAfter = memberRes.headers.get('Retry-After');
          const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
          await new Promise((r) => setTimeout(r, waitMs));
          continue; // Skip this user for now, will be retried
        }

        if (!memberRes.ok) {
          skipped++;
          continue;
        }

        const member = (await memberRes.json()) as { roles?: string[] };
        const roles = member.roles ?? [];
        const hasRole =
          roles.includes(requiredRoleId) || (requiredRoleId === sourceGuildId && memberRes.ok);

        if (hasRole) {
          // Find or create subject for this Discord user
          const subjectId = await this.convexClient.mutation(
            api.identitySync.getOrCreateSubjectForDiscordUser,
            {
              apiSecret: this.apiSecret,
              discordUserId: account.providerUserId,
            }
          );

          // Grant entitlement
          const sourceReference = `discord_role:${sourceGuildId}:${requiredRoleId}`;
          await this.convexClient.mutation(api.entitlements.grantEntitlement, {
            apiSecret: this.apiSecret,
            authUserId,
            subjectId,
            productId,
            evidence: {
              provider: 'discord',
              sourceReference,
            },
          });
          granted++;
        } else {
          skipped++;
        }
      } catch (err) {
        failed++;
        this.logger.warn('Proactive discord role check failed for account', {
          providerUserId: account.providerUserId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.info('Proactive discord role check completed', {
      authUserId,
      productId,
      granted,
      skipped,
      expired,
      failed,
      total: accounts.length,
    });
  }

  /**
   * Decrypt an encrypted token using AES-256-GCM.
   * Same algorithm as apps/api/src/lib/encrypt.ts.
   */
  private async decryptToken(ciphertextB64: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
    const key = await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['decrypt']);
    const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(decrypted);
  }

  /**
   * Add a role to a guild member.
   * Uses member.roles.add() per discord.js docs.
   * Bot needs MANAGE_ROLES and its role must be above the target role in hierarchy.
   */
  private async addRoleToMember(
    guildId: string,
    discordUserId: string,
    roleId: string
  ): Promise<{ added: boolean; error?: string; nonRetriable?: boolean }> {
    const guild = this.discordClient.guilds.cache.get(guildId);

    if (!guild) {
      return { added: false, error: 'Guild not found or bot not in guild' };
    }

    // Role hierarchy: bot can only assign roles below its highest role
    const role = guild.roles.cache.get(roleId);
    const botMember = guild.members.me;
    if (role && botMember && role.position >= botMember.roles.highest.position) {
      return {
        added: false,
        error: `Role hierarchy: verified role is at or above bot's role. Move the bot's role higher in Server Settings > Roles.`,
        nonRetriable: true,
      };
    }

    // Wait for rate limit
    const route = `guilds/${guildId}/members/${discordUserId}`;
    await this.rateLimiter.waitForRateLimit(route);

    try {
      let member: GuildMember;
      try {
        member = await guild.members.fetch(discordUserId);
      } catch (fetchErr) {
        const code = (fetchErr as { code?: number })?.code;
        this.logger.warn('guild.members.fetch failed', {
          guildId,
          discordUserId,
          roleId,
          errorCode: code,
          errorMessage: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        });
        throw fetchErr;
      }

      // Already has role = success (idempotent)
      if (member.roles.cache.has(roleId)) {
        return { added: true };
      }

      // Check if role is managed (integration/booster roles can't be assigned by bot)
      const role = guild.roles.cache.get(roleId);
      if (role?.managed) {
        return {
          added: false,
          error: `Role "${role.name}" is managed by an integration and cannot be assigned by the bot. Create a new role for verification.`,
          nonRetriable: true,
        };
      }

      // Add the role
      try {
        await member.roles.add(roleId, 'Entitlement sync - role granted');
      } catch (addErr) {
        const code = (addErr as { code?: number })?.code;
        this.logger.warn('member.roles.add failed', {
          guildId,
          discordUserId,
          roleId,
          errorCode: code,
          errorMessage: addErr instanceof Error ? addErr.message : String(addErr),
        });
        throw addErr;
      }

      this.logger.info('Role added to member', {
        guildId,
        discordUserId,
        roleId,
      });

      return { added: true };
    } catch (error) {
      // Handle Discord API errors
      if (this.isDiscordError(error)) {
        const discordError = error as { code: number; message: string };

        // Handle specific error codes
        if (discordError.code === RESTJSONErrorCodes.UnknownMember) {
          return { added: false, error: 'Member not found in guild' };
        }
        if (discordError.code === RESTJSONErrorCodes.UnknownRole) {
          return { added: false, error: 'Role not found' };
        }
        if (discordError.code === RESTJSONErrorCodes.MissingPermissions) {
          return {
            added: false,
            error:
              'Bot lacks permission: Grant "Manage Roles" to the bot and ensure the bot\'s role is above the verified role in Server Settings → Roles.',
            nonRetriable: true,
          };
        }
        // 50001 Missing Access: Server Members Intent, managed role, or bot not in guild
        if (discordError.code === 50001) {
          return {
            added: false,
            error:
              'Missing Access (50001): Enable Server Members Intent in Developer Portal, ensure the role is not managed by an integration, and that the bot is in the guild.',
            nonRetriable: true,
          };
        }

        return { added: false, error: `Discord error: ${discordError.message}` };
      }

      throw error;
    }
  }

  /**
   * Remove a role from a guild member.
   * Bot needs MANAGE_ROLES and its role must be above the target role in hierarchy.
   */
  private async removeRoleFromMember(
    guildId: string,
    discordUserId: string,
    roleId: string
  ): Promise<{ removed: boolean; error?: string; nonRetriable?: boolean }> {
    const guild = this.discordClient.guilds.cache.get(guildId);

    if (!guild) {
      return { removed: false, error: 'Guild not found or bot not in guild' };
    }

    // Role hierarchy: bot can only manage roles below its highest role
    const role = guild.roles.cache.get(roleId);
    const botMember = guild.members.me;
    if (role && botMember && role.position >= botMember.roles.highest.position) {
      return {
        removed: false,
        error: `Role hierarchy: verified role is at or above bot's role. Move the bot's role higher in Server Settings > Roles.`,
        nonRetriable: true,
      };
    }

    // Wait for rate limit
    const route = `guilds/${guildId}/members/${discordUserId}`;
    await this.rateLimiter.waitForRateLimit(route);

    try {
      // Fetch or get member from cache
      let member: GuildMember | undefined;
      try {
        member = await guild.members.fetch(discordUserId);
      } catch {
        // Member not in guild, role removal not needed
        return { removed: true, error: 'Member not in guild, role effectively removed' };
      }

      // Already doesn't have role = success (idempotent)
      if (!member.roles.cache.has(roleId)) {
        return { removed: true };
      }

      // Remove the role
      await member.roles.remove(roleId, 'Entitlement sync - role revoked');

      this.logger.info('Role removed from member', {
        guildId,
        discordUserId,
        roleId,
      });

      return { removed: true };
    } catch (error) {
      // Handle Discord API errors
      if (this.isDiscordError(error)) {
        const discordError = error as { code: number; message: string };

        if (discordError.code === RESTJSONErrorCodes.UnknownRole) {
          return { removed: true, error: 'Role no longer exists' };
        }
        if (discordError.code === RESTJSONErrorCodes.MissingPermissions) {
          return {
            removed: false,
            error: 'Bot lacks permission to manage roles',
            nonRetriable: true,
          };
        }

        return { removed: false, error: `Discord error: ${discordError.message}` };
      }

      throw error;
    }
  }

  /**
   * Handle job failure with retry logic.
   */
  private async handleJobFailure(job: OutboxJob, error: string): Promise<void> {
    const newRetryCount = job.retryCount + 1;

    this.logger.warn('Job failed', {
      jobId: job._id,
      retryCount: newRetryCount,
      maxRetries: job.maxRetries,
      error,
    });

    if (newRetryCount >= job.maxRetries) {
      // Move to dead letter queue
      await this.updateJobStatus(job._id, 'dead_letter', error);
      this.logger.error('Job moved to dead letter queue', {
        jobId: job._id,
        totalRetries: newRetryCount,
      });
    } else {
      // Schedule retry with backoff
      const backoffMs = this.rateLimiter.calculateBackoff(newRetryCount);
      const nextRetryAt = Date.now() + backoffMs;

      await this.updateJobStatus(job._id, 'pending', error, nextRetryAt);
    }
  }

  /**
   * Emit audit event for role sync operation.
   */
  private async emitAuditEvent(job: OutboxJob, result: RoleSyncResult): Promise<void> {
    try {
      const eventType =
        job.jobType === 'role_sync'
          ? 'discord.role.sync.completed'
          : 'discord.role.removal.completed';

      await this.convexClient.mutation(api.audit_events.createAuditEvent, {
        apiSecret: this.apiSecret,
        authUserId: job.authUserId,
        eventType,
        actorType: 'system',
        actorId: 'role-sync-service',
        subjectId: (job.payload as RoleSyncPayload).subjectId,
        metadata: {
          jobId: job._id,
          jobType: job.jobType,
          guildId: result.guildId,
          discordUserId: result.discordUserId,
          rolesAdded: result.rolesAdded,
          rolesRemoved: result.rolesRemoved,
          success: result.success,
          error: result.error,
        },
      });
    } catch (error) {
      // Don't fail the job if audit logging fails
      this.logger.error('Failed to emit audit event', {
        jobId: job._id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ============================================================================
  // CONVEX API HELPERS
  // ============================================================================

  /**
   * Fetch pending outbox jobs for role sync.
   */
  private async fetchPendingJobs(): Promise<OutboxJob[]> {
    return withBotStageSpan(
      'outbox.fetch_pending',
      {
        limit: 10,
      },
      async () => {
        try {
          const jobs = await this.convexClient.query(api.outbox_jobs.getPendingJobs, {
            apiSecret: this.apiSecret,
            jobTypes: [
              'role_sync',
              'role_removal',
              'creator_alert',
              'retroactive_rule_sync',
              'migration_analyze',
              'setup_apply',
              'setup_generate_plan',
              'verify_prompt_refresh',
            ],
            limit: 10,
          });

          return jobs as OutboxJob[];
        } catch (error) {
          this.logger.error('Failed to fetch pending jobs', {
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }
    );
  }

  /**
   * Update outbox job status.
   */
  private async updateJobStatus(
    jobId: Id<'outbox_jobs'>,
    status: OutboxJob['status'],
    error?: string,
    nextRetryAt?: number
  ): Promise<void> {
    await withBotStageSpan(
      'outbox.update_status',
      {
        jobId,
        status,
        hasError: Boolean(error),
        hasNextRetryAt: nextRetryAt !== undefined,
      },
      async () => {
        try {
          await this.convexClient.mutation(api.outbox_jobs.updateJobStatus, {
            apiSecret: this.apiSecret,
            jobId,
            status,
            error,
            nextRetryAt,
          });
        } catch (updateError) {
          this.logger.error('Failed to update job status', {
            jobId,
            status,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        }
      }
    );
  }

  /**
   * Fetch role rules for a creator and product.
   */
  private async fetchRoleRules(authUserId: string, productId: string): Promise<RoleRule[]> {
    return withBotStageSpan(
      'role_rules.fetch',
      {
        authUserId,
        productId,
      },
      async () => {
        try {
          const rules = await this.convexClient.query(api.role_rules.getByProduct, {
            apiSecret: this.apiSecret,
            authUserId,
            productId,
          });

          return rules as RoleRule[];
        } catch (error) {
          this.logger.error('Failed to fetch role rules', {
            authUserId,
            productId,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }
    );
  }

  /**
   * Fetch entitlement by ID.
   */
  private async fetchEntitlement(entitlementId: Id<'entitlements'>): Promise<Entitlement | null> {
    return withBotStageSpan(
      'entitlement.fetch',
      {
        entitlementId,
      },
      async () => {
        try {
          const result = await this.convexClient.query(api.entitlements.getEntitlement, {
            apiSecret: this.apiSecret,
            entitlementId,
          });

          if (result.found) {
            return result.entitlement as Entitlement;
          }
          return null;
        } catch (error) {
          this.logger.error('Failed to fetch entitlement', {
            entitlementId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }
    );
  }

  private async fetchActiveCatalogTierIds(
    entitlementId: Id<'entitlements'>
  ): Promise<Array<Id<'catalog_tiers'>>> {
    return withBotStageSpan(
      'catalog_tiers.fetch_active',
      {
        entitlementId,
      },
      async () => {
        try {
          const tierIds = await this.convexClient.query(
            api.catalogTiers.getActiveCatalogTierIdsForEntitlement,
            {
              apiSecret: this.apiSecret,
              entitlementId,
            }
          );
          return tierIds as Array<Id<'catalog_tiers'>>;
        } catch (error) {
          this.logger.error('Failed to fetch active catalog tiers for entitlement', {
            entitlementId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
    );
  }

  private async persistSetupRolePlanEntry(
    entry: {
      title: string;
      detail?: string | null;
      status?: 'proposed' | 'applied' | 'dismissed' | 'superseded' | 'requires_attention';
    },
    setupJobId: Id<'setup_jobs'>,
    payload: Record<string, unknown>,
    status:
      | 'proposed'
      | 'applied'
      | 'dismissed'
      | 'superseded'
      | 'requires_attention' = entry.status ?? 'proposed'
  ): Promise<void> {
    await this.convexClient.mutation(api.setupJobs.upsertSetupRecommendation, {
      apiSecret: this.apiSecret,
      setupJobId,
      recommendationType: 'role_plan_entry',
      title: entry.title,
      status,
      detail: entry.detail ?? undefined,
      payload,
    });
  }

  private matchesExistingGuildRule(
    existingRules: ExistingGuildProductRule[],
    product: SetupProduct
  ): boolean {
    const normalizedProductName = normalizeSetupName(product.name);
    return existingRules.some((rule) => {
      if (rule.enabled === false) {
        return false;
      }
      if (rule.provider === product.provider && rule.productId === product.id) {
        return true;
      }
      if (!rule.provider && rule.productId === product.id) {
        return true;
      }
      if (!rule.provider) {
        return normalizeSetupName(rule.displayName ?? '') === normalizedProductName;
      }
      return (
        rule.provider === product.provider &&
        normalizeSetupName(rule.displayName ?? '') === normalizedProductName
      );
    });
  }

  private async fetchSetupCatalog(authUserId: string): Promise<SetupCatalogSummary> {
    const results = await Promise.all(
      CATALOG_SYNC_PROVIDER_KEYS.map(async (providerKey) => {
        const result = await listProviderProducts(providerKey, authUserId);
        if (result.error) {
          this.logger.warn('Provider product listing returned an error during setup catalog sync', {
            authUserId,
            provider: providerKey,
            error: result.error,
          });
        }
        return {
          provider: providerKey,
          products: result.products.map((product) => ({
            id: product.id,
            name: product.name,
            productUrl: product.productUrl,
          })),
          error: result.error,
        };
      })
    );

    return summarizeSetupCatalogResults(results);
  }

  private async fetchSetupProducts(authUserId: string): Promise<SetupProduct[]> {
    const catalog = await this.fetchSetupCatalog(authUserId);
    return catalog.products;
  }

  private async ensureSetupVerifyPrompt(args: {
    authUserId: string;
    guildLinkId: Id<'guild_links'>;
    guildId: string;
  }): Promise<{ reused: boolean; created: boolean; channelId?: string; messageId?: string }> {
    const link = (await this.convexClient.query(api.guildLinks.getVerifyPromptMessageForBot, {
      apiSecret: this.apiSecret,
      guildLinkId: args.guildLinkId,
    })) as {
      authUserId: string;
      guildId: string;
      verifyPromptMessage?: {
        channelId: string;
        messageId: string;
        titleOverride?: string;
        descriptionOverride?: string;
        buttonTextOverride?: string;
        color?: number;
        imageUrl?: string;
      };
    } | null;

    if (!link) {
      throw new Error('Guild link is no longer active.');
    }

    const guild = await this.discordClient.guilds.fetch(args.guildId);
    await guild.channels.fetch();

    const providersResult = await this.convexClient.query(
      api.role_rules.getEnabledVerificationProvidersFromProducts,
      {
        apiSecret: this.apiSecret,
        authUserId: args.authUserId,
        guildId: args.guildId,
      }
    );
    const enabledSet = new Set<string>(getEnabledProviders(providersResult));
    const accessPreview = await buildVerifyPromptAccessPreview({
      convex: this.convexClient,
      discordClient: this.discordClient,
      apiSecret: this.apiSecret,
      authUserId: args.authUserId,
      guildId: args.guildId,
    });
    const { embed, row } = buildVerifyPromptMessage(
      enabledSet,
      {
        titleOverride: link.verifyPromptMessage?.titleOverride,
        descriptionOverride: link.verifyPromptMessage?.descriptionOverride,
        buttonTextOverride: link.verifyPromptMessage?.buttonTextOverride,
        color: link.verifyPromptMessage?.color,
        imageUrl: link.verifyPromptMessage?.imageUrl,
      },
      { accessPreview }
    );

    if (link.verifyPromptMessage) {
      const existingChannel = await this.discordClient.channels
        .fetch(link.verifyPromptMessage.channelId)
        .catch(() => null);
      if (existingChannel && 'messages' in existingChannel) {
        const existingMessage = await existingChannel.messages
          .fetch(link.verifyPromptMessage.messageId)
          .catch(() => null);
        if (existingMessage) {
          await existingMessage.edit({ embeds: [embed], components: [row] });
          return {
            reused: true,
            created: false,
            channelId: existingChannel.id,
            messageId: existingMessage.id,
          };
        }
      }

      await this.clearVerifyPromptMessage(args.guildLinkId);
    }

    throw new Error(
      'No reusable verification message is connected for this server. Automatic channel creation is disabled.'
    );
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Check if an error is a Discord API error.
   */
  private isDiscordError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code: unknown }).code === 'number'
    );
  }

  private isUnknownDiscordResource(error: unknown): boolean {
    if (!this.isDiscordError(error)) {
      return false;
    }

    const discordError = error as { code: number };
    return (
      discordError.code === RESTJSONErrorCodes.UnknownChannel ||
      discordError.code === RESTJSONErrorCodes.UnknownMessage
    );
  }

  /**
   * Returns true for Discord errors that will never succeed on retry regardless of timing
   * (e.g., the bot lacks a required permission in the guild configuration).
   */
  private isNonRetriableDiscordError(error: unknown): boolean {
    if (!this.isDiscordError(error)) {
      return false;
    }
    const discordError = error as { code: number };
    return discordError.code === RESTJSONErrorCodes.MissingPermissions;
  }

  /**
   * Translate raw Discord API errors (and other known errors) into actionable sentences
   * that are safe to show directly to the creator in the dashboard.
   */
  private translateSetupApplyError(error: unknown): string {
    if (this.isDiscordError(error)) {
      const discordError = error as { code: number };
      if (discordError.code === RESTJSONErrorCodes.MissingPermissions) {
        return (
          'Discord permissions missing: The YUCP bot role needs "Manage Roles" and "Manage Channels". ' +
          'In your Discord server, go to Server Settings > Roles, find the YUCP role, and turn on those two permissions. Then try setup again.'
        );
      }
      if (discordError.code === RESTJSONErrorCodes.UnknownGuild) {
        return 'The bot is no longer in your Discord server. Re-invite YUCP using the invite link in your dashboard, then try setup again.';
      }
      if (discordError.code === RESTJSONErrorCodes.MissingAccess) {
        return 'The bot cannot access one of your channels. Make sure the YUCP role has permission to view and send messages in the channels you want YUCP to use, then try setup again.';
      }
    }
    return error instanceof Error ? error.message : String(error);
  }

  private async clearVerifyPromptMessage(guildLinkId: Id<'guild_links'>): Promise<void> {
    await this.convexClient.mutation(api.guildLinks.clearVerifyPromptMessage, {
      apiSecret: this.apiSecret,
      guildLinkId,
    });
  }

  /**
   * Sleep for a specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default RoleSyncService;
