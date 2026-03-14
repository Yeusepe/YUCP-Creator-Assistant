/**
 * /creator-admin autosetup - Guided setup: create roles, channels, verify button, or migrate
 *
 * Modular flow: user picks mode (full, roles_only, channels_only, migrate),
 * then the bot walks them through each step using Discord.js v14 UI components.
 */

import { createLogger } from '@yucp/shared';
import type { ConvexHttpClient } from 'convex/browser';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { getApiUrls } from '../lib/apiUrls';
import { E, Emoji } from '../lib/emojis';
import { listGumroadProducts, listJinxxyProducts } from '../lib/internalRpc';
import { track } from '../lib/posthog';
import { canBotManageRole } from '../lib/roleHierarchy';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const AUTOSETUP_PREFIX = 'creator_autosetup:';

export interface AutosetupProduct {
  id: string;
  name: string;
  provider: string;
}

interface AutosetupSession {
  authUserId: string;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  mode?: 'full' | 'roles_only' | 'channels_only' | 'migrate';
  step?: number;
  products?: AutosetupProduct[];
  selectedProductIds?: string[];
  createdRoleIds?: Record<string, string>;
  verifyChannelId?: string;
  migrateRoleIndex?: number;
  /** Role selected for migration - stored in session to keep customId under 100 chars */
  migrateRoleId?: string;
  /** Product keys (provider:id) mapped during this migrate session */
  migrateMappedProductKeys?: string[];
  /** Product being mapped in "map all" flow - stored in session */
  migrateMapAllProduct?: { provider: string; id: string };
  /** Role name format: full, first_word, first_two_words, first_three_words, last_word */
  roleFormat?: 'full' | 'first_word' | 'first_two_words' | 'first_three_words' | 'last_word';
  /** Optional emoji prefix (e.g. "⭐") */
  roleEmoji?: string;
  /** Optional text prefix (e.g. "VIP ") */
  rolePrefix?: string;
  /** Optional text suffix (e.g. " ✓") */
  roleSuffix?: string;
  /** Whether to combine products with same name into one role */
  combineDuplicates?: boolean;
  expiresAt: number;
}

const autosetupSessions = new Map<string, AutosetupSession>();

function getSessionKey(userId: string, authUserId: string): string {
  return `autosetup:${userId}:${authUserId}`;
}

function productKey(p: AutosetupProduct): string {
  return `${p.provider}:${p.id}`;
}

/** Build error container for ComponentsV2 - use instead of content in editReply */
function errorContainer(message: string): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(0xed4245);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${E.X_} ${message}`));
  return container;
}

/** Build loading container - refresh ephemeral message with status while async work runs */
function loadingContainer(message: string): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${E.Timer} ${message}`)
  );
  return container;
}

