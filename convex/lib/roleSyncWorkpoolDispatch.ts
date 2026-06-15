import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { roleSyncPool } from '../roleSyncWorkpool';

type RoleOutboxPayload = {
  subjectId?: Id<'subjects'>;
  entitlementId?: Id<'entitlements'>;
  discordUserId?: string;
  targetGuildId?: string;
  guildId?: string;
  roleId?: string;
};

type DispatchResult = { enqueued: true } | { enqueued: false; reason: string };

function readRoleOutboxPayload(payload: unknown): RoleOutboxPayload {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return {
    subjectId:
      typeof record.subjectId === 'string' ? (record.subjectId as Id<'subjects'>) : undefined,
    entitlementId:
      typeof record.entitlementId === 'string'
        ? (record.entitlementId as Id<'entitlements'>)
        : undefined,
    discordUserId: typeof record.discordUserId === 'string' ? record.discordUserId : undefined,
    targetGuildId: typeof record.targetGuildId === 'string' ? record.targetGuildId : undefined,
    guildId: typeof record.guildId === 'string' ? record.guildId : undefined,
    roleId: typeof record.roleId === 'string' ? record.roleId : undefined,
  };
}

export function isRoleOutboxJob(job: Pick<Doc<'outbox_jobs'>, 'jobType'>) {
  return job.jobType === 'role_sync' || job.jobType === 'role_removal';
}

export async function enqueueExistingRoleOutboxJobInWorkpool(
  ctx: MutationCtx,
  job: Doc<'outbox_jobs'>
): Promise<DispatchResult> {
  const payload = readRoleOutboxPayload(job.payload);

  if (job.jobType === 'role_sync') {
    if (!payload.subjectId || !payload.entitlementId) {
      return { enqueued: false, reason: 'role_sync payload missing subjectId or entitlementId' };
    }
    await roleSyncPool.enqueueAction(
      ctx,
      internal.roleSyncActions.runRoleSync,
      {
        outboxJobId: job._id,
        authUserId: job.authUserId,
        subjectId: payload.subjectId,
        entitlementId: payload.entitlementId,
        discordUserId: payload.discordUserId,
        targetGuildId: payload.targetGuildId,
      },
      {
        onComplete: internal.roleSyncOnComplete.roleSyncCompleted,
        context: { outboxJobId: job._id },
      }
    );
    return { enqueued: true };
  }

  if (job.jobType === 'role_removal') {
    if (!payload.subjectId || !payload.guildId || !payload.roleId) {
      return {
        enqueued: false,
        reason: 'role_removal payload missing subjectId, guildId, or roleId',
      };
    }
    await roleSyncPool.enqueueAction(
      ctx,
      internal.roleSyncActions.runRoleRemoval,
      {
        outboxJobId: job._id,
        authUserId: job.authUserId,
        subjectId: payload.subjectId,
        entitlementId: payload.entitlementId,
        guildId: payload.guildId,
        roleId: payload.roleId,
        discordUserId: payload.discordUserId,
      },
      {
        onComplete: internal.roleSyncOnComplete.roleSyncCompleted,
        context: { outboxJobId: job._id },
      }
    );
    return { enqueued: true };
  }

  return { enqueued: false, reason: `Unsupported role outbox job type: ${job.jobType}` };
}
