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
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { createLogger } from '@yucp/shared';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { E } from '../lib/emojis';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  runSetupStart,
  handleSetupSelect,
  handleSetupJinxxyModal,
  buildSetupStep2Components,
  buildJinxxyModal,
} from '../commands/setup';
import { track } from '../lib/posthog';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

/** Message when server has no guild link. forAdmin: securely fetch token to sign-in; otherwise tell user to ask admin. */
async function getNotConfiguredMessage(guildId: string, discordUserId: string, apiSecret: string, forAdmin = false): Promise<string> {
  if (forAdmin) {
    const apiBase = process.env.API_BASE_URL;
    if (apiBase) {
      try {
        const res = await fetch(`${apiBase}/api/connect/create-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordUserId, apiSecret })
        });
        if (res.ok) {
          const { token } = await res.json() as { token: string };
          return `This server is not configured. [Sign in to configure](${apiBase}/connect?guild_id=${guildId}&token=${token})`;
        }
      } catch (e) {
        logger.error('Failed to generate secure connect token', { error: e });
      }
      return `This server is not configured. [Sign in to configure](${apiBase}/connect?guild_id=${guildId})`;
    }
    return 'This server is not configured. Please sign in to configure (API_BASE_URL not set).';
  }
  return 'This server isn\'t set up for verification yet. Ask a server admin to configure it in the Creator Portal.';
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
    | import('discord.js').ChannelSelectMenuInteraction,
  ctx: InteractionHandlerContext,
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
    await handleSelectMenu(interaction as any, ctx);
    return;
  }
}

// ── Autocomplete handler ──────────────────────────────────────────────────────

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  const { commandName, options } = interaction;

  if (commandName === 'creator-admin') {
    const focused = options.getFocused(true);
    if (focused.name !== 'product_id') {
      await interaction.respond([]);
      return;
    }

    const guildId = interaction.guildId;
    if (!guildId) { await interaction.respond([]); return; }

    try {
      const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot as any, {
        apiSecret: ctx.apiSecret,
        discordGuildId: guildId,
      });
      if (!guildLink) { await interaction.respond([]); return; }

      // We use getByGuildWithProductNames because it lists all products currently configured for the server
      const products = await ctx.convex.query(api.role_rules.getByGuildWithProductNames as any, {
        tenantId: guildLink.tenantId,
        guildId,
      });

      const query = focused.value.toLowerCase();
      const filtered = products
        .filter((p: { productId: string; displayName: string | null }) => {
          const searchLabel = (p.displayName ?? p.productId).toLowerCase();
          const discordLabel = p.productId.startsWith('discord_role:') ? 'discord role' : '';
          return !query || searchLabel.includes(query) || discordLabel.includes(query);
        })
        .slice(0, 25);

      // Resolve Discord role names for display (optional; OAuth checks roles, not the bot)
      const currentGuild = interaction.guild;
      const choices = await Promise.all(
        filtered.map(async (p: { productId: string; displayName: string | null; sourceGuildId?: string; requiredRoleId?: string; verifiedRoleId?: string }) => {
          let label = p.displayName ?? p.productId;
          if (p.productId.startsWith('discord_role:') && p.sourceGuildId && p.requiredRoleId) {
            try {
              const sourceGuild = await interaction.client.guilds.fetch(p.sourceGuildId).catch(() => null);
              const sourceRole = sourceGuild ? await sourceGuild.roles.fetch(p.requiredRoleId).catch(() => null) : null;
              const targetRole = currentGuild && p.verifiedRoleId ? await currentGuild.roles.fetch(p.verifiedRoleId).catch(() => null) : null;
              const sourceName = sourceRole?.name ?? '?';
              const targetName = targetRole?.name ?? '?';
              label = `Discord Role: ${sourceName} → ${targetName}`;
            } catch {
              label = 'Discord Role (cross-server)';
            }
          }
          return { name: label.slice(0, 100), value: p.productId.slice(0, 100) };
        })
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
  if (!guildId) { await interaction.respond([]); return; }

  try {
    const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot as any, {
      apiSecret: ctx.apiSecret,
      discordGuildId: guildId,
    });
    if (!guildLink) { await interaction.respond([]); return; }

    const products = (await ctx.convex.query('productResolution:getProductsForTenant' as any, {
      tenantId: guildLink.tenantId,
    })) as Array<{ productId: string; provider: string; providerProductRef: string; canonicalSlug?: string; displayName?: string }>;

    const query = focused.value.toLowerCase();
    const filtered = products
      .filter((p) => {
        const label = (p.displayName ?? p.canonicalSlug ?? p.productId).toLowerCase();
        return !query || label.includes(query) || p.provider.includes(query);
      })
      .slice(0, 25);

    await interaction.respond(
      filtered.map((p) => ({
        name: `${p.provider === 'gumroad' ? '🟣' : '🔷'} ${p.displayName ?? p.canonicalSlug ?? p.productId}`,
        value: `${p.provider}::${p.providerProductRef}`,
      })),
    );
  } catch {
    await interaction.respond([]);
  }
}


async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  const commandName = interaction.commandName;
  if (commandName !== 'creator' && commandName !== 'creator-admin') return;

  const subcommand = interaction.options.getSubcommand(false);
  const subcommandGroup = interaction.options.getSubcommandGroup(false);

  // /creator — no subcommands, smart state-aware entry point
  if (commandName === 'creator') {
    await handleUserCommand(interaction, ctx);
    return;
  }

  // /creator-admin — all admin subcommands; Discord hides this from non-admins; double-check
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

  const guildLink = await ctx.convex.query(api.guildLinks.getByDiscordGuildForBot as any, {
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
    if (subcommandGroup === 'setup') {
      if (subcommand === 'start' || subcommand === 'restart') {
        await runSetupStart(interaction, ctx.convex, ctx.apiSecret, {
          tenantId,
          guildLinkId,
          guildId,
        });
      }
    } else if (subcommandGroup === 'product') {
      const sub = interaction.options.getSubcommand();
      const { handleProductAddInteractive, handleProductList, handleProductRemove } =
        await import('../commands/product');
      if (sub === 'add') {
        await handleProductAddInteractive(interaction, { tenantId, guildLinkId, guildId });
      } else if (sub === 'list') {
        await handleProductList(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      } else if (sub === 'remove') {
        await handleProductRemove(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      }
    } else if (subcommand === 'stats') {
      // Single subcommand (not a group) — overview with navigation buttons
      const { handleStats } = await import('../commands/stats');
      await handleStats(interaction, ctx.convex, { tenantId, guildId });
    } else if (subcommand === 'spawn-verify') {
      const { handleVerifySpawn } = await import('../commands/verify');
      await handleVerifySpawn(interaction, ctx.convex, process.env.API_BASE_URL, {
        tenantId,
        guildLinkId,
        guildId,
      });
    } else if (subcommandGroup === 'settings') {
      // settings cross-server
      const { handleDiscordRoleVerification } = await import(
        '../commands/discordRoleVerification'
      );
      await handleDiscordRoleVerification(interaction, ctx.convex, ctx.apiSecret, { tenantId });
    } else if (subcommand === 'analytics') {
      // Single subcommand (not a group) — combined link + summary
      const { handleAnalytics } = await import('../commands/analytics');
      await handleAnalytics(interaction, ctx.convex, { tenantId, guildId });
    } else if (subcommandGroup === 'moderation') {
      const sub = interaction.options.getSubcommand();
      const { handleModerationMark, handleModerationList, handleModerationClear, handleModerationUnverify } =
        await import('../commands/moderation');
      if (sub === 'mark') {
        await handleModerationMark(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      } else if (sub === 'list') {
        await handleModerationList(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      } else if (sub === 'clear') {
        await handleModerationClear(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      } else if (sub === 'unverify') {
        await handleModerationUnverify(interaction, ctx.convex, ctx.apiSecret, { tenantId, guildId });
      }
    } else {
      await interaction.reply({
        content: 'Unknown command.',
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    logger.error('Command handler error', { err, command: subcommand });
    track(interaction.user.id, 'command_error', {
      command: subcommand,
      error: String(err),
    });
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: 'An error occurred. Please try again.' }).catch(() => { });
      } else if (!interaction.replied) {
        await interaction
          .reply({ content: 'An error occurred. Please try again.', flags: MessageFlags.Ephemeral })
          .catch(() => { });
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
      content: await getNotConfiguredMessage(guildId, interaction.user.id, ctx.apiSecret),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tenantId = guildLink.tenantId as Id<'tenants'>;

  try {
    const subcommand = interaction.options.getSubcommand(false);

    // /creator status — show status panel (default entry point)
    // /creator verify [product] — fast path: skip the picker, go straight to modal
    if (subcommand === 'status' || subcommand === null) {
      const { handleCreatorCommand } = await import('../commands/verify');
      await handleCreatorCommand(interaction, ctx.convex, ctx.apiSecret, process.env.API_BASE_URL, {
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
      const {
        ActionRowBuilder,
        ModalBuilder,
        TextInputBuilder,
        TextInputStyle,
      } = await import('discord.js');
      const modal = new ModalBuilder()
        .setCustomId(`creator_verify:lp_modal:${tenantId}:${providerProductRef}:${provider}`)
        .setTitle(isGumroad ? 'Enter Gumroad License Key' : 'Enter Jinxxy License Key');
      const keyInput = new TextInputBuilder()
        .setCustomId('license_key')
        .setLabel(isGumroad ? 'License Key (XXXX-XXXX-XXXX-XXXX)' : 'License Key')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(
          isGumroad ? 'XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX' : 'Enter your license key',
        )
        .setRequired(true)
        .setMinLength(8)
        .setMaxLength(200);
      modal.addComponents(
        new ActionRowBuilder<any>().addComponents(keyInput),
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

    // Unknown subcommand — show status panel as fallback
    const { handleCreatorCommand } = await import('../commands/verify');
    await handleCreatorCommand(interaction, ctx.convex, ctx.apiSecret, process.env.API_BASE_URL, {
      tenantId,
      guildId,
    });
  } catch (err) {
    logger.error('User command error', { err });
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: 'An error occurred.', flags: MessageFlags.Ephemeral })
        .catch(() => { });
    }
  }
}

async function handleButton(
  interaction: ButtonInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  const customId = interaction.customId;

  // ─── Verify flow (backwards-compatible) ───────────────────────────────────
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
        content: await getNotConfiguredMessage(guildId, interaction.user.id, ctx.apiSecret),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const { handleVerifyStartButton } = await import('../commands/verify');
    await handleVerifyStartButton(interaction, ctx.convex, ctx.apiSecret, process.env.API_BASE_URL, {
      tenantId: guildLink.tenantId as Id<'tenants'>,
      guildId,
    });
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
      provider,
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

  // ─── License picker — filter/page navigation ───────────────────────────────
  if (customId.startsWith('creator_verify:lp_filter:') || customId.startsWith('creator_verify:lp_page:')) {
    // Format: creator_verify:lp_filter:{tenantId}:{filter}:{page}
    //      OR creator_verify:lp_page:{tenantId}:{filter}:{page}
    const prefix = customId.startsWith('creator_verify:lp_filter:')
      ? 'creator_verify:lp_filter:'
      : 'creator_verify:lp_page:';
    const rest = customId.slice(prefix.length);
    const parts = rest.split(':');
    // parts[0] = tenantId, parts[1] = filter, parts[2] = page
    const tenantId = parts[0] as Id<'tenants'>;
    const filter = (parts[1] ?? 'all') as 'all' | 'gumroad' | 'jinxxy';
    const page = parseInt(parts[2] ?? '0', 10);
    const { handlePickerNavigation } = await import('../commands/licenseVerify');
    await handlePickerNavigation(interaction, ctx.convex, ctx.apiSecret, tenantId, filter, page);
    return;
  }

  // ─── Stats navigation ──────────────────────────────────────────────────────
  if (customId.startsWith('creator_stats:view_users:')) {
    const tenantId = customId.slice('creator_stats:view_users:'.length) as Id<'tenants'>;
    const { handleStatsViewUsersButton } = await import('../commands/stats');
    await handleStatsViewUsersButton(interaction, ctx.convex, tenantId);
    return;
  }

  if (customId.startsWith('creator_stats:view_products:')) {
    const tenantId = customId.slice('creator_stats:view_products:'.length) as Id<'tenants'>;
    const { handleStatsViewProductsButton } = await import('../commands/stats');
    await handleStatsViewProductsButton(interaction, ctx.convex, tenantId);
    return;
  }

  if (customId.startsWith('creator_stats:check_user:')) {
    const tenantId = customId.slice('creator_stats:check_user:'.length) as Id<'tenants'>;
    const { handleStatsCheckUserButton } = await import('../commands/stats');
    await handleStatsCheckUserButton(interaction, tenantId);
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
      actorId,
    );
    return;
  }

  if (customId === 'creator_moderation:cancel_clear') {
    await interaction.update({ content: 'Cancelled.', components: [], embeds: [] });
    return;
  }

  // ─── Legacy setup buttons ──────────────────────────────────────────────────
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
      const row1 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        logChannelSelect ?? new ChannelSelectMenuBuilder().setCustomId('dummy_select'),
      );
      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        jinxxyButton ??
        new ButtonBuilder().setCustomId('dummy_btn').setLabel('Dummy').setStyle(1),
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });
      return;
    }
    if (action === 'jinxxy_btn' && tenantId) {
      await interaction.showModal(buildJinxxyModal(tenantId as Id<'tenants'>) as any);
      return;
    }
  }

  await interaction.reply({ content: 'Unknown button.', flags: MessageFlags.Ephemeral }).catch(() => { });
}

async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_setup:jinxxy:')) {
    await handleSetupJinxxyModal(interaction, ctx.convex, ctx.apiSecret);
    return;
  }

  if (customId.startsWith('creator_verify:lp_modal:')) {
    const { handleLicenseKeyModal } = await import('../commands/licenseVerify');
    await handleLicenseKeyModal(interaction, ctx.convex, ctx.apiSecret, process.env.API_BASE_URL);
    return;
  }

  // Product add — URL modal: creator_product:url_modal:{userId}:{tenantId}
  if (customId.startsWith('creator_product:url_modal:')) {
    const rest = customId.slice('creator_product:url_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductUrlModal } = await import('../commands/product');
    await handleProductUrlModal(interaction, userId, tenantId);
    return;
  }

  // Product add — Discord role modal: creator_product:discord_modal:{userId}:{tenantId}
  if (customId.startsWith('creator_product:discord_modal:')) {
    const rest = customId.slice('creator_product:discord_modal:'.length);
    const colonIdx = rest.indexOf(':');
    const userId = rest.slice(0, colonIdx);
    const tenantId = rest.slice(colonIdx + 1) as Id<'tenants'>;
    const { handleProductDiscordModal } = await import('../commands/product');
    await handleProductDiscordModal(interaction, userId, tenantId);
    return;
  }

  // Stats — check user modal: creator_stats:check_user_modal:{tenantId}
  if (customId.startsWith('creator_stats:check_user_modal:')) {
    const tenantId = customId.slice('creator_stats:check_user_modal:'.length) as Id<'tenants'>;
    const { handleStatsCheckUserModal } = await import('../commands/stats');
    await handleStatsCheckUserModal(interaction, ctx.convex, tenantId);
    return;
  }

  await interaction.reply({ content: 'Unknown modal.', flags: MessageFlags.Ephemeral }).catch(() => { });
}

async function handleSelectMenu(
  interaction: StringSelectMenuInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  const customId = interaction.customId;

  if (customId.startsWith('creator_setup:')) {
    await handleSetupSelect(interaction as any, ctx.convex, ctx.apiSecret);
    return;
  }

  // Product picker — product selected
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
      targetUserId,
    );
    return;
  }

  await interaction.reply({ content: 'Unknown select.', flags: MessageFlags.Ephemeral }).catch(() => { });
}

async function handleRoleSelectMenu(
  interaction: RoleSelectMenuInteraction,
  ctx: InteractionHandlerContext,
): Promise<void> {
  const customId = interaction.customId;

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

  await interaction.reply({ content: 'Unknown role select.', flags: MessageFlags.Ephemeral }).catch(() => { });
}
