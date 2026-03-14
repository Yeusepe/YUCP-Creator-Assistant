import { describe, expect, it, mock } from 'bun:test';
import {
  extractAllCustomIds,
  getEmbedFromReply,
  mockButton,
  mockSlashCommand,
} from '../helpers/mockInteraction';

// settings.ts uses convex directly (not internalRpc), so no module mock needed
import {
  handleDisconnectCancel,
  handleSettingsDisconnect,
} from '../../src/commands/settings';

const noop = mock(() => {});
const makeLogger = () => ({
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  child: () => makeLogger(),
});

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

    await handleSettingsDisconnect(interaction as any, mockConvex, 'api-secret', {
      logger: makeLogger() as any,
      authUserId: 'auth_settings_1',
      guildId: 'guild_settings_1',
    });

    expect(interaction.reply.mock.calls.length).toBe(1);

    const embed = getEmbedFromReply(interaction) as any;
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

    await handleDisconnectCancel(interaction as any, mockConvex, 'api-secret', {
      logger: makeLogger() as any,
    });

    // cancel uses update(), not reply()
    expect(interaction.update.mock.calls.length).toBe(1);
    const payload = interaction.update.mock.calls[0]?.[0] as any;

    expect(payload?.embeds?.[0]?.data?.title).toBe('✅ Cancelled');
    expect(payload?.embeds?.[0]?.data?.description).toContain('remains connected');
    // All buttons removed on cancel
    expect(payload?.components).toEqual([]);
  });
});
