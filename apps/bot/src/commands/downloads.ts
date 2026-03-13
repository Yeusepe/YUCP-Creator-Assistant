import { createLogger } from '@yucp/shared';
import type { ConvexHttpClient } from 'convex/browser';
import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  type ChannelSelectMenuInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Guild,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  RoleSelectMenuBuilder,
  type RoleSelectMenuInteraction,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { E, Emoji } from '../lib/emojis';
import { sanitizeUserFacingErrorMessage } from '../lib/userFacingErrors';
import { LienedDownloadsService } from '../services/lienedDownloads';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

interface DownloadRouteSession {
  authUserId: string;
  guildLinkId: Id<'guild_links'>;
  guildId: string;
  sourceChannelId?: string;
  archiveChannelId?: string;
  messageTitle: string;
  messageBody: string;
  requiredRoleIds: string[];
  roleLogic: 'all' | 'any';
  allowedExtensions: string[];
  expiresAt: number;
}

type RouteRecord = {
  _id: Id<'download_routes'>;
  authUserId: string;
  guildId: string;
  sourceChannelId: string;
  archiveChannelId: string;
  messageTitle: string;
  messageBody: string;
  requiredRoleIds: string[];
  roleLogic: 'all' | 'any';
  allowedExtensions: string[];
  enabled: boolean;
};

type ManageRouteRecord = RouteRecord & {
  sourceName: string;
  archiveName: string;
};

const downloadSessions = new Map<string, DownloadRouteSession>();
const managePanels = new Map<
  string,
  {
    userId: string;
    authUserId: string;
    guildId: string;
    selectedRouteId: Id<'download_routes'>;
    expiresAt: number;
  }
>();
const SESSION_TTL_MS = 10 * 60 * 1000;
const SUPPORTED_EXTENSIONS = [
  'fbx',
  'unitypackage',
  'zip',
  '7z',
  'rar',
  'blend',
  'spp',
  'sbscfg',
  'sbsar',
];
const DEFAULT_PRESET = 'all_supported';
const DEFAULT_MESSAGE_TITLE = 'Ready to Download';
const DEFAULT_MESSAGE_BODY =
  'Open Download to check access. If this file is available to you, Discord sends it privately.';

const EXTENSION_PRESETS: Record<
  string,
  { label: string; description: string; extensions: string[] }
> = {
  all_supported: {
    label: 'All supported creator files',
    description: 'FBX, Unity packages, archives, and Substance files',
    extensions: SUPPORTED_EXTENSIONS,
  },
  packages_only: {
    label: 'Packages and archives only',
    description: 'Unity packages and compressed archives only',
    extensions: ['unitypackage', 'zip', '7z', 'rar'],
  },
  source_assets: {
    label: 'Source assets only',
    description: 'FBX, Blend, and Substance source files',
    extensions: ['fbx', 'blend', 'spp', 'sbscfg', 'sbsar'],
  },
};

function getSessionKey(userId: string, authUserId: string): string {
  return `${userId}:${authUserId}`;
}

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [key, session] of downloadSessions.entries()) {
    if (now > session.expiresAt) downloadSessions.delete(key);
  }
  for (const [key, panel] of managePanels.entries()) {
    if (now > panel.expiresAt) managePanels.delete(key);
  }
}

function getGuildContext(interaction: {
  guild: Guild | null;
  guildId: string | null;
}): { guild: Guild; guildId: string } | null {
  if (!interaction.guild || !interaction.guildId) {
    return null;
  }

  return {
    guild: interaction.guild,
    guildId: interaction.guildId,
  };
}

function createManagePanelToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

function requireManagePanel(token: string) {
  cleanExpiredSessions();
  const panel = managePanels.get(token);
  if (!panel || Date.now() > panel.expiresAt) return null;
  return panel;
}

