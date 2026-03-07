/**
 * /creator-admin autosetup — Guided setup: create roles, channels, verify button, or migrate
 *
 * Modular flow: user picks mode (full, roles_only, channels_only, migrate),
 * then the bot walks them through each step using Discord.js v14 UI components.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ChannelSelectMenuInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import { E, Emoji } from '../lib/emojis';
import { getApiUrls } from '../lib/apiUrls';
import { canBotManageRole } from '../lib/roleHierarchy';
import { track } from '../lib/posthog';
import { createLogger } from '@yucp/shared';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const AUTOSETUP_PREFIX = 'creator_autosetup:';

export interface AutosetupProduct {
  id: string;
  name: string;
  provider: 'gumroad' | 'jinxxy';
}

interface AutosetupSession {
  tenantId: Id<'tenants'>;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  mode?: 'full' | 'roles_only' | 'channels_only' | 'migrate';
  step?: number;
  products?: AutosetupProduct[];
  selectedProductIds?: string[];
  createdRoleIds?: Record<string, string>;
  verifyChannelId?: string;
  migrateRoleIndex?: number;
  /** Role selected for migration — stored in session to keep customId under 100 chars */
  migrateRoleId?: string;
  expiresAt: number;
}

const autosetupSessions = new Map<string, AutosetupSession>();

function getSessionKey(userId: string, tenantId: string): string {
  return `autosetup:${userId}:${tenantId}`;
}

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [key, session] of autosetupSessions.entries()) {
    if (now > session.expiresAt) autosetupSessions.delete(key);
  }
}

function sanitizeRoleName(name: string): string {
  return name
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'Verified';
}

