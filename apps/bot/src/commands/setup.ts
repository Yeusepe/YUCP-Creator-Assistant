/**
 * /creator-admin setup start - Opens the dashboard for configuration
 */

import { PROVIDER_REGISTRY } from '@yucp/providers/providerMetadata';
import type { ProviderDescriptor } from '@yucp/providers/types';
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
import { createConnectToken, createSetupSessionToken } from '../lib/internalRpc';
import { track } from '../lib/posthog';

const SETUP_PREFIX = 'creator_setup:';

/** Comma-/or-separated list of active commerce provider labels for embed text. */
const ACTIVE_COMMERCE_PROVIDER_LIST = (() => {
  const labels = (PROVIDER_REGISTRY as readonly ProviderDescriptor[])
    .filter((p) => p.status === 'active' && p.category === 'commerce')
    .map((p) => p.label);
  if (labels.length <= 2) return labels.join(' or ');
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
})();

export interface SetupContext {
  authUserId: string;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
}

export async function runSetupStart(
  interaction: ChatInputCommandInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  ctx: SetupContext
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { apiPublic, webPublic } = getApiUrls();
  if (!apiPublic) {
    throw new Error('API_BASE_URL is not configured for the bot service');
  }
  if (!webPublic) {
    throw new Error(
      'FRONTEND_URL, VERIFY_BASE_URL, or API_BASE_URL must be configured for the bot service'
    );
  }

  const apiBase = webPublic;

  let setupToken = '';
  try {
    setupToken =
      (await createSetupSessionToken({
        authUserId: ctx.authUserId,
        guildId: ctx.guildId,
        discordUserId: interaction.user.id,
      })) ?? '';
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

  const dashboardUrl = `${apiBase}/dashboard?tenant_id=${ctx.authUserId}&guild_id=${ctx.guildId}#s=${encodeURIComponent(setupToken)}`;

  const embed = new EmbedBuilder()
    .setTitle(`${E.Wrench} Creator Setup`)
    .setDescription(
      'Open the setup dashboard to connect your stores, review your server settings, and finish onboarding in one place.'
    )
    .setColor(0x5865f2)
    .addFields(
      {
        name: `1. Connect ${ACTIVE_COMMERCE_PROVIDER_LIST}`,
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
    authUserId: ctx.authUserId,
    guildId: ctx.guildId,
  });
}

/**
 * Shows the setup panel for a server that hasn't been registered yet.
 * Generates a connect token so the admin can sign in and register the server in one click.
 */
export async function runSetupStartUnconfigured(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { webPublic, apiPublic } = getApiUrls();
  const linkBase = webPublic ?? apiPublic;

  if (!linkBase) {
    await interaction.editReply({
      content:
        'This server is not yet configured. Visit the Creator Portal to set it up (API_BASE_URL not configured).',
    });
    return;
  }

  let dashboardUrl = `${linkBase}/dashboard?guild_id=${guildId}`;
  try {
    const token = await createConnectToken({ discordUserId: interaction.user.id, guildId });
    if (token) {
      dashboardUrl = `${linkBase}/dashboard?guild_id=${guildId}#token=${token}`;
    }
  } catch (_) {
    // Use URL without token as fallback
  }

  const embed = new EmbedBuilder()
    .setTitle(`${E.Wrench} Creator Setup`)
    .setDescription(
      'This server is not yet registered. Sign in to the Creator Portal to link this server and connect your stores.'
    )
    .setColor(0x5865f2)
    .addFields(
      {
        name: '1. Sign In & Register This Server',
        value:
          'Click the button below. Sign in with your creator account and the portal will automatically link this server.',
        inline: false,
      },
      {
        name: '2. Connect Your Stores',
        value: `Connect ${ACTIVE_COMMERCE_PROVIDER_LIST} from the dashboard.`,
        inline: false,
      },
      {
        name: '3. Return to Discord',
        value: 'After setup, run `/creator-admin autosetup` to finish role and channel automation.',
        inline: false,
      }
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Sign In & Setup Server')
      .setStyle(ButtonStyle.Link)
      .setURL(dashboardUrl)
  );

  await interaction.editReply({
    embeds: [embed],
    components: [row],
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

export function buildSetupStep2Components(_authUserId: string) {
  return { logChannelSelect: null, jinxxyButton: null };
}

export function buildJinxxyModal(_authUserId: string) {
  return null;
}