function buildMigrateConfirmationUI(
  session: AutosetupSession,
  userId: string,
  authUserId: string,
  justMapped?: { roleName: string; productName: string }
): { container: ContainerBuilder; hasUnmapped: boolean } {
  const mappedCount = session.migrateMappedProductKeys?.length ?? 0;
  const total = session.products?.length ?? 0;
  const hasUnmapped = mappedCount < total;

  const header = justMapped
    ? `## ${E.Checkmark} Mapped!\n\n**${justMapped.roleName}** → **${justMapped.productName}**`
    : `## ${E.Checkmark} Migration progress`;
  const progress =
    total > 0 ? `\n\n${E.Checkmark} **${mappedCount}** of **${total}** products mapped` : '';
  const footer = hasUnmapped
    ? '\n\nWhat would you like to do next?'
    : '\n\nAll products are mapped!';

  const container = new ContainerBuilder().setAccentColor(0x57f287);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(header + progress + footer)
  );

  const doneBtn = new ButtonBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}mp_done:${userId}:${authUserId}`)
    .setLabel('Done')
    .setStyle(ButtonStyle.Success)
    .setEmoji(Emoji.ThumbsUp);

  const mapAnotherBtn = new ButtonBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}mp_another:${userId}:${authUserId}`)
    .setLabel('Map another')
    .setStyle(ButtonStyle.Primary)
    .setEmoji(Emoji.Refresh);

  const mapAllBtn = new ButtonBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}mp_all:${userId}:${authUserId}`)
    .setLabel('Map all')
    .setStyle(ButtonStyle.Primary)
    .setEmoji(Emoji.ClapStars);

  if (!hasUnmapped) {
    mapAllBtn.setDisabled(true);
  }

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(doneBtn, mapAnotherBtn, mapAllBtn)
  );

  return { container, hasUnmapped };
}

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [key, session] of autosetupSessions.entries()) {
    if (now > session.expiresAt) autosetupSessions.delete(key);
  }
}

function sanitizeRoleName(name: string): string {
  return (
    name
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'Verified'
  );
}

function formatRoleName(
  name: string,
  session: Pick<AutosetupSession, 'roleFormat' | 'roleEmoji' | 'rolePrefix' | 'roleSuffix'>
): string {
  let base = sanitizeRoleName(name);
  const format = session.roleFormat ?? 'full';
  const words = base.split(/\s+/).filter(Boolean);
  if (format === 'first_word' && words.length > 0) {
    base = words[0];
  } else if (format === 'first_two_words' && words.length >= 2) {
    base = words.slice(0, 2).join(' ');
  } else if (format === 'first_three_words' && words.length >= 3) {
    base = words.slice(0, 3).join(' ');
  } else if (format === 'last_word' && words.length > 0) {
    base = words[words.length - 1];
  }
  const prefix = (session.roleEmoji ?? '') + (session.rolePrefix ?? '');
  const suffix = session.roleSuffix ?? '';
  const result = (prefix + base + suffix).slice(0, 100);
  return result || 'Verified';
}

async function fetchAllProducts(
  authUserId: string,
  _apiSecret: string
): Promise<AutosetupProduct[]> {
  const products: AutosetupProduct[] = [];

  const [gumroadData, jinxxyData] = await Promise.all([
    listGumroadProducts(authUserId),
    listJinxxyProducts(authUserId),
  ]);

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
  _convex: ConvexHttpClient,
  _apiSecret: string,
  ctx: { authUserId: string; guildLinkId: Id<'guild_links'>; guildId: string }
): Promise<void> {
  cleanExpiredSessions();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [errorContainer('This command must be used in a server.')],
    });
    return;
  }

  const me = guild.members.me;
  const perms = me?.permissions;
  const hasManageRoles = perms?.has(PermissionFlagsBits.ManageRoles) ?? false;
  const hasManageChannels = perms?.has(PermissionFlagsBits.ManageChannels) ?? false;

  const sessionKey = getSessionKey(interaction.user.id, ctx.authUserId);
  autosetupSessions.set(sessionKey, {
    authUserId: ctx.authUserId,
    guildLinkId: ctx.guildLinkId,
    guildId: ctx.guildId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${E.Wrench} Autosetup`)
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `Choose what you need. Each option guides you through the setup step by step.\n\n${hasManageRoles ? '' : `${E.Wrench} **Note:** The bot needs **Manage Roles** for role creation.\n`}${hasManageChannels ? '' : `${E.Wrench} **Note:** The bot needs **Manage Channels** for channel creation.\n`}`
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}mode:${ctx.authUserId}`)
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
        .setEmoji(Emoji.Refresh)
    );

  container.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });

  track(interaction.user.id, 'autosetup_started', {
    authUserId: ctx.authUserId,
    guildId: ctx.guildId,
  });
}

/** Mode selected - route to appropriate flow */
export async function handleAutosetupModeSelect(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string
): Promise<void> {
  const mode = interaction.values[0] as AutosetupSession['mode'];
  const sessionKey = getSessionKey(interaction.user.id, authUserId);
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

function getDuplicateNameGroups(products: AutosetupProduct[]): Map<string, AutosetupProduct[]> {
  const byName = new Map<string, AutosetupProduct[]>();
  for (const p of products) {
    const key = p.name.toLowerCase().trim();
    const list = byName.get(key) ?? [];
    list.push(p);
    byName.set(key, list);
  }
  const duplicates = new Map<string, AutosetupProduct[]>();
  for (const [name, list] of byName) {
    if (list.length > 1 && new Set(list.map((x) => x.provider)).size > 1) {
      duplicates.set(name, list);
    }
  }
  return duplicates;
}

function buildRoleCustomizationPreview(session: AutosetupSession): string {
  const example = session.products?.[0]?.name ?? 'My Awesome Product';
  const formatted = formatRoleName(example, session);
  const parts: string[] = [];
  parts.push(`**Preview:** \`${formatted}\``);
  const hasDecoration = session.roleEmoji || session.rolePrefix || session.roleSuffix;
  if (hasDecoration) {
    const dec: string[] = [];
    if (session.roleEmoji) dec.push(`emoji: ${session.roleEmoji.trim()}`);
    if (session.rolePrefix) dec.push(`prefix: "${session.rolePrefix}"`);
    if (session.roleSuffix) dec.push(`suffix: "${session.roleSuffix}"`);
    parts.push(`**Current decoration:** ${dec.join(', ')}`);
  }
  return parts.length > 0 ? `\n\n${parts.join('\n')}` : '';
}

