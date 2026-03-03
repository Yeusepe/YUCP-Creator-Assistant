/**
 * Discord interaction handler for slash commands, buttons, modals, select menus.
 *
 * Routes interactions to command handlers. Admin subcommands require Administrator permission.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ChannelSelectMenuBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { createLogger } from '@yucp/shared';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { USER_COMMANDS } from '../commands';
import {
  runSetupStart,
  handleSetupSelect,
  handleSetupJinxxyModal,
  buildSetupStep2Components,
  buildJinxxyModal,
} from '../commands/setup';
import { track } from '../lib/posthog';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

function getNotConfiguredMessage(guildId: string): string {
  const apiBase = process.env.API_BASE_URL;
  if (apiBase) {
    return `This server is not configured. [Sign in to configure](${apiBase}/connect?guild_id=${guildId})`;
  }
  return 'This server is not configured. Please sign in to configure (API_BASE_URL not set).';
}

/** Admin-only subcommand groups and subcommands (require Administrator) */
const ADMIN_SUBCOMMANDS = new Set([
  'setup',
  'product',
  'stats',
  'verify-spawn',
  'analytics',
  'suspicious',
  'discord-role-verification',
]);

export interface InteractionHandlerContext {
  convex: ConvexHttpClient;
  apiSecret: string;
}

function requireAdmin(interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member;
  if (!member || typeof member.permissions === 'string') return false;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

function isAdminSubcommand(interaction: ChatInputCommandInteraction): boolean {
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);
  if (subcommand === 'verify-spawn') return true;
  if (ADMIN_SUBCOMMANDS.has(subcommandGroup ?? '')) return true;
  return false;
}

export async function handleInteraction(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction
    | import('discord.js').ChannelSelectMenuInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction, ctx);
    return;
  }
  if (interaction.isButton()) {
    await handleButton(interaction, ctx);
    return;
  }
  if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, ctx);
    return;
  }
  if (interaction.isStringSelectMenu()) {
    await handleSelectMenu(interaction, ctx);
    return;
  }
  if (interaction.isChannelSelectMenu()) {
    await handleSelectMenu(interaction as any, ctx);
    return;
  }
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  if (interaction.commandName !== 'creator') return;

  const subcommand = interaction.options.getSubcommand(false);
  const subcommandGroup = interaction.options.getSubcommandGroup(false);

  // User commands: link, status, help - no admin check
  if (USER_COMMANDS.includes(subcommand ?? '')) {
    await handleUserCommand(interaction, ctx);
    return;
  }

  // Admin subcommands require Administrator
  if (isAdminSubcommand(interaction) && !requireAdmin(interaction)) {
    await interaction.reply({
      content: 'This command requires Administrator permission.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer for long-running commands
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: 'This command must be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot as any, {
    apiSecret: ctx.apiSecret,
    discordGuildId: guildId,
  });

  if (!guildLink) {
    await interaction.reply({
      content: getNotConfiguredMessage(guildId),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tenantId = guildLink.tenantId as Id<'tenants'>;
  const guildLinkId = guildLink.guildLinkId as Id<'guild_links'>;

  track(interaction.user.id, 'command_used', {
    command: subcommand,
    subcommandGroup: subcommandGroup ?? undefined,
    guildId,
    tenantId,
    userId: interaction.user.id,
  });

  try {
    if (subcommandGroup === 'setup') {
      await runSetupStart(interaction, ctx.convex, ctx.apiSecret, {
        tenantId,
        guildLinkId,
        guildId,
      });
      return;
    } else if (subcommandGroup === 'product') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') {
        const { handleProductAdd } = await import('../commands/product');
        await handleProductAdd(interaction, ctx.convex, ctx.apiSecret, {
          tenantId,
          guildLinkId,
          guildId,
        });
      } else if (sub === 'list') {
        const { handleProductList } = await import('../commands/product');
        await handleProductList(interaction, ctx.convex, ctx.apiSecret, {
          tenantId,
          guildId,
        });
      } else if (sub === 'remove') {
        const { handleProductRemove } = await import('../commands/product');
        await handleProductRemove(interaction, ctx.convex, ctx.apiSecret, {
          tenantId,
          guildId,
        });
      }
      return;
    } else if (subcommandGroup === 'stats') {
      const sub = interaction.options.getSubcommand();
      const { handleStatsOverview, handleStatsVerified, handleStatsProducts, handleStatsUser } =
        await import('../commands/stats');
      if (sub === 'overview') {
        await handleStatsOverview(interaction, ctx.convex, { tenantId, guildId });
      } else if (sub === 'verified') {
        await handleStatsVerified(interaction, ctx.convex, { tenantId, guildId });
      } else if (sub === 'products') {
        await handleStatsProducts(interaction, ctx.convex, { tenantId, guildId });
      } else if (sub === 'user') {
        await handleStatsUser(interaction, ctx.convex, { tenantId, guildId });
      }
      return;
    } else if (subcommand === 'verify-spawn') {
      const { handleVerifySpawn } = await import('../commands/verify');
      await handleVerifySpawn(interaction, ctx.convex, process.env.API_BASE_URL, {
        tenantId,
        guildLinkId,
        guildId,
      });
      return;
    } else if (subcommandGroup === 'analytics') {
      const sub = interaction.options.getSubcommand();
      const { handleAnalyticsLink, handleAnalyticsSummary } =
        await import('../commands/analytics');
      if (sub === 'link') {
        await handleAnalyticsLink(interaction, ctx.convex, { tenantId, guildId });
      } else if (sub === 'summary') {
        await handleAnalyticsSummary(interaction, ctx.convex, { tenantId, guildId });
      }
    } else if (subcommandGroup === 'suspicious') {
      const sub = interaction.options.getSubcommand();
      const { handleSuspiciousMark, handleSuspiciousList, handleSuspiciousClear } =
        await import('../commands/suspicious');
      if (sub === 'mark') {
        await handleSuspiciousMark(interaction, ctx.convex, ctx.apiSecret, {
          tenantId,
          guildId,
        });
      } else if (sub === 'list') {
        await handleSuspiciousList(interaction, ctx.convex, ctx.apiSecret, {
          tenantId,
          guildId,
        });
      } else if (sub === 'clear') {
        await handleSuspiciousClear(interaction, ctx.convex, ctx.apiSecret, {
          tenantId,
          guildId,
        });
      }
      return;
    } else if (subcommandGroup === 'discord-role-verification') {
      const { handleDiscordRoleVerification } = await import(
        '../commands/discordRoleVerification'
      );
      await handleDiscordRoleVerification(interaction, ctx.convex, ctx.apiSecret, {
        tenantId,
      });
      return;
    } else {
      await interaction.reply({
        content: 'Unknown command. Use `/creator help` for usage.',
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    logger.error('Command handler error', { err, command: subcommand });
    track(interaction.user.id, 'command_error', {
      command: subcommand,
      error: String(err),
    });
    const content =
      interaction.deferred || interaction.replied
        ? undefined
        : 'An error occurred. Please try again.';
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: content ?? 'An error occurred.' }).catch(() => {});
      } else if (!interaction.replied) {
        await interaction.reply({ content: content ?? 'An error occurred.', flags: MessageFlags.Ephemeral });
      }
    } catch {
      // ignore
    }
  }
}

