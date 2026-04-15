/**
 * /creator suspicious - Suspicious account management (admin)
 */

import type { ConvexHttpClient } from 'convex/browser';
import type { ChatInputCommandInteraction } from 'discord.js';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import { getRequiredBotActorBinding } from '../lib/convexActor';
import { track } from '../lib/posthog';

export async function handleSuspiciousMark(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const actor = await getRequiredBotActorBinding();

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId, {
    actor,
    apiSecret,
    discordUserId: targetUser.id,
  });
  if (!subjectResult.found) {
    await interaction.editReply({
      content: `No account found for <@${targetUser.id}>.`,
    });
    return;
  }

  const result = await convex.mutation(api.identitySync.markSubjectSuspicious, {
    apiSecret,
    subjectId: subjectResult.subject._id,
    reason,
    actorId: interaction.user.id,
    authUserId: ctx.authUserId,
    quarantine: true,
  });

  track(interaction.user.id, 'suspicious_marked', {
    authUserId: ctx.authUserId,
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
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const list = await convex.query(api.identitySync.listSuspiciousSubjects, {
    apiSecret,
    authUserId: ctx.authUserId,
    limit: 25,
  });

  if (!list.length) {
    await interaction.editReply({ content: 'No suspicious accounts.' });
    return;
  }

  const lines = list.map(
    (s: { discordUserId: string; reason?: string }) =>
      `<@${s.discordUserId}> - ${s.reason ?? 'No reason'}`
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
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const actor = await getRequiredBotActorBinding();

  const subjectResult = await convex.query(api.subjects.getSubjectByDiscordId, {
    actor,
    apiSecret,
    discordUserId: targetUser.id,
  });
  if (!subjectResult.found) {
    await interaction.editReply({
      content: `No account found for <@${targetUser.id}>.`,
    });
    return;
  }

  await convex.mutation(api.identitySync.clearSubjectSuspicious, {
    apiSecret,
    subjectId: subjectResult.subject._id,
    actorId: interaction.user.id,
    authUserId: ctx.authUserId,
  });

  await interaction.editReply({
    content: `Cleared suspicious flag for <@${targetUser.id}>.`,
  });
}
