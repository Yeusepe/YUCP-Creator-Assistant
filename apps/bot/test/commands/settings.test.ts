import { describe, expect, it, mock } from 'bun:test';
import type { Logger } from '@yucp/shared';
import type { ConvexHttpClient } from 'convex/browser';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
// settings.ts uses convex directly (not internalRpc), so no module mock needed
import { handleDisconnectCancel, handleSettingsDisconnect } from '../../src/commands/settings';
import { handleInteraction } from '../../src/handlers/interactions';
import {
  extractAllCustomIds,
  getEmbedFromReply,
  mockButton,
  mockSlashCommand,
} from '../helpers/mockInteraction';

const noop = mock(() => {});
const makeLogger = () => ({
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  child: () => makeLogger(),
});

function makeSettingsConvex() {
  return {
    query: mock(async () => ({
      authUserId: 'auth_settings_secure',
      guildLinkId: 'guild_link_settings_secure',
    })),
    mutation: mock(async () => ({ success: true })),
  };
}

describe('settings command', () => {
  it('handleSettingsDisconnect shows warning embed with disconnect/cancel buttons', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_settings_1',
      guildId: 'guild_settings_1',
      commandName: 'creator-admin',
      subcommand: 'disconnect',
      subcommandGroup: 'settings',
      isAdmin: true,
    });
    const mockConvex = {} as Parameters<typeof handleSettingsDisconnect>[1];

    await handleSettingsDisconnect(
      interaction as unknown as ChatInputCommandInteraction,
      mockConvex,
      'api-secret',
      {
        logger: makeLogger() as unknown as Logger,
        authUserId: 'auth_settings_1',
        guildId: 'guild_settings_1',
      }
    );

    expect(interaction.reply.mock.calls.length).toBe(1);

    const embed = getEmbedFromReply(interaction) as {
      data?: { title?: string; description?: string };
    };
    expect(embed?.data?.title).toBe('⚠️ Warning: Disconnect Server');
    expect(embed?.data?.description).toContain('disconnect this server');

    const customIds = extractAllCustomIds(interaction);
    expect(customIds).toContain('creator_settings:disconnect_warn1:confirm');
    expect(customIds).toContain('creator_settings:disconnect_cancel');
  });

  it('handleDisconnectCancel shows cancellation embed and removes buttons', async () => {
    const interaction = mockButton({
      userId: 'user_settings_2',
      guildId: 'guild_settings_2',
      customId: 'creator_settings:disconnect_cancel',
    });
    const mockConvex = {} as Parameters<typeof handleDisconnectCancel>[1];

    await handleDisconnectCancel(
      interaction as unknown as ButtonInteraction,
      mockConvex,
      'api-secret',
      {
        logger: makeLogger() as unknown as Logger,
      }
    );

    // cancel uses update(), not reply()
    expect(interaction.update.mock.calls.length).toBe(1);
    const payload = interaction.update.mock.calls[0]?.[0];

    expect(payload?.embeds?.[0]?.data?.title).toBe('✅ Cancelled');
    expect(payload?.embeds?.[0]?.data?.description).toContain('remains connected');
    // All buttons removed on cancel
    expect(payload?.components).toEqual([]);
  });

  it('handleInteraction rejects disconnect buttons in DMs without mutating anything', async () => {
    const interaction = mockButton({
      userId: 'user_settings_guard_1',
      guildId: null,
      customId: 'creator_settings:disconnect_confirm',
      isAdmin: true,
    });
    const convex = makeSettingsConvex();

    await handleInteraction(interaction as unknown as ButtonInteraction, {
      convex: convex as unknown as ConvexHttpClient,
      apiSecret: 'api-secret',
    });

    const reply = interaction.reply.mock.calls[0]?.[0];
    expect(reply?.content).toMatch(/server/i);
    expect(reply?.flags).toBe(MessageFlags.Ephemeral);
    expect(interaction.deferUpdate.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
    expect(convex.query.mock.calls).toHaveLength(0);
    expect(convex.mutation.mock.calls).toHaveLength(0);
  });

  it('handleInteraction rejects non-admin disconnect confirmations before any guild lookup', async () => {
    const interaction = mockButton({
      userId: 'user_settings_guard_2',
      guildId: 'guild_settings_guard_2',
      customId: 'creator_settings:disconnect_confirm',
      isAdmin: false,
    });
    const convex = makeSettingsConvex();

    await handleInteraction(interaction as unknown as ButtonInteraction, {
      convex: convex as unknown as ConvexHttpClient,
      apiSecret: 'api-secret',
    });

    const reply = interaction.reply.mock.calls[0]?.[0];
    expect(reply?.content).toMatch(/administrator/i);
    expect(reply?.flags).toBe(MessageFlags.Ephemeral);
    expect(interaction.deferUpdate.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
    expect(convex.query.mock.calls).toHaveLength(0);
    expect(convex.mutation.mock.calls).toHaveLength(0);
  });

  it('handleInteraction replies with an unknown-button error for unsupported disconnect actions', async () => {
    const interaction = mockButton({
      userId: 'user_settings_guard_3',
      guildId: 'guild_settings_guard_3',
      customId: 'creator_settings:disconnect_bogus',
      isAdmin: true,
    });
    const convex = makeSettingsConvex();

    await handleInteraction(interaction as unknown as ButtonInteraction, {
      convex: convex as unknown as ConvexHttpClient,
      apiSecret: 'api-secret',
    });

    const reply = interaction.reply.mock.calls[0]?.[0];
    expect(reply?.content).toBe('Unknown button.');
    expect(reply?.flags).toBe(MessageFlags.Ephemeral);
    expect(interaction.deferUpdate.mock.calls).toHaveLength(0);
    expect(interaction.editReply.mock.calls).toHaveLength(0);
  });
});