async function handleUserCommand(
  interaction: ChatInputCommandInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(false);
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({
      content: 'This command must be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot as any, {
    apiSecret: ctx.apiSecret,
    discordGuildId: guildId,
  });

  if (!guildLink) {
    await interaction.reply({
      content: getNotConfiguredMessage(guildId),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tenantId = guildLink.tenantId as Id<'tenants'>;
  const guildLinkId = guildLink.guildLinkId as Id<'guild_links'>;

  track(interaction.user.id, 'command_used', {
    command: subcommand,
    guildId,
    tenantId,
    userId: interaction.user.id,
  });

  try {
    if (subcommand === 'link') {
      const { handleLink } = await import('../commands/link');
      await handleLink(interaction, ctx.convex, ctx.apiSecret, process.env.API_BASE_URL, {
        tenantId,
        guildLinkId,
        guildId,
      });
    } else if (subcommand === 'status') {
      const { handleStatus } = await import('../commands/status');
      await handleStatus(interaction, ctx.convex, { tenantId, guildId });
    } else if (subcommand === 'help') {
      await handleHelp(interaction);
    }
  } catch (err) {
    logger.error('User command error', { err, command: subcommand });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'An error occurred.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}





async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: `**Creator Assistant**
\`/creator link\` - Link your Gumroad, Jinxxy, or Discord account
\`/creator status\` - Check your verification status
\`/creator help\` - This message

*Admin commands:* setup, product, stats, verify-spawn, analytics, suspicious`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleButton(
  interaction: ButtonInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  const customId = interaction.customId;

  if (customId === 'verify_start') {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot as any, {
      apiSecret: ctx.apiSecret,
      discordGuildId: guildId,
    });
    if (!guildLink) {
      await interaction.reply({
        content: getNotConfiguredMessage(guildId),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const { handleVerifyStartButton } = await import('../commands/verify');
    const apiBaseUrl = process.env.API_BASE_URL;
    await handleVerifyStartButton(interaction, ctx.convex, ctx.apiSecret, apiBaseUrl, {
      tenantId: guildLink.tenantId as Id<'tenants'>,
      guildId,
    });
    return;
  }

  if (customId.startsWith('creator_verify:license:')) {
    const tenantId = customId.slice('creator_verify:license:'.length) as Id<'tenants'>;
    const { buildLicenseModal } = await import('../commands/verify');
    await interaction.showModal(buildLicenseModal(tenantId));
    return;
  }

  if (customId.startsWith('creator_setup:')) {
    const parts = customId.slice('creator_setup:'.length).split(':');
    const action = parts[0];
    const tenantId = parts[1];
    if (action === 'next' && tenantId) {
      const { logChannelSelect, jinxxyButton } = buildSetupStep2Components(
        tenantId as Id<'tenants'>,
      );
      const embed = {
        title: 'Creator Setup — Step 2 of 3',
        description: 'Log channel and Jinxxy API key.',
        color: 0x5865f2,
      };
      const row1 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(logChannelSelect);
      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(jinxxyButton);
      await interaction.update({
        embeds: [embed],
        components: [row1, row2],
      });
      return;
    }
    if (action === 'jinxxy_btn' && tenantId) {
      await interaction.showModal(buildJinxxyModal(tenantId as Id<'tenants'>));
      return;
    }
  }

  await interaction.reply({ content: 'Unknown button.', flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  if (interaction.customId.startsWith('creator_setup:jinxxy:')) {
    await handleSetupJinxxyModal(interaction, ctx.convex, ctx.apiSecret);
    return;
  }
  if (interaction.customId.startsWith('creator_verify:license_modal:')) {
    const { handleLicenseModalSubmit } = await import('../commands/verify');
    await handleLicenseModalSubmit(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      process.env.API_BASE_URL,
    );
    return;
  }
  await interaction.reply({ content: 'Unknown modal.', flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function handleSelectMenu(
  interaction: StringSelectMenuInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  if (interaction.customId.startsWith('creator_setup:')) {
    await handleSetupSelect(interaction as any, ctx.convex, ctx.apiSecret);
    return;
  }
  await interaction.reply({ content: 'Unknown select.', flags: MessageFlags.Ephemeral }).catch(() => {});
}