async function fetchAllProducts(
  tenantId: string,
  apiSecret: string,
): Promise<AutosetupProduct[]> {
  const { apiInternal, apiPublic } = getApiUrls();
  const apiForFetch = apiInternal ?? apiPublic;
  if (!apiForFetch) return [];

  const products: AutosetupProduct[] = [];

  const [gumroadRes, jinxxyRes] = await Promise.all([
    fetch(`${apiForFetch}/api/gumroad/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiSecret, tenantId }),
    }),
    fetch(`${apiForFetch}/api/jinxxy/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiSecret, tenantId }),
    }),
  ]);

  const gumroadData = (await gumroadRes.json()) as { products?: { id: string; name: string }[] };
  const jinxxyData = (await jinxxyRes.json()) as { products?: { id: string; name: string }[] };

  for (const p of gumroadData.products ?? []) {
    products.push({ id: p.id, name: p.name, provider: 'gumroad' });
  }
  for (const p of jinxxyData.products ?? []) {
    products.push({ id: p.id, name: p.name, provider: 'jinxxy' });
  }

  const seen = new Set<string>();
  return products.filter((p) => {
    const key = `${p.provider}:${p.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Entry: /creator-admin autosetup */
export async function handleAutosetupStart(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { tenantId: Id<'tenants'>; guildLinkId: Id<'guild_links'>; guildId: string },
): Promise<void> {
  cleanExpiredSessions();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'This command must be used in a server.' });
    return;
  }

  const me = guild.members.me;
  const perms = me?.permissions;
  const hasManageRoles = perms?.has(PermissionFlagsBits.ManageRoles) ?? false;
  const hasManageChannels = perms?.has(PermissionFlagsBits.ManageChannels) ?? false;

  const sessionKey = getSessionKey(interaction.user.id, ctx.tenantId);
  autosetupSessions.set(sessionKey, {
    tenantId: ctx.tenantId,
    guildLinkId: ctx.guildLinkId,
    guildId: ctx.guildId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${E.Wrench} Autosetup`),
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      'Choose what you need. Each option guides you through the setup step by step.\n\n' +
        (hasManageRoles ? '' : `${E.Wrench} **Note:** The bot needs **Manage Roles** for role creation.\n`) +
        (hasManageChannels ? '' : `${E.Wrench} **Note:** The bot needs **Manage Channels** for channel creation.\n`),
    ),
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}mode:${ctx.tenantId}`)
    .setPlaceholder('Select setup mode...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Full setup')
        .setDescription('Create roles for products, verify channel, and spawn verify button')
        .setValue('full')
        .setEmoji(Emoji.Assistant),
      new StringSelectMenuOptionBuilder()
        .setLabel('Roles only')
        .setDescription('Create roles for your products and map them (channels already set up)')
        .setValue('roles_only')
        .setEmoji(Emoji.PersonKey),
      new StringSelectMenuOptionBuilder()
        .setLabel('Channels only')
        .setDescription('Create verify channel and spawn button (roles already exist)')
        .setValue('channels_only')
        .setEmoji(Emoji.Library),
      new StringSelectMenuOptionBuilder()
        .setLabel('Migrate from another bot')
        .setDescription('Map your existing roles to products')
        .setValue('migrate')
        .setEmoji(Emoji.Refresh),
    );

  container.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });

  track(interaction.user.id, 'autosetup_started', { tenantId: ctx.tenantId, guildId: ctx.guildId });
}

/** Mode selected — route to appropriate flow */
export async function handleAutosetupModeSelect(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const mode = interaction.values[0] as AutosetupSession['mode'];
  const sessionKey = getSessionKey(interaction.user.id, tenantId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  session.mode = mode;

  if (mode === 'roles_only' || mode === 'full') {
    await handleRolesFlowStart(interaction, convex, apiSecret, session);
  } else if (mode === 'channels_only') {
    await handleChannelsFlowStart(interaction, convex, apiSecret, session);
  } else if (mode === 'migrate') {
    await handleMigrateFlowStart(interaction, convex, apiSecret, session);
  }
}

async function handleRolesFlowStart(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  session: AutosetupSession,
): Promise<void> {
  await interaction.deferUpdate();

  const products = await fetchAllProducts(session.tenantId, apiSecret);

  if (products.length === 0) {
    const { apiPublic } = getApiUrls();
    const setupUrl = apiPublic ? `${apiPublic}/connect` : null;
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Wrench} No products found\n\n` +
          'Connect your Gumroad or Jinxxy account first to see your products.\n\n' +
          (setupUrl
            ? `Use \`/creator-admin setup start\` to get the link, or visit ${setupUrl}`
            : 'Use `/creator-admin setup start` to connect your accounts.'),
      ),
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  session.products = products;

  const existingRules = await convex.query(api.role_rules.getByGuildWithProductNames as any, {
    tenantId: session.tenantId,
    guildId: session.guildId,
  });
  const existingProductIds = new Set(
    (existingRules as Array<{ productId: string }>).map((r) => r.productId),
  );

  const availableProducts = products.filter((p) => {
    const key = p.provider === 'gumroad' ? p.id : `jinxxy:${p.id}`;
    return !existingProductIds.has(p.id) && !existingProductIds.has(key);
  });

  if (availableProducts.length === 0) {
    const container = new ContainerBuilder().setAccentColor(0x57f287);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Checkmark} All products already mapped\n\n` +
          'Every product from Gumroad and Jinxxy already has a role in this server.',
      ),
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  const MAX_OPTIONS = 25;
  const toShow = availableProducts.slice(0, MAX_OPTIONS);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}products:${interaction.user.id}:${session.tenantId}`)
    .setPlaceholder('Select products to create roles for...')
    .setMinValues(1)
    .setMaxValues(Math.min(toShow.length, 25))
    .addOptions(
      toShow.map((p) => {
        const value = `${p.provider}::${p.id}`;
        const label = p.name.length > 100 ? p.name.slice(0, 97) + '...' : p.name;
        const desc = `${p.provider === 'gumroad' ? E.Gumorad : E.Jinxxy} ${p.name}`.slice(0, 100);
        return new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setValue(value)
          .setDescription(desc);
      }),
    );

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.PersonKey} Select products\n\n` +
        `Choose which products should get new roles. We'll create a role for each and map them automatically.\n\n` +
        (availableProducts.length > MAX_OPTIONS
          ? `*(Showing first ${MAX_OPTIONS} of ${availableProducts.length})*`
          : ''),
    ),
  );
  container.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Products selected — create roles and map */
