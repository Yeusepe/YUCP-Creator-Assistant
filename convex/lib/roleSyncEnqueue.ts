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

export function roleSyncViaWorkpool(): boolean {
  return process.env.ROLE_SYNC_VIA_WORKPOOL === 'true';
}

async function findByIdempotencyKey(
  ctx: MutationCtx,
  idempotencyKey: string
): Promise<Id<'outbox_jobs'> | null> {
  const existing = await ctx.db
    .query('outbox_jobs')
    .withIndex('by_idempotency', (q) => q.eq('idempotencyKey', idempotencyKey))
    .first();
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
  const existing = await findByIdempotencyKey(ctx, params.idempotencyKey);
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const outboxJobId = await ctx.db.insert('outbox_jobs', {
    authUserId: params.authUserId,
    jobType: 'role_sync',
    payload: {
      subjectId: params.subjectId,
      entitlementId: params.entitlementId,
      ...(params.discordUserId ? { discordUserId: params.discordUserId } : {}),
      ...(params.targetGuildId ? { targetGuildId: params.targetGuildId } : {}),
    },
    status: 'pending',
    idempotencyKey: params.idempotencyKey,
    ...(params.targetGuildId ? { targetGuildId: params.targetGuildId } : {}),
    ...(params.discordUserId ? { targetDiscordUserId: params.discordUserId } : {}),
    retryCount: 0,
    maxRetries: params.maxRetries ?? DEFAULT_MAX_RETRIES,
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
  const existing = await findByIdempotencyKey(ctx, params.idempotencyKey);
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const outboxJobId = await ctx.db.insert('outbox_jobs', {
    authUserId: params.authUserId,
    jobType: 'role_removal',
    payload: {
      subjectId: params.subjectId,
      ...(params.entitlementId ? { entitlementId: params.entitlementId } : {}),
      guildId: params.guildId,
      roleId: params.roleId,
      ...(params.discordUserId ? { discordUserId: params.discordUserId } : {}),
    },
    status: 'pending',
    idempotencyKey: params.idempotencyKey,
    targetGuildId: params.guildId,
    ...(params.discordUserId ? { targetDiscordUserId: params.discordUserId } : {}),
    retryCount: 0,
    maxRetries: params.maxRetries ?? DEFAULT_MAX_RETRIES,
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
  }

  return outboxJobId;
}