async function showRoleCustomizationStep(
  interaction: StringSelectMenuInteraction | ButtonInteraction | ModalSubmitInteraction,
  session: AutosetupSession,
  userId: string,
  authUserId: string
): Promise<void> {
  const currentFormat = session.roleFormat ?? 'full';
  const formatOptions = [
    { value: 'full', label: 'Full product name', desc: 'e.g. My Awesome Product' },
    { value: 'first_word', label: 'First word only', desc: 'e.g. My' },
    { value: 'first_two_words', label: 'First two words', desc: 'e.g. My Awesome' },
    { value: 'first_three_words', label: 'First three words', desc: 'e.g. My Awesome Product' },
    { value: 'last_word', label: 'Last word only', desc: 'e.g. Product' },
  ];
  const formatSelect = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}role_format:${userId}:${authUserId}`)
    .setPlaceholder('Role name style...')
    .addOptions(
      formatOptions.map((o) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(o.label)
          .setValue(o.value)
          .setDescription(o.desc)
          .setDefault(o.value === currentFormat)
      )
    );

  const preview = buildRoleCustomizationPreview(session);

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.PersonKey} Customize role names\n\n**Format:** How much of the product name to use.\n**Decoration:** Add prefix, suffix, or emoji via the button below.${preview}`
    )
  );
  const hasDecoration = !!(session.roleEmoji || session.rolePrefix || session.roleSuffix);
  container.addActionRowComponents(
    // biome-ignore lint/suspicious/noExplicitAny: Discord container row typing is narrower than the runtime builder support here.
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(formatSelect) as any,
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${AUTOSETUP_PREFIX}role_custom_modal:${userId}:${authUserId}`)
        .setLabel(hasDecoration ? 'Edit prefix / suffix / emoji' : 'Add prefix / suffix / emoji')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${AUTOSETUP_PREFIX}role_custom_done:${userId}:${authUserId}`)
        .setLabel('Continue')
        .setStyle(ButtonStyle.Success)
        .setEmoji(Emoji.Checkmark)
    )
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

const ROLE_CUSTOM_MODAL_PREFIX = 'creator_autosetup:role_modal:';

function buildRoleCustomModal(userId: string, authUserId: string): ModalBuilder {
  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);
  const prefix = session?.rolePrefix ?? '';
  const suffix = session?.roleSuffix ?? '';
  const emoji = (session?.roleEmoji ?? '').trim();

  const modal = new ModalBuilder()
    .setCustomId(`${ROLE_CUSTOM_MODAL_PREFIX}${userId}:${authUserId}`)
    .setTitle('Custom role decoration');

  const prefixInput = new TextInputBuilder()
    .setCustomId('prefix')
    .setLabel('Prefix (before name)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. VIP , ⭐ , [Backer] ')
    .setRequired(false)
    .setMaxLength(30)
    .setValue(prefix);

  const suffixInput = new TextInputBuilder()
    .setCustomId('suffix')
    .setLabel('Suffix (after name)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g.  ✓,  🎉, [Verified]')
    .setRequired(false)
    .setMaxLength(30)
    .setValue(suffix);

  const emojiInput = new TextInputBuilder()
    .setCustomId('emoji')
    .setLabel('Emoji (at start, before prefix)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. ⭐ or leave empty')
    .setRequired(false)
    .setMaxLength(10)
    .setValue(emoji);

  modal.addComponents(
    new ActionRowBuilder<typeof prefixInput>().addComponents(prefixInput),
    new ActionRowBuilder<typeof suffixInput>().addComponents(suffixInput),
    new ActionRowBuilder<typeof emojiInput>().addComponents(emojiInput)
  );

  return modal;
}

