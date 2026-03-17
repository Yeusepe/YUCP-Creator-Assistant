import { describe, expect, it, mock } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  handleDownloadsAdd,
  handleDownloadsManage,
  handleDownloadsManageToggle,
} from '../../src/commands/downloads';
import {
  extractAllCustomIds,
  getEmbedFromReply,
  mockButton,
  mockSlashCommand,
} from '../helpers/mockInteraction';

// ─── Shared mock factories ─────────────────────────────────────────────────────

function makeConvex(queryReturn: unknown) {
  return {
    query: mock(() => Promise.resolve(queryReturn)),
    mutation: mock(() => Promise.resolve({})),
  };
}

function makeManageConvex(route = SAMPLE_ROUTE) {
  return {
    query: mock(async (_ref: unknown, args: Record<string, unknown>) => {
      if ('routeId' in args) {
        return route;
      }
      return [route];
    }),
    mutation: mock(async () => ({})),
  };
}

/** Extend a mock interaction's guild with a channels cache/fetch stub. */
function withGuildChannels(interaction: ReturnType<typeof mockSlashCommand>) {
  (interaction as unknown as { guild: unknown }).guild = {
    roles: { fetch: () => Promise.resolve(null) },
    channels: {
      cache: { get: (_id: string) => undefined },
      fetch: (_id: string) => Promise.resolve(null),
    },
  };
  return interaction;
}

type DownloadsAddCtx = Parameters<typeof handleDownloadsAdd>[1];

