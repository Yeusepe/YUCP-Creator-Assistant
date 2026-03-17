/**
 * Tests for /creator-admin moderation sub-commands.
 *
 * Moderation commands use ConvexHttpClient directly — no internalRpc.
 * posthog is mocked via mock.module so track() is a no-op in tests.
 */

import { describe, expect, it, mock } from 'bun:test';

// Mock posthog BEFORE importing any command (bun:test hoists mock.module)
mock.module('../../src/lib/posthog', () => ({
  track: mock(() => {}),
  flush: mock(() => Promise.resolve()),
}));

import type { ConvexHttpClient } from 'convex/browser';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import {
  handleModerationConfirmClear,
  handleModerationMark,
  handleModerationReasonSelect,
} from '../../src/commands/moderation';
import { handleInteraction } from '../../src/handlers/interactions';
import {
  type MockFn,
  mockButton,
  mockSlashCommand,
  mockStringSelect,
} from '../helpers/mockInteraction';

// ─── Convex mock factory ──────────────────────────────────────────────────────

type ModerationConvexOpts = {
  subjectFound?: boolean;
  subjectId?: string;
};

function makeConvex(opts: ModerationConvexOpts = {}): ConvexHttpClient {
  const { subjectFound = true, subjectId = 'subject_mod_test' } = opts;

  return {
    query: mock(async (_ref: unknown, args: Record<string, unknown>) => {
      if ('discordGuildId' in args) {
        return {
          authUserId: 'auth_mod_secure',
          guildLinkId: 'guild_link_mod_secure',
        };
      }
      // All moderation queries go through getSubjectByDiscordId pattern
      if (!subjectFound) return { found: false };
      return { found: true, subject: { _id: subjectId } };
    }),
    mutation: mock(async () => ({})),
  } as unknown as ConvexHttpClient;
}