/** Show custom role decoration modal */
export async function handleAutosetupRoleCustomModal(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const modal = buildRoleCustomModal(userId, authUserId);
  await interaction.showModal(modal);
}

/** Handle custom role decoration modal submit */
export async function handleAutosetupRoleModalSubmit(
  interaction: ModalSubmitInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const prefix = interaction.fields.getTextInputValue('prefix')?.trim() ?? '';
  const suffix = interaction.fields.getTextInputValue('suffix')?.trim() ?? '';
  const emoji = interaction.fields.getTextInputValue('emoji')?.trim() ?? '';

  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);
  if (!session || Date.now() > session.expiresAt) {
    await interaction.reply({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.rolePrefix = prefix || undefined;
  session.roleSuffix = suffix || undefined;
  session.roleEmoji = emoji ? `${emoji} ` : undefined;

  await interaction.deferUpdate();
  await showRoleCustomizationStep(interaction, session, userId, authUserId);
}

async function showProductSelectStep(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  session: AutosetupSession,
  userId: string
): Promise<void> {
  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [loadingContainer('Loading...')],
  });

  const products = session.products ?? [];
  const existingRules = (await convex.query(api.role_rules.getByGuildWithProductNames, {
    apiSecret,
    authUserId: session.authUserId,
    guildId: session.guildId,
  })) as Array<{ productId: string }>;
  const hasExisting = existingRules.length > 0;

  const combineDuplicates = session.combineDuplicates ?? false;
  let toShow: { value: string; label: string; desc: string }[];
  if (combineDuplicates) {
    const byName = new Map<string, AutosetupProduct[]>();
    for (const p of products) {
      const key = p.name.toLowerCase().trim();
      const list = byName.get(key) ?? [];
      list.push(p);
      byName.set(key, list);
    }
    toShow = Array.from(byName.entries())
      .slice(0, 25)
      .map(([_name, list]) => {
        const value = list.map((p) => productKey(p)).join(',');
        const label = list[0].name.length > 100 ? `${list[0].name.slice(0, 97)}...` : list[0].name;
        const providers = [...new Set(list.map((p) => p.provider))].join(' + ');
        return { value, label, desc: `${list.length} product(s) from ${providers}` };
      });
  } else {
    toShow = products.slice(0, 25).map((p) => {
      const value = productKey(p);
      const label = p.name.length > 100 ? `${p.name.slice(0, 97)}...` : p.name;
      const desc = `${p.provider === 'gumroad' ? E.Gumorad : E.Jinxxy} ${p.name}`.slice(0, 100);
      return { value, label, desc };
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}products:${userId}:${session.authUserId}`)
    .setPlaceholder('Select products to create roles for...')
    .setMinValues(1)
    .setMaxValues(Math.min(toShow.length, 25))
    .addOptions(
      toShow.map((o) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(o.label)
          .setValue(o.value)
          .setDescription(o.desc)
      )
    );

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.PersonKey} Select products\n\n${
        hasExisting
          ? `${E.Wrench} **Warning:** Some products already have roles. Creating new roles will add additional mappings.\n\n`
          : ''
      }${combineDuplicates ? '*(Products with the same name are combined into one role.)*\n\n' : ''}Choose which products should get new roles:\n\n${products.length > 25 ? `*(Showing first 25 of ${products.length})*` : ''}`
    )
  );
  container.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

async function handleRolesFlowStart(
  interaction: StringSelectMenuInteraction,
  _convex: ConvexHttpClient,
  apiSecret: string,
  session: AutosetupSession
): Promise<void> {
  await interaction.deferUpdate();

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [loadingContainer('Loading products...')],
  });

  const products = await fetchAllProducts(session.authUserId, apiSecret);

  if (products.length === 0) {
    const { apiPublic } = getApiUrls();
    const setupUrl = apiPublic ? `${apiPublic}/dashboard` : null;
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Wrench} No products found\n\nConnect your Gumroad or Jinxxy account first to see your products.\n\n${
          setupUrl
            ? `Use \`/creator-admin setup start\` to get the link, or visit ${setupUrl}`
            : 'Use `/creator-admin setup start` to connect your accounts.'
        }`
      )
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  session.products = products;
  await showRoleCustomizationStep(interaction, session, interaction.user.id, session.authUserId);
}

/** Role format selected */
export async function handleAutosetupRoleFormatSelect(
  interaction: StringSelectMenuInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);
  if (!session || Date.now() > session.expiresAt) return;
  session.roleFormat = interaction.values[0] as AutosetupSession['roleFormat'];
  await interaction.deferUpdate();
  await showRoleCustomizationStep(interaction, session, userId, authUserId);
}

/** Role customization done - show combine prompt or product select */
export async function handleAutosetupRoleCustomDone(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);
  if (!session || Date.now() > session.expiresAt) return;
  await interaction.deferUpdate();

  const products = session.products ?? [];
  const duplicates = getDuplicateNameGroups(products);

  if (duplicates.size > 0) {
    const dupNames = Array.from(duplicates.keys()).slice(0, 5).join(', ');
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Refresh} Same name products?\n\nSome products have the same name across stores (e.g. "${dupNames}").\n\nCombine them into one role?\n\n**Yes** - One role for all products with the same name\n**No** - Separate roles for each product`
      )
    );
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${AUTOSETUP_PREFIX}combine_yes:${userId}:${authUserId}`)
          .setLabel('Yes, combine')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${AUTOSETUP_PREFIX}combine_no:${userId}:${authUserId}`)
          .setLabel('No, separate')
          .setStyle(ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
  } else {
    await showProductSelectStep(interaction, convex, apiSecret, session, userId);
  }
}