const ALL_EXTENSIONS = [
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

const SAMPLE_ROUTE = {
  _id: 'route_dl_1' as Id<'download_routes'>,
  authUserId: 'auth_dl_test',
  guildId: 'guild_dl_test',
  sourceChannelId: 'ch_source_1',
  archiveChannelId: 'ch_archive_1',
  messageTitle: 'Ready to Download',
  messageBody: 'Open Download to check access.',
  requiredRoleIds: ['role_1'],
  roleLogic: 'all' as const,
  allowedExtensions: ALL_EXTENSIONS,
  enabled: true,
};

describe('downloads command', () => {
  it('given /downloads setup slash command, shows step-1 setup embed', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_dl_1',
      guildId: 'guild_dl_1',
      commandName: 'creator-admin',
      subcommandGroup: 'downloads',
      subcommand: 'setup',
      isAdmin: true,
    });

    const ctx: DownloadsAddCtx = {
      authUserId: 'auth_dl_1',
      guildLinkId: 'link_dl_1' as DownloadsAddCtx['guildLinkId'],
      guildId: 'guild_dl_1',
    };

    await handleDownloadsAdd(interaction as unknown as ChatInputCommandInteraction, ctx);

    expect(interaction.reply.mock.calls.length).toBe(1);
    const embed = getEmbedFromReply(interaction) as {
      data?: { title?: string; footer?: { text?: string } };
    };
    expect(embed?.data?.title).toContain('Set Up Liened Downloads');
    expect(embed?.data?.footer?.text).toContain('Step 1 of 3');

    // Should have Continue and Cancel buttons
    const customIds = extractAllCustomIds(interaction);
    expect(customIds.some((id) => id.startsWith('creator_downloads:to_access:'))).toBe(true);
    expect(customIds.some((id) => id.startsWith('creator_downloads:cancel_add:'))).toBe(true);
  });

  it('given /downloads manage with no routes, shows empty state message', async () => {
    const interaction = withGuildChannels(
      mockSlashCommand({
        userId: 'user_dl_2',
        guildId: 'guild_dl_test',
        commandName: 'creator-admin',
        subcommandGroup: 'downloads',
        subcommand: 'manage',
        isAdmin: true,
      })
    );

    const convex = makeConvex([]);

    await handleDownloadsManage(
      interaction as unknown as ChatInputCommandInteraction,
      convex as unknown as ConvexHttpClient,
      'api-secret',
      {
        authUserId: 'auth_dl_test',
        guildId: 'guild_dl_test',
      }
    );

    expect(interaction.deferReply.mock.calls.length).toBe(1);
    const replyContent = interaction.editReply.mock.calls[0]?.[0];
    const content: string =
      typeof replyContent === 'string' ? replyContent : (replyContent?.content ?? '');
    expect(content).toContain('No routes yet');
    expect(content).toContain('/creator-admin downloads setup');
  });

  it('given /downloads manage with an existing route, shows manage embed with route details', async () => {
    const interaction = withGuildChannels(
      mockSlashCommand({
        userId: 'user_dl_3',
        guildId: 'guild_dl_test',
        commandName: 'creator-admin',
        subcommandGroup: 'downloads',
        subcommand: 'manage',
        isAdmin: true,
      })
    );

    const convex = makeConvex([SAMPLE_ROUTE]);

    await handleDownloadsManage(
      interaction as unknown as ChatInputCommandInteraction,
      convex as unknown as ConvexHttpClient,
      'api-secret',
      {
        authUserId: 'auth_dl_test',
        guildId: 'guild_dl_test',
      }
    );

    expect(interaction.deferReply.mock.calls.length).toBe(1);

    const replyPayload = interaction.editReply.mock.calls[0]?.[0];
    const embed = replyPayload?.embeds?.[0];
    expect(embed?.data?.title).toContain('Manage Liened Downloads');
    // Footer shows route ID and total count
    expect(embed?.data?.footer?.text).toContain('1 total');

    // Manage components: select menu and toggle/remove buttons
    const customIds = extractAllCustomIds(interaction);
    expect(customIds.some((id) => id.startsWith('creator_downloads:manage_select:'))).toBe(true);
    expect(customIds.some((id) => id.startsWith('creator_downloads:manage_toggle:'))).toBe(true);
    expect(customIds.some((id) => id.startsWith('creator_downloads:manage_remove_prompt:'))).toBe(
      true
    );
  });

  it('rejects stale manage tokens before any route query runs', async () => {
    const interaction = mockButton({
      userId: 'user_dl_guard_1',
      guildId: 'guild_dl_test',
      customId: 'creator_downloads:manage_toggle:missing_token',
    });
    const convex = makeManageConvex();

    await handleDownloadsManageToggle(
      interaction as unknown as ButtonInteraction,
      convex as unknown as ConvexHttpClient,
      'api-secret',
      'missing_token'
    );

    const reply = interaction.reply.mock.calls[0]?.[0];
    expect(reply?.content).toContain('panel expired');
    expect(interaction.update.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
    expect(convex.query.mock.calls).toHaveLength(0);
    expect(convex.mutation.mock.calls).toHaveLength(0);
  });

  it('rejects managed-route toggles from a different user without touching the route', async () => {
    const openInteraction = withGuildChannels(
      mockSlashCommand({
        userId: 'user_dl_guard_2',
        guildId: 'guild_dl_test',
        commandName: 'creator-admin',
        subcommandGroup: 'downloads',
        subcommand: 'manage',
        isAdmin: true,
      })
    );
    const convex = makeManageConvex();
    await handleDownloadsManage(
      openInteraction as unknown as ChatInputCommandInteraction,
      convex as unknown as ConvexHttpClient,
      'api-secret',
      {
        authUserId: 'auth_dl_test',
        guildId: 'guild_dl_test',
      }
    );

    const panelToken = extractAllCustomIds(openInteraction)
      .find((id) => id.startsWith('creator_downloads:manage_toggle:'))
      ?.slice('creator_downloads:manage_toggle:'.length);
    expect(panelToken).toBeDefined();

    const intruderInteraction = mockButton({
      userId: 'user_dl_intruder_2',
      guildId: 'guild_dl_test',
      customId: `creator_downloads:manage_toggle:${panelToken}`,
    });

    await handleDownloadsManageToggle(
      intruderInteraction as unknown as ButtonInteraction,
      convex as unknown as ConvexHttpClient,
      'api-secret',
      panelToken as string
    );

    const reply = intruderInteraction.reply.mock.calls[0]?.[0];
    expect(reply?.content).toContain('Only the person who opened this panel');
    expect(intruderInteraction.update.mock.calls).toHaveLength(0);
    expect(intruderInteraction.editReply.mock.calls).toHaveLength(0);
  });

  it('keeps managed routes isolated to their original guild when a panel token is replayed elsewhere', async () => {
    const openInteraction = withGuildChannels(
      mockSlashCommand({
        userId: 'user_dl_guard_3',
        guildId: 'guild_dl_test',
        commandName: 'creator-admin',
        subcommandGroup: 'downloads',
        subcommand: 'manage',
        isAdmin: true,
      })
    );
    const convex = makeManageConvex();
    await handleDownloadsManage(
      openInteraction as unknown as ChatInputCommandInteraction,
      convex as unknown as ConvexHttpClient,
      'api-secret',
      {
        authUserId: 'auth_dl_test',
        guildId: 'guild_dl_test',
      }
    );

    const panelToken = extractAllCustomIds(openInteraction)
      .find((id) => id.startsWith('creator_downloads:manage_toggle:'))
      ?.slice('creator_downloads:manage_toggle:'.length);
    expect(panelToken).toBeDefined();

    const replayInteraction = mockButton({
      userId: 'user_dl_guard_3',
      guildId: 'guild_dl_other',
      customId: `creator_downloads:manage_toggle:${panelToken}`,
    });

    await handleDownloadsManageToggle(
      replayInteraction as unknown as ButtonInteraction,
      convex as unknown as ConvexHttpClient,
      'api-secret',
      panelToken as string
    );

    const updatePayload = replayInteraction.update.mock.calls[0]?.[0];
    expect(updatePayload?.content).toContain('no longer available');
    expect(replayInteraction.reply.mock.calls).toHaveLength(0);
    expect(convex.mutation.mock.calls).toHaveLength(0);
  });
});
