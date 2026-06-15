/**
 * Role Sync Enqueue Helpers
 *
 * Single source of truth for producing Discord role_sync / role_removal work.
 * Replaces 7 duplicated `ctx.db.insert('outbox_jobs', ...)` sites.
 *
 * Always writes the `outbox_jobs` row (idempotency record + UI projection +
 * what the legacy bot poller reads). When ROLE_SYNC_VIA_WORKPOOL is enabled it
 * ALSO enqueues the Workpool action transactionally; otherwise the row is left
 * for the bot poller (legacy path), keeping rollout/rollback a single env flip.
 */

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { roleSyncPool } from '../roleSyncWorkpool';

/** Default retry budget for new jobs (~17 min of Workpool backoff at maxAttempts:10). */
const DEFAULT_MAX_RETRIES = 10;
const MAX_RETRY_BUDGET = 100;
const DEDUPE_STATUSES = new Set(['pending', 'in_progress', 'failed']);

export function roleSyncViaWorkpool(): boolean {
  return process.env.ROLE_SYNC_VIA_WORKPOOL === 'true';
}

function requireIdempotencyKey(idempotencyKey: string): string {
  const normalized = idempotencyKey.trim();
  if (normalized.length === 0) {
    throw new Error('idempotencyKey must be a non-empty string');
  }
  return normalized;
}

function resolveMaxRetries(maxRetries: number | undefined): number {
  const resolved = maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > MAX_RETRY_BUDGET) {
    throw new Error(`maxRetries must be an integer between 0 and ${MAX_RETRY_BUDGET}`);
  }
  return resolved;
}

async function findByIdempotencyKey(
  ctx: MutationCtx,
  idempotencyKey: string
): Promise<Id<'outbox_jobs'> | null> {
  const normalized = requireIdempotencyKey(idempotencyKey);
  const existing = (
    await ctx.db
      .query('outbox_jobs')
      .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', normalized))
      .collect()
  ).find((job) => DEDUPE_STATUSES.has(job.status));
  return existing?._id ?? null;
}

export async function enqueueRoleSync(
  ctx: MutationCtx,
  params: {
    authUserId: string;
    subjectId: Id<'subjects'>;
    entitlementId: Id<'entitlements'>;
    discordUserId?: string;
    targetGuildId?: string;
    idempotencyKey: string;
    maxRetries?: number;
  }
): Promise<Id<'outbox_jobs'>> {
  const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
  const maxRetries = resolveMaxRetries(params.maxRetries);
  // Convex mutations use serializable optimistic concurrency. If another
  // mutation inserts this indexed key before commit, this mutation is retried
  // against the new value instead of committing a duplicate projection row.
  const existing = await findByIdempotencyKey(ctx, idempotencyKey);
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const outboxJobId = await ctx.db.insert('outbox_jobs', {
    authUserId: params.authUserId,
    jobType: 'role_sync',
    // Payload fields are consumed by the Workpool action handler.
    payload: {
      subjectId: params.subjectId,
      entitlementId: params.entitlementId,
      ...(params.discordUserId ? { discordUserId: params.discordUserId } : {}),
      ...(params.targetGuildId ? { targetGuildId: params.targetGuildId } : {}),
    },
    status: 'pending',
    idempotencyKey,
    // Top-level targeting fields keep the legacy bot poller and UI projection normalized.
    ...(params.targetGuildId ? { targetGuildId: params.targetGuildId } : {}),
    ...(params.discordUserId ? { targetDiscordUserId: params.discordUserId } : {}),
    retryCount: 0,
    maxRetries,
    createdAt: now,
    updatedAt: now,
  });

  if (roleSyncViaWorkpool()) {
    await roleSyncPool.enqueueAction(
      ctx,
      internal.roleSyncActions.runRoleSync,
      {
        outboxJobId,
        authUserId: params.authUserId,
        subjectId: params.subjectId,
        entitlementId: params.entitlementId,
        discordUserId: params.discordUserId,
        targetGuildId: params.targetGuildId,
      },
      {
        onComplete: internal.roleSyncOnComplete.roleSyncCompleted,
        context: { outboxJobId },
      }
    );
    await ctx.db.patch(outboxJobId, { workpoolEnqueuedAt: now, updatedAt: now });
  }

  return outboxJobId;
}

export async function enqueueRoleRemoval(
  ctx: MutationCtx,
  params: {
    authUserId: string;
    subjectId: Id<'subjects'>;
    entitlementId?: Id<'entitlements'>;
    guildId: string;
    roleId: string;
    discordUserId?: string;
    idempotencyKey: string;
    maxRetries?: number;
  }
): Promise<Id<'outbox_jobs'>> {
  const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
  const maxRetries = resolveMaxRetries(params.maxRetries);
  const existing = await findByIdempotencyKey(ctx, idempotencyKey);
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const outboxJobId = await ctx.db.insert('outbox_jobs', {
    authUserId: params.authUserId,
    jobType: 'role_removal',
    // Payload fields are consumed by the Workpool action handler.
    payload: {
      subjectId: params.subjectId,
      ...(params.entitlementId ? { entitlementId: params.entitlementId } : {}),
      guildId: params.guildId,
      roleId: params.roleId,
      ...(params.discordUserId ? { discordUserId: params.discordUserId } : {}),
    },
    status: 'pending',
    idempotencyKey,
    // Top-level targeting fields keep the legacy bot poller and UI projection normalized.
    targetGuildId: params.guildId,
    ...(params.discordUserId ? { targetDiscordUserId: params.discordUserId } : {}),
    retryCount: 0,
    maxRetries,
    createdAt: now,
    updatedAt: now,
  });

  if (roleSyncViaWorkpool()) {
    await roleSyncPool.enqueueAction(
      ctx,
      internal.roleSyncActions.runRoleRemoval,
      {
        outboxJobId,
        authUserId: params.authUserId,
        subjectId: params.subjectId,
        entitlementId: params.entitlementId,
        guildId: params.guildId,
        roleId: params.roleId,
        discordUserId: params.discordUserId,
      },
      {
        onComplete: internal.roleSyncOnComplete.roleSyncCompleted,
        context: { outboxJobId },
      }
    );
    await ctx.db.patch(outboxJobId, { workpoolEnqueuedAt: now, updatedAt: now });
  }

  return outboxJobId;
}