export async function handleAutosetupProductsSelect(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  session.selectedProductIds = interaction.values;

  await interaction.deferUpdate();

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Guild not found.' });
    return;
  }

  const createdRoleIds: Record<string, string> = {};
  const productList = session.products ?? [];
  const productMap = new Map(productList.map((p) => [`${p.provider}::${p.id}`, p]));

  let created = 0;
  let failed = 0;

  for (const value of session.selectedProductIds ?? []) {
    const product = productMap.get(value);
    if (!product) continue;

    try {
      const roleName = sanitizeRoleName(product.name);
      const role = await guild.roles.create({
        name: roleName,
        reason: 'Creator Assistant autosetup',
      });

      const hierarchyCheck = canBotManageRole(guild, role.id);
      if (!hierarchyCheck.canManage) {
        await role.delete('Bot cannot manage this role - hierarchy issue');
        failed++;
        continue;
      }

      createdRoleIds[value] = role.id;

      if (product.provider === 'gumroad') {
        const result = await convex.mutation(api.role_rules.addProductFromGumroad as any, {
          apiSecret,
          tenantId,
          productId: product.id,
          providerProductRef: product.id,
        });
        await convex.mutation(api.role_rules.createRoleRule as any, {
          apiSecret,
          tenantId,
          guildId: session.guildId,
          guildLinkId: session.guildLinkId,
          productId: result.productId,
          catalogProductId: result.catalogProductId,
          verifiedRoleId: role.id,
        });
      } else {
        const result = await convex.mutation(api.role_rules.addProductFromJinxxy as any, {
          apiSecret,
          tenantId,
          productId: product.id,
          providerProductRef: product.id,
          displayName: product.name,
        });
        await convex.mutation(api.role_rules.createRoleRule as any, {
          apiSecret,
          tenantId,
          guildId: session.guildId,
          guildLinkId: session.guildLinkId,
          productId: result.productId,
          catalogProductId: result.catalogProductId,
          verifiedRoleId: role.id,
        });
      }
      created++;

      if (created % 5 === 0 && created < (session.selectedProductIds?.length ?? 0)) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      logger.error('Autosetup role creation failed', {
        product: product.name,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  session.createdRoleIds = createdRoleIds;

  const container = new ContainerBuilder().setAccentColor(created > 0 ? 0x57f287 : 0xfaa61a);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.Checkmark} Roles created\n\n` +
        `Created **${created}** role(s) and mapped them to your products.\n` +
        (failed > 0 ? `\n${failed} failed (check role hierarchy).` : '') +
        (session.mode === 'full'
          ? '\n\nNext: we\'ll set up the verify channel and spawn the verify button.'
          : ''),
    ),
  );

  if (session.mode === 'full') {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${AUTOSETUP_PREFIX}channels_next:${userId}:${tenantId}`)
        .setLabel('Continue to channels')
        .setEmoji(Emoji.Checkmark)
        .setStyle(ButtonStyle.Success),
    );
    container.addActionRowComponents(row);
  }

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });

  track(interaction.user.id, 'autosetup_roles_created', {
    tenantId,
    guildId: session.guildId,
    count: created,
  });
}

