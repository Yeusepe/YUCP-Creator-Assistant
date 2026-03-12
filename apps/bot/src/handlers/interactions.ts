/**
 * Discord interaction handler for slash commands, buttons, modals, select menus.
 *
 * Routes interactions to command handlers. Admin subcommands require Administrator permission.
 */

import { PROVIDER_META } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { ConvexHttpClient } from 'convex/browser';
import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ChannelSelectMenuBuilder,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  buildJinxxyModal,
  buildSetupStep2Components,
  handleSetupJinxxyModal,
  handleSetupSelect,
  runSetupStart,
} from '../commands/setup';
import { getApiUrls } from '../lib/apiUrls';
import { E } from '../lib/emojis';
import { createConnectToken } from '../lib/internalRpc';
import { track } from '../lib/posthog';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

/** Message when server has no guild link. forAdmin: securely fetch token to sign-in; otherwise tell user to ask admin. */
async function getNotConfiguredMessage(
  guildId: string,
  discordUserId: string,
  apiSecret: string,
  forAdmin = false
): Promise<string> {
  if (forAdmin) {
    const { apiInternal, apiPublic, webPublic } = getApiUrls();
    const linkBase = webPublic ?? apiPublic;
    if (linkBase) {
      try {
        if (apiInternal ?? apiPublic) {
          const token = await createConnectToken({ discordUserId });
          if (token) {
            return `This server is not configured. [Sign in to configure](${linkBase}/dashboard?guild_id=${guildId}#token=${token})`;
          }
        }
      } catch (e) {
        logger.error('Failed to generate secure connect token', { error: e });
      }
      return `This server is not configured. [Sign in to configure](${linkBase}/dashboard?guild_id=${guildId})`;
    }
    return 'This server is not configured. Please sign in to configure (API_BASE_URL not set).';
  }
  return "This server isn't set up for verification yet. Ask a server admin to configure it in the Creator Portal.";
}

export interface InteractionHandlerContext {
  convex: ConvexHttpClient;
  apiSecret: string;
}

function requireAdmin(interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member;
  if (!member || typeof member.permissions === 'string') return false;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

export async function handleInteraction(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction
    | RoleSelectMenuInteraction
    | AutocompleteInteraction
    | ChannelSelectMenuInteraction
    | UserSelectMenuInteraction,
  ctx: InteractionHandlerContext
): Promise<void> {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction, ctx);
    return;
  }
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
  if (interaction.isRoleSelectMenu()) {
    await handleRoleSelectMenu(interaction, ctx);
    return;
  }
  if (interaction.isChannelSelectMenu()) {
    await handleChannelSelectMenu(interaction, ctx);
    return;
  }
  if (interaction.isUserSelectMenu()) {
    await handleUserSelectMenu(interaction, ctx);
    return;
  }
}

