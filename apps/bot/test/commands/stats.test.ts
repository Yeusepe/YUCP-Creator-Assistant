/**
 * Tests for the /creator-admin stats command.
 *
 * handleStats uses convex directly — no internalRpc calls.
 * Embed data is accessed via embed.data.fields (EmbedBuilder internal).
 */

import { describe, expect, it, mock } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { handleStats } from '../../src/commands/stats';
import { handleInteraction } from '../../src/handlers/interactions';
import { mockButton, mockSlashCommand } from '../helpers/mockInteraction';

// ─── Convex mock factory ──────────────────────────────────────────────────────

type StatsMockOpts = {
  rules?: unknown[];
  totalVerified?: number;
  recent24h?: number;
  recent7d?: number;
  recent30d?: number;
};

function makeConvex(opts: StatsMockOpts = {}): ConvexHttpClient {
  const { rules = [], totalVerified = 0, recent24h = 0, recent7d = 0, recent30d = 0 } = opts;

  return {
    query: mock(async (_ref: unknown, args: Record<string, unknown>) => {
      // getByGuild — has guildId in args
      if ('guildId' in args) {
        return rules;
      }
      // getStatsOverviewExtended — has only apiSecret + authUserId (no guildId)
      return { totalVerified, recent24h, recent7d, recent30d };
    }),
    mutation: mock(async () => ({})),
  } as unknown as ConvexHttpClient;
}

function makeInteractionConvex(
  opts: { guildLinkAuthUserId?: string; totalVerified?: number; nextCursor?: string | null } = {}
): ConvexHttpClient {
  const { guildLinkAuthUserId = 'auth_stats_secure', totalVerified = 0, nextCursor = null } = opts;

  return {
    query: mock(async (_ref: unknown, args: Record<string, unknown>) => {
      if ('discordGuildId' in args) {
        return {
          authUserId: guildLinkAuthUserId,
          guildLinkId: 'guild_link_stats_secure',
        };
      }

      if ('limit' in args) {
        return {
          users: [{ discordUserId: 'viewer_1', productCount: 1 }],
          nextCursor,
          totalCount: totalVerified,
        };
      }

      if ('guildId' in args) {
        return [];
      }

      return { totalVerified, recent24h: 0, recent7d: 0, recent30d: 0 };
    }),
    mutation: mock(async () => ({})),
  } as unknown as ConvexHttpClient;
}

