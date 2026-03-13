/**
 * Outbox Jobs - Queue for async side effects
 *
 * Provides queries and mutations for the outbox pattern:
 * - Job producers emit jobs with idempotency keys
 * - Job workers poll for pending jobs and process them
 * - Failed jobs are retried with exponential backoff
 * - Dead letter queue for permanently failed jobs
 */

import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

/** Outbox job status values */
export const OutboxJobStatus = v.union(
  v.literal('pending'),
  v.literal('in_progress'),
  v.literal('completed'),
  v.literal('failed'),
  v.literal('dead_letter')
);

/** Outbox job types */
export const OutboxJobType = v.union(
  v.literal('role_sync'),
  v.literal('role_removal'),
  v.literal('entitlement_refresh'),
  v.literal('revocation'),
  v.literal('notification'),
  v.literal('creator_alert'),
  v.literal('retroactive_rule_sync')
);

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get pending jobs for processing.
 * Returns jobs that are either pending or ready for retry.
 */
export const getPendingJobs = query({
  args: {
    apiSecret: v.string(),
    jobTypes: v.optional(v.array(OutboxJobType)),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = Math.min(args.limit ?? 10, 100);
    const now = Date.now();

    // Get pending jobs
    const pendingQuery = ctx.db
      .query('outbox_jobs')
      .withIndex('by_status', (q) => q.eq('status', 'pending'));

    // Filter by job types if specified
    if (args.jobTypes && args.jobTypes.length > 0) {
      // We need to filter after fetching since we can't combine index filters
      const allPending = await pendingQuery.take(1000);
      const filtered = allPending.filter((job) => args.jobTypes?.includes(job.jobType as any));
      return filtered.slice(0, limit);
    }

    const pendingJobs = await pendingQuery.take(limit);

    // Also get jobs ready for retry (in_progress with nextRetryAt in the past)
    const retryJobs = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_status_next_retry', (q) => q.eq('status', 'pending').lt('nextRetryAt', now))
      .take(limit - pendingJobs.length);

    return [...pendingJobs, ...retryJobs];
  },
});

/**
 * Get job by idempotency key.
 * Used for deduplication.
 */
export const getByIdempotencyKey = query({
  args: {
    apiSecret: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      job: v.any(),
    }),
    v.object({
      found: v.literal(false),
      job: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const job = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', args.idempotencyKey))
      .first();

    if (!job) {
      return { found: false as const, job: null };
    }

    return { found: true as const, job };
  },
});

/**
 * Get jobs by guild and user.
 * Useful for checking pending operations for a specific Discord user.
 */
export const getByGuildAndUser = query({
  args: {
    apiSecret: v.string(),
    guildId: v.string(),
    discordUserId: v.string(),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const jobs = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_guild_user', (q) =>
        q.eq('targetGuildId', args.guildId).eq('targetDiscordUserId', args.discordUserId)
      )
      .filter((q) => q.neq(q.field('status'), 'completed'))
      .filter((q) => q.neq(q.field('status'), 'dead_letter'))
      .take(1000);

    return jobs;
  },
});

/**
 * Get recent failed role_sync jobs for a Discord user.
 * Used to show role hierarchy / permission errors in the verify panel.
 */
export const getFailedRoleSyncForUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    discordUserId: v.string(),
    guildId: v.string(),
  },
  returns: v.array(
    v.object({
      lastError: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const jobs = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('jobType'), 'role_sync'))
      .filter((q) =>
        q.or(q.eq(q.field('status'), 'pending'), q.eq(q.field('status'), 'dead_letter'))
      )
      .take(1000);

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return jobs
      .filter((j) => {
        const payload = j.payload as { discordUserId?: string; guildId?: string };
        const matchGuild = j.targetGuildId === args.guildId || payload?.guildId === args.guildId;
        const matchUser =
          j.targetDiscordUserId === args.discordUserId ||
          payload?.discordUserId === args.discordUserId;
        const hasError = j.lastError && j.lastError.length > 0;
        const recent = (j.updatedAt ?? j.createdAt) >= oneDayAgo;
        return matchGuild && matchUser && hasError && recent;
      })
      .slice(0, 5)
      .map((j) => ({ lastError: j.lastError ?? null }));
  },
});