/** Combine duplicates choice */
export async function handleAutosetupCombineChoice(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  authUserId: string,
  combine: boolean
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);
  if (!session || Date.now() > session.expiresAt) return;
  await interaction.deferUpdate();
  session.combineDuplicates = combine;
  await showProductSelectStep(interaction, convex, apiSecret, session, userId);
}

/** Products selected - create roles and map */
export async function handleAutosetupProductsSelect(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
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

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [loadingContainer('Creating roles...')],
  });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [errorContainer('Guild not found.')],
    });
    return;
  }

  const createdRoleIds: Record<string, string> = {};
  const productList = session.products ?? [];
  const productMap = new Map(productList.map((p) => [productKey(p), p]));

  let created = 0;
  let failed = 0;

  for (const value of session.selectedProductIds ?? []) {
    const productKeys = value
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const products = productKeys
      .map((k) => productMap.get(k))
      .filter((p): p is AutosetupProduct => p != null);
    if (products.length === 0) continue;

    const primaryProduct = products[0];
    const roleName = formatRoleName(primaryProduct.name, session);

    try {
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

      for (const pk of productKeys) createdRoleIds[pk] = role.id;

      for (const product of products) {
        if (product.provider === 'gumroad') {
          const result = await convex.mutation(api.role_rules.addProductFromGumroad, {
            apiSecret,
            authUserId,
            productId: product.id,
            providerProductRef: product.id,
          });
          await convex.mutation(api.role_rules.createRoleRule, {
            apiSecret,
            authUserId,
            guildId: session.guildId,
            guildLinkId: session.guildLinkId,
            productId: result.productId,
            catalogProductId: result.catalogProductId,
            verifiedRoleId: role.id,
          });
        } else {
          const result = await convex.mutation(api.role_rules.addProductFromJinxxy, {
            apiSecret,
            authUserId,
            productId: product.id,
            providerProductRef: product.id,
            displayName: product.name,
          });
          await convex.mutation(api.role_rules.createRoleRule, {
            apiSecret,
            authUserId,
            guildId: session.guildId,
            guildLinkId: session.guildLinkId,
            productId: result.productId,
            catalogProductId: result.catalogProductId,
            verifiedRoleId: role.id,
          });
        }
      }
      created++;

      if (created % 5 === 0 && created < (session.selectedProductIds?.length ?? 0)) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      logger.error('Autosetup role creation failed', {
        product: primaryProduct.name,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  session.createdRoleIds = createdRoleIds;

  const container = new ContainerBuilder().setAccentColor(created > 0 ? 0x57f287 : 0xfaa61a);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.Checkmark} Roles created\n\nCreated **${created}** role(s) and mapped them to your products.\n${failed > 0 ? `\n${failed} failed (check role hierarchy).` : ''}${
        session.mode === 'full'
          ? "\n\nNext: we'll set up the verify channel and spawn the verify button."
          : ''
      }`
    )
  );

  if (session.mode === 'full') {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${AUTOSETUP_PREFIX}channels_next:${userId}:${authUserId}`)
        .setLabel('Continue to channels')
        .setEmoji(Emoji.Checkmark)
        .setStyle(ButtonStyle.Success)
    );
    container.addActionRowComponents(row);
  }

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });

  track(interaction.user.id, 'autosetup_roles_created', {
    authUserId,
    guildId: session.guildId,
    count: created,
  });
}