const BASE_CTX: Parameters<typeof handleStats>[3] = {
  authUserId: 'auth_stats_test',
  guildId: 'guild_stats_test',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handleStats', () => {
  it('given zero stats, embed shows "0" for all counts — not "undefined"', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_stats_1',
      guildId: 'guild_stats_1',
      isAdmin: true,
    });
    const convex = makeConvex({
      rules: [],
      totalVerified: 0,
      recent24h: 0,
      recent7d: 0,
      recent30d: 0,
    });

    await handleStats(
      interaction as unknown as ChatInputCommandInteraction,
      convex,
      'api-secret',
      BASE_CTX
    );

    const embed = interaction.editReply.mock.calls[0]?.[0]?.embeds?.[0];
    const fields: Array<{ name: string; value: string }> = embed?.data?.fields ?? [];

    for (const field of fields) {
      expect(field.value).not.toBe('undefined');
      expect(field.value).toBe('0');
    }
  });

  it('given 3 verified members, embed "Verified Users" field shows "3"', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_stats_2',
      guildId: 'guild_stats_2',
      isAdmin: true,
    });
    const convex = makeConvex({
      rules: [{ id: 'rule_1' }, { id: 'rule_2' }],
      totalVerified: 3,
      recent24h: 1,
      recent7d: 2,
      recent30d: 3,
    });

    await handleStats(
      interaction as unknown as ChatInputCommandInteraction,
      convex,
      'api-secret',
      BASE_CTX
    );

    const embed = interaction.editReply.mock.calls[0]?.[0]?.embeds?.[0];
    const verifiedField = embed?.data?.fields?.find(
      (f: { name: string }) => f.name === 'Verified Users'
    );
    expect(verifiedField?.value).toBe('3');
  });

  it('given non-admin user, handleStats executes without internal permission check', async () => {
    // handleStats itself has no admin check — the permission gate lives in the interactions
    // handler (which checks member.permissions.has(MANAGE_GUILD_BIT) before dispatching).
    // This test documents that design: calling handleStats directly works for any user.
    const interaction = mockSlashCommand({
      userId: 'user_stats_3',
      guildId: 'guild_stats_3',
      isAdmin: false, // non-admin
    });
    const convex = makeConvex({ totalVerified: 42 });

    await handleStats(
      interaction as unknown as ChatInputCommandInteraction,
      convex,
      'api-secret',
      BASE_CTX
    );

    // Non-admin user still receives the stats embed (handler guards are external)
    expect(interaction.deferReply.mock.calls).toHaveLength(1);
    expect(interaction.editReply.mock.calls).toHaveLength(1);
    const embed = interaction.editReply.mock.calls[0]?.[0]?.embeds?.[0];
    expect(embed?.data?.title).toContain('Verification Stats');
  });

  it('embed contains all required fields with non-empty values', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_stats_4',
      guildId: 'guild_stats_4',
      isAdmin: true,
    });
    const convex = makeConvex({
      rules: [{ id: 'rule_1' }, { id: 'rule_2' }, { id: 'rule_3' }],
      totalVerified: 10,
      recent24h: 2,
      recent7d: 5,
      recent30d: 8,
    });

    await handleStats(
      interaction as unknown as ChatInputCommandInteraction,
      convex,
      'api-secret',
      BASE_CTX
    );

    expect(interaction.deferReply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ flags: MessageFlags.Ephemeral })
    );

    const embed = interaction.editReply.mock.calls[0]?.[0]?.embeds?.[0];
    const fieldNames = embed?.data?.fields?.map((f: { name: string }) => f.name) ?? [];

    expect(fieldNames).toContain('Verified Users');
    expect(fieldNames).toContain('Products Mapped');
    expect(fieldNames).toContain('Verified (24h)');
    expect(fieldNames).toContain('Verified (7d)');
    expect(fieldNames).toContain('Verified (30d)');

    for (const field of embed?.data?.fields ?? []) {
      expect(field.value).not.toBe('');
      expect(field.value).not.toBe('undefined');
    }

    // Products Mapped comes from the rules array length
    const mappedField = embed?.data?.fields?.find(
      (f: { name: string }) => f.name === 'Products Mapped'
    );
    expect(mappedField?.value).toBe('3');
  });

  it('stats command in DM context returns appropriate error', async () => {
    // ⚠️ BUG: handleStats has no guild guard. When called with null guildId it queries
    // convex with guildId=null and returns a stats embed instead of a "use in a server" error.
    // The assertion below expects a guild-required message — it will FAIL, revealing the bug.
    const interaction = mockSlashCommand({ userId: 'user_stats_5', guildId: null });
    const convex = makeConvex({ totalVerified: 0, recent24h: 0, recent7d: 0, recent30d: 0 });

    await handleStats(interaction as unknown as ChatInputCommandInteraction, convex, 'api-secret', {
      authUserId: 'auth_stats_5',
      guildId: null as unknown as string,
    });

    // Fix: guard calls reply() with guild-required message (no deferReply needed for early exit).
    const replyArgs = interaction.reply.mock.calls[0]?.[0];
    const content: string = replyArgs?.content ?? '';
    expect(content).toMatch(/server|guild/i);
    // editReply must NOT have been called (no embed sent for DM context)
    expect(interaction.editReply.mock.calls).toHaveLength(0);
  });

  it('handleInteraction rejects non-admin /creator-admin stats before dispatch', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_stats_guard_1',
      guildId: 'guild_stats_guard_1',
      commandName: 'creator-admin',
      subcommand: 'stats',
      isAdmin: false,
    });
    const convex = makeInteractionConvex();

    await handleInteraction(interaction as unknown as ChatInputCommandInteraction, {
      convex,
      apiSecret: 'api-secret',
    });

    expect(interaction.reply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        content: expect.stringMatching(/administrator/i),
        flags: MessageFlags.Ephemeral,
      })
    );
    expect(interaction.deferReply.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
    expect((convex.query as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it('handleInteraction rejects stats slash commands in DMs before any query runs', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_stats_guard_2',
      guildId: null,
      commandName: 'creator-admin',
      subcommand: 'stats',
      isAdmin: true,
    });
    const convex = makeInteractionConvex();

    await handleInteraction(interaction as unknown as ChatInputCommandInteraction, {
      convex,
      apiSecret: 'api-secret',
    });

    expect(interaction.reply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        content: expect.stringMatching(/server/i),
        flags: MessageFlags.Ephemeral,
      })
    );
    expect(interaction.deferReply.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
    expect((convex.query as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it('handleInteraction rejects tampered stats buttons with mismatched embedded authUserId and guildId', async () => {
    const interaction = mockButton({
      userId: 'user_stats_guard_3',
      guildId: 'guild_stats_guard_3',
      customId: 'creator_stats:view_users:auth_stats_other:guild_stats_other',
      isAdmin: true,
    });
    const convex = makeInteractionConvex({ guildLinkAuthUserId: 'auth_stats_guard_3' });

    await handleInteraction(interaction as unknown as ButtonInteraction, {
      convex,
      apiSecret: 'api-secret',
    });

    const reply = interaction.reply.mock.calls[0]?.[0];
    expect(reply?.content).toMatch(/different server|no longer valid/i);
    expect(reply?.flags).toBe(MessageFlags.Ephemeral);
    expect(interaction.deferUpdate.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
    expect((convex.query as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });
});