const _BASE_CTX = {
  authUserId: 'auth_mod_test',
  guildId: 'guild_mod_test',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('moderation commands', () => {
  it('given mark subcommand with target user, shows reason select menu', async () => {
    const interaction = mockSlashCommand({
      userId: 'actor_mod_1',
      guildId: 'guild_mod_1',
      isAdmin: true,
      userOptions: { user: { id: 'target_mod_1', username: 'flagged_user' } },
    });

    // handleModerationMark does not use convex (_convex parameter)
    await handleModerationMark(
      interaction as unknown as ChatInputCommandInteraction,
      {} as ConvexHttpClient,
      'api-secret',
      {
        authUserId: 'auth_mod_1',
        guildId: 'guild_mod_1',
      }
    );

    expect(interaction.reply.mock.calls).toHaveLength(1);
    const payload = interaction.reply.mock.calls[0]?.[0];

    // Reply mentions the target user
    expect(payload?.content).toContain('<@target_mod_1>');

    // Select menu customId encodes actorId, authUserId, targetUserId
    const selectMenuRow = payload?.components?.[0];
    const selectMenu = selectMenuRow?.components?.[0];
    expect(selectMenu?.data?.custom_id).toMatch(
      /^creator_moderation:reason_select:actor_mod_1:auth_mod_1:target_mod_1$/
    );
  });

  it('given confirm-clear button, clears the suspicious flag and shows success embed', async () => {
    const interaction = mockButton({
      userId: 'actor_mod_2',
      guildId: 'guild_mod_2',
      customId: 'creator_moderation:confirm_clear:target_mod_2:auth_mod_2:actor_mod_2',
    });
    const convex = makeConvex({ subjectFound: true, subjectId: 'sub_mod_2' });

    await handleModerationConfirmClear(
      interaction as unknown as ButtonInteraction,
      convex,
      'api-secret',
      'target_mod_2',
      'auth_mod_2',
      'actor_mod_2'
    );

    expect(interaction.deferUpdate.mock.calls).toHaveLength(1);
    expect(interaction.editReply.mock.calls).toHaveLength(1);

    const embed = interaction.editReply.mock.calls[0]?.[0]?.embeds?.[0];
    expect(embed?.data?.title).toBe('Flag Cleared');
    // Success color: green (0x57f287)
    expect(embed?.data?.color).toBe(0x57f287);
    expect(embed?.data?.description).toContain('<@target_mod_2>');
  });

  it('given non-moderator user, moderation mark action returns permission error', async () => {
    // ⚠️ BUG: handleModerationMark has no internal permission check.
    // Any user who bypasses the interactions handler can mark others as suspicious.
    // This test expects a permission error — it will FAIL, revealing the missing guard.
    const interaction = mockSlashCommand({
      userId: 'unprivileged_mod_3',
      guildId: 'guild_mod_3',
      isAdmin: false, // non-admin / non-moderator
      userOptions: { user: { id: 'victim_mod_3', username: 'victim' } },
    });

    await handleModerationMark(
      interaction as unknown as ChatInputCommandInteraction,
      {} as ConvexHttpClient,
      'api-secret',
      {
        authUserId: 'auth_mod_3',
        guildId: 'guild_mod_3',
      }
    );

    // ⚠️ BUG: command shows select menu to non-admin users instead of rejecting
    const replyContent: string | undefined = interaction.reply.mock.calls[0]?.[0]?.content;
    expect(replyContent).toMatch(/permission|not authorized|missing permissions/i);
  });

  it('given unknown target userId, mark-reason select shows "no account found" error', async () => {
    const interaction = mockStringSelect({
      userId: 'actor_mod_4',
      guildId: 'guild_mod_4',
      values: ['Piracy'],
    });
    // Subject not found in DB
    const convex = makeConvex({ subjectFound: false });

    await handleModerationReasonSelect(
      interaction as unknown as StringSelectMenuInteraction,
      convex,
      'api-secret',
      'actor_mod_4', // actorId
      'auth_mod_4', // authUserId
      'unknown_mod_4' // targetUserId — not in DB
    );

    expect(interaction.deferUpdate.mock.calls).toHaveLength(1);
    expect(interaction.editReply.mock.calls).toHaveLength(1);

    const content: string | undefined = interaction.editReply.mock.calls[0]?.[0]?.content;
    expect(content).toContain('<@unknown_mod_4>');
    expect(content?.toLowerCase()).toMatch(/no account|not have verified/i);
  });

  it('moderation mark reply is ephemeral', async () => {
    const interaction = mockSlashCommand({
      userId: 'actor_mod_5',
      guildId: 'guild_mod_5',
      isAdmin: true,
      userOptions: { user: { id: 'target_mod_5', username: 'some_user' } },
    });

    await handleModerationMark(
      interaction as unknown as ChatInputCommandInteraction,
      {} as ConvexHttpClient,
      'api-secret',
      {
        authUserId: 'auth_mod_5',
        guildId: 'guild_mod_5',
      }
    );

    const replyArgs = interaction.reply.mock.calls[0]?.[0];
    expect(replyArgs?.flags).toBe(MessageFlags.Ephemeral);
  });

  it('given DM context (null guildId), moderation mark returns guild-required error', async () => {
    // ⚠️ BUG: handleModerationMark has no guild guard. In a DM, ctx.guildId is null
    // but the command proceeds and shows the flag select menu instead of a guild-required error.
    // The assertion below expects a guild-required message — it will FAIL, revealing the bug.
    const interaction = mockSlashCommand({
      userId: 'actor_mod_6',
      guildId: null, // DM context
      isAdmin: true,
      userOptions: { user: { id: 'target_mod_6', username: 'target' } },
    });

    await handleModerationMark(
      interaction as unknown as ChatInputCommandInteraction,
      {} as ConvexHttpClient,
      'api-secret',
      {
        authUserId: 'auth_mod_6',
        guildId: null as unknown as string,
      }
    );

    // ⚠️ BUG: shows select menu instead of guild-required error
    const replyContent: string | undefined = interaction.reply.mock.calls[0]?.[0]?.content;
    expect(replyContent).toMatch(/server|guild/i);
  });

  it('handleInteraction rejects moderation slash commands in DMs before dispatch', async () => {
    const interaction = mockSlashCommand({
      userId: 'actor_mod_guard_1',
      guildId: null,
      commandName: 'creator-admin',
      subcommandGroup: 'moderation',
      subcommand: 'mark',
      isAdmin: true,
      userOptions: { user: { id: 'target_mod_guard_1', username: 'target' } },
    });
    const convex = makeConvex();

    await handleInteraction(interaction as unknown as ChatInputCommandInteraction, {
      convex,
      apiSecret: 'api-secret',
    });

    const reply = interaction.reply.mock.calls[0]?.[0];
    expect(reply?.content).toMatch(/server/i);
    expect(reply?.flags).toBe(MessageFlags.Ephemeral);
    expect(interaction.deferReply.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
    expect((convex.query as unknown as MockFn).mock.calls).toHaveLength(0);
  });

  it('handleInteraction rejects tampered moderation reason selects when the embedded actorId does not match the clicker', async () => {
    const interaction = mockStringSelect({
      userId: 'intruder_mod_guard_2',
      guildId: 'guild_mod_guard_2',
      customId:
        'creator_moderation:reason_select:admin_mod_guard_2:auth_mod_secure:target_mod_guard_2',
      values: ['Piracy'],
      isAdmin: true,
    });
    const convex = makeConvex();

    await handleInteraction(interaction as unknown as StringSelectMenuInteraction, {
      convex,
      apiSecret: 'api-secret',
    });

    const reply = interaction.reply.mock.calls[0]?.[0];
    expect(reply?.content).toMatch(/only the admin who started/i);
    expect(reply?.flags).toBe(MessageFlags.Ephemeral);
    expect(interaction.deferUpdate.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
    expect((convex.mutation as unknown as MockFn).mock.calls).toHaveLength(0);
  });

  it('handleInteraction rejects tampered moderation clear buttons with mismatched embedded authUserId', async () => {
    const interaction = mockButton({
      userId: 'admin_mod_guard_3',
      guildId: 'guild_mod_guard_3',
      customId:
        'creator_moderation:confirm_clear:target_mod_guard_3:auth_mod_other:admin_mod_guard_3',
      isAdmin: true,
    });
    const convex = makeConvex();

    await handleInteraction(interaction as unknown as ButtonInteraction, {
      convex,
      apiSecret: 'api-secret',
    });

    const reply = interaction.reply.mock.calls[0]?.[0];
    expect(reply?.content).toMatch(/no longer valid/i);
    expect(reply?.flags).toBe(MessageFlags.Ephemeral);
    expect(interaction.deferUpdate.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
    expect((convex.mutation as unknown as MockFn).mock.calls).toHaveLength(0);
  });
});