async function handleChannelsFlowStart(
  interaction: StringSelectMenuInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  session: AutosetupSession
): Promise<void> {
  await interaction.deferUpdate();

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.Library} Verify channel\n\nShould we create a **#verify** channel and post the verify button there?`
    )
  );
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `${AUTOSETUP_PREFIX}create_verify:${interaction.user.id}:${session.authUserId}`
        )
        .setLabel('Create #verify channel')
        .setEmoji(Emoji.Checkmark)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${AUTOSETUP_PREFIX}spawn_here:${interaction.user.id}:${session.authUserId}`)
        .setLabel('Just spawn button here')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(
          `${AUTOSETUP_PREFIX}channels_skip:${interaction.user.id}:${session.authUserId}`
        )
        .setLabel('Skip')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Create verify channel and spawn button */
export async function handleAutosetupCreateVerify(
  interaction: ButtonInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
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
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [errorContainer('Guild not found.')],
    });
    return;
  }

  try {
    const channel = await guild.channels.create({
      name: 'verify',
      type: ChannelType.GuildText,
      reason: 'Creator Assistant autosetup',
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.SendMessages],
        },
      ],
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
          `${(await import('../lib/emojis')).E.Link} **Sign in** - Connect Gumroad or Discord. We recognize your purchases and grant your role automatically.`,
          '',
          `${(await import('../lib/emojis')).E.KeyCloud} **License key** - Using Jinxxy or Gumroad license? Enter one key once. We link your account and sync all past and future purchases.`,
          '',
          'Connections are secure and used only for verification.',
        ].join('\n')
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
          `Created <#${channel.id}> and posted the verify button. Your members can now verify their purchases there.`
      )
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });

    track(interaction.user.id, 'autosetup_verify_channel_created', {
      authUserId,
      guildId: session.guildId,
    });
  } catch (err) {
    logger.error('Autosetup create verify channel failed', {
      error: err instanceof Error ? err.message : String(err),
      authUserId,
      guildId: session.guildId,
    });
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        errorContainer(
          'Could not create the verify channel. Check that the bot has **Manage Channels** permission.'
        ),
      ],
    });
  }
}

/** Spawn verify button in current channel */
export async function handleAutosetupSpawnHere(
  interaction: ButtonInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
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
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [errorContainer('Cannot send messages in this channel.')],
    });
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
        `${Em.Link} **Sign in** - Connect Gumroad or Discord.`,
        '',
        `${Em.KeyCloud} **License key** - Enter your license key to verify.`,
        '',
        'Connections are secure and used only for verification.',
      ].join('\n')
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
      `## ${E.Checkmark} Done!\n\nPosted the verify button in this channel.`
    )
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
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
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
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
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
    session
  );
}

