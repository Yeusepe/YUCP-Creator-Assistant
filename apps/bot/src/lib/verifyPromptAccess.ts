import { ChannelType, type Client, type Guild, PermissionsBitField } from 'discord.js';
import { api } from '../../../../convex/_generated/api';
import type { VerifyPromptAccessPreview } from './verifyPrompt';

const MAX_VERIFY_PROMPT_CHANNELS = 3;
const MAX_VERIFY_PROMPT_DOWNLOAD_CHANNELS = 2;
const MAX_VERIFY_PROMPT_SOURCE_GUILDS = 3;
const DISCORD_CHANNELS_BASE_URL = 'https://discord.com/channels';

interface GuildRoleRule {
  productId?: string;
  enabled?: boolean;
  verifiedRoleId?: string;
  verifiedRoleIds?: string[];
  sourceGuildId?: string;
  sourceGuildName?: string;
  displayName?: string | null;
  requiredRoleId?: string;
  requiredRoleIds?: string[];
  requiredRoleMatchMode?: 'any' | 'all';
}

interface DownloadRouteSummary {
  enabled: boolean;
  sourceChannelId: string;
}

type QueryClient = {
  // biome-ignore lint/suspicious/noExplicitAny: Convex queries are dynamically dispatched in the bot runtime.
  query: (...args: any[]) => Promise<any>;
};

function limitPreviewItems<T>(items: T[], limit: number): { items: T[]; extraCount: number } {
  return {
    items: items.slice(0, limit),
    extraCount: Math.max(0, items.length - limit),
  };
}

function isPreviewableGuildChannelType(type: ChannelType): boolean {
  return (
    type === ChannelType.GuildText ||
    type === ChannelType.GuildAnnouncement ||
    type === ChannelType.GuildForum
  );
}

function parseSourceGuildName(displayName?: string | null): string | undefined {
  if (!displayName) return undefined;
  const match = /\(([^()]+)\)\s*$/.exec(displayName);
  const guildName = match?.[1]?.trim();
  return guildName || undefined;
}

function resolveSourceGuildLabel(options: {
  sourceGuildName?: string;
  displayName?: string | null;
  sourceGuildId?: string;
}): string | undefined {
  const parsedDisplayGuildName = parseSourceGuildName(options.displayName);
  const trimmedDisplayName = options.displayName?.trim();

  return (
    options.sourceGuildName ??
    parsedDisplayGuildName ??
    (trimmedDisplayName ? trimmedDisplayName : undefined) ??
    options.sourceGuildId
  );
}

function buildDiscordChannelUrl(guildId: string, channelId: string): string {
  return `${DISCORD_CHANNELS_BASE_URL}/${guildId}/${channelId}`;
}

function parseDiscordRoleProduct(productId?: string): {
  sourceGuildId?: string;
} {
  if (!productId?.startsWith('discord_role:')) {
    return {};
  }

  const parts = productId.split(':');
  if (parts.length === 3) {
    return {
      sourceGuildId: parts[1],
    };
  }

  return {
    sourceGuildId: parts[1],
  };
}

function pickPreferredSourceChannelId(guild: Guild | null): string | undefined {
  if (!guild) return undefined;

  if (guild.systemChannelId) return guild.systemChannelId;
  if (guild.rulesChannelId) return guild.rulesChannelId;
  if (guild.publicUpdatesChannelId) return guild.publicUpdatesChannelId;

  return undefined;
}

