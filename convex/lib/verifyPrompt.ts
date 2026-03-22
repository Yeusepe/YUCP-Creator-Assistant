import type { GenericMutationCtx } from 'convex/server';
import type { DataModel, Id } from '../_generated/dataModel';

type MutationCtx = GenericMutationCtx<DataModel>;

export async function enqueueVerifyPromptRefreshJob(
  ctx: MutationCtx,
  args: {
    authUserId: string;
    guildId: string;
    guildLinkId: Id<'guild_links'>;
  }
): Promise<void> {
  const now = Date.now();
  const nonce = Math.random().toString(36).slice(2, 10);

  await ctx.db.insert('outbox_jobs', {
    authUserId: args.authUserId,
    jobType: 'verify_prompt_refresh',
    payload: {
      guildId: args.guildId,
      guildLinkId: args.guildLinkId,
    },
    status: 'pending',
    idempotencyKey: `verify_prompt_refresh:${args.guildLinkId}:${now}:${nonce}`,
    targetGuildId: args.guildId,
    retryCount: 0,
    maxRetries: 5,
    createdAt: now,
    updatedAt: now,
  });
}
