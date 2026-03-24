import type { ChatInputCommandInteraction } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { getApiUrls } from '../lib/apiUrls';

export async function handleAccountCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const { webPublic } = getApiUrls();
  if (!webPublic) {
    await interaction.reply({
      content: 'The Creator Portal is not configured right now. Please try again later.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const accountUrl = new URL('/account', webPublic).toString();
  const connectionsUrl = new URL('/account/connections', webPublic).toString();

  const embed = new EmbedBuilder()
    .setTitle('Your Creator Account')
    .setDescription(
      'Open the Creator Portal to manage your linked accounts, licenses, authorized apps, and privacy settings.'
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Open My Account').setStyle(ButtonStyle.Link).setURL(accountUrl),
    new ButtonBuilder()
      .setLabel('Manage Connections')
      .setStyle(ButtonStyle.Link)
      .setURL(connectionsUrl)
  );

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}