// ── Autocomplete handler ──────────────────────────────────────────────────────

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  ctx: InteractionHandlerContext
): Promise<void> {
  const { commandName, options } = interaction;

  if (commandName === 'creator-admin') {
    const focused = options.getFocused(true);
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.respond([]);
      return;
    }

    try {
      const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot, {
        apiSecret: ctx.apiSecret,
        discordGuildId: guildId,
      });
      if (!guildLink) {
        await interaction.respond([]);
        return;
      }

      if (focused.name === 'route_id') {
        const { handleDownloadsRouteAutocomplete } = await import('../commands/downloads');
        await handleDownloadsRouteAutocomplete(
          interaction,
          ctx.convex,
          ctx.apiSecret,
          guildLink.tenantId as Id<'tenants'>,
          guildId
        );
        return;
      }

      if (focused.name !== 'product_id') {
        await interaction.respond([]);
        return;
      }

      // We use getByGuildWithProductNames because it lists all products currently configured for the server
      const products = await ctx.convex.query(api.role_rules.getByGuildWithProductNames, {
        tenantId: guildLink.tenantId,
        guildId,
      });

      const query = focused.value.toLowerCase();
      const filtered = products
        .filter((p: { productId: string; displayName: string | null; provider?: string }) => {
          const searchLabel = (p.displayName ?? p.productId).toLowerCase();
          const discordLabel = p.productId.startsWith('discord_role:') ? 'discord role' : '';
          const providerLabel = (p.provider ?? '').toLowerCase();
          return (
            !query ||
            searchLabel.includes(query) ||
            discordLabel.includes(query) ||
            providerLabel.includes(query)
          );
        })
        .slice(0, 25);

      const providerPrefix = (p: { provider?: string }) => {
        switch (p.provider) {
          case 'gumroad':
            return '[Gumroad] ';
          case 'jinxxy':
            return '[Jinxxy] ';
          case 'discord':
            return '[Discord Role] ';
          case 'manual':
            return '[License] ';
          default:
            return '';
        }
      };

      // Resolve Discord role names for display (optional; OAuth checks roles, not the bot)
      const currentGuild = interaction.guild;
      const choices = await Promise.all(
        filtered.map(
          async (p: {
            productId: string;
            displayName: string | null;
            provider?: string;
            sourceGuildId?: string;
            requiredRoleId?: string;
            verifiedRoleId?: string;
          }) => {
            let label = p.displayName ?? p.productId;
            if (p.productId.startsWith('discord_role:') && p.sourceGuildId && p.requiredRoleId) {
              try {
                const sourceGuild = await interaction.client.guilds
                  .fetch(p.sourceGuildId)
                  .catch(() => null);
                const sourceRole = sourceGuild
                  ? await sourceGuild.roles.fetch(p.requiredRoleId).catch(() => null)
                  : null;
                const targetRole =
                  currentGuild && p.verifiedRoleId
                    ? await currentGuild.roles.fetch(p.verifiedRoleId).catch(() => null)
                    : null;
                const sourceName = sourceRole?.name ?? '?';
                const targetName = targetRole?.name ?? '?';
                label = `Discord Role: ${sourceName} → ${targetName}`;
              } catch {
                label = 'Discord Role (cross-server)';
              }
            } else {
              label = `${providerPrefix(p)}${label}`;
            }
            return { name: label.slice(0, 100), value: p.productId.slice(0, 100) };
          }
        )
      );

      await interaction.respond(choices);
    } catch {
      await interaction.respond([]);
    }
    return;
  }

  if (commandName !== 'creator') {
    await interaction.respond([]);
    return;
  }

  const focused = options.getFocused(true);
  if (focused.name !== 'product') {
    await interaction.respond([]);
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.respond([]);
    return;
  }

  try {
    const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot, {
      apiSecret: ctx.apiSecret,
      discordGuildId: guildId,
    });
    if (!guildLink) {
      await interaction.respond([]);
      return;
    }

    const products = (await ctx.convex.query(api.productResolution.getProductsForTenant, {
      tenantId: guildLink.tenantId,
    })) as Array<{
      productId: string;
      provider: string;
      providerProductRef: string;
      canonicalSlug?: string;
      displayName?: string;
    }>;

    const query = focused.value.toLowerCase();
    const filtered = products
      .filter((p) => {
        const label = (p.displayName ?? p.canonicalSlug ?? p.productId).toLowerCase();
        return !query || label.includes(query) || p.provider.includes(query);
      })
      .slice(0, 25);

    await interaction.respond(
      filtered.map((p) => ({
        name: `${E[(PROVIDER_META[p.provider as keyof typeof PROVIDER_META]?.emojiKey ?? '') as keyof typeof E] ?? '🔷'} ${p.displayName ?? p.canonicalSlug ?? p.productId}`,
        value: `${p.provider}::${p.providerProductRef}`,
      }))
    );
  } catch {
    await interaction.respond([]);
  }
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  ctx: InteractionHandlerContext
): Promise<void> {
  const commandName = interaction.commandName;
  if (commandName !== 'creator' && commandName !== 'creator-admin') return;

  const subcommand = interaction.options.getSubcommand(false);
  const subcommandGroup = interaction.options.getSubcommandGroup(false);

  // /creator - no subcommands, smart state-aware entry point
  if (commandName === 'creator') {
    await handleUserCommand(interaction, ctx);
    return;
  }

  // /creator-admin - all admin subcommands; Discord hides this from non-admins; double-check
  if (!requireAdmin(interaction)) {
    await interaction.reply({
      content: 'This command requires Administrator permission.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: 'This command must be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot, {
    apiSecret: ctx.apiSecret,
    discordGuildId: guildId,
  });

  if (!guildLink) {
    await interaction.reply({
      content: await getNotConfiguredMessage(guildId, interaction.user.id, ctx.apiSecret, true),
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
    if (subcommandGroup === 'setup' && subcommand === 'start') {
      await runSetupStart(interaction, ctx.convex, ctx.apiSecret, {
        tenantId,
        guildLinkId,
        guildId,
      });
    } else if (!subcommandGroup && subcommand === 'dashboard') {
      await runSetupStart(interaction, ctx.convex, ctx.apiSecret, {
        tenantId,
        guildLinkId,
        guildId,
      });
    } else if (subcommandGroup === 'product') {
      const sub = interaction.options.getSubcommand();
      const { handleProductAddInteractive, handleProductList, handleProductRemove } = await import(
        '../commands/product'
      );
      if (sub === 'add') {
        await handleProductAddInteractive(interaction, { tenantId, guildLinkId, guildId });
      } else if (sub === 'list') {
        await handleProductList(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      } else if (sub === 'remove') {
        await handleProductRemove(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      }
    } else if (subcommandGroup === 'downloads') {
      const sub = interaction.options.getSubcommand();
      const { handleDownloadsAdd, handleDownloadsManage } = await import('../commands/downloads');
      if (sub === 'setup') {
        await handleDownloadsAdd(interaction, { tenantId, guildLinkId, guildId });
      } else if (sub === 'manage' || sub === 'list') {
        await handleDownloadsManage(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      }
    } else if (subcommand === 'stats') {
      // Single subcommand (not a group) - overview with navigation buttons
      const { handleStats } = await import('../commands/stats');
      await handleStats(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
    } else if (subcommand === 'spawn-verify') {
      const { handleVerifySpawn } = await import('../commands/verify');
      await handleVerifySpawn(interaction, ctx.convex, getApiUrls().apiPublic, {
        tenantId,
        guildLinkId,
        guildId,
      });
    } else if (subcommand === 'autosetup') {
      const { handleAutosetupStart } = await import('../commands/autosetup');
      await handleAutosetupStart(interaction, ctx.convex, ctx.apiSecret, {
        tenantId,
        guildLinkId,
        guildId,
      });
    } else if (subcommandGroup === 'settings') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'cross-server') {
        const { handleDiscordRoleVerification } = await import(
          '../commands/discordRoleVerification'
        );
        await handleDiscordRoleVerification(interaction, ctx.convex, ctx.apiSecret, { tenantId });
      } else if (sub === 'disconnect') {
        const { handleSettingsDisconnect } = await import('../commands/settings');
        await handleSettingsDisconnect(interaction, ctx.convex, ctx.apiSecret, {
          logger,
          tenantId,
          guildId,
        });
      }
    } else if (subcommand === 'analytics') {
      // Single subcommand (not a group) - combined link + summary
      const { handleAnalytics } = await import('../commands/analytics');
      await handleAnalytics(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
    } else if (subcommandGroup === 'moderation') {
      const sub = interaction.options.getSubcommand();
      const {
        handleModerationMark,
        handleModerationList,
        handleModerationClear,
        handleModerationUnverify,
      } = await import('../commands/moderation');
      if (sub === 'mark') {
        await handleModerationMark(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      } else if (sub === 'list') {
        await handleModerationList(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      } else if (sub === 'clear') {
        await handleModerationClear(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      } else if (sub === 'unverify') {
        await handleModerationUnverify(interaction, ctx.convex, ctx.apiSecret, {
          tenantId,
          guildId,
        });
      }
    } else if (subcommandGroup === 'collab') {
      const sub = interaction.options.getSubcommand();
      const { handleCollabInvite, handleCollabAdd, handleCollabList } = await import(
        '../commands/collab'
      );
      if (sub === 'invite') {
        await handleCollabInvite(interaction, ctx.apiSecret, tenantId);
      } else if (sub === 'add') {
        await handleCollabAdd(interaction, ctx.apiSecret, tenantId);
      } else if (sub === 'list') {
        await handleCollabList(interaction, ctx.apiSecret, tenantId);
      }
    } else {
      await interaction.reply({
        content: 'Unknown command.',
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    logger.error('Command handler error', {
      command: subcommand,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    track(interaction.user.id, 'command_error', {
      command: subcommand,
      error: String(err),
    });
    try {
      if (interaction.deferred) {
        await interaction
          .editReply({ content: 'An error occurred. Please try again.' })
          .catch(() => {});
      } else if (!interaction.replied) {
        await interaction
          .reply({ content: 'An error occurred. Please try again.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    } catch {
      // ignore
    }
  }
}

async function handleUserCommand(
  interaction: ChatInputCommandInteraction,
  ctx: InteractionHandlerContext
): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({
      content: 'This command must be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot, {
    apiSecret: ctx.apiSecret,
    discordGuildId: guildId,
  });

  if (!guildLink) {
    await interaction.reply({
      content: await getNotConfiguredMessage(guildId, interaction.user.id, ctx.apiSecret),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tenantId = guildLink.tenantId as Id<'tenants'>;

  try {
    const subcommand = interaction.options.getSubcommand(false);

    // /creator status - show status panel (default entry point)
    // /creator verify [product] - fast path: skip the picker, go straight to modal
    if (subcommand === 'status' || subcommand === null) {
      const { handleCreatorCommand } = await import('../commands/verify');
      await handleCreatorCommand(interaction, ctx.convex, ctx.apiSecret, getApiUrls().apiPublic, {
        tenantId,
        guildId,
      });
      return;
    }

    if (subcommand === 'verify') {
      const productValue = interaction.options.getString('product', true);
      // productValue format: "{provider}::{providerProductRef}"
      const sepIdx = productValue.indexOf('::');
      if (sepIdx === -1) {
        await interaction.reply({
          content: `${E.X_} Invalid product selection. Please choose from the autocomplete list.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const provider = productValue.slice(0, sepIdx);
      const providerProductRef = productValue.slice(sepIdx + 2);
      const isGumroad = provider === 'gumroad';
      const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = await import(
        'discord.js'
      );
      const modal = new ModalBuilder()
        .setCustomId(`creator_verify:lp_modal:${tenantId}:${providerProductRef}:${provider}`)
        .setTitle(isGumroad ? 'Enter Gumroad License Key' : 'Enter Jinxxy License Key');
      const keyInput = new TextInputBuilder()
        .setCustomId('license_key')
        .setLabel(isGumroad ? 'License Key (XXXX-XXXX-XXXX-XXXX)' : 'License Key')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(
          isGumroad ? 'XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX' : 'Enter your license key'
        )
        .setRequired(true)
        .setMinLength(8)
        .setMaxLength(200);
      modal.addComponents(
        // biome-ignore lint/suspicious/noExplicitAny: Discord modal builder typing is narrower than the runtime builder composition.
        new ActionRowBuilder().addComponents(keyInput) as any
      );
      await interaction.showModal(modal);
      return;
    }

    if (subcommand === 'refresh') {
      const { handleRefreshCommand } = await import('../commands/verify');
      await handleRefreshCommand(interaction, ctx.convex, ctx.apiSecret, {
        tenantId,
      });
      return;
    }

    if (subcommand === 'docs') {
      const docsUrl = 'https://creators.yucp.club/docs.html';
      const embed = new EmbedBuilder()
        .setTitle('Creator Assistant Documentation')
        .setURL(docsUrl)
        .setDescription(
          'Full guide covering setup, commands, product types, collaborators, liened downloads, and more.'
        )
        .setThumbnail('https://creators.yucp.club/Icons/Library.png')
        .setColor(0x0ea5e9);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    // Unknown subcommand - show status panel as fallback
    const { handleCreatorCommand } = await import('../commands/verify');
    await handleCreatorCommand(interaction, ctx.convex, ctx.apiSecret, getApiUrls().apiPublic, {
      tenantId,
      guildId,
    });
  } catch (err) {
    logger.error('User command error', { err });
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: 'An error occurred.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
}

async function handleButton(
  interaction: ButtonInteraction,
  ctx: InteractionHandlerContext
): Promise<void> {
  const customId = interaction.customId;

  // ─── Verify flow (backwards-compatible) ───────────────────────────────────
  if (customId === 'verify_start') {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot, {
      apiSecret: ctx.apiSecret,
      discordGuildId: guildId,
    });
    if (!guildLink) {
      await interaction.editReply({
        content: await getNotConfiguredMessage(guildId, interaction.user.id, ctx.apiSecret),
      });
      return;
    }
    const { handleVerifyStartButton } = await import('../commands/verify');
    await handleVerifyStartButton(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      process.env.API_BASE_URL,
      {
        tenantId: guildLink.tenantId as Id<'tenants'>,
        guildId,
      }
    );
    return;
  }

  if (customId.startsWith('creator_verify:disconnect:')) {
    const provider = customId.split(':')[2];
    const { handleVerifyDisconnectButton } = await import('../commands/verify');
    await handleVerifyDisconnectButton(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      process.env.API_BASE_URL,
      provider
    );
    return;
  }

  if (customId.startsWith('creator_verify:license:')) {
    const tenantId = customId.slice('creator_verify:license:'.length) as Id<'tenants'>;
    const { showProductPicker } = await import('../commands/licenseVerify');
    await showProductPicker(interaction, ctx.convex, ctx.apiSecret, tenantId);
    return;
  }

  if (customId.startsWith('creator_verify:add_more:')) {
    const tenantId = customId.slice('creator_verify:add_more:'.length) as Id<'tenants'>;
    const guildId = interaction.guildId ?? '';
    const { handleVerifyAddMore } = await import('../commands/verify');
    await handleVerifyAddMore(interaction, ctx.convex, ctx.apiSecret, process.env.API_BASE_URL, {
      tenantId,
      guildId,
    });
    return;
  }

  // ─── License picker - filter/page navigation ───────────────────────────────
  if (
    customId.startsWith('creator_verify:lp_filter:') ||
    customId.startsWith('creator_verify:lp_page:')
  ) {
    // Format: creator_verify:lp_filter:{tenantId}:{filter}:{page}
    //      OR creator_verify:lp_page:{tenantId}:{filter}:{page}
    const prefix = customId.startsWith('creator_verify:lp_filter:')
      ? 'creator_verify:lp_filter:'
      : 'creator_verify:lp_page:';
    const rest = customId.slice(prefix.length);
    const parts = rest.split(':');
    // parts[0] = tenantId, parts[1] = filter, parts[2] = page
    const tenantId = parts[0] as Id<'tenants'>;
    const filter = (parts[1] ?? 'all') as string;
    const page = Number.parseInt(parts[2] ?? '0', 10);
    const { handlePickerNavigation } = await import('../commands/licenseVerify');
    await handlePickerNavigation(interaction, ctx.convex, ctx.apiSecret, tenantId, filter, page);
    return;
  }

  // ─── Stats navigation ──────────────────────────────────────────────────────
  // Format: creator_stats:view_users:{tenantId}:{guildId}
  if (customId.startsWith('creator_stats:view_users:')) {
    const rest = customId.slice('creator_stats:view_users:'.length);
    const parts = rest.split(':');
    const tenantId = parts[0] as Id<'tenants'>;
    const guildId = parts[1] ?? interaction.guildId ?? '';
    const { handleStatsViewUsersButton } = await import('../commands/stats');
    await handleStatsViewUsersButton(interaction, ctx.convex, ctx.apiSecret, tenantId, guildId);
    return;
  }

  // Format: creator_stats:view_users_page:{tenantId}:{guildId}:next|prev
  if (customId.startsWith('creator_stats:view_users_page:')) {
    const rest = customId.slice('creator_stats:view_users_page:'.length);
    const parts = rest.split(':');
    const tenantId = parts[0] as Id<'tenants'>;
    const guildId = parts[1] ?? interaction.guildId ?? '';
    const direction = parts[2] as 'next' | 'prev';
    const { handleStatsViewUsersPageButton } = await import('../commands/stats');
    await handleStatsViewUsersPageButton(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      tenantId,
      guildId,
      direction
    );
    return;
  }

  // Format: creator_stats:back:{tenantId}:{guildId}
  if (customId.startsWith('creator_stats:back:')) {
    const rest = customId.slice('creator_stats:back:'.length);
    const parts = rest.split(':');
    const tenantId = parts[0] as Id<'tenants'>;
    const guildId = parts[1] ?? interaction.guildId ?? '';
    const { handleStatsBackButton } = await import('../commands/stats');
    await handleStatsBackButton(interaction, ctx.convex, ctx.apiSecret, tenantId, guildId);
    return;
  }

  // Format: creator_stats:view_products:{tenantId}:{guildId}
  if (customId.startsWith('creator_stats:view_products:')) {
    const rest = customId.slice('creator_stats:view_products:'.length);
    const parts = rest.split(':');
    const tenantId = parts[0] as Id<'tenants'>;
    const guildId = parts[1] ?? interaction.guildId ?? '';
    const { handleStatsViewProductsButton } = await import('../commands/stats');
    await handleStatsViewProductsButton(interaction, ctx.convex, ctx.apiSecret, tenantId, guildId);
    return;
  }

  // Format: creator_stats:check_user:{tenantId}:{guildId}
  if (customId.startsWith('creator_stats:check_user:')) {
    const rest = customId.slice('creator_stats:check_user:'.length);
    const parts = rest.split(':');
    const tenantId = parts[0] as Id<'tenants'>;
    const guildId = parts[1] ?? interaction.guildId ?? '';
    const { handleStatsCheckUserButton } = await import('../commands/stats');
    await handleStatsCheckUserButton(interaction, tenantId, guildId);
    return;
  }

  // ─── Settings (cross-server) ───────────────────────────────────────────────
  if (customId.startsWith('creator_settings:enable:')) {
    const tenantId = customId.slice('creator_settings:enable:'.length) as Id<'tenants'>;
    const { handleSettingsEnable } = await import('../commands/discordRoleVerification');
    await handleSettingsEnable(interaction, ctx.convex, ctx.apiSecret, tenantId);
    return;
  }

  if (customId.startsWith('creator_settings:disable:')) {
    const tenantId = customId.slice('creator_settings:disable:'.length) as Id<'tenants'>;
    const { handleSettingsDisable } = await import('../commands/discordRoleVerification');
    await handleSettingsDisable(interaction, ctx.convex, ctx.apiSecret, tenantId);
    return;
  }

  // ─── Autosetup flow ────────────────────────────────────────────────────────
  if (customId.startsWith('creator_autosetup:create_verify:')) {
    const rest = customId.slice('creator_autosetup:create_verify:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupCreateVerify } = await import('../commands/autosetup');
    await handleAutosetupCreateVerify(interaction, ctx.convex, ctx.apiSecret, userId, tenantId);
    return;
  }
  if (customId.startsWith('creator_autosetup:spawn_here:')) {
    const rest = customId.slice('creator_autosetup:spawn_here:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupSpawnHere } = await import('../commands/autosetup');
    await handleAutosetupSpawnHere(interaction, ctx.convex, ctx.apiSecret, userId, tenantId);
    return;
  }
  if (customId.startsWith('creator_autosetup:role_custom_modal:')) {
    const rest = customId.slice('creator_autosetup:role_custom_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupRoleCustomModal } = await import('../commands/autosetup');
    await handleAutosetupRoleCustomModal(interaction, userId, tenantId);
    return;
  }
  if (customId.startsWith('creator_autosetup:role_custom_done:')) {
    const rest = customId.slice('creator_autosetup:role_custom_done:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupRoleCustomDone } = await import('../commands/autosetup');
    await handleAutosetupRoleCustomDone(interaction, ctx.convex, ctx.apiSecret, userId, tenantId);
    return;
  }
  if (customId.startsWith('creator_autosetup:combine_yes:')) {
    const rest = customId.slice('creator_autosetup:combine_yes:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupCombineChoice } = await import('../commands/autosetup');
    await handleAutosetupCombineChoice(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      userId,
      tenantId,
      true
    );
    return;
  }
  if (customId.startsWith('creator_autosetup:combine_no:')) {
    const rest = customId.slice('creator_autosetup:combine_no:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupCombineChoice } = await import('../commands/autosetup');
    await handleAutosetupCombineChoice(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      userId,
      tenantId,
      false
    );
    return;
  }
  if (customId.startsWith('creator_autosetup:channels_skip:')) {
    const rest = customId.slice('creator_autosetup:channels_skip:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupChannelsSkip } = await import('../commands/autosetup');
    await handleAutosetupChannelsSkip(interaction, userId, tenantId);
    return;
  }
  if (customId.startsWith('creator_autosetup:channels_next:')) {
    const rest = customId.slice('creator_autosetup:channels_next:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupChannelsNext } = await import('../commands/autosetup');
    await handleAutosetupChannelsNext(interaction, ctx.convex, ctx.apiSecret, userId, tenantId);
    return;
  }
  if (customId.startsWith('creator_autosetup:mp_done:')) {
    const rest = customId.slice('creator_autosetup:mp_done:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupMigrateDone } = await import('../commands/autosetup');
    await handleAutosetupMigrateDone(interaction, userId, tenantId);
    return;
  }
  if (customId.startsWith('creator_autosetup:mp_another:')) {
    const rest = customId.slice('creator_autosetup:mp_another:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupMigrateMapAnother } = await import('../commands/autosetup');
    await handleAutosetupMigrateMapAnother(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      userId,
      tenantId
    );
    return;
  }
  if (customId.startsWith('creator_autosetup:mp_all:')) {
    const rest = customId.slice('creator_autosetup:mp_all:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupMigrateMapAll } = await import('../commands/autosetup');
    await handleAutosetupMigrateMapAll(interaction, ctx.convex, ctx.apiSecret, userId, tenantId);
    return;
  }

  // ─── Product add flow ──────────────────────────────────────────────────────
  if (customId.startsWith('creator_product:confirm_add:')) {
    // Format: creator_product:confirm_add:{userId}:{tenantId}
    const rest = customId.slice('creator_product:confirm_add:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductConfirmAdd } = await import('../commands/product');
    await handleProductConfirmAdd(interaction, ctx.convex, ctx.apiSecret, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_product:cancel_add:')) {
    const tenantId = customId.slice('creator_product:cancel_add:'.length) as Id<'tenants'>;
    const { handleProductCancelAdd } = await import('../commands/product');
    await handleProductCancelAdd(interaction, interaction.user.id, tenantId);
    return;
  }

  if (customId.startsWith('creator_product:discord_role_done:')) {
    // Format: creator_product:discord_role_done:{userId}:{tenantId}
    const rest = customId.slice('creator_product:discord_role_done:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductDiscordRoleDone } = await import('../commands/product');
    await handleProductDiscordRoleDone(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:to_access:')) {
    const rest = customId.slice('creator_downloads:to_access:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsGoToAccess } = await import('../commands/downloads');
    await handleDownloadsGoToAccess(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:back_to_channels:')) {
    const rest = customId.slice('creator_downloads:back_to_channels:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsBackToChannels } = await import('../commands/downloads');
    await handleDownloadsBackToChannels(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:to_confirm:')) {
    const rest = customId.slice('creator_downloads:to_confirm:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsGoToConfirm } = await import('../commands/downloads');
    await handleDownloadsGoToConfirm(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:back_to_access:')) {
    const rest = customId.slice('creator_downloads:back_to_access:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsGoToAccess } = await import('../commands/downloads');
    await handleDownloadsGoToAccess(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:confirm_add:')) {
    const rest = customId.slice('creator_downloads:confirm_add:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsConfirmAdd } = await import('../commands/downloads');
    await handleDownloadsConfirmAdd(interaction, ctx.convex, ctx.apiSecret, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:customize_message:')) {
    const rest = customId.slice('creator_downloads:customize_message:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsCustomizeMessage } = await import('../commands/downloads');
    await handleDownloadsCustomizeMessage(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:cancel_add:')) {
    const rest = customId.slice('creator_downloads:cancel_add:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsCancelAdd } = await import('../commands/downloads');
    await handleDownloadsCancelAdd(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:autofix_prompt:')) {
    const rest = customId.slice('creator_downloads:autofix_prompt:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const routeId = rest.slice(colonIdx + 1) as Id<'download_routes'>;
    const { handleDownloadsAutofixPrompt } = await import('../commands/downloads');
    await handleDownloadsAutofixPrompt(interaction, ctx.convex, ctx.apiSecret, userId, routeId);
    return;
  }

  if (customId.startsWith('creator_downloads:autofix_run:')) {
    const rest = customId.slice('creator_downloads:autofix_run:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const routeId = rest.slice(colonIdx + 1) as Id<'download_routes'>;
    const { handleDownloadsAutofixRun } = await import('../commands/downloads');
    await handleDownloadsAutofixRun(interaction, ctx.convex, ctx.apiSecret, userId, routeId);
    return;
  }

  if (customId.startsWith('creator_downloads:autofix_cancel:')) {
    const { handleDownloadsAutofixCancel } = await import('../commands/downloads');
    await handleDownloadsAutofixCancel(interaction);
    return;
  }

  if (customId.startsWith('creator_downloads:manage_toggle:')) {
    const panelToken = customId.slice('creator_downloads:manage_toggle:'.length);
    const { handleDownloadsManageToggle } = await import('../commands/downloads');
    await handleDownloadsManageToggle(interaction, ctx.convex, ctx.apiSecret, panelToken);
    return;
  }

  if (customId.startsWith('creator_downloads:manage_edit_message:')) {
    const panelToken = customId.slice('creator_downloads:manage_edit_message:'.length);
    const { handleDownloadsManageEditMessage } = await import('../commands/downloads');
    await handleDownloadsManageEditMessage(interaction, ctx.convex, ctx.apiSecret, panelToken);
    return;
  }

  if (customId.startsWith('creator_downloads:manage_remove_prompt:')) {
    const panelToken = customId.slice('creator_downloads:manage_remove_prompt:'.length);
    const { handleDownloadsManageRemovePrompt } = await import('../commands/downloads');
    await handleDownloadsManageRemovePrompt(interaction, ctx.convex, ctx.apiSecret, panelToken);
    return;
  }

  if (customId.startsWith('creator_downloads:manage_remove_confirm:')) {
    const panelToken = customId.slice('creator_downloads:manage_remove_confirm:'.length);
    const { handleDownloadsManageRemoveConfirm } = await import('../commands/downloads');
    await handleDownloadsManageRemoveConfirm(interaction, ctx.convex, ctx.apiSecret, panelToken);
    return;
  }

  if (customId.startsWith('creator_downloads:manage_refresh:')) {
    const panelToken = customId.slice('creator_downloads:manage_refresh:'.length);
    const { handleDownloadsManageRefresh } = await import('../commands/downloads');
    await handleDownloadsManageRefresh(interaction, ctx.convex, ctx.apiSecret, panelToken);
    return;
  }

  if (customId.startsWith('creator_download:artifact:')) {
    const artifactId = customId.slice('creator_download:artifact:'.length);
    const { LienedDownloadsService } = await import('../services/lienedDownloads');
    const service = new LienedDownloadsService(interaction.client, ctx.convex, ctx.apiSecret);
    await service.handleDownloadButton(interaction, artifactId);
    return;
  }

  if (customId.startsWith('creator_download:autofix_prompt:')) {
    const artifactId = customId.slice('creator_download:autofix_prompt:'.length);
    const { LienedDownloadsService } = await import('../services/lienedDownloads');
    const service = new LienedDownloadsService(interaction.client, ctx.convex, ctx.apiSecret);
    await service.handleAutofixPrompt(interaction, artifactId);
    return;
  }

  if (customId.startsWith('creator_download:autofix_run:')) {
    const artifactId = customId.slice('creator_download:autofix_run:'.length);
    const { LienedDownloadsService } = await import('../services/lienedDownloads');
    const service = new LienedDownloadsService(interaction.client, ctx.convex, ctx.apiSecret);
    await service.handleAutofixRun(interaction, artifactId);
    return;
  }

  if (customId.startsWith('creator_download:autofix_cancel:')) {
    const { LienedDownloadsService } = await import('../services/lienedDownloads');
    const service = new LienedDownloadsService(interaction.client, ctx.convex, ctx.apiSecret);
    await service.handleAutofixCancel(interaction);
    return;
  }

  // ─── Moderation ────────────────────────────────────────────────────────────
  if (customId.startsWith('creator_moderation:confirm_clear:')) {
    // Format: creator_moderation:confirm_clear:{targetUserId}:{tenantId}:{actorUserId}
    const rest = customId.slice('creator_moderation:confirm_clear:'.length);
    const parts = rest.split(':');
    const targetUserId = parts[0];
    const tenantId = parts[1] as Id<'tenants'>;
    const actorId = parts[2];
    const { handleModerationConfirmClear } = await import('../commands/moderation');
    await handleModerationConfirmClear(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      targetUserId,
      tenantId,
      actorId
    );
    return;
  }

  if (customId === 'creator_moderation:cancel_clear') {
    await interaction.update({ content: 'Cancelled.', components: [], embeds: [] });
    return;
  }

  // Product remove confirm: creator_product:confirm_remove:{userId}:{tenantId}
  if (customId.startsWith('creator_product:confirm_remove:')) {
    const rest = customId.slice('creator_product:confirm_remove:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductConfirmRemove } = await import('../commands/product');
    await handleProductConfirmRemove(
      interaction as ButtonInteraction,
      ctx.convex,
      ctx.apiSecret,
      userId,
      tenantId
    );
    return;
  }

  // Product remove cancel: creator_product:cancel_remove:{userId}:{tenantId}
  if (customId.startsWith('creator_product:cancel_remove:')) {
    const rest = customId.slice('creator_product:cancel_remove:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductCancelRemove } = await import('../commands/product');
    await handleProductCancelRemove(interaction as ButtonInteraction, userId, tenantId);
    return;
  }

  // ─── Collab invite ─────────────────────────────────────────────────────────
  // creator_collab:remove:{tenantId}:{connectionId}
  if (customId.startsWith('creator_collab:remove:')) {
    const rest = customId.slice('creator_collab:remove:'.length);
    const colonIdx = rest.indexOf(':');
    const tenantId = rest.slice(0, colonIdx) as Id<'tenants'>;
    const connectionId = rest.slice(colonIdx + 1);
    const { handleCollabRemove } = await import('../commands/collab');
    await handleCollabRemove(interaction, ctx.apiSecret, tenantId, connectionId);
    return;
  }

  // ─── Settings disconnect flow ──────────────────────────────────────────────
  if (customId.startsWith('creator_settings:disconnect')) {
    const guildId = interaction.guildId;
    if (!guildId) return;

    if (customId === 'creator_settings:disconnect_warn1:confirm') {
      const { handleDisconnectWarn1 } = await import('../commands/settings');
      await handleDisconnectWarn1(interaction, ctx.convex, ctx.apiSecret, {
        logger,
        guildId,
      });
      return;
    }

    if (customId === 'creator_settings:disconnect_warn2:confirm') {
      const { handleDisconnectWarn2 } = await import('../commands/settings');
      await handleDisconnectWarn2(interaction, ctx.convex, ctx.apiSecret, {
        logger,
        guildId,
      });
      return;
    }

    if (customId === 'creator_settings:disconnect_confirm') {
      const { handleDisconnectConfirm } = await import('../commands/settings');
      await handleDisconnectConfirm(interaction, ctx.convex, ctx.apiSecret, {
        logger,
        guildId,
      });
      return;
    }

    if (customId === 'creator_settings:disconnect_cancel') {
      const { handleDisconnectCancel } = await import('../commands/settings');
      await handleDisconnectCancel(interaction, ctx.convex, ctx.apiSecret, { logger });
      return;
    }
  }

  // ─── Legacy setup buttons ──────────────────────────────────────────────────
  if (customId.startsWith('creator_setup:')) {
    const parts = customId.slice('creator_setup:'.length).split(':');
    const action = parts[0];
    const tenantId = parts[1];
    if (action === 'next' && tenantId) {
      const { logChannelSelect, jinxxyButton } = buildSetupStep2Components(
        tenantId as Id<'tenants'>
      );
      const embed = {
        title: 'Creator Setup - Step 2 of 3',
        description: 'Log channel and Jinxxy API key.',
        color: 0x5865f2,
      };
      const row1 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        logChannelSelect ?? new ChannelSelectMenuBuilder().setCustomId('dummy_select')
      );
      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        jinxxyButton ?? new ButtonBuilder().setCustomId('dummy_btn').setLabel('Dummy').setStyle(1)
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });
      return;
    }
    if (action === 'jinxxy_btn' && tenantId) {
      const modal = buildJinxxyModal(tenantId as Id<'tenants'>);
      if (modal) {
        // biome-ignore lint/suspicious/noExplicitAny: setup modal helper currently returns a looser builder shape.
        await interaction.showModal(modal as any);
      }
      return;
    }
  }

  await interaction
    .reply({ content: 'Unknown button.', flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  ctx: InteractionHandlerContext
): Promise<void> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_setup:jinxxy:')) {
    await handleSetupJinxxyModal(interaction, ctx.convex, ctx.apiSecret);
    return;
  }

  if (customId.startsWith('creator_collab:add_modal:')) {
    const tenantId = customId.slice('creator_collab:add_modal:'.length) as Id<'tenants'>;
    const { handleCollabAddModalSubmit } = await import('../commands/collab');
    await handleCollabAddModalSubmit(interaction, ctx.apiSecret, tenantId);
    return;
  }

  if (customId.startsWith('creator_autosetup:role_modal:')) {
    const rest = customId.slice('creator_autosetup:role_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupRoleModalSubmit } = await import('../commands/autosetup');
    await handleAutosetupRoleModalSubmit(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_verify:lp_modal:')) {
    const { handleLicenseKeyModal } = await import('../commands/licenseVerify');
    await handleLicenseKeyModal(interaction, ctx.convex, ctx.apiSecret, process.env.API_BASE_URL);
    return;
  }

  // Product add - URL modal: creator_product:url_modal:{userId}:{tenantId}
  if (customId.startsWith('creator_product:url_modal:')) {
    const rest = customId.slice('creator_product:url_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductUrlModal } = await import('../commands/product');
    await handleProductUrlModal(interaction, userId, tenantId);
    return;
  }

  // Product add - Discord role modal: creator_product:discord_modal:{userId}:{tenantId}
  if (customId.startsWith('creator_product:discord_modal:')) {
    const rest = customId.slice('creator_product:discord_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductDiscordModal } = await import('../commands/product');
    await handleProductDiscordModal(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:message_modal:')) {
    const rest = customId.slice('creator_downloads:message_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsMessageModal } = await import('../commands/downloads');
    await handleDownloadsMessageModal(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:manage_message_modal:')) {
    const panelToken = customId.slice('creator_downloads:manage_message_modal:'.length);
    const { handleDownloadsManageMessageModal } = await import('../commands/downloads');
    await handleDownloadsManageMessageModal(interaction, ctx.convex, ctx.apiSecret, panelToken);
    return;
  }

  await interaction
    .reply({ content: 'Unknown modal.', flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

async function handleSelectMenu(
  interaction: StringSelectMenuInteraction,
  ctx: InteractionHandlerContext
): Promise<void> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_setup:')) {
    // biome-ignore lint/suspicious/noExplicitAny: setup select handler accepts the relevant select interactions at runtime.
    await handleSetupSelect(interaction as any, ctx.convex, ctx.apiSecret);
    return;
  }

  // Autosetup - mode select
  if (customId.startsWith('creator_autosetup:mode:')) {
    const tenantId = customId.slice('creator_autosetup:mode:'.length) as Id<'tenants'>;
    const { handleAutosetupModeSelect } = await import('../commands/autosetup');
    await handleAutosetupModeSelect(interaction, ctx.convex, ctx.apiSecret, tenantId);
    return;
  }
  // Autosetup - role format select
  if (customId.startsWith('creator_autosetup:role_format:')) {
    const rest = customId.slice('creator_autosetup:role_format:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupRoleFormatSelect } = await import('../commands/autosetup');
    await handleAutosetupRoleFormatSelect(interaction, userId, tenantId);
    return;
  }
  // Autosetup - products select (roles flow)
  if (customId.startsWith('creator_autosetup:products:')) {
    const rest = customId.slice('creator_autosetup:products:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupProductsSelect } = await import('../commands/autosetup');
    await handleAutosetupProductsSelect(interaction, ctx.convex, ctx.apiSecret, userId, tenantId);
    return;
  }
  // Autosetup - migrate product select (roleId stored in session to keep customId under 100 chars)
  if (customId.startsWith('creator_autosetup:mp:')) {
    const rest = customId.slice('creator_autosetup:mp:'.length);
    const parts = rest.split(':');
    const userId = parts[0];
    const tenantId = parts[1] as Id<'tenants'>;
    const { handleAutosetupMigrateProductSelect } = await import('../commands/autosetup');
    await handleAutosetupMigrateProductSelect(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      userId,
      tenantId
    );
    return;
  }

  // Product picker - product selected
  if (customId.startsWith('creator_verify:lp_select:')) {
    // Format: creator_verify:lp_select:{tenantId}:{filter}:{page}
    const rest = customId.slice('creator_verify:lp_select:'.length);
    const parts = rest.split(':');
    const tenantId = parts[0] as Id<'tenants'>;
    const { handleProductSelected } = await import('../commands/licenseVerify');
    await handleProductSelected(interaction, tenantId);
    return;
  }

  // Product type select: creator_product:type_select:{tenantId}
  if (customId.startsWith('creator_product:type_select:')) {
    const tenantId = customId.slice('creator_product:type_select:'.length) as Id<'tenants'>;
    const { handleProductTypeSelect } = await import('../commands/product');
    await handleProductTypeSelect(interaction, tenantId);
    return;
  }

  // Product Jinxxy product select: creator_product:jinxxy_product_select:{userId}:{tenantId}
  if (customId.startsWith('creator_product:jinxxy_product_select:')) {
    const rest = customId.slice('creator_product:jinxxy_product_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductJinxxySelect } = await import('../commands/product');
    await handleProductJinxxySelect(interaction, userId, tenantId);
    return;
  }

  // Product Lemon Squeezy product select: creator_product:ls_product_select:{userId}:{tenantId}
  if (customId.startsWith('creator_product:ls_product_select:')) {
    const rest = customId.slice('creator_product:ls_product_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductLemonSqueezySelect } = await import('../commands/product');
    await handleProductLemonSqueezySelect(interaction, userId, tenantId);
    return;
  }

  // Product remove select: creator_product:remove_select:{tenantId}
  if (customId.startsWith('creator_product:remove_select:')) {
    const tenantId = customId.slice('creator_product:remove_select:'.length) as Id<'tenants'>;
    const { handleProductRemoveSelect } = await import('../commands/product');
    await handleProductRemoveSelect(
      interaction as StringSelectMenuInteraction,
      ctx.convex,
      ctx.apiSecret,
      tenantId
    );
    return;
  }

  if (customId.startsWith('creator_downloads:logic_select:')) {
    const rest = customId.slice('creator_downloads:logic_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsLogicSelect } = await import('../commands/downloads');
    await handleDownloadsLogicSelect(interaction as StringSelectMenuInteraction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:ext_select:')) {
    const rest = customId.slice('creator_downloads:ext_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsExtensionSelect } = await import('../commands/downloads');
    await handleDownloadsExtensionSelect(
      interaction as StringSelectMenuInteraction,
      userId,
      tenantId
    );
    return;
  }

  if (customId.startsWith('creator_downloads:manage_select:')) {
    const panelToken = customId.slice('creator_downloads:manage_select:'.length);
    const { handleDownloadsManageSelect } = await import('../commands/downloads');
    await handleDownloadsManageSelect(
      interaction as StringSelectMenuInteraction,
      ctx.convex,
      ctx.apiSecret,
      panelToken
    );
    return;
  }

  // Moderation reason select: creator_moderation:reason_select:{actorId}:{tenantId}:{targetUserId}
  if (customId.startsWith('creator_moderation:reason_select:')) {
    const rest = customId.slice('creator_moderation:reason_select:'.length);
    const parts = rest.split(':');
    const actorId = parts[0];
    const tenantId = parts[1] as Id<'tenants'>;
    const targetUserId = parts[2];
    const { handleModerationReasonSelect } = await import('../commands/moderation');
    await handleModerationReasonSelect(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      actorId,
      tenantId,
      targetUserId
    );
    return;
  }

  await interaction
    .reply({ content: 'Unknown select.', flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

async function handleRoleSelectMenu(
  interaction: RoleSelectMenuInteraction,
  ctx: InteractionHandlerContext
): Promise<void> {
  await interaction.deferUpdate();

  const customId = interaction.customId;

  // Autosetup - migrate role select
  if (customId.startsWith('creator_autosetup:migrate_role:')) {
    const rest = customId.slice('creator_autosetup:migrate_role:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupMigrateRoleSelect } = await import('../commands/autosetup');
    await handleAutosetupMigrateRoleSelect(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      userId,
      tenantId
    );
    return;
  }
  // Autosetup - map-all role select
  if (customId.startsWith('creator_autosetup:mp_all_role:')) {
    const rest = customId.slice('creator_autosetup:mp_all_role:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleAutosetupMigrateMapAllRoleSelect } = await import('../commands/autosetup');
    await handleAutosetupMigrateMapAllRoleSelect(
      interaction,
      ctx.convex,
      ctx.apiSecret,
      userId,
      tenantId
    );
    return;
  }

  // Product role select: creator_product:role_select:{userId}:{tenantId}
  if (customId.startsWith('creator_product:role_select:')) {
    const rest = customId.slice('creator_product:role_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductRoleSelect } = await import('../commands/product');
    await handleProductRoleSelect(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:roles_select:')) {
    const rest = customId.slice('creator_downloads:roles_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsRoleSelect } = await import('../commands/downloads');
    await handleDownloadsRoleSelect(interaction, userId, tenantId);
    return;
  }

  await interaction.editReply({ content: 'Unknown role select.' }).catch(() => {});
}

async function handleChannelSelectMenu(
  interaction: ChannelSelectMenuInteraction,
  _ctx: InteractionHandlerContext
): Promise<void> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_downloads:source_select:')) {
    const rest = customId.slice('creator_downloads:source_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsSourceSelect } = await import('../commands/downloads');
    await handleDownloadsSourceSelect(interaction, userId, tenantId);
    return;
  }

  if (customId.startsWith('creator_downloads:archive_select:')) {
    const rest = customId.slice('creator_downloads:archive_select:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleDownloadsArchiveSelect } = await import('../commands/downloads');
    await handleDownloadsArchiveSelect(interaction, userId, tenantId);
    return;
  }

  await interaction
    .reply({ content: 'Unknown channel select.', flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

async function handleUserSelectMenu(
  interaction: UserSelectMenuInteraction,
  ctx: InteractionHandlerContext
): Promise<void> {
  const customId = interaction.customId;

  // Stats - check user select: creator_stats:check_user_select:{tenantId}:{guildId}
  if (customId.startsWith('creator_stats:check_user_select:')) {
    const rest = customId.slice('creator_stats:check_user_select:'.length);
    const parts = rest.split(':');
    const tenantId = parts[0] as Id<'tenants'>;
    const guildId = parts[1] ?? interaction.guildId ?? '';
    const { handleStatsCheckUserSelect } = await import('../commands/stats');
    await handleStatsCheckUserSelect(interaction, ctx.convex, ctx.apiSecret, tenantId, guildId);
    return;
  }

  await interaction
    .reply({ content: 'Unknown user select.', flags: MessageFlags.Ephemeral })
    .catch(() => {});
}