async function handleMigrateFlowStart(
  interaction: StringSelectMenuInteraction,
  _convex: ConvexHttpClient,
  apiSecret: string,
  session: AutosetupSession
): Promise<void> {
  await interaction.deferUpdate();

  const products = await fetchAllProducts(session.authUserId, apiSecret);

  if (products.length === 0) {
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Wrench} No products found\n\nConnect Gumroad or Jinxxy first. Use \`/creator-admin setup start\`.`
      )
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  session.products = products;
  session.migrateRoleIndex = 0;
  session.migrateMappedProductKeys = [];

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [errorContainer('Guild not found.')],
    });
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
        `## ${E.Wrench} No roles to map\n\nThis server has no roles besides @everyone and bot roles. Create roles first, then run autosetup migrate.`
      )
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  const select = new RoleSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}migrate_role:${interaction.user.id}:${session.authUserId}`)
    .setPlaceholder('Select a role to map to a product...');

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.Refresh} Migrate: map role to product\n\nSelect a role from your server. Next, we'll ask which product it corresponds to.`
    )
  );
  container.addActionRowComponents(
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select)
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Role selected for migration - show product picker */
export async function handleAutosetupMigrateRoleSelect(
  interaction: RoleSelectMenuInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const roleId = interaction.values[0];
  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Timer} Session expired\n\nRun \`/creator-admin autosetup\` again.`
      )
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  session.migrateRoleId = roleId;

  const mapped = new Set(session.migrateMappedProductKeys ?? []);
  const products = session.products ?? [];
  const unmapped = products.filter((p) => !mapped.has(productKey(p)));
  const MAX_OPTIONS = 25;
  const toShow = unmapped.slice(0, MAX_OPTIONS);

  if (toShow.length === 0) {
    const { container } = buildMigrateConfirmationUI(session, userId, authUserId);
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}mp:${userId}:${authUserId}`)
    .setPlaceholder('Which product does this role represent?')
    .addOptions(
      toShow.map((p) => {
        const value = `${p.provider}::${p.id}`;
        const label = p.name.length > 100 ? `${p.name.slice(0, 97)}...` : p.name;
        return new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setValue(value)
          .setDescription(`${p.provider}`);
      })
    );

  const role = interaction.guild?.roles.cache.get(roleId);
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## Map role to product\n\nRole: **${role?.name ?? 'Unknown'}**\n\nSelect the product this role should grant access to:`
    )
  );
  container.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Product selected for migration - create rule */
export async function handleAutosetupMigrateProductSelect(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
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
  const product = session.products?.find((p) => p.id === productId && p.provider === provider);

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
    const result = await convex.mutation(api.role_rules.addProductForProvider, {
      apiSecret,
      authUserId,
      productId: product.id,
      providerProductRef: product.id,
      provider: product.provider,
      displayName: product.name,
    });
    await convex.mutation(api.role_rules.createRoleRule, {
      apiSecret,
      authUserId,
      guildId: session.guildId,
      guildLinkId: session.guildLinkId,
      productId: result.productId,
      catalogProductId: result.catalogProductId,
      verifiedRoleId: roleId,
    });

    const role = interaction.guild?.roles.cache.get(roleId);
    const key = productKey(product);
    if (!session.migrateMappedProductKeys) session.migrateMappedProductKeys = [];
    session.migrateMappedProductKeys.push(key);
    session.migrateRoleId = undefined;

    const { container } = buildMigrateConfirmationUI(session, userId, authUserId, {
      roleName: role?.name ?? 'Role',
      productName: product.name,
    });
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });

    track(interaction.user.id, 'autosetup_migrate_mapped', {
      authUserId,
      guildId: session.guildId,
    });
  } catch (err) {
    logger.error('Autosetup migrate failed', {
      error: err instanceof Error ? err.message : String(err),
      authUserId,
      productId: product.id,
    });
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [errorContainer('Could not create the mapping. Try again.')],
    });
  }
}

/** Migrate confirmation - Done button */
export async function handleAutosetupMigrateDone(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  const mapped = session.migrateMappedProductKeys?.length ?? 0;
  const container = new ContainerBuilder().setAccentColor(0x57f287);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.ThumbsUp} Done!\n\n` +
        `Mapped **${mapped}** product${mapped === 1 ? '' : 's'} to roles. You're all set.`
    )
  );
  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Migrate confirmation - Map another button */
