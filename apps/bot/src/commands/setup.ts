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

function buildDashboardUrl(args: {
  baseUrl: string;
  path?: '/dashboard' | '/dashboard/setup';
  guildId: string;
  tenantId?: string;
  setupToken?: string;
  connectToken?: string;
}) {
  const dashboardUrl = new URL(args.path ?? '/dashboard', args.baseUrl);
  dashboardUrl.searchParams.set('guild_id', args.guildId);
  if (args.tenantId) {
    dashboardUrl.searchParams.set('tenant_id', args.tenantId);
  }
  const hash = new URLSearchParams({
    ...(args.setupToken ? { s: args.setupToken } : {}),
    ...(args.connectToken ? { token: args.connectToken } : {}),
  }).toString();
  dashboardUrl.hash = hash;
  return dashboardUrl.toString();
}

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

  const { webPublic } = getApiUrls();
  if (!webPublic) {
    throw new Error('FRONTEND_URL or VERIFY_BASE_URL must be configured for the bot service');
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

  const dashboardUrl = buildDashboardUrl({
    baseUrl: apiBase,
    path: '/dashboard/setup',
    guildId: ctx.guildId,
    tenantId: ctx.authUserId,
    setupToken,
  });

  const embed = new EmbedBuilder()
    .setTitle(`${E.Wrench} Creator Setup`)
    .setDescription(
      'Open the setup page for this server to use the manual setup tools, review the current state, and keep verification current.'
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
        name: '2. Review product-role mappings',
        value:
          'Use the dashboard tools to confirm which products should grant each Discord role for this server.',
        inline: false,
      },
      {
        name: '3. Refresh verification',
        value:
          'Keep the verification prompt current after setup changes and come back to the setup page when you need to maintain this server.',
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

  const { webPublic } = getApiUrls();
  const linkBase = webPublic;

  if (!linkBase) {
    await interaction.editReply({
      content:
        'This server is not yet configured. Visit the Creator Portal to set it up once the frontend URL is configured.',
    });
    return;
  }

  let dashboardUrl = buildDashboardUrl({
    baseUrl: linkBase,
    path: '/dashboard/setup',
    guildId,
  });
  try {
    const token = await createConnectToken({ discordUserId: interaction.user.id, guildId });
    if (token) {
      dashboardUrl = buildDashboardUrl({
        baseUrl: linkBase,
        path: '/dashboard/setup',
        guildId,
        connectToken: token,
      });
    }
  } catch (_) {
    // Use URL without token as fallback
  }

  const embed = new EmbedBuilder()
    .setTitle(`${E.Wrench} Creator Setup`)
    .setDescription(
      'This server is not yet registered. Sign in to the Creator Dashboard to link it, then finish manual setup from the setup page.'
    )
    .setColor(0x5865f2)
    .addFields(
      {
        name: '1. Sign In & Register This Server',
        value:
          'Click the button below, sign in with your Creator Identity, and the dashboard will link this server for you.',
        inline: false,
      },
      {
        name: '2. Connect Your Stores',
        value: `Connect ${ACTIVE_COMMERCE_PROVIDER_LIST} from the dashboard.`,
        inline: false,
      },
      {
        name: '3. Finish manual setup',
        value:
          'After sign-in, use the setup page to review the setup tools, role mappings, and verification surfaces for this server.',
        inline: false,
      }
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Sign In & Open Setup Dashboard')
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
