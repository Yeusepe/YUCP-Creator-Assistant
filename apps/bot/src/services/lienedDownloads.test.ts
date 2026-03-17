import { describe, expect, it, mock } from 'bun:test';
import { LienedDownloadsService } from './lienedDownloads';

type ServiceClient = ConstructorParameters<typeof LienedDownloadsService>[0];
type ServiceConvex = ConstructorParameters<typeof LienedDownloadsService>[1];
type DownloadInteraction = Parameters<LienedDownloadsService['handleDownloadButton']>[0];

describe('LienedDownloadsService', () => {
  it('force-refreshes the archive message before serving download links', async () => {
    const query = mock(async () => ({
      _id: 'artifact_123',
      guildId: 'guild_123',
      routeId: 'route_123',
      sourceChannelId: 'source_channel_123',
      sourceMessageId: 'source_message_123',
      sourceMessageUrl:
        'https://discord.com/channels/guild_123/source_channel_123/source_message_123',
      archiveChannelId: 'archive_channel_123',
      archiveMessageId: 'archive_message_123',
      requiredRoleIds: ['role_123'],
      roleLogic: 'any' as const,
      files: [
        {
          filename: 'Novacat_1.0.2.unitypackage',
          url: 'https://stale.example/old',
          extension: 'unitypackage',
        },
      ],
      status: 'active' as const,
    }));
    const mutation = mock(async () => null);
    const action = mock(async () => null);
    const fetchArchiveMessage = mock(async () => ({
      attachments: new Map([
        [
          'attachment_123',
          {
            name: 'Novacat_1.0.2.unitypackage',
            url: 'https://fresh.example/new',
            size: 1024,
            contentType: 'application/octet-stream',
          },
        ],
      ]),
      messageSnapshots: {
        first: () => null,
      },
    }));
    const channelFetch = mock(async () => ({
      isTextBased: () => true,
      messages: {
        fetch: fetchArchiveMessage,
      },
    }));
    const reply = mock(async (payload: unknown) => payload);
    const memberFetch = mock(async () => ({
      roles: {
        cache: new Set(['role_123']),
      },
    }));

    const service = new LienedDownloadsService(
      {
        channels: {
          fetch: channelFetch,
        },
      } as unknown as ServiceClient,
      {
        query,
        mutation,
        action,
      } as unknown as ServiceConvex,
      'api-secret'
    );

    await service.handleDownloadButton(
      {
        inGuild: () => true,
        guildId: 'guild_123',
        user: {
          id: 'user_123',
        },
        guild: {
          members: {
            fetch: memberFetch,
          },
        },
        reply,
      } as unknown as DownloadInteraction,
      'artifact_123'
    );

    expect(fetchArchiveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'archive_message_123',
        force: true,
      })
    );

    const payload = reply.mock.calls[0]?.[0] as {
      embeds?: Array<{
        data?: {
          description?: string;
        };
      }>;
    };
    const description = payload.embeds?.[0]?.data?.description ?? '';

    expect(description).toContain('https://fresh.example/new');
    expect(description).not.toContain('https://stale.example/old');
  });
});
