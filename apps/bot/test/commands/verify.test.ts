/**
 * Tests for the verify command panel builder.
 *
 * buildVerifyStatusReply constructs a Discord ComponentsV2 container from Convex data.
 * We mock the ConvexHttpClient directly, no internalRpc calls happen during panel builds.
 *
 * Call-order note for the two "guild-only" convex queries:
 *   buildVerifyStatusReply runs Promise.all([fetchVerifyData(), convex.query(getEnabledProviders)])
 *   fetchVerifyData suspends at its FIRST await (getSubjectByDiscordId), so getEnabledProviders
 *   is invoked synchronously BEFORE fetchVerifyData's inner queries.
 *   Therefore among queries whose args match only {apiSecret, authUserId, guildId}:
 *     call index 1 → getEnabledVerificationProvidersFromProducts → return { providers }
 *     call index 2 → getByGuildWithProductNames (only when subject found) → return array
 */

import { describe, expect, it, mock } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import type { ChatInputCommandInteraction } from 'discord.js';
import { buildVerifyStatusReply, handleVerifySpawn } from '../../src/commands/verify';
import { E } from '../../src/lib/emojis';
import { buildVerifyPromptMessage, VERIFY_PROMPT_FOOTER_TEXT } from '../../src/lib/verifyPrompt';
import { mockSlashCommand } from '../helpers/mockInteraction';

// ─── Convex mock factory ──────────────────────────────────────────────────────

type SpawnPayload = {
  embeds?: Array<{ toJSON: () => { title?: string; description?: string } }>;
  components?: Array<{ components?: Array<{ data?: { label?: string; style?: number } }> }>;
};

type ConvexMockOpts = {
  subjectFound?: boolean;
  linkedAccounts?: Array<{ provider: string; status: string; _id?: string }>;
  entitlements?: Array<{ productId: string }>;
  guildProducts?: Array<{ productId: string; displayName: string | null }>;
  providers?: string[];
  failedRoleSyncJobs?: unknown[];
  roleRules?: Array<{
    productId?: string;
    enabled?: boolean;
    verifiedRoleId?: string;
    verifiedRoleIds?: string[];
    sourceGuildId?: string;
    displayName?: string | null;
    requiredRoleId?: string;
    requiredRoleIds?: string[];
    requiredRoleMatchMode?: 'any' | 'all';
  }>;
  downloadRoutes?: Array<{ enabled: boolean; sourceChannelId: string }>;
};