async function handleChannelsFlowStart(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  session: AutosetupSession,
): Promise<void> {
  await interaction.deferUpdate();

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.Library} Verify channel\n\n` +
        'Should we create a **#verify** channel and post the verify button there?',
    ),
  );
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${AUTOSETUP_PREFIX}create_verify:${interaction.user.id}:${session.tenantId}`)
        .setLabel('Create #verify channel')
        .setEmoji(Emoji.Checkmark)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${AUTOSETUP_PREFIX}spawn_here:${interaction.user.id}:${session.tenantId}`)
        .setLabel('Just spawn button here')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${AUTOSETUP_PREFIX}channels_skip:${interaction.user.id}:${session.tenantId}`)
        .setLabel('Skip')
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Create verify channel and spawn button */
export async function handleAutosetupCreateVerify(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Guild not found.' });
    return;
  }

  try {
    const channel = await guild.channels.create({
      name: 'verify',
      type: ChannelType.GuildText,
      reason: 'Creator Assistant autosetup',
    });
    session.verifyChannelId = channel.id;

    const { EmbedBuilder } = await import('discord.js');
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');

    const embed = new EmbedBuilder()
      .setTitle(`${(await import('../lib/emojis')).E.Assistant} Verify your purchase`)
      .setDescription(
        [
          `${(await import('../lib/emojis')).E.Touch} Click the button below to open the verification panel.`,
          '',
          `${(await import('../lib/emojis')).E.Link} **Sign in** — Connect Gumroad or Discord. We recognize your purchases and grant your role automatically.`,
          '',
          `${(await import('../lib/emojis')).E.KeyCloud} **License key** — Using Jinxxy or Gumroad license? Enter one key once. We link your account and sync all past and future purchases.`,
          '',
          'Connections are secure and used only for verification.',
        ].join('\n'),
      )
      .setColor(0x5865f2)
      .setFooter({ text: 'Creator Assistant · Secure verification' });

    const button = new ButtonBuilder()
      .setCustomId('verify_start')
      .setLabel('Verify')
      .setEmoji((await import('../lib/emojis')).Emoji.Bag)
      .setStyle(ButtonStyle.Primary);

    await channel.send({
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
    });

    const container = new ContainerBuilder().setAccentColor(0x57f287);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Checkmark} Done!\n\n` +
          `Created <#${channel.id}> and posted the verify button. Your members can now verify their purchases there.`,
      ),
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });

    track(interaction.user.id, 'autosetup_verify_channel_created', {
      tenantId,
      guildId: session.guildId,
    });
  } catch (err) {
    logger.error('Autosetup create verify channel failed', {
      error: err instanceof Error ? err.message : String(err),
      tenantId,
      guildId: session.guildId,
    });
    await interaction.editReply({
      content: `${E.X_} Could not create the verify channel. Check that the bot has Manage Channels permission.`,
    });
  }
}

/** Spawn verify button in current channel */
export async function handleAutosetupSpawnHere(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  const channel = interaction.channel;
  if (!channel || !('send' in channel)) {
    await interaction.editReply({ content: 'Cannot send messages in this channel.' });
    return;
  }

  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
  const { E: Em, Emoji: EmojiMod } = await import('../lib/emojis');

  const embed = new EmbedBuilder()
    .setTitle(`${Em.Assistant} Verify your purchase`)
    .setDescription(
      [
        `${Em.Touch} Click the button below to open the verification panel.`,
        '',
        `${Em.Link} **Sign in** — Connect Gumroad or Discord.`,
        '',
        `${Em.KeyCloud} **License key** — Enter your license key to verify.`,
        '',
        'Connections are secure and used only for verification.',
      ].join('\n'),
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'Creator Assistant · Secure verification' });

  const button = new ButtonBuilder()
    .setCustomId('verify_start')
    .setLabel('Verify')
    .setEmoji(EmojiMod.Bag)
    .setStyle(ButtonStyle.Primary);

  await channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
  });

  const container = new ContainerBuilder().setAccentColor(0x57f287);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.Checkmark} Done!\n\nPosted the verify button in this channel.`,
    ),
  );
  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Skip channels */
export async function handleAutosetupChannelsSkip(
  interaction: ButtonInteraction,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  await interaction.update({
    content: `${E.Checkmark} Skipped channel setup. Use \`/creator-admin spawn-verify\` anytime to post the verify button.`,
    components: [],
  });
}

/** Continue from roles to channels (full flow) */
export async function handleAutosetupChannelsNext(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  await handleChannelsFlowStart(
    interaction as unknown as StringSelectMenuInteraction,
    convex,
    apiSecret,
    session,
  );
}

