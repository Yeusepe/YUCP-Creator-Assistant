import { describe, expect, it, mock } from 'bun:test';

// Mock internalRpc functions used by collab.ts
const mockAddCollaboratorConnectionManual = mock(() =>
  Promise.resolve({
    success: true,
    connectionId: 'conn_abc',
    displayName: 'Jinxxy Creator',
    error: undefined,
  })
);

mock.module('../../src/lib/internalRpc', () => ({
  createCollaboratorInvite: mock(() =>
    Promise.resolve({
      inviteUrl: 'https://example.com/invite/token',
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    })
  ),
  listCollaboratorConnections: mock(() => Promise.resolve([])),
  addCollaboratorConnectionManual: mockAddCollaboratorConnectionManual,
  removeCollaboratorConnection: mock(() => Promise.resolve({ success: true })),
}));

import { handleCollabAdd, handleCollabAddModalSubmit } from '../../src/commands/collab';
import { extractAllCustomIds, mockModalSubmit, mockSlashCommand } from '../helpers/mockInteraction';

describe('collab command', () => {
  it('given /collab add, shows provider selection menu for collab-capable providers', async () => {
    const interaction = mockSlashCommand({
      userId: 'user_collab_1',
      guildId: 'guild_collab_1',
      commandName: 'creator-admin',
      subcommandGroup: 'collab',
      subcommand: 'add',
      isAdmin: true,
    });

    await handleCollabAdd(interaction as any, 'api-secret', 'auth_collab_1');

    expect(interaction.reply.mock.calls.length).toBe(1);
    const payload = interaction.reply.mock.calls[0]?.[0] as any;

    // Only jinxxy has supportsCollab:true — the select menu should be shown
    const customIds = extractAllCustomIds(interaction);
    const addSelectId = customIds.find((id) => id.startsWith('creator_collab:add_select:'));
    expect(addSelectId).toBeDefined();
    expect(addSelectId).toBe('creator_collab:add_select:auth_collab_1');

    // Content mentions "Add Collaborator"
    expect(payload?.content).toContain('Add Collaborator');
  });

  it('given collab add modal submitted with valid credential, replies with success', async () => {
    // Set API_BASE_URL so getApiUrls() returns a non-null value
    const originalApiBaseUrl = process.env.API_BASE_URL;
    process.env.API_BASE_URL = 'http://test.internal';

    try {
      const interaction = mockModalSubmit({
        userId: 'user_collab_2',
        guildId: 'guild_collab_2',
        customId: 'creator_collab:add_modal:jinxxy:auth_collab_2',
        textInputValues: {
          collab_credential: 'jinxxy-api-key-abc123xyz456',
        },
      });

      await handleCollabAddModalSubmit(interaction as any, 'api-secret', 'auth_collab_2', 'jinxxy');

      // deferReply then editReply
      expect(interaction.deferReply.mock.calls.length).toBe(1);
      expect(interaction.editReply.mock.calls.length).toBe(1);

      const replyPayload = interaction.editReply.mock.calls[0]?.[0] as any;
      const content: string =
        typeof replyPayload === 'string' ? replyPayload : (replyPayload?.content ?? '');
      expect(content).toContain('Jinxxy Creator');
      expect(mockAddCollaboratorConnectionManual.mock.calls.length).toBeGreaterThan(0);
    } finally {
      process.env.API_BASE_URL = originalApiBaseUrl;
    }
  });
});
