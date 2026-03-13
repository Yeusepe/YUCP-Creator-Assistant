import type { Logger } from '@yucp/shared';
import { ConvexHttpClient } from 'convex/browser';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { api } from '../../../../convex/_generated/api';

export async function handleSettingsDisconnect(
  interaction: ChatInputCommandInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  _ctx: { logger: Logger; authUserId: string; guildId: string }
) {
  const embed = new EmbedBuilder()
    .setTitle('⚠️ Warning: Disconnect Server')
    .setDescription(
      'You are about to disconnect this server from your Creator Assistant account. This will completely stop role verification.'
    )
    .setColor('#FFA500'); // Orange

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('creator_settings:disconnect_warn1:confirm')
      .setLabel('I understand, disconnect')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('creator_settings:disconnect_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleDisconnectWarn1(
  interaction: ButtonInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  _ctx: { logger: Logger; guildId: string }
) {
  const embed = new EmbedBuilder()
    .setTitle('🚨 Danger: Data Deletion')
    .setDescription(
      'Disconnecting will **PERMANENTLY DELETE** all verification rules, download routes, and verification history for this server. Users will not lose their roles, but they will not be updated anymore.'
    )
    .setColor('#FF4500'); // Orange-Red

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('creator_settings:disconnect_warn2:confirm')
      .setLabel('Yes, I am sure')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('creator_settings:disconnect_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.update({
    embeds: [embed],
    components: [row],
  });
}

export async function handleDisconnectWarn2(
  interaction: ButtonInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  _ctx: { logger: Logger; guildId: string }
) {
  const embed = new EmbedBuilder()
    .setTitle('🛑 FINAL CONFIRMATION')
    .setDescription(
      'This action CANNOT be undone. Are you absolutely sure you want to completely disconnect and destroy all data for this server?'
    )
    .setColor('#FF0000'); // Red

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('creator_settings:disconnect_confirm')
      .setLabel('Confirm Disconnect')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('creator_settings:disconnect_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.update({
    embeds: [embed],
    components: [row],
  });
}

export async function handleDisconnectConfirm(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { logger: Logger; guildId: string }
) {
  await interaction.deferUpdate();

  try {
    const result = await convex.mutation(api.guildLinks.hardDisconnectGuild, {
      apiSecret,
      discordGuildId: ctx.guildId,
    });

    if (result.success) {
      const embed = new EmbedBuilder()
        .setTitle('✅ Server Disconnected')
        .setDescription(
          'This server has been successfully disconnected and all verification data has been permanently deleted.'
        )
        .setColor('#00FF00');

      await interaction.editReply({
        embeds: [embed],
        components: [],
      });
    } else {
      throw new Error(`Failed to unbind server: ${result.reason}`);
    }
  } catch (error) {
    ctx.logger.error('Failed to disconnect guild', { error, guildId: ctx.guildId });
    const errorEmbed = new EmbedBuilder()
      .setTitle('❌ Error')
      .setDescription('An error occurred while disconnecting the server.')
      .setColor('#FF0000');

    await interaction.editReply({
      embeds: [errorEmbed],
      components: [],
    });
  }
}

export async function handleDisconnectCancel(
  interaction: ButtonInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  _ctx: { logger: Logger }
) {
  const embed = new EmbedBuilder()
    .setTitle('✅ Cancelled')
    .setDescription('Cancellation confirmed. The server remains connected.')
    .setColor('#00FF00');

  await interaction.update({
    embeds: [embed],
    components: [],
  });
}