function makeConvex(opts: ConvexMockOpts = {}): ConvexHttpClient {
  const {
    subjectFound = false,
    linkedAccounts = [],
    entitlements = [],
    guildProducts = [],
    providers = [],
    failedRoleSyncJobs = [],
    roleRules = [],
    downloadRoutes = [],
  } = opts;

  let guildOnlyIdx = 0;

  return {
    query: mock(async (_ref: unknown, args: Record<string, unknown>) => {
      // getSubjectByDiscordId, has discordUserId but not guildId
      if ('discordUserId' in args && !('guildId' in args)) {
        if (!subjectFound) return { found: false };
        return { found: true, subject: { _id: 'subject_test_abc' } };
      }

      // getVerifyPromptMessageForOwner, has guildLinkId and authUserId, but no guildId
      if ('guildLinkId' in args && !('guildId' in args)) {
        return null;
      }

      // getFailedRoleSyncForUser, has both discordUserId AND guildId
      if ('discordUserId' in args && 'guildId' in args) {
        return failedRoleSyncJobs;
      }

      // getEntitlementsBySubject, has subjectId and includeInactive
      if ('subjectId' in args && 'includeInactive' in args) {
        return entitlements;
      }

      // getSubjectWithAccounts, has subjectId only
      if ('subjectId' in args) {
        return { found: true, externalAccounts: linkedAccounts };
      }

      // Guild-only queries: getEnabledVerificationProvidersFromProducts (1st call)
      // and getByGuildWithProductNames (2nd call, only when subject is found).
      guildOnlyIdx++;
      if (guildOnlyIdx === 1) {
        return { providers };
      }
      if (roleRules.length > 0 || downloadRoutes.length > 0) {
        if (guildOnlyIdx === 2) return roleRules;
        if (guildOnlyIdx === 3) return downloadRoutes;
      }
      return guildProducts;
    }),
    mutation: mock(async () => ({})),
  } as unknown as ConvexHttpClient;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildVerifyStatusReply', () => {
  it('shows setup-required message when no providers are configured for the guild', async () => {
    const convex = makeConvex({ subjectFound: false, providers: [] });

    const reply = await buildVerifyStatusReply(
      'user_verify_1',
      'auth_verify_1',
      'guild_verify_1',
      convex,
      'api-secret',
      'https://api.example.com'
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    expect(text).toContain('Nothing to verify yet!');
  });

  it('shows verified state with product names when user has active entitlements in this guild', async () => {
    const convex = makeConvex({
      subjectFound: true,
      linkedAccounts: [{ provider: 'gumroad', status: 'active', _id: 'acct_1' }],
      entitlements: [{ productId: 'prod_verify_abc' }],
      guildProducts: [{ productId: 'prod_verify_abc', displayName: 'Awesome Course' }],
      providers: ['gumroad'],
      failedRoleSyncJobs: [],
    });

    const reply = await buildVerifyStatusReply(
      'user_verify_2',
      'auth_verify_2',
      'guild_verify_2',
      convex,
      'api-secret',
      'https://api.example.com'
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    expect(text).toContain("You're verified!");
    expect(text).toContain('Awesome Course');
  });

  it('shows license-key verify button when user is unverified but providers are configured', async () => {
    // No subject found → state = 'nothing'; gumroad in enabledSet → license key button is shown
    const convex = makeConvex({ subjectFound: false, providers: ['gumroad'] });

    const reply = await buildVerifyStatusReply(
      'user_verify_3',
      'auth_verify_3',
      'guild_verify_3',
      convex,
      'api-secret',
      'https://api.example.com'
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    // License key button uses a custom_id (not a URL), present regardless of apiBaseUrl
    expect(text).toContain('creator_verify:license:auth_verify_3');
  });

  it('describes the enabled verification coverage when multiple provider types are configured', async () => {
    const convex = makeConvex({ subjectFound: false, providers: ['gumroad', 'discord', 'vrchat'] });

    const reply = await buildVerifyStatusReply(
      'user_verify_coverage',
      'auth_verify_coverage',
      'guild_verify_coverage',
      convex,
      'api-secret',
      'https://api.example.com'
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    expect(text).toContain('Pick the option that matches how you got access.');
    expect(text).toContain(
      'Available here: purchases from Gumroad, VRChat ownership, and access from another Discord server.'
    );
  });

  it('uses account-link verification URLs for provider connect buttons', async () => {
    const convex = makeConvex({ subjectFound: false, providers: ['gumroad'] });

    const reply = await buildVerifyStatusReply(
      'user_verify_5',
      'auth_verify_5',
      'guild_verify_5',
      convex,
      'api-secret',
      'https://api.example.com'
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    expect(text).toContain(
      'https://api.example.com/api/verification/begin?authUserId=auth_verify_5&mode=gumroad'
    );
    expect(text).toContain('verificationMethod=account_link');
  });

  it('handles DM context (null guildId) gracefully without throwing', async () => {
    const convex = makeConvex({ subjectFound: false, providers: [] });

    const reply = await buildVerifyStatusReply(
      'user_verify_4',
      'auth_verify_4',
      null as unknown as string, // DM: no guild
      convex,
      'api-secret',
      undefined
    );

    const text = JSON.stringify(reply.components[0].toJSON());
    expect(text).toContain('Use this command in a server');
  });
});

describe('handleVerifySpawn', () => {
  it('builds benefit-led copy with capped channels, downloads, and provider-specific instructions', () => {
    const message = buildVerifyPromptMessage(new Set(['gumroad', 'discord']), undefined, {
      accessPreview: {
        channelMentions: ['#vip-chat', '#support', '#announcements'],
        moreChannelCount: 2,
        lienedDownloadMentions: ['#avatar-drops', '#asset-releases'],
        moreLienedDownloadCount: 1,
        discordSourceGuildMentions: [
          '[**Alpha Club**](https://discord.com/channels/source_guild_1/channel_alpha)',
          '[**Beta Lounge**](https://discord.com/channels/source_guild_2/channel_beta)',
          '[**Gamma Hub**](https://discord.com/channels/source_guild_3/channel_gamma)',
        ],
        moreDiscordSourceGuildCount: 0,
      },
    });

    expect(message.presentation.description).toContain(
      'Verify to access #vip-chat, #support, #announcements, and 2 more!'
    );
    expect(message.presentation.description).toContain(
      'Find your Liened Downloads in #avatar-drops, #asset-releases, and 1 more.'
    );
    expect(message.presentation.description).toContain(
      `${E.Gumorad} Using Gumroad? Sign in with your Gumroad account or paste your license key.`
    );
    expect(message.presentation.description).toContain(
      `${E.Discord} Have you verified in [**Alpha Club**](https://discord.com/channels/source_guild_1/channel_alpha), [**Beta Lounge**](https://discord.com/channels/source_guild_2/channel_beta), or [**Gamma Hub**](https://discord.com/channels/source_guild_3/channel_gamma)? Bring your verification here! Sign in and sync your roles.`
    );
    expect(message.embed.toJSON().footer?.text).toBe(VERIFY_PROMPT_FOOTER_TEXT);
    expect(message.presentation.description).not.toContain('Available here');
  });

  it('builds dynamic spawn copy from the enabled providers for the guild', async () => {
    const convex = makeConvex({
      providers: ['gumroad', 'jinxxy', 'discord'],
      roleRules: [
        {
          productId: 'discord_role:source_guild_1:role_1',
          enabled: true,
          sourceGuildId: 'source_guild_1',
          displayName: 'Members (Alpha Club)',
        },
      ],
      downloadRoutes: [],
    });
    const interaction = mockSlashCommand({
      commandName: 'creator-admin',
      subcommand: 'spawn-verify',
    });
    interaction.client.guilds.fetch = mock(async (id: string) => {
      if (id === 'source_guild_1') {
        return {
          id: 'source_guild_1',
          name: 'Alpha Club',
          systemChannelId: 'channel_alpha',
          rulesChannelId: null,
          publicUpdatesChannelId: null,
          channels: { fetch: async () => null },
          roles: { everyone: { id: 'everyone' } },
        } as never;
      }
      return null;
    });

    await handleVerifySpawn(
      interaction as unknown as ChatInputCommandInteraction,
      convex,
      'api-secret',
      'https://api.example.com',
      {
        authUserId: 'auth_spawn_1',
        guildId: 'guild_spawn_1',
        guildLinkId: 'guild_link_spawn_1' as never,
      }
    );

    expect(interaction.channel?.send.mock.calls[0]).toBeDefined();

    const sendPayload = interaction.channel?.send.mock.calls[0]?.[0] as SpawnPayload;
    const embed = sendPayload.embeds?.[0]?.toJSON();
    const button = sendPayload.components?.[0]?.components?.[0] as {
      data?: { label?: string; style?: number };
    };

    expect(embed?.title).toContain('Verify your creator access');
    expect(embed?.description).toContain(
      `${E.Home} Verify to access your channels, downloads, roles, and more!`
    );
    expect(embed?.description).toContain(
      `${E.Touch} Click **Start verification** to choose your verification path.`
    );
    expect(embed?.description).toContain(
      `${E.Gumorad} Using Gumroad? Sign in with your Gumroad account.`
    );
    expect(embed?.description).toContain(
      `${E.Key} Using a ${E.Gumorad} Gumroad or ${E.Jinxxy} Jinxxy license key? Paste it in to verify.`
    );
    expect(embed?.description).toContain(
      `${E.Discord} Have you verified in [**Alpha Club**](https://discord.com/channels/source_guild_1/channel_alpha)? Bring your verification here! Sign in and sync your roles.`
    );
    expect(embed?.description).toContain(
      `${E.Checkmark} We’ll confirm it and update your roles automatically.`
    );
    expect(embed?.description).not.toContain('Available here');
    expect(button.data?.label).toBe('Start verification');
    expect(button.data?.style).toBe(3);

    const mutationCalls = (
      convex.mutation as unknown as {
        mock: { calls: Array<[unknown, Record<string, unknown>]> };
      }
    ).mock.calls;
    expect(mutationCalls.at(-1)?.[1]).toMatchObject({
      guildLinkId: 'guild_link_spawn_1',
      channelId: interaction.channel?.id,
      messageId: 'mock_message_id',
    });
  });

  it('lists unique Discord source servers in the spawned prompt', async () => {
    const convex = makeConvex({
      providers: ['discord'],
      roleRules: [
        {
          productId: 'discord_role:source_guild_1:role_1',
          enabled: true,
          sourceGuildId: 'source_guild_1',
          displayName: 'Members (Alpha Club)',
          verifiedRoleId: 'verified_1',
        },
        {
          productId: 'discord_role:source_guild_1:role_2',
          enabled: true,
          sourceGuildId: 'source_guild_1',
          requiredRoleId: 'role_2',
          verifiedRoleId: 'verified_2',
        },
        {
          productId: 'discord_role:source_guild_3:role_3',
          enabled: true,
          sourceGuildId: 'source_guild_3',
          displayName: 'Access (Gamma Hub)',
          verifiedRoleId: 'verified_3',
        },
      ],
      downloadRoutes: [],
    });
    const interaction = mockSlashCommand({
      commandName: 'creator-admin',
      subcommand: 'spawn-verify',
    });
    interaction.client.guilds.fetch = mock(async (id: string) => {
      if (id === 'source_guild_1') {
        return {
          id: 'source_guild_1',
          name: 'Alpha Club',
          systemChannelId: 'channel_alpha',
          rulesChannelId: null,
          publicUpdatesChannelId: null,
          channels: { fetch: async () => null },
          roles: {
            everyone: { id: 'everyone' },
            cache: new Map(),
            fetch: async () =>
              new Map([
                ['role_1', { name: 'Members' }],
                ['role_2', { name: 'VRC Ready' }],
              ]),
          },
        } as never;
      }
      if (id === 'source_guild_3') {
        return {
          id: 'source_guild_3',
          name: 'Gamma Hub',
          systemChannelId: 'channel_gamma',
          rulesChannelId: null,
          publicUpdatesChannelId: null,
          channels: { fetch: async () => null },
          roles: {
            everyone: { id: 'everyone' },
            cache: new Map(),
            fetch: async () => new Map([['role_3', { name: 'Gamma Access' }]]),
          },
        } as never;
      }
      return null;
    });

    await handleVerifySpawn(
      interaction as unknown as ChatInputCommandInteraction,
      convex,
      'api-secret',
      'https://api.example.com',
      {
        authUserId: 'auth_spawn_multi',
        guildId: 'guild_spawn_multi',
        guildLinkId: 'guild_link_spawn_multi' as never,
      }
    );

    const sendPayload = interaction.channel?.send.mock.calls[0]?.[0] as SpawnPayload;
    const embed = sendPayload.embeds?.[0]?.toJSON();

    expect(embed?.description).toContain(
      '[**Alpha Club**](https://discord.com/channels/source_guild_1/channel_alpha)'
    );
    expect(embed?.description).toContain(
      '[**Gamma Hub**](https://discord.com/channels/source_guild_3/channel_gamma)'
    );
    expect(embed?.description).not.toContain('Members (Alpha Club)');
    expect(embed?.description).not.toContain('VRC Ready (Alpha Club)');
    expect(embed?.description).not.toContain('Access (Gamma Hub)');
  });

  it('prefers the stored source server name over a raw guild id when the source guild cannot be fetched', async () => {
    const sourceGuildId = '1169053833922629653';
    const convex = makeConvex({
      providers: ['discord'],
      roleRules: [
        {
          productId: `discord_role:${sourceGuildId}:1169056856354852927`,
          enabled: true,
          sourceGuildId,
          displayName: 'Humanify',
          verifiedRoleId: 'verified_1',
        },
      ],
      downloadRoutes: [],
    });
    const interaction = mockSlashCommand({
      commandName: 'creator-admin',
      subcommand: 'spawn-verify',
    });
    interaction.client.guilds.fetch = mock(async () => null);

    await handleVerifySpawn(
      interaction as unknown as ChatInputCommandInteraction,
      convex,
      'api-secret',
      'https://api.example.com',
      {
        authUserId: 'auth_spawn_guild_name_fallback',
        guildId: 'guild_spawn_guild_name_fallback',
        guildLinkId: 'guild_link_spawn_guild_name_fallback' as never,
      }
    );

    const sendPayload = interaction.channel?.send.mock.calls[0]?.[0] as SpawnPayload;
    const embed = sendPayload.embeds?.[0]?.toJSON();

    expect(embed?.description).toContain('**Humanify**');
    expect(embed?.description).not.toContain(sourceGuildId);
  });
});
