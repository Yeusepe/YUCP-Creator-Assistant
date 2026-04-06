import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import { E, Emoji } from '../lib/emojis';
import type { DownloadRouteSession, ManageRouteRecord, RouteRecord } from './downloadsTypes';

export const SUPPORTED_EXTENSIONS = [
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

export const DEFAULT_PRESET = 'all_supported';
export const DEFAULT_MESSAGE_TITLE = 'Ready to Download';
export const DEFAULT_MESSAGE_BODY =
  'Open Download to check access. If this file is available to you, Discord sends it privately.';

export const EXTENSION_PRESETS: Record<
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

export function buildStepOneEmbed(session: DownloadRouteSession): EmbedBuilder {
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

export function buildStepTwoEmbed(session: DownloadRouteSession): EmbedBuilder {
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

export function buildConfirmEmbed(session: DownloadRouteSession): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${E.Checkmark} Review Route`)
    .setColor(0x57f287)
    .setDescription(
      ['Review this route before you turn it on.', '', routeSummary(session)].join('\n')
    )
    .setFooter({ text: 'Step 3 of 3 • Create the route or go back to make changes.' });
}

export function buildSourceArchiveComponents(
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

export function buildAccessComponents(
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

export function buildConfirmComponents(
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

export function buildBackfillWarningComponents(
  userId: string,
  authUserId: string,
  routeId: Id<'download_routes'>
): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:autofix_prompt:${userId}:${authUserId}:${routeId}`)
        .setLabel('Autofix Messages')
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

export function buildBackfillAutofixConfirmComponents(
  userId: string,
  authUserId: string,
  routeId: Id<'download_routes'>
): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:autofix_run:${userId}:${authUserId}:${routeId}`)
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

function formatRouteOptionLabel(route: ManageRouteRecord): string {
  return truncateLabel(`${route.enabled ? 'On' : 'Off'} • ${route.sourceName}`, 100);
}

export function buildManageEmbed(route: RouteRecord, totalRoutes: number): EmbedBuilder {
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

export function buildManageComponents(
  panelToken: string,
  routes: ManageRouteRecord[],
  selectedRouteId: Id<'download_routes'>
): Array<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>> {
  const selectedRoute = routes.find((route) => route._id === selectedRouteId) ?? routes[0];
  const hasRoutes = routes.length > 0;

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`creator_downloads:manage_select:${panelToken}`)
        .setPlaceholder(hasRoutes ? 'Choose a route' : 'No routes available')
        .setDisabled(!hasRoutes)
        .addOptions(
          hasRoutes
            ? routes.slice(0, 25).map((route) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(formatRouteOptionLabel(route))
                  .setDescription(truncateLabel(`${route.sourceName} → ${route.archiveName}`, 100))
                  .setValue(route._id)
                  .setDefault(route._id === selectedRoute?._id)
              )
            : [
                new StringSelectMenuOptionBuilder()
                  .setLabel('No routes available')
                  .setValue('__empty__'),
              ]
        )
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`creator_downloads:manage_toggle:${panelToken}`)
        .setLabel(selectedRoute?.enabled ? 'Turn Off' : 'Turn On')
        .setStyle(selectedRoute?.enabled ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(!hasRoutes),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:manage_edit_message:${panelToken}`)
        .setLabel('Edit Delivery Message...')
        .setEmoji(Emoji.Assistant)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!hasRoutes),
      new ButtonBuilder()
        .setCustomId(`creator_downloads:manage_remove_prompt:${panelToken}`)
        .setLabel('Remove Route...')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!hasRoutes)
    ),
  ];
}

export function buildManageRemoveConfirmComponents(
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

export function buildMessageCustomizeModal(
  userId: string,
  authUserId: string,
  session: Pick<DownloadRouteSession, 'messageTitle' | 'messageBody'>
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

export function buildManageMessageModal(
  panelToken: string,
  route: Pick<RouteRecord, 'messageTitle' | 'messageBody'>
): ModalBuilder {
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
