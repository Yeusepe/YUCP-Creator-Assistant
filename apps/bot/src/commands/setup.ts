/**
 * /creator-admin setup start - Opens the dashboard for configuration
 */

import type { ConvexHttpClient } from 'convex/browser';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import { getApiUrls } from '../lib/apiUrls';
import { E } from '../lib/emojis';
import { track } from '../lib/posthog';

const SETUP_PREFIX = 'creator_setup:';

export interface SetupContext {
  tenantId: Id<'tenants'>;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
}

export async function runSetupStart(
  interaction: ChatInputCommandInteraction,
  _convex: ConvexHttpClient,
  apiSecret: string,
  ctx: SetupContext
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { apiInternal, apiPublic, webPublic } = getApiUrls();
  if (!apiPublic) {
    throw new Error('API_BASE_URL is not configured for the bot service');
  }
  if (!webPublic) {
    throw new Error(
      'FRONTEND_URL, VERIFY_BASE_URL, or API_BASE_URL must be configured for the bot service'
    );
  }

  const apiBase = webPublic;
  const apiForFetch = apiInternal ?? apiPublic;

  // Create a secure setup session via the API (use internal URL when on Zeabur)
  let setupToken = '';
  try {
    const res = await fetch(`${apiForFetch}/api/setup/create-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: ctx.tenantId,
        guildId: ctx.guildId,
        discordUserId: interaction.user.id,
        apiSecret,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { token: string };
      setupToken = data.token;
    }
  } catch (_) {
    // Handled below with a user-visible error.
  }

  if (!setupToken) {
    await interaction.editReply({
      content:
        'Could not create a secure setup session. Try `/creator-admin setup start` again in a moment.',
      embeds: [],
      components: [],
    });
    return;
  }

  const dashboardUrl = `${apiBase}/dashboard?tenant_id=${ctx.tenantId}&guild_id=${ctx.guildId}#s=${encodeURIComponent(setupToken)}`;

  const embed = new EmbedBuilder()
    .setTitle(`${E.Wrench} Creator Setup`)
    .setDescription(
      'Open the setup dashboard to connect your stores, review your server settings, and finish onboarding in one place.'
    )
    .setColor(0x5865f2)
    .addFields(
      {
        name: '1. Connect Gumroad or Jinxxy',
        value:
          'Use the platform cards in the dashboard to connect the storefronts you sell through.',
        inline: false,
      },
      {
        name: '2. Review Server Options',
        value:
          'Adjust verification settings, collaborator access, and any store-specific configuration from the same page.',
        inline: false,
      },
      {
        name: '3. Return to Discord',
        value:
          'After the dashboard is set up, finish any role and channel automation back here with `/creator-admin autosetup` if you need it.',
        inline: false,
      }
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Open Setup Dashboard')
      .setStyle(ButtonStyle.Link)
      .setURL(dashboardUrl)
  );

  await interaction.editReply({
    embeds: [embed],
    components: [row],
  });

  track(interaction.user.id, 'setup_started', {
    tenantId: ctx.tenantId,
    guildId: ctx.guildId,
  });
}

/* Legacy handlers kept as no-ops for safety - old button/select/modal interactions won't crash */
export async function handleSetupSelect(
  interaction: StringSelectMenuInteraction | ChannelSelectMenuInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string
): Promise<void> {
  if (!interaction.customId.startsWith(SETUP_PREFIX)) return;
  await interaction.reply({
    content:
      'This setup flow has moved to the dashboard. Use `/creator-admin setup start` for the link.',
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSetupJinxxyModal(
  interaction: ModalSubmitInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string
): Promise<void> {
  if (!interaction.customId.startsWith(`${SETUP_PREFIX}jinxxy:`)) return;
  await interaction.reply({
    content:
      'Jinxxy setup has moved to the dashboard. Use `/creator-admin setup start` for the link.',
    flags: MessageFlags.Ephemeral,
  });
}

export function buildSetupStep2Components(_tenantId: Id<'tenants'>) {
  return { logChannelSelect: null, jinxxyButton: null };
}

export function buildJinxxyModal(_tenantId: Id<'tenants'>) {
  return null;
}
