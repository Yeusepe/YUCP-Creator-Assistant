/**
 * /creator link - Account linking (user command)
 *
 * Options: Gumroad OAuth, License key, Discord (other server)
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { buildLicenseModal } from './verify';

export async function handleLink(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  apiBaseUrl: string | undefined,
  ctx: { tenantId: Id<'tenants'>; guildLinkId: Id<'guild_links'>; guildId: string },
): Promise<void> {
  const provider = interaction.options.getString('provider', true);

  if (provider === 'gumroad') {
    const redirectUri = apiBaseUrl
      ? `${apiBaseUrl}/verify-success?returnTo=${encodeURIComponent(`https://discord.com/channels/${ctx.guildId}`)}`
      : '';
    const gumroadUrl = apiBaseUrl
      ? `${apiBaseUrl}/api/verification/begin?tenantId=${ctx.tenantId}&mode=gumroad&redirectUri=${encodeURIComponent(redirectUri)}`
      : null;
    if (!gumroadUrl) {
      await interaction.reply({
        content: 'Gumroad linking is not configured. Use license key instead.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const button = new ButtonBuilder()
      .setLabel('Sign in with Gumroad')
      .setStyle(ButtonStyle.Link)
      .setURL(gumroadUrl);
    await interaction.reply({
      content: 'Click below to link your Gumroad account:',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (provider === 'license') {
    await interaction.showModal(buildLicenseModal(ctx.tenantId));
    return;
  }

  if (provider === 'discord') {
    const redirectUri = apiBaseUrl
      ? `${apiBaseUrl}/verify-success?returnTo=${encodeURIComponent(`https://discord.com/channels/${ctx.guildId}`)}`
      : '';
    const discordUrl = apiBaseUrl
      ? `${apiBaseUrl}/api/verification/begin?tenantId=${ctx.tenantId}&mode=discord_role&redirectUri=${encodeURIComponent(redirectUri)}`
      : null;
    if (!discordUrl) {
      await interaction.reply({
        content: 'Discord (other server) linking is not configured.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const button = new ButtonBuilder()
      .setLabel('Sign in with Discord')
      .setStyle(ButtonStyle.Link)
      .setURL(discordUrl);
    await interaction.reply({
      content: 'Click below to verify your role from another Discord server:',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: 'Unknown provider.', flags: MessageFlags.Ephemeral });
}
