/**
 * /creator suspicious - Suspicious account management (admin)
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { track } from '../lib/posthog';

export async function handleSuspiciousMark(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId: targetUser.id,
  });
  if (!subjectResult.found) {
    await interaction.editReply({
      content: `No account found for <@${targetUser.id}>.`,
    });
    return;
  }

  const result = await convex.mutation(api.identitySync.markSubjectSuspicious as any, {
    apiSecret,
    subjectId: subjectResult.subject._id,
    reason,
    actorId: interaction.user.id,
    tenantId: ctx.tenantId,
    quarantine: true,
  });

  track(interaction.user.id, 'suspicious_marked', {
    tenantId: ctx.tenantId,
    subjectId: subjectResult.subject._id,
    targetUserId: targetUser.id,
  });

  await interaction.editReply({
    content: `Marked <@${targetUser.id}> as suspicious${result.wasAlreadySuspicious ? ' (was already flagged)' : ''}.`,
  });
}

export async function handleSuspiciousList(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const list = await convex.query(api.identitySync.listSuspiciousSubjects as any, {
    apiSecret,
    tenantId: ctx.tenantId,
    limit: 25,
  });

  if (!list.length) {
    await interaction.editReply({ content: 'No suspicious accounts.' });
    return;
  }

  const lines = list.map(
    (s: { discordUserId: string; reason?: string }) =>
      `<@${s.discordUserId}> - ${s.reason ?? 'No reason'}`,
  );
  const embed = new EmbedBuilder()
    .setTitle('Suspicious Accounts')
    .setColor(0xed4245)
    .setDescription(lines.join('\n'));

  await interaction.editReply({ embeds: [embed] });
}

export async function handleSuspiciousClear(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildId: string },
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId as any, {
    discordUserId: targetUser.id,
  });
  if (!subjectResult.found) {
    await interaction.editReply({
      content: `No account found for <@${targetUser.id}>.`,
    });
    return;
  }

  await convex.mutation(api.identitySync.clearSubjectSuspicious as any, {
    apiSecret,
    subjectId: subjectResult.subject._id,
    actorId: interaction.user.id,
    tenantId: ctx.tenantId,
  });

  await interaction.editReply({
    content: `Cleared suspicious flag for <@${targetUser.id}>.`,
  });
}
