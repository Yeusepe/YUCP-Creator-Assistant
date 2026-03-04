/**
 * /creator setup - Directs users to the website for configuration
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type ChannelSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { track } from '../lib/posthog';

const SETUP_PREFIX = 'creator_setup:';

export interface SetupContext {
  tenantId: Id<'tenants'>;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
}

export async function runSetupStart(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: SetupContext,
): Promise<void> {
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:3001';

  // Create a secure setup session via the API
  let setupToken = '';
  try {
    const res = await fetch(`${apiBase}/api/setup/create-session`, {
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
    // Fall back to legacy URL params if session creation fails
  }

  const connectUrl = setupToken
    ? `${apiBase}/connect?s=${encodeURIComponent(setupToken)}`
    : `${apiBase}/connect?tenant_id=${ctx.tenantId}&guild_id=${ctx.guildId}`;
  const jinxxyUrl = setupToken
    ? `${apiBase}/jinxxy-setup?s=${encodeURIComponent(setupToken)}`
    : `${apiBase}/jinxxy-setup?tenant_id=${ctx.tenantId}&guild_id=${ctx.guildId}`;

  const embed = new EmbedBuilder()
    .setTitle('🔧 Creator Setup')
    .setDescription(
      'Configure your server through the website. Use the buttons below to get started.',
    )
    .setColor(0x5865f2)
    .addFields(
      {
        name: '🔗 Connect Accounts',
        value: 'Link your Gumroad, Jinxxy, or Discord accounts.',
        inline: false,
      },
      {
        name: '🦊 Jinxxy Setup',
        value: 'Configure your Jinxxy API key and webhook.',
        inline: false,
      },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Connect Accounts')
      .setStyle(ButtonStyle.Link)
      .setURL(connectUrl),
    new ButtonBuilder()
      .setLabel('Jinxxy Setup')
      .setStyle(ButtonStyle.Link)
      .setURL(jinxxyUrl),
  );

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });

  track(interaction.user.id, 'setup_started', {
    tenantId: ctx.tenantId,
    guildId: ctx.guildId,
  });
}

/* Legacy handlers kept as no-ops for safety — old button/select/modal interactions won't crash */
export async function handleSetupSelect(
  interaction: StringSelectMenuInteraction | ChannelSelectMenuInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
): Promise<void> {
  if (!interaction.customId.startsWith(SETUP_PREFIX)) return;
  await interaction.reply({
    content: 'This setup flow has moved to the website. Use `/creator setup start` for the link.',
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSetupJinxxyModal(
  interaction: ModalSubmitInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
): Promise<void> {
  if (!interaction.customId.startsWith(SETUP_PREFIX + 'jinxxy:')) return;
  await interaction.reply({
    content: 'Jinxxy setup has moved to the website. Use `/creator setup start` for the link.',
    flags: MessageFlags.Ephemeral,
  });
}

export function buildSetupStep2Components(_tenantId: Id<'tenants'>) {
  return { logChannelSelect: null, jinxxyButton: null };
}

export function buildJinxxyModal(_tenantId: Id<'tenants'>) {
  return null;
}