/**
 * Get dead letter jobs for a creator/user.
 * Used for manual review and reprocessing.
 */
export const getDeadLetterJobs = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = args.limit ?? 50;

    const jobs = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('status'), 'dead_letter'))
      .order('desc')
      .take(limit);

    return jobs;
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new outbox job.
 * Idempotent - will return existing job if idempotency key matches.
 */
export const createJob = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    jobType: OutboxJobType,
    payload: v.any(),
    idempotencyKey: v.string(),
    targetGuildId: v.optional(v.string()),
    targetDiscordUserId: v.optional(v.string()),
    maxRetries: v.optional(v.number()),
  },
  returns: v.object({
    jobId: v.id('outbox_jobs'),
    isNew: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    // Check for existing job with same idempotency key
    const existing = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', args.idempotencyKey))
      .first();

    if (existing) {
      return { jobId: existing._id, isNew: false };
    }

    const now = Date.now();

    const jobId = await ctx.db.insert('outbox_jobs', {
      authUserId: args.authUserId,
      jobType: args.jobType,
      payload: args.payload,
      status: 'pending',
      idempotencyKey: args.idempotencyKey,
      targetGuildId: args.targetGuildId,
      targetDiscordUserId: args.targetDiscordUserId,
      retryCount: 0,
      maxRetries: args.maxRetries ?? 5,
      createdAt: now,
      updatedAt: now,
    });

    return { jobId, isNew: true };
  },
});

/**
 * Update job status.
 * Used by workers to mark jobs as in_progress, completed, failed, etc.
 */
export const updateJobStatus = mutation({
  args: {
    apiSecret: v.string(),
    jobId: v.id('outbox_jobs'),
    status: OutboxJobStatus,
    error: v.optional(v.string()),
    nextRetryAt: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const job = await ctx.db.get(args.jobId);
    if (!job) {
      throw new Error(`Job not found: ${args.jobId}`);
    }

    const now = Date.now();
    const update: Record<string, unknown> = {
      status: args.status,
      updatedAt: now,
    };

    if (args.error) {
      update.lastError = args.error;
    }

    if (args.nextRetryAt) {
      update.nextRetryAt = args.nextRetryAt;
    }

    if (args.status === 'completed') {
      update.completedAt = now;
    }

    // Increment retry count if moving to pending (retry)
    if (args.status === 'pending' && job.status !== 'pending') {
      update.retryCount = job.retryCount + 1;
    }

    await ctx.db.patch(args.jobId, update);

    return { success: true };
  },
});

/**
 * Retry a dead letter job.
 * Moves job back to pending queue for reprocessing.
 */
export const retryDeadLetterJob = mutation({
  args: {
    apiSecret: v.string(),
    jobId: v.id('outbox_jobs'),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);

    const job = await ctx.db.get(args.jobId);
    if (!job) {
      throw new Error(`Job not found: ${args.jobId}`);
    }

    if (job.status !== 'dead_letter') {
      return {
        success: false,
        error: 'Job is not in dead letter queue',
      };
    }

    const now = Date.now();

    await ctx.db.patch(args.jobId, {
      status: 'pending',
      retryCount: 0,
      lastError: undefined,
      nextRetryAt: now,
      updatedAt: now,
    });

    return { success: true };
  },
});

/**
 * Clean up old completed jobs.
 * Called by scheduled jobs to keep the queue size manageable.
 */
export const cleanupCompletedJobs = mutation({
  args: {
    apiSecret: v.string(),
    olderThan: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    deletedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const limit = args.limit ?? 100;
    let deletedCount = 0;

    const jobs = await ctx.db
      .query('outbox_jobs')
      .filter((q) => q.eq(q.field('status'), 'completed'))
      .filter((q) => q.lt(q.field('updatedAt'), args.olderThan))
      .take(limit);

    for (const job of jobs) {
      await ctx.db.delete(job._id);
      deletedCount++;
    }

    return { deletedCount };
  },
});