export async function buildVerifyPromptAccessPreview(options: {
  convex: QueryClient;
  discordClient: Client;
  apiSecret: string;
  authUserId: string;
  guildId: string;
}): Promise<VerifyPromptAccessPreview | undefined> {
  const [roleRulesResult, downloadRoutesResult] = await Promise.all([
    options.convex.query(api.role_rules.getByGuild, {
      apiSecret: options.apiSecret,
      authUserId: options.authUserId,
      guildId: options.guildId,
    }),
    options.convex.query(api.downloads.listRoutesByGuild, {
      apiSecret: options.apiSecret,
      authUserId: options.authUserId,
      guildId: options.guildId,
    }),
  ]);

  const roleRules = roleRulesResult as GuildRoleRule[];
  const enabledRoleRules = roleRules.filter((rule) => rule.enabled !== false);
  const downloadRoutes = (downloadRoutesResult as DownloadRouteSummary[]).filter(
    (route) => route.enabled
  );
  const verifiedRoleIds = [
    ...new Set(
      enabledRoleRules
        .flatMap(
          (rule) => rule.verifiedRoleIds ?? (rule.verifiedRoleId ? [rule.verifiedRoleId] : [])
        )
        .filter(Boolean)
    ),
  ];
  const discordRoleRules = enabledRoleRules.filter((rule) =>
    rule.productId?.startsWith('discord_role:')
  );
  const discordSourceGuildIds = [
    ...new Set(
      discordRoleRules
        .map((rule) => rule.sourceGuildId ?? parseDiscordRoleProduct(rule.productId).sourceGuildId)
        .filter(Boolean)
    ),
  ] as string[];
  const lienedDownloadChannelIds = [
    ...new Set(downloadRoutes.map((route) => route.sourceChannelId)),
  ];

  if (
    verifiedRoleIds.length === 0 &&
    lienedDownloadChannelIds.length === 0 &&
    discordRoleRules.length === 0
  ) {
    return undefined;
  }

  const sourceGuildContextEntries = await Promise.all(
    discordSourceGuildIds.map(async (sourceGuildId) => {
      const guild = await options.discordClient.guilds.fetch(sourceGuildId).catch(() => null);
      if (!guild) {
        return [sourceGuildId, null] as const;
      }

      let channelId = pickPreferredSourceChannelId(guild);
      if (!channelId) {
        const channels = await guild.channels.fetch().catch(() => null);
        if (channels) {
          const firstPreviewableChannel = [...channels.values()]
            .filter((channel): channel is NonNullable<typeof channel> => channel !== null)
            .filter((channel) => isPreviewableGuildChannelType(channel.type))
            .sort((left, right) => left.rawPosition - right.rawPosition)
            .find(
              (channel) =>
                channel
                  .permissionsFor(guild.roles.everyone)
                  ?.has(PermissionsBitField.Flags.ViewChannel) ?? true
            );
          channelId = firstPreviewableChannel?.id;
        }
      }

      return [
        sourceGuildId,
        {
          guildName: guild.name,
          url: channelId ? buildDiscordChannelUrl(guild.id, channelId) : undefined,
        },
      ] as const;
    })
  );
  const sourceGuildContextMap = new Map(sourceGuildContextEntries);
  const discordSourceGuildMentionMap = new Map<string, string>();
  for (const rule of discordRoleRules) {
    const parsed = parseDiscordRoleProduct(rule.productId);
    const sourceGuildId = rule.sourceGuildId ?? parsed.sourceGuildId;
    const sourceGuildContext = sourceGuildId
      ? (sourceGuildContextMap.get(sourceGuildId) ?? null)
      : null;
    const label = resolveSourceGuildLabel({
      sourceGuildName: sourceGuildContext?.guildName ?? rule.sourceGuildName,
      displayName: rule.displayName,
      sourceGuildId,
    });

    if (!label) {
      continue;
    }

    const key = sourceGuildId ?? label;
    const mention = sourceGuildContext?.url
      ? `[**${label}**](${sourceGuildContext.url})`
      : `**${label}**`;
    discordSourceGuildMentionMap.set(key, mention);
  }
  const limitedDiscordSourceGuilds = limitPreviewItems(
    [...discordSourceGuildMentionMap.values()],
    MAX_VERIFY_PROMPT_SOURCE_GUILDS
  );

  let limitedChannels = { items: [] as string[], extraCount: 0 };
  let limitedLienedDownloads = { items: [] as string[], extraCount: 0 };

  const guild = await options.discordClient.guilds.fetch(options.guildId).catch(() => null);
  if (guild) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (channels) {
      const everyoneRole = guild.roles.everyone;
      const previewableChannels = [...channels.values()]
        .filter((channel): channel is NonNullable<typeof channel> => channel !== null)
        .filter((channel) => isPreviewableGuildChannelType(channel.type))
        .sort((left, right) => left.rawPosition - right.rawPosition);

      const downloadChannelNameSet = new Set(
        previewableChannels
          .filter((channel) => lienedDownloadChannelIds.includes(channel.id))
          .map((channel) => `#${channel.name}`)
      );

      const unlockedChannelNames = previewableChannels
        .filter((channel) => {
          const everyoneCanView =
            channel.permissionsFor(everyoneRole)?.has(PermissionsBitField.Flags.ViewChannel) ??
            true;
          if (everyoneCanView) {
            return false;
          }
          return verifiedRoleIds.some(
            (roleId) =>
              channel.permissionsFor(roleId)?.has(PermissionsBitField.Flags.ViewChannel) ?? false
          );
        })
        .map((channel) => `#${channel.name}`)
        .filter((channelName) => !downloadChannelNameSet.has(channelName));

      limitedChannels = limitPreviewItems(unlockedChannelNames, MAX_VERIFY_PROMPT_CHANNELS);
      limitedLienedDownloads = limitPreviewItems(
        [...downloadChannelNameSet],
        MAX_VERIFY_PROMPT_DOWNLOAD_CHANNELS
      );
    }
  }

  if (
    limitedChannels.items.length === 0 &&
    limitedLienedDownloads.items.length === 0 &&
    limitedDiscordSourceGuilds.items.length === 0
  ) {
    return undefined;
  }

  return {
    channelMentions: limitedChannels.items,
    moreChannelCount: limitedChannels.extraCount,
    lienedDownloadMentions: limitedLienedDownloads.items,
    moreLienedDownloadCount: limitedLienedDownloads.extraCount,
    discordSourceGuildMentions: limitedDiscordSourceGuilds.items,
    moreDiscordSourceGuildCount: limitedDiscordSourceGuilds.extraCount,
  };
}