async function handleMigrateFlowStart(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  session: AutosetupSession,
): Promise<void> {
  await interaction.deferUpdate();

  const products = await fetchAllProducts(session.tenantId, apiSecret);

  if (products.length === 0) {
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Wrench} No products found\n\n` +
          'Connect Gumroad or Jinxxy first. Use `/creator-admin setup start`.',
      ),
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  session.products = products;
  session.migrateRoleIndex = 0;

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Guild not found.' });
    return;
  }

  const roles = await guild.roles.fetch();
  const mappableRoles = roles
    .filter((r) => !r.managed && r.id !== guild.id && r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .first(25);

  if (mappableRoles.length === 0) {
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Wrench} No roles to map\n\n` +
          'This server has no roles besides @everyone and bot roles. Create roles first, then run autosetup migrate.',
      ),
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  const select = new RoleSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}migrate_role:${interaction.user.id}:${session.tenantId}`)
    .setPlaceholder('Select a role to map to a product...');

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.Refresh} Migrate: map role to product\n\n` +
        'Select a role from your server. Next, we\'ll ask which product it corresponds to.',
    ),
  );
  container.addActionRowComponents(
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select),
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Role selected for migration — show product picker */
export async function handleAutosetupMigrateRoleSelect(
  interaction: RoleSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const roleId = interaction.values[0];
  const sessionKey = getSessionKey(userId, tenantId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  session.migrateRoleId = roleId;

  const products = session.products ?? [];
  const MAX_OPTIONS = 25;
  const toShow = products.slice(0, MAX_OPTIONS);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}mp:${userId}:${tenantId}`)
    .setPlaceholder('Which product does this role represent?')
    .addOptions(
      toShow.map((p) => {
        const value = `${p.provider}::${p.id}`;
        const label = p.name.length > 100 ? p.name.slice(0, 97) + '...' : p.name;
        return new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setValue(value)
          .setDescription(`${p.provider}`);
      }),
    );

  const role = interaction.guild?.roles.cache.get(roleId);
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## Map role to product\n\n` +
        `Role: **${role?.name ?? 'Unknown'}**\n\n` +
        'Select the product this role should grant access to:',
    ),
  );
  container.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  );

  await interaction.reply({
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Product selected for migration — create rule */
export async function handleAutosetupMigrateProductSelect(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  tenantId: Id<'tenants'>,
): Promise<void> {
  const sessionKey = getSessionKey(userId, tenantId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  const value = interaction.values[0];
  const [provider, productId] = value.split('::');
  const product = session.products?.find(
    (p) => p.id === productId && p.provider === provider,
  );

  if (!product) {
    await interaction.update({ content: 'Product not found.' });
    return;
  }

  const roleId = session.migrateRoleId;
  if (!roleId) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` and select the role again.`,
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    if (product.provider === 'gumroad') {
      const result = await convex.mutation(api.role_rules.addProductFromGumroad as any, {
        apiSecret,
        tenantId,
        productId: product.id,
        providerProductRef: product.id,
      });
      await convex.mutation(api.role_rules.createRoleRule as any, {
        apiSecret,
        tenantId,
        guildId: session.guildId,
        guildLinkId: session.guildLinkId,
        productId: result.productId,
        catalogProductId: result.catalogProductId,
        verifiedRoleId: roleId,
      });
    } else {
      const result = await convex.mutation(api.role_rules.addProductFromJinxxy as any, {
        apiSecret,
        tenantId,
        productId: product.id,
        providerProductRef: product.id,
        displayName: product.name,
      });
      await convex.mutation(api.role_rules.createRoleRule as any, {
        apiSecret,
        tenantId,
        guildId: session.guildId,
        guildLinkId: session.guildLinkId,
        productId: result.productId,
        catalogProductId: result.catalogProductId,
        verifiedRoleId: roleId,
      });
    }

    const role = interaction.guild?.roles.cache.get(roleId);
    const container = new ContainerBuilder().setAccentColor(0x57f287);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Checkmark} Mapped!\n\n` +
          `**${role?.name ?? 'Role'}** → **${product.name}**\n\n` +
          'Map another role? Run `/creator-admin autosetup` and choose **Migrate** again.',
      ),
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });

    session.migrateRoleId = undefined;

    track(interaction.user.id, 'autosetup_migrate_mapped', {
      tenantId,
      guildId: session.guildId,
    });
  } catch (err) {
    logger.error('Autosetup migrate failed', {
      error: err instanceof Error ? err.message : String(err),
      tenantId,
      productId: product.id,
    });
    await interaction.editReply({
      content: `${E.X_} Could not create the mapping. Try again.`,
    });
  }
}