function upsertManagePanel(
  token: string,
  panel: {
    userId: string;
    authUserId: string;
    guildId: string;
    selectedRouteId: Id<'download_routes'>;
  }
): void {
  managePanels.set(token, {
    ...panel,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

function roleLogicLabel(roleLogic: 'all' | 'any'): string {
  return roleLogic === 'all' ? 'All selected roles' : 'Any selected role';
}

function getPresetKey(extensions: string[]): string | null {
  const normalized = [...new Set(extensions.map((ext) => ext.toLowerCase()))].sort();
  for (const [key, preset] of Object.entries(EXTENSION_PRESETS)) {
    const presetNormalized = [...preset.extensions].sort();
    if (
      normalized.length === presetNormalized.length &&
      normalized.every((ext, index) => ext === presetNormalized[index])
    ) {
      return key;
    }
  }
  return null;
}

function routeSummary(
  session: Pick<
    DownloadRouteSession,
    | 'sourceChannelId'
    | 'archiveChannelId'
    | 'messageTitle'
    | 'messageBody'
    | 'requiredRoleIds'
    | 'roleLogic'
    | 'allowedExtensions'
  >
): string {
  const presetKey = getPresetKey(session.allowedExtensions);
  const presetLabel = presetKey
    ? EXTENSION_PRESETS[presetKey].label
    : session.allowedExtensions.map((ext) => `.${ext}`).join(', ');
  return [
    `${E.World} **Uploads**\n${session.sourceChannelId ? `<#${session.sourceChannelId}>` : 'Choose a channel or forum'}`,
    `${E.Library} **Archive**\n${session.archiveChannelId ? `<#${session.archiveChannelId}>` : 'Choose a private channel or forum'}`,
    `${E.Assistant} **Message**\n**${session.messageTitle}**\n${session.messageBody}`,
    `${E.Key} **Access**\n${session.requiredRoleIds.length > 0 ? `${roleLogicLabel(session.roleLogic)}\n${session.requiredRoleIds.map((roleId) => `<@&${roleId}>`).join(', ')}` : 'Choose one or more roles'}`,
    `${E.Bag} **Files**\n${presetLabel}`,
  ].join('\n');
}

function buildStepOneEmbed(session: DownloadRouteSession): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${E.Assistant} Set Up Liened Downloads`)
    .setColor(0x5865f2)
    .setDescription(
      [
        'Choose where members post files and where protected copies are stored.',
        '',
        routeSummary(session),
      ].join('\n')
    )
    .setFooter({ text: 'Step 1 of 3 • Choose the uploads location and the private archive.' });
}

function buildStepTwoEmbed(session: DownloadRouteSession): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${E.Key} Choose Access`)
    .setColor(0x5865f2)
    .setDescription(
      [
        'Choose who can open downloads and which file types trigger protection.',
        '',
        routeSummary(session),
      ].join('\n')
    )
    .setFooter({ text: 'Step 2 of 3 • Choose roles, access rules, and file types.' });
}

function buildConfirmEmbed(session: DownloadRouteSession): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${E.Checkmark} Review Route`)
    .setColor(0x57f287)
    .setDescription(
      ['Review this route before you turn it on.', '', routeSummary(session)].join('\n')
    )
    .setFooter({ text: 'Step 3 of 3 • Create the route or go back to make changes.' });
}

function buildSourceArchiveComponents(
  userId: string,
  authUserId: string,
  session?: Pick<DownloadRouteSession, 'sourceChannelId' | 'archiveChannelId'>
): Array<ActionRowBuilder<ChannelSelectMenuBuilder | ButtonBuilder>> {
  return [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`creator_downloads:source_select:${userId}:${authUserId}`)
        .setPlaceholder('Choose an uploads channel or forum')
        .setChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum
        )
        .setMinValues(1)
        .setMaxValues(1)
        .setDefaultChannels(...(session?.sourceChannelId ? [session.sourceChannelId] : []))
    ),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`creator_downloads:archive_select:${userId}:${authUserId}`)
        .setPlaceholder('Choose a private archive channel or forum')
        .setChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum
        )
        .setMinValues(1)
        .setMaxValues(1)
        .setDefaultChannels(...(session?.archiveChannelId ? [session.archiveChannelId] : []))
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:to_access:${userId}:${authUserId}`)
        .setLabel('Continue')
        .setEmoji(Emoji.Carrot)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:cancel_add:${userId}:${authUserId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildAccessComponents(
  userId: string,
  authUserId: string,
  session: Pick<DownloadRouteSession, 'requiredRoleIds' | 'roleLogic' | 'allowedExtensions'>
): Array<ActionRowBuilder<RoleSelectMenuBuilder | StringSelectMenuBuilder | ButtonBuilder>> {
  const selectedPreset = getPresetKey(session.allowedExtensions) ?? DEFAULT_PRESET;

  return [
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`creator_downloads:roles_select:${userId}:${authUserId}`)
        .setPlaceholder('Choose required roles')
        .setMinValues(1)
        .setMaxValues(10)
        .setDefaultRoles(...session.requiredRoleIds)
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`creator_downloads:logic_select:${userId}:${authUserId}`)
        .setPlaceholder('Choose an access rule')
        .addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel('All Roles')
            .setDescription('Member needs every selected role')
            .setValue('all')
            .setDefault(session.roleLogic === 'all'),
          new StringSelectMenuOptionBuilder()
            .setLabel('Any Role')
            .setDescription('Member needs at least one selected role')
            .setValue('any')
            .setDefault(session.roleLogic === 'any')
        )
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`creator_downloads:ext_select:${userId}:${authUserId}`)
        .setPlaceholder('Choose file types')
        .addOptions(
          Object.entries(EXTENSION_PRESETS).map(([value, preset]) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(preset.label)
              .setDescription(preset.description)
              .setValue(value)
              .setDefault(value === selectedPreset)
          )
        )
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:back_to_channels:${userId}:${authUserId}`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:to_confirm:${userId}:${authUserId}`)
        .setLabel('Review')
        .setEmoji(Emoji.Carrot)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:cancel_add:${userId}:${authUserId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildConfirmComponents(
  userId: string,
  authUserId: string
): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:back_to_access:${userId}:${authUserId}`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:customize_message:${userId}:${authUserId}`)
        .setLabel('Edit Delivery Message...')
        .setEmoji(Emoji.Assistant)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:confirm_add:${userId}:${authUserId}`)
        .setLabel('Turn On Route')
        .setEmoji(Emoji.Checkmark)
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function buildBackfillWarningComponents(
  userId: string,
  routeId: Id<'download_routes'>
): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:autofix_prompt:${userId}:${routeId}`)
        .setLabel('Autofix Messages')
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildBackfillAutofixConfirmComponents(
  userId: string,
  routeId: Id<'download_routes'>
): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:autofix_run:${userId}:${routeId}`)
        .setLabel('Replace Messages')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:autofix_cancel:${userId}:${routeId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function truncateLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function buildManageRoutes(
  guild: Guild,
  routes: RouteRecord[]
): Promise<ManageRouteRecord[]> {
  const channelIds = [
    ...new Set(routes.flatMap((route) => [route.sourceChannelId, route.archiveChannelId])),
  ];
  const channelNames = new Map<string, string>();

  await Promise.all(
    channelIds.map(async (channelId) => {
      const cached = guild.channels.cache.get(channelId);
      if (cached && 'name' in cached) {
        channelNames.set(channelId, cached.name);
        return;
      }

      const fetched = await guild.channels.fetch(channelId).catch(() => null);
      if (fetched && 'name' in fetched) {
        channelNames.set(channelId, fetched.name);
        return;
      }

      channelNames.set(channelId, channelId);
    })
  );

  return routes.map((route) => ({
    ...route,
    sourceName: channelNames.get(route.sourceChannelId) ?? route.sourceChannelId,
    archiveName: channelNames.get(route.archiveChannelId) ?? route.archiveChannelId,
  }));
}

function formatRouteOptionLabel(route: ManageRouteRecord): string {
  return truncateLabel(`${route.enabled ? 'On' : 'Off'} • ${route.sourceName}`, 100);
}

function buildManageEmbed(route: RouteRecord, totalRoutes: number): EmbedBuilder {
  const presetKey = getPresetKey(route.allowedExtensions);
  const presetLabel = presetKey
    ? EXTENSION_PRESETS[presetKey].label
    : route.allowedExtensions.map((ext) => `.${ext}`).join(', ');

  return new EmbedBuilder()
    .setTitle(`${E.Library} Manage Liened Downloads`)
    .setColor(route.enabled ? 0x57f287 : 0xfaa61a)
    .setDescription(
      [
        `${route.enabled ? E.Checkmark : E.X_} **${route.enabled ? 'Route On' : 'Route Off'}**`,
        '',
        `${E.World} **Uploads**\n<#${route.sourceChannelId}>`,
        `${E.Library} **Archive**\n<#${route.archiveChannelId}>`,
        `${E.Assistant} **Message**\n**${route.messageTitle}**\n${route.messageBody}`,
        `${E.Key} **Access**\n${roleLogicLabel(route.roleLogic)}\n${route.requiredRoleIds.map((roleId) => `<@&${roleId}>`).join(', ')}`,
        `${E.Bag} **Files**\n${presetLabel}`,
      ].join('\n')
    )
    .setFooter({ text: `Route ${route._id} • ${totalRoutes} total` });
}