export async function handleAutosetupMigrateMapAnother(
  interaction: ButtonInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  const select = new RoleSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}migrate_role:${userId}:${authUserId}`)
    .setPlaceholder('Select a role to map to a product...');

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.Refresh} Map another role\n\nSelect a role from your server. Next, we'll ask which product it corresponds to.`
    )
  );
  container.addActionRowComponents(
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select)
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Migrate confirmation - Map all button */
export async function handleAutosetupMigrateMapAll(
  interaction: ButtonInteraction,
  _convex: ConvexHttpClient,
  _apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    await interaction.update({
      content: `${E.Timer} Session expired. Run \`/creator-admin autosetup\` again.`,
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  const mapped = new Set(session.migrateMappedProductKeys ?? []);
  const products = session.products ?? [];
  const firstUnmapped = products.find((p) => !mapped.has(productKey(p)));

  if (!firstUnmapped) {
    const { container } = buildMigrateConfirmationUI(session, userId, authUserId);
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  session.migrateMapAllProduct = { provider: firstUnmapped.provider, id: firstUnmapped.id };
  session.migrateRoleId = undefined;

  const select = new RoleSelectMenuBuilder()
    .setCustomId(`${AUTOSETUP_PREFIX}mp_all_role:${userId}:${authUserId}`)
    .setPlaceholder(`Which role represents "${firstUnmapped.name}"?`);

  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${E.ClapStars} Map all\n\n**${firstUnmapped.name}** (${firstUnmapped.provider})\n\nSelect the role that grants access to this product:`
    )
  );
  container.addActionRowComponents(
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select)
  );

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  });
}

/** Role selected in map-all flow - create rule and show next or confirmation */
export async function handleAutosetupMigrateMapAllRoleSelect(
  interaction: RoleSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const roleId = interaction.values[0];
  const sessionKey = getSessionKey(userId, authUserId);
  const session = autosetupSessions.get(sessionKey);

  if (!session || Date.now() > session.expiresAt) {
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Timer} Session expired\n\nRun \`/creator-admin autosetup\` again.`
      )
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  const productSpec = session.migrateMapAllProduct;
  if (!productSpec) {
    const container = new ContainerBuilder().setAccentColor(0xfaa61a);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${E.Timer} Session state lost\n\nRun \`/creator-admin autosetup\` again.`
      )
    );
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    });
    return;
  }

  const product = session.products?.find(
    (p) => p.provider === productSpec.provider && p.id === productSpec.id
  );
  if (!product) {
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [errorContainer('Product not found.')],
    });
    return;
  }

  try {
    const result = await convex.mutation(api.role_rules.addProductForProvider, {
      apiSecret,
      authUserId,
      productId: product.id,
      providerProductRef: product.id,
      provider: product.provider,
      displayName: product.name,
    });
    await convex.mutation(api.role_rules.createRoleRule, {
      apiSecret,
      authUserId,
      guildId: session.guildId,
      guildLinkId: session.guildLinkId,
      productId: result.productId,
      catalogProductId: result.catalogProductId,
      verifiedRoleId: roleId,
    });

    const key = productKey(product);
    if (!session.migrateMappedProductKeys) session.migrateMappedProductKeys = [];
    session.migrateMappedProductKeys.push(key);
    session.migrateMapAllProduct = undefined;

    const mapped = new Set(session.migrateMappedProductKeys);
    const products = session.products ?? [];
    const nextUnmapped = products.find((p) => !mapped.has(productKey(p)));

    if (nextUnmapped) {
      session.migrateMapAllProduct = { provider: nextUnmapped.provider, id: nextUnmapped.id };
      const select = new RoleSelectMenuBuilder()
        .setCustomId(`${AUTOSETUP_PREFIX}mp_all_role:${userId}:${authUserId}`)
        .setPlaceholder(`Which role represents "${nextUnmapped.name}"?`);

      const role = interaction.guild?.roles.cache.get(roleId);
      const container = new ContainerBuilder().setAccentColor(0x57f287);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## ${E.Checkmark} **${role?.name ?? 'Role'}** → **${product.name}**\n\nNext: **${nextUnmapped.name}**\n\nSelect the role for this product:`
        )
      );
      container.addActionRowComponents(
        new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select)
      );
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
      });
    } else {
      const { container } = buildMigrateConfirmationUI(session, userId, authUserId, {
        roleName: interaction.guild?.roles.cache.get(roleId)?.name ?? 'Role',
        productName: product.name,
      });
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
      });
    }

    track(interaction.user.id, 'autosetup_migrate_mapped', {
      authUserId,
      guildId: session.guildId,
    });
  } catch (err) {
    logger.error('Autosetup migrate map-all failed', {
      error: err instanceof Error ? err.message : String(err),
      authUserId,
      productId: product.id,
    });
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [errorContainer('Could not create the mapping. Try again.')],
    });
  }
}
