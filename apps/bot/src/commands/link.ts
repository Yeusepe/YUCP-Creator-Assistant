/**
 * /creator link - Account linking (user command)
 *
 * Options: Gumroad OAuth, License key, Discord (other server)
 */

import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import type { ConvexHttpClient } from 'convex/browser';
import type { ChatInputCommandInteraction } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import { buildLicenseModal } from './verify';

export async function handleLink(
  interaction: ChatInputCommandInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  apiBaseUrl: string | undefined,
  ctx: { authUserId: string; guildLinkId: Id<'guild_links'>; guildId: string }
): Promise<void> {
  const provider = interaction.options.getString('provider', true);

  if (provider === 'license') {
    await interaction.showModal(buildLicenseModal(ctx.authUserId));
    return;
  }

  if (provider === 'discord') {
    const redirectUri = apiBaseUrl
      ? `${apiBaseUrl}/verify-success?returnTo=${encodeURIComponent(`https://discord.com/channels/${ctx.guildId}`)}`
      : '';
    const discordUrl = apiBaseUrl
      ? `${apiBaseUrl}/api/verification/begin?authUserId=${ctx.authUserId}&mode=discord_role&redirectUri=${encodeURIComponent(redirectUri)}`
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

  const descriptor = getProviderDescriptor(provider);
  if (descriptor?.supportsOAuth) {
    const redirectUri = apiBaseUrl
      ? `${apiBaseUrl}/verify-success?returnTo=${encodeURIComponent(`https://discord.com/channels/${ctx.guildId}`)}`
      : '';
    const oauthUrl = apiBaseUrl
      ? `${apiBaseUrl}/api/verification/begin?authUserId=${ctx.authUserId}&mode=${provider}&redirectUri=${encodeURIComponent(redirectUri)}`
      : null;
    if (!oauthUrl) {
      await interaction.reply({
        content: `${descriptor.label} linking is not configured. Use license key instead.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const button = new ButtonBuilder()
      .setLabel(`Sign in with ${descriptor.label}`)
      .setStyle(ButtonStyle.Link)
      .setURL(oauthUrl);
    await interaction.reply({
      content: `Click below to link your ${descriptor.label} account:`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: 'Unknown provider.', flags: MessageFlags.Ephemeral });
}