function buildManageComponents(
  panelToken: string,
  routes: ManageRouteRecord[],
  selectedRouteId: Id<'download_routes'>
): Array<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>> {
  const selectedRoute = routes.find((route) => route._id === selectedRouteId) ?? routes[0];

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`creator_downloads:manage_select:${panelToken}`)
        .setPlaceholder('Choose a route')
        .addOptions(
          routes.slice(0, 25).map((route) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(formatRouteOptionLabel(route))
              .setDescription(truncateLabel(`${route.sourceName} → ${route.archiveName}`, 100))
              .setValue(route._id)
              .setDefault(route._id === selectedRoute?._id)
          )
        )
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:manage_toggle:${panelToken}`)
        .setLabel(selectedRoute.enabled ? 'Turn Off' : 'Turn On')
        .setStyle(selectedRoute.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:manage_edit_message:${panelToken}`)
        .setLabel('Edit Delivery Message...')
        .setEmoji(Emoji.Assistant)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:manage_remove_prompt:${panelToken}`)
        .setLabel('Remove Route...')
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildManageRemoveConfirmComponents(
  panelToken: string
): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:manage_remove_confirm:${panelToken}`)
        .setLabel('Remove Route')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:manage_refresh:${panelToken}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function requireSession(userId: string, authUserId: string): DownloadRouteSession | null {
  cleanExpiredSessions();
  const session = downloadSessions.get(getSessionKey(userId, authUserId));
  if (!session || Date.now() > session.expiresAt) return null;
  return session;
}

async function fetchRouteList(
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string,
  guildId: string
): Promise<RouteRecord[]> {
  return await convex.query(api.downloads.listRoutesByGuild, {
    apiSecret,
    authUserId,
    guildId,
  });
}

function buildMessageCustomizeModal(
  userId: string,
  authUserId: string,
  session: DownloadRouteSession
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`creator_downloads:message_modal:${userId}:${authUserId}`)
    .setTitle('Edit Delivery Message')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('message_title')
          .setLabel('Title')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setPlaceholder(DEFAULT_MESSAGE_TITLE)
          .setValue(session.messageTitle)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('message_body')
          .setLabel('Body')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder(DEFAULT_MESSAGE_BODY)
          .setValue(session.messageBody)
      )
    );
}

