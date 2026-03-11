/**
 * Guild Member Add Handler
 *
 * Plan Phase 5: When a user joins a guild, resolve guild→tenant, member→subject,
 * load entitlements, and queue role_sync if autoVerifyOnJoin. No provider API calls.
 */

import { createLogger } from '@yucp/shared';
import type { ConvexHttpClient } from 'convex/browser';
import type { GuildMember } from 'discord.js';
import { api } from '../../../../convex/_generated/api';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export interface GuildMemberAddContext {
  convex: ConvexHttpClient;
  apiSecret: string;
}

export async function handleGuildMemberAdd(
  member: GuildMember,
  ctx: GuildMemberAddContext
): Promise<void> {
  try {
    const result = await ctx.convex.mutation(api.guildMemberAdd.handleGuildMemberJoin, {
      apiSecret: ctx.apiSecret,
      discordGuildId: member.guild.id,
      discordUserId: member.id,
    });

    if (result.queued && result.jobCount > 0) {
      logger.info('Queued role sync for guild join', {
        guildId: member.guild.id,
        userId: member.id,
        jobCount: result.jobCount,
      });
    }
  } catch (err) {
    logger.error('guildMemberAdd handler failed', {
      guildId: member.guild.id,
      userId: member.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
