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

import { createStructuredLogger, type StructuredLogger } from '@yucp/shared';
import { ConvexHttpClient } from 'convex/browser';
import { Client, GuildMember, RESTJSONErrorCodes } from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { sendDashboardNotification } from '../lib/notifications';

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

/** Outbox job document type */
export interface OutboxJob {
  _id: Id<'outbox_jobs'>;
  authUserId: string;
  jobType: 'role_sync' | 'role_removal' | 'creator_alert' | 'retroactive_rule_sync';
  payload: RoleSyncPayload | RoleRemovalPayload | CreatorAlertPayload | RetroactiveRuleSyncPayload;
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

/** Role sync result */
export interface RoleSyncResult {
  success: boolean;
  guildId: string;
  discordUserId: string;
  rolesAdded: string[];
  rolesRemoved: string[];
  error?: string;
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

    this.convexClient = new ConvexHttpClient(options.convexUrl) as unknown as BotConvexClient;
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
    // Fetch pending jobs from Convex
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

  /**
   * Process a single outbox job.
   */
  private async processJob(job: OutboxJob): Promise<void> {
    this.logger.info('Processing job', {
      jobId: job._id,
      jobType: job.jobType,
      retryCount: job.retryCount,
    });

    // Mark job as in progress
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

      let result: RoleSyncResult;

      if (job.jobType === 'role_sync') {
        result = await this.processRoleSyncJob(job);
      } else if (job.jobType === 'role_removal') {
        result = await this.processRoleRemovalJob(job);
      } else {
        throw new Error(`Unknown job type: ${(job as OutboxJob).jobType}`);
      }

      if (result.success) {
        // Mark job as completed
        await this.updateJobStatus(job._id, 'completed');

        // Emit audit event
        await this.emitAuditEvent(job, result);

        this.logger.info('Job completed successfully', {
          jobId: job._id,
          rolesAdded: result.rolesAdded,
          rolesRemoved: result.rolesRemoved,
        });

        // Notify the creator dashboard (fire-and-forget)
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
      } else {
        // Handle failure with retry
        await this.handleJobFailure(job, result.error ?? 'Unknown error');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.handleJobFailure(job, errorMessage);
    }
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

    // Get all role rules for this product
    let roleRules = await this.fetchRoleRules(job.authUserId, entitlement.productId);

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
  ): Promise<{ added: boolean; error?: string }> {
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
          };
        }
        // 50001 Missing Access: Server Members Intent, managed role, or bot not in guild
        if (discordError.code === 50001) {
          return {
            added: false,
            error:
              'Missing Access (50001): Enable Server Members Intent in Developer Portal, ensure the role is not managed by an integration, and that the bot is in the guild.',
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
  ): Promise<{ removed: boolean; error?: string }> {
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
          return { removed: false, error: 'Bot lacks permission to manage roles' };
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
    try {
      const jobs = await this.convexClient.query(api.outbox_jobs.getPendingJobs, {
        apiSecret: this.apiSecret,
        jobTypes: ['role_sync', 'role_removal', 'creator_alert', 'retroactive_rule_sync'],
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

  /**
   * Update outbox job status.
   */
  private async updateJobStatus(
    jobId: Id<'outbox_jobs'>,
    status: OutboxJob['status'],
    error?: string,
    nextRetryAt?: number
  ): Promise<void> {
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

  /**
   * Fetch role rules for a creator and product.
   */
  private async fetchRoleRules(authUserId: string, productId: string): Promise<RoleRule[]> {
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

  /**
   * Fetch entitlement by ID.
   */
  private async fetchEntitlement(entitlementId: Id<'entitlements'>): Promise<Entitlement | null> {
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