function buildManageMessageModal(panelToken: string, route: RouteRecord): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`creator_downloads:manage_message_modal:${panelToken}`)
    .setTitle('Edit Delivery Message')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('message_title')
          .setLabel('Title')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setPlaceholder(DEFAULT_MESSAGE_TITLE)
          .setValue(route.messageTitle)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('message_body')
          .setLabel('Body')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder(DEFAULT_MESSAGE_BODY)
          .setValue(route.messageBody)
      )
    );
}

export async function handleDownloadsAdd(
  interaction: ChatInputCommandInteraction,
  ctx: { authUserId: string; guildLinkId: Id<'guild_links'>; guildId: string }
): Promise<void> {
  cleanExpiredSessions();

  const sessionKey = getSessionKey(interaction.user.id, ctx.authUserId);
  const session: DownloadRouteSession = {
    authUserId: ctx.authUserId,
    guildLinkId: ctx.guildLinkId,
    guildId: ctx.guildId,
    messageTitle: DEFAULT_MESSAGE_TITLE,
    messageBody: DEFAULT_MESSAGE_BODY,
    requiredRoleIds: [],
    roleLogic: 'all',
    allowedExtensions: [...EXTENSION_PRESETS[DEFAULT_PRESET].extensions],
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  downloadSessions.set(sessionKey, session);

  await interaction.reply({
    embeds: [buildStepOneEmbed(session)],
    components: buildSourceArchiveComponents(interaction.user.id, ctx.authUserId, session),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleDownloadsSourceSelect(
  interaction: ChannelSelectMenuInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.reply({
      content: `${E.Timer} Setup expired. Start again with \`/creator-admin downloads add\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.sourceChannelId = interaction.values[0];
  await interaction.update({
    embeds: [buildStepOneEmbed(session)],
    components: buildSourceArchiveComponents(userId, authUserId, session),
  });
}

export async function handleDownloadsArchiveSelect(
  interaction: ChannelSelectMenuInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.reply({
      content: `${E.Timer} Setup expired. Start again with \`/creator-admin downloads add\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.archiveChannelId = interaction.values[0];
  await interaction.update({
    embeds: [buildStepOneEmbed(session)],
    components: buildSourceArchiveComponents(userId, authUserId, session),
  });
}

export async function handleDownloadsGoToAccess(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.update({
      content: `${E.Timer} Setup expired. Start again with \`/creator-admin downloads add\`.`,
      embeds: [],
      components: [],
    });
    return;
  }

  if (!session.sourceChannelId || !session.archiveChannelId) {
    await interaction.reply({
      content: `${E.X_} Choose an uploads location and an archive before you continue.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (session.sourceChannelId === session.archiveChannelId) {
    await interaction.reply({
      content: `${E.X_} Choose different locations for uploads and the archive.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({
    embeds: [buildStepTwoEmbed(session)],
    components: buildAccessComponents(userId, authUserId, session),
  });
}

export async function handleDownloadsRoleSelect(
  interaction: RoleSelectMenuInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.editReply({
      content: `${E.Timer} Setup expired. Start again with \`/creator-admin downloads add\`.`,
    });
    return;
  }

  session.requiredRoleIds = [...new Set(interaction.values)];
  await interaction.editReply({
    embeds: [buildStepTwoEmbed(session)],
    components: buildAccessComponents(userId, authUserId, session),
  });
}

export async function handleDownloadsLogicSelect(
  interaction: StringSelectMenuInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.reply({
      content: `${E.Timer} Setup expired. Start again with \`/creator-admin downloads add\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.roleLogic = interaction.values[0] as 'all' | 'any';
  await interaction.update({
    embeds: [buildStepTwoEmbed(session)],
    components: buildAccessComponents(userId, authUserId, session),
  });
}

export async function handleDownloadsExtensionSelect(
  interaction: StringSelectMenuInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.reply({
      content: `${E.Timer} Session expired. Run \`/creator-admin downloads add\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const preset = EXTENSION_PRESETS[interaction.values[0]];
  if (!preset) {
    await interaction.reply({
      content: `${E.X_} That file set is no longer available. Choose another one.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.allowedExtensions = [...preset.extensions];
  await interaction.update({
    embeds: [buildStepTwoEmbed(session)],
    components: buildAccessComponents(userId, authUserId, session),
  });
}

export async function handleDownloadsBackToChannels(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.update({
      content: `${E.Timer} Setup expired. Start again with \`/creator-admin downloads add\`.`,
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.update({
    embeds: [buildStepOneEmbed(session)],
    components: buildSourceArchiveComponents(userId, authUserId, session),
  });
}

export async function handleDownloadsGoToConfirm(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.update({
      content: `${E.Timer} Setup expired. Start again with \`/creator-admin downloads add\`.`,
      embeds: [],
      components: [],
    });
    return;
  }

  if (session.requiredRoleIds.length === 0) {
    await interaction.reply({
      content: `${E.X_} Choose at least one role before you continue.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({
    embeds: [buildConfirmEmbed(session)],
    components: buildConfirmComponents(userId, authUserId),
  });
}

export async function handleDownloadsConfirmAdd(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  authUserId: string
): Promise<void> {
  const sessionKey = getSessionKey(userId, authUserId);
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.update({
      content: `${E.Timer} Setup expired. Start again with \`/creator-admin downloads add\`.`,
      embeds: [],
      components: [],
    });
    return;
  }

  if (
    !session.sourceChannelId ||
    !session.archiveChannelId ||
    session.requiredRoleIds.length === 0
  ) {
    await interaction.update({
      content: `${E.X_} This route is incomplete. Start again with \`/creator-admin downloads add\`.`,
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const existingRoutes = await fetchRouteList(convex, apiSecret, authUserId, session.guildId);
    const duplicate = existingRoutes.find(
      (route) =>
        route.sourceChannelId === session.sourceChannelId &&
        route.archiveChannelId === session.archiveChannelId &&
        route.roleLogic === session.roleLogic &&
        route.requiredRoleIds.length === session.requiredRoleIds.length &&
        route.requiredRoleIds.every((roleId) => session.requiredRoleIds.includes(roleId)) &&
        route.allowedExtensions.length === session.allowedExtensions.length &&
        route.allowedExtensions.every((ext) => session.allowedExtensions.includes(ext))
    );

    if (duplicate) {
      downloadSessions.delete(sessionKey);
      await interaction.editReply({
        content: `${E.X_} This route already exists.`,
        embeds: [
          buildConfirmEmbed({
            ...session,
            sourceChannelId: duplicate.sourceChannelId,
            archiveChannelId: duplicate.archiveChannelId,
            requiredRoleIds: duplicate.requiredRoleIds,
            roleLogic: duplicate.roleLogic,
            allowedExtensions: duplicate.allowedExtensions,
          }),
        ],
        components: [],
      });
      return;
    }

    const result = await convex.mutation(api.downloads.createRoute, {
      apiSecret,
      authUserId,
      guildId: session.guildId,
      guildLinkId: session.guildLinkId,
      sourceChannelId: session.sourceChannelId,
      archiveChannelId: session.archiveChannelId,
      messageTitle: session.messageTitle,
      messageBody: session.messageBody,
      requiredRoleIds: session.requiredRoleIds,
      roleLogic: session.roleLogic,
      allowedExtensions: session.allowedExtensions,
      enabled: true,
    });

    const service = new LienedDownloadsService(interaction.client, convex, apiSecret);
    const backfillStats = await service.backfillRoute({
      _id: result.routeId,
      authUserId,
      guildId: session.guildId,
      guildLinkId: session.guildLinkId,
      sourceChannelId: session.sourceChannelId,
      archiveChannelId: session.archiveChannelId,
      messageTitle: session.messageTitle,
      messageBody: session.messageBody,
      requiredRoleIds: session.requiredRoleIds,
      roleLogic: session.roleLogic,
      allowedExtensions: session.allowedExtensions,
      enabled: true,
    });

    const manualCleanupList = backfillStats.manualCleanupMessages
      .slice(0, 10)
      .map((entry, index) => `${index + 1}. ${entry.sourceMessageUrl}`)
      .join('\n');
    const remainingManualCleanupCount = Math.max(
      0,
      backfillStats.manualCleanupMessages.length - 10
    );

    downloadSessions.delete(sessionKey);
    await interaction.editReply({
      content: `${E.Checkmark} Liened Downloads is on for <#${session.sourceChannelId}>.\nScanned **${backfillStats.scannedMessages}** existing messages: **${backfillStats.securedMessages}** prepared, **${backfillStats.skippedMessages}** skipped, **${backfillStats.failedMessages}** failed.${
        backfillStats.manualCleanupMessages.length > 0
          ? `\n\n${E.Wrench} Existing messages keep their original attachments for now.\nIf you want full protection, remove the original attachments from:\n${manualCleanupList}${remainingManualCleanupCount > 0 ? `\n...and ${remainingManualCleanupCount} more.` : ''}\n\nUse **Autofix Messages** to replace those messages automatically.\n${E.X_} This breaks image previews in forum posts.`
          : ''
      }`,
      embeds: [
        buildConfirmEmbed(session).setFooter({
          text: `Route ID: ${result.routeId}`,
        }),
      ],
      components:
        backfillStats.manualCleanupMessages.length > 0
          ? buildBackfillWarningComponents(interaction.user.id, result.routeId)
          : [],
    });
  } catch (err) {
    logger.error('Failed to create Liened Downloads route', {
      error: err instanceof Error ? err.message : String(err),
      authUserId,
      guildId: session.guildId,
      sourceChannelId: session.sourceChannelId,
      archiveChannelId: session.archiveChannelId,
    });
    downloadSessions.delete(sessionKey);
    await interaction.editReply({
      content: `${E.X_} Couldn’t create this route. ${sanitizeUserFacingErrorMessage(
        err instanceof Error ? err.message : String(err),
        'Try again in a moment.'
      )}`,
      embeds: [],
      components: [],
    });
  }
}

export async function handleDownloadsCancelAdd(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  downloadSessions.delete(getSessionKey(userId, authUserId));
  await interaction.update({
    content: `${E.Home} Setup canceled.`,
    embeds: [],
    components: [],
  });
}

export async function handleDownloadsCustomizeMessage(
  interaction: ButtonInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.reply({
      content: `${E.Timer} This setup expired. Start again with \`/creator-admin downloads setup\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(buildMessageCustomizeModal(userId, authUserId, session));
}

export async function handleDownloadsMessageModal(
  interaction: ModalSubmitInteraction,
  userId: string,
  authUserId: string
): Promise<void> {
  const session = requireSession(userId, authUserId);
  if (!session) {
    await interaction.reply({
      content: `${E.Timer} This setup expired. Start again with \`/creator-admin downloads setup\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const messageTitle = interaction.fields.getTextInputValue('message_title').trim();
  const messageBody = interaction.fields.getTextInputValue('message_body').trim();

  if (!messageTitle || !messageBody) {
    await interaction.reply({
      content: `${E.X_} Add a title and body before you continue.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.messageTitle = messageTitle;
  session.messageBody = messageBody;

  await interaction.reply({
    embeds: [buildConfirmEmbed(session)],
    components: buildConfirmComponents(userId, authUserId),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleDownloadsAutofixPrompt(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  routeId: Id<'download_routes'>
): Promise<void> {
  if (interaction.user.id !== userId) {
    await interaction.reply({
      content: `${E.X_} Only the person who started this setup can use this button.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const route = await convex.query(api.downloads.getRouteById, { apiSecret, routeId });
  if (!route) {
    await interaction.update({
      content: `${E.X_} This route is no longer available.`,
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.update({
    content:
      `${E.Wrench} Autofix deletes the original messages found during setup and replaces them with the protected version.\n` +
      `This can’t be undone.\n\n${E.X_} This breaks image previews in forum posts.`,
    embeds: [],
    components: buildBackfillAutofixConfirmComponents(userId, routeId),
  });
}

export async function handleDownloadsAutofixRun(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  userId: string,
  routeId: Id<'download_routes'>
): Promise<void> {
  if (interaction.user.id !== userId) {
    await interaction.reply({
      content: `${E.X_} Only the person who started this setup can use this button.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const route = await convex.query(api.downloads.getRouteById, { apiSecret, routeId });
  if (!route) {
    await interaction.editReply({
      content: `${E.X_} This route is no longer available.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const service = new LienedDownloadsService(interaction.client, convex, apiSecret);
  const stats = await service.autofixRoute(route);

  await interaction.editReply({
    content:
      `${E.Checkmark} Autofix finished for route \`${routeId}\`.\n` +
      `Updated **${stats.fixedMessages}** messages, skipped **${stats.skippedMessages}**, failed **${stats.failedMessages}**.`,
    embeds: [],
    components: [],
  });
}

export async function handleDownloadsAutofixCancel(interaction: ButtonInteraction): Promise<void> {
  await interaction.update({
    content: `${E.Home} Autofix canceled. Existing messages were left as they are.`,
    embeds: [],
    components: [],
  });
}

export async function handleDownloadsManage(
  interaction: ChatInputCommandInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  ctx: { authUserId: string; guildId: string }
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildContext = getGuildContext(interaction);
  if (!guildContext) {
    await interaction.editReply(`${E.X_} This command can only be used inside a server.`);
    return;
  }
  const routes = await fetchRouteList(convex, apiSecret, ctx.authUserId, ctx.guildId);

  if (routes.length === 0) {
    await interaction.editReply(
      `${E.Library} No routes yet. Use \`/creator-admin downloads setup\` to create one.`
    );
    return;
  }

  const selectedRoute = routes[0];
  if (!selectedRoute) {
    await interaction.editReply(`${E.Library} No routes are available anymore.`);
    return;
  }
  const manageRoutes = await buildManageRoutes(guildContext.guild, routes);
  const panelToken = createManagePanelToken();
  upsertManagePanel(panelToken, {
    userId: interaction.user.id,
    authUserId: ctx.authUserId,
    guildId: ctx.guildId,
    selectedRouteId: selectedRoute._id,
  });
  await interaction.editReply({
    embeds: [buildManageEmbed(selectedRoute, routes.length)],
    components: buildManageComponents(panelToken, manageRoutes, selectedRoute._id),
  });
}

export async function handleDownloadsManageSelect(
  interaction: StringSelectMenuInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  panelToken: string
): Promise<void> {
  const panel = requireManagePanel(panelToken);
  if (!panel) {
    await interaction.reply({
      content: `${E.Timer} This panel expired. Open \`/creator-admin downloads manage\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== panel.userId) {
    await interaction.reply({
      content: `${E.X_} Only the person who opened this panel can use it.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const guild = interaction.guild;
  if (!guildId || !guild) return;

  const routes = await fetchRouteList(convex, apiSecret, panel.authUserId, guildId);
  if (routes.length === 0) {
    await interaction.update({
      content: `${E.Library} No routes are available anymore.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const selectedRouteId = interaction.values[0] as Id<'download_routes'>;
  const selectedRoute = routes.find((route) => route._id === selectedRouteId) ?? routes[0];
  if (!selectedRoute) {
    await interaction.update({
      content: `${E.Library} No routes are available anymore.`,
      embeds: [],
      components: [],
    });
    return;
  }
  const manageRoutes = await buildManageRoutes(guild, routes);
  upsertManagePanel(panelToken, {
    userId: panel.userId,
    authUserId: panel.authUserId,
    guildId,
    selectedRouteId: selectedRoute._id,
  });

  await interaction.update({
    embeds: [buildManageEmbed(selectedRoute, routes.length)],
    components: buildManageComponents(panelToken, manageRoutes, selectedRoute._id),
  });
}

export async function handleDownloadsManageToggle(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  panelToken: string
): Promise<void> {
  const panel = requireManagePanel(panelToken);
  if (!panel) {
    await interaction.reply({
      content: `${E.Timer} This panel expired. Open \`/creator-admin downloads manage\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== panel.userId) {
    await interaction.reply({
      content: `${E.X_} Only the person who opened this panel can use it.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const routeId = panel.selectedRouteId;
  const route = await convex.query(api.downloads.getRouteById, { apiSecret, routeId });
  if (!route || route.authUserId !== panel.authUserId || route.guildId !== interaction.guildId) {
    await interaction.update({
      content: `${E.X_} This route is no longer available.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const nextEnabled = !route.enabled;
  await convex.mutation(api.downloads.toggleRoute, {
    apiSecret,
    routeId,
    enabled: nextEnabled,
  });

  const guildContext = getGuildContext(interaction);
  if (!guildContext) {
    await interaction.update({
      content: `${E.X_} This route is only manageable inside a server.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const routes = await fetchRouteList(convex, apiSecret, panel.authUserId, guildContext.guildId);
  const updatedRoute = routes.find((entry) => entry._id === routeId);
  if (!updatedRoute) {
    await interaction.update({
      content: `${nextEnabled ? E.Checkmark : E.X_} Route updated.`,
      embeds: [],
      components: [],
    });
    return;
  }

  upsertManagePanel(panelToken, {
    userId: panel.userId,
    authUserId: panel.authUserId,
    guildId: guildContext.guildId,
    selectedRouteId: updatedRoute._id,
  });
  const manageRoutes = await buildManageRoutes(guildContext.guild, routes);

  await interaction.update({
    content: `${nextEnabled ? E.Checkmark : E.X_} Route is now **${nextEnabled ? 'on' : 'off'}**.`,
    embeds: [buildManageEmbed(updatedRoute, routes.length)],
    components: buildManageComponents(panelToken, manageRoutes, updatedRoute._id),
  });
}

export async function handleDownloadsManageRemovePrompt(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  panelToken: string
): Promise<void> {
  const panel = requireManagePanel(panelToken);
  if (!panel) {
    await interaction.reply({
      content: `${E.Timer} This panel expired. Open \`/creator-admin downloads manage\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== panel.userId) {
    await interaction.reply({
      content: `${E.X_} Only the person who opened this panel can use it.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const routeId = panel.selectedRouteId;
  const route = await convex.query(api.downloads.getRouteById, { apiSecret, routeId });
  if (!route || route.authUserId !== panel.authUserId || route.guildId !== interaction.guildId) {
    await interaction.update({
      content: `${E.X_} This route is no longer available.`,
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.update({
    content: `${E.X_} Remove this route?\nUploads: <#${route.sourceChannelId}>\nArchive: <#${route.archiveChannelId}>\n\nMembers will stop getting liened download links from this route.`,
    embeds: [],
    components: buildManageRemoveConfirmComponents(panelToken),
  });
}

export async function handleDownloadsManageEditMessage(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  panelToken: string
): Promise<void> {
  const panel = requireManagePanel(panelToken);
  if (!panel) {
    await interaction.reply({
      content: `${E.Timer} This panel expired. Open \`/creator-admin downloads manage\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== panel.userId) {
    await interaction.reply({
      content: `${E.X_} Only the person who opened this panel can use it.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const route = await convex.query(api.downloads.getRouteById, {
    apiSecret,
    routeId: panel.selectedRouteId,
  });
  if (!route || route.authUserId !== panel.authUserId || route.guildId !== interaction.guildId) {
    await interaction.reply({
      content: `${E.X_} This route is no longer available.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(buildManageMessageModal(panelToken, route));
}

export async function handleDownloadsManageRemoveConfirm(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  panelToken: string
): Promise<void> {
  const panel = requireManagePanel(panelToken);
  if (!panel) {
    await interaction.reply({
      content: `${E.Timer} This panel expired. Open \`/creator-admin downloads manage\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== panel.userId) {
    await interaction.reply({
      content: `${E.X_} Only the person who opened this panel can use it.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const routeId = panel.selectedRouteId;
  const route = await convex.query(api.downloads.getRouteById, { apiSecret, routeId });
  if (!route || route.authUserId !== panel.authUserId || route.guildId !== interaction.guildId) {
    await interaction.update({
      content: `${E.X_} This route is no longer available.`,
      embeds: [],
      components: [],
    });
    return;
  }

  await convex.mutation(api.downloads.deleteRoute, { apiSecret, routeId });
  const guildContext = getGuildContext(interaction);
  if (!guildContext) {
    await interaction.update({
      content: `${E.X_} This route is only manageable inside a server.`,
      embeds: [],
      components: [],
    });
    return;
  }
  const routes = await fetchRouteList(convex, apiSecret, panel.authUserId, guildContext.guildId);

  if (routes.length === 0) {
    managePanels.delete(panelToken);
    await interaction.update({
      content: `${E.Checkmark} Route removed. No liened download routes are left in this server.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const nextRoute = routes[0];
  if (!nextRoute) {
    await interaction.update({
      content: `${E.Library} No routes are available anymore.`,
      embeds: [],
      components: [],
    });
    return;
  }
  const manageRoutes = await buildManageRoutes(guildContext.guild, routes);
  upsertManagePanel(panelToken, {
    userId: panel.userId,
    authUserId: panel.authUserId,
    guildId: guildContext.guildId,
    selectedRouteId: nextRoute._id,
  });
  await interaction.update({
    content: `${E.Checkmark} Route removed.`,
    embeds: [buildManageEmbed(nextRoute, routes.length)],
    components: buildManageComponents(panelToken, manageRoutes, nextRoute._id),
  });
}

export async function handleDownloadsManageRefresh(
  interaction: ButtonInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  panelToken: string
): Promise<void> {
  const panel = requireManagePanel(panelToken);
  if (!panel) {
    await interaction.reply({
      content: `${E.Timer} This panel expired. Open \`/creator-admin downloads manage\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== panel.userId) {
    await interaction.reply({
      content: `${E.X_} Only the person who opened this panel can use it.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildContext = getGuildContext(interaction);
  if (!guildContext) {
    await interaction.update({
      content: `${E.X_} This route is only manageable inside a server.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const routes = await fetchRouteList(convex, apiSecret, panel.authUserId, guildContext.guildId);
  if (routes.length === 0) {
    managePanels.delete(panelToken);
    await interaction.update({
      content: `${E.Library} No routes are available anymore.`,
      embeds: [],
      components: [],
    });
    return;
  }

  const selectedRoute = routes.find((entry) => entry._id === panel.selectedRouteId) ?? routes[0];
  if (!selectedRoute) {
    await interaction.update({
      content: `${E.Library} No routes are available anymore.`,
      embeds: [],
      components: [],
    });
    return;
  }
  const manageRoutes = await buildManageRoutes(guildContext.guild, routes);
  upsertManagePanel(panelToken, {
    userId: panel.userId,
    authUserId: panel.authUserId,
    guildId: guildContext.guildId,
    selectedRouteId: selectedRoute._id,
  });
  await interaction.update({
    embeds: [buildManageEmbed(selectedRoute, routes.length)],
    components: buildManageComponents(panelToken, manageRoutes, selectedRoute._id),
  });
}

export async function handleDownloadsManageMessageModal(
  interaction: ModalSubmitInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  panelToken: string
): Promise<void> {
  const panel = requireManagePanel(panelToken);
  if (!panel) {
    await interaction.reply({
      content: `${E.Timer} This panel expired. Open \`/creator-admin downloads manage\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== panel.userId) {
    await interaction.reply({
      content: `${E.X_} Only the person who opened this panel can use it.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const route = await convex.query(api.downloads.getRouteById, {
    apiSecret,
    routeId: panel.selectedRouteId,
  });
  if (!route || route.authUserId !== panel.authUserId || route.guildId !== interaction.guildId) {
    await interaction.reply({
      content: `${E.X_} This route is no longer available.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const messageTitle = interaction.fields.getTextInputValue('message_title').trim();
  const messageBody = interaction.fields.getTextInputValue('message_body').trim();

  if (!messageTitle || !messageBody) {
    await interaction.reply({
      content: `${E.X_} Add a title and body before saving.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await convex.mutation(api.downloads.updateRouteMessage, {
    apiSecret,
    routeId: panel.selectedRouteId,
    messageTitle,
    messageBody,
  });

  const guildContext = getGuildContext(interaction);
  if (!guildContext) {
    await interaction.reply({
      content: `${E.X_} This route is only manageable inside a server.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const routes = await fetchRouteList(convex, apiSecret, panel.authUserId, guildContext.guildId);
  const selectedRoute = routes.find((entry) => entry._id === panel.selectedRouteId) ?? routes[0];
  if (!selectedRoute) {
    await interaction.reply({
      content: `${E.Checkmark} Delivery message updated.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const manageRoutes = await buildManageRoutes(guildContext.guild, routes);
  upsertManagePanel(panelToken, {
    userId: panel.userId,
    authUserId: panel.authUserId,
    guildId: guildContext.guildId,
    selectedRouteId: selectedRoute._id,
  });

  await interaction.reply({
    content: `${E.Checkmark} Delivery message updated.`,
    embeds: [buildManageEmbed(selectedRoute, routes.length)],
    components: buildManageComponents(panelToken, manageRoutes, selectedRoute._id),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleDownloadsRouteAutocomplete(
  interaction: AutocompleteInteraction,
  convex: ConvexHttpClient,
  apiSecret: string,
  authUserId: string,
  guildId: string
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'route_id') {
    await interaction.respond([]);
    return;
  }

  const routes = await fetchRouteList(convex, apiSecret, authUserId, guildId);
  const query = focused.value.toLowerCase();

  await interaction.respond(
    routes
      .filter((route) => {
        const searchText = [
          route._id,
          route.sourceChannelId,
          route.archiveChannelId,
          route.enabled ? 'enabled' : 'disabled',
        ]
          .join(' ')
          .toLowerCase();
        return !query || searchText.includes(query);
      })
      .slice(0, 25)
      .map((route) => ({
        name: `${route.enabled ? 'Enabled' : 'Disabled'} • #${route.sourceChannelId} -> #${route.archiveChannelId}`,
        value: route._id,
      }))
  );
}
