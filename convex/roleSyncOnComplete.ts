/**
 * Role Sync onComplete
 *
 * Workpool calls this after a role_sync / role_removal action settles. It writes
 * the result back into the `outbox_jobs` row (now a projection / idempotency
 * record), emits the audit event, and fires the dashboard notification, so the
 * verify-panel banner (api.outbox_jobs.getFailedRoleSyncForUser) and audit trail
 * keep working unchanged after the bot stops polling these job types.
 *
 * The row is patched directly (not via outbox_jobs.updateJobStatus) to avoid that
 * mutation's retryCount auto-increment side effect.
 */

import { vOnCompleteValidator } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import type { RoleSyncActionResult } from './roleSyncActions';

const NOTIFICATION_TTL_MS = 60_000;

export const roleSyncCompleted = internalMutation({
  args: vOnCompleteValidator(
    v.object({
      outboxJobId: v.id('outbox_jobs'),
    })
  ),
  handler: async (ctx, { context, result }) => {
    const job = await ctx.db.get(context.outboxJobId);
    if (!job) {
      return;
    }
    const now = Date.now();
    const payload = (job.payload ?? {}) as { subjectId?: string; discordUserId?: string };

    if (result.kind === 'success') {
      const r = result.returnValue as RoleSyncActionResult;

      if (r.success) {
        await ctx.db.patch(context.outboxJobId, {
          status: 'completed',
          completedAt: now,
          updatedAt: now,
          ...(r.targetGuildIds && r.targetGuildIds.length > 0
            ? { targetGuildIds: r.targetGuildIds }
            : {}),
          ...(r.error ? { lastError: r.error } : {}),
        });

        // Audit trail (previously emitted by the bot's emitAuditEvent).
        await ctx.db.insert('audit_events', {
          authUserId: job.authUserId,
          eventType:
            job.jobType === 'role_sync'
              ? 'discord.role.sync.completed'
              : 'discord.role.removal.completed',
          actorType: 'system',
          actorId: 'role-sync-workpool',
          subjectId: payload.subjectId as never,
          metadata: {
            jobId: context.outboxJobId,
            jobType: job.jobType,
            guildId: r.guildId,
            discordUserId: r.discordUserId,
            rolesAdded: r.rolesAdded,
            rolesRemoved: r.rolesRemoved,
            success: true,
            skipped: r.skipped ?? false,
          },
          createdAt: now,
        });

        // Dashboard notification on a real role_sync grant (mirrors the bot).
        if (job.jobType === 'role_sync' && r.rolesAdded.length > 0 && r.guildId) {
          const roleCount = r.rolesAdded.length;
          await ctx.db.insert('admin_notifications', {
            authUserId: job.authUserId,
            guildId: r.guildId,
            type: 'info',
            title: 'Roles synced',
            message: `${roleCount} role${roleCount !== 1 ? 's' : ''} assigned${
              r.discordUserId ? ` to <@${r.discordUserId}>` : ''
            }.`,
            expiresAt: now + NOTIFICATION_TTL_MS,
            createdAt: now,
          });
        }
        return;
      }

      // Permanent failure surfaced as a structured result.
      await ctx.db.patch(context.outboxJobId, {
        status: 'dead_letter',
        updatedAt: now,
        lastError: r.error ?? 'Role sync failed',
        ...(r.targetGuildIds && r.targetGuildIds.length > 0
          ? { targetGuildIds: r.targetGuildIds }
          : {}),
      });
      return;
    }

    // kind === 'failed' (retries exhausted / thrown) or 'canceled'.
    await ctx.db.patch(context.outboxJobId, {
      status: 'dead_letter',
      updatedAt: now,
      lastError:
        result.kind === 'failed'
          ? typeof result.error === 'string'
            ? result.error
            : 'Role sync failed after retries'
          : 'Role sync canceled',
    });
  },
});
