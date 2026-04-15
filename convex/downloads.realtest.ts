import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import { makeTestConvex, seedGuildLink } from './testHelpers';

const API_SECRET = 'test-secret';
const INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

describe('downloads route consistency', () => {
  beforeEach(() => {
    process.env.CONVEX_API_SECRET = API_SECRET;
    process.env.INTERNAL_SERVICE_AUTH_SECRET = INTERNAL_SERVICE_AUTH_SECRET;
  });

  afterEach(() => {
    delete process.env.CONVEX_API_SECRET;
    delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
  });

  it('rejects route creation when the guild link belongs to a different guild', async () => {
    const t = makeTestConvex();
    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-download-owner',
      discordGuildId: 'guild-linked',
    });

    await expect(
      t.mutation(api.downloads.createRoute, {
        apiSecret: API_SECRET,
        authUserId: 'auth-download-owner',
        guildId: 'guild-other',
        guildLinkId,
        sourceChannelId: 'channel-source-test',
        archiveChannelId: 'channel-archive-test',
        messageTitle: 'Downloads',
        messageBody: 'Protected downloads',
        requiredRoleIds: ['role-download-test'],
        roleLogic: 'all',
        allowedExtensions: ['zip'],
      })
    ).rejects.toThrow(/guild/i);
  });

  it('derives artifact routing fields from the saved route', async () => {
    const t = makeTestConvex();
    const guildLinkId = await seedGuildLink(t, {
      authUserId: 'auth-download-owner',
      discordGuildId: 'guild-linked',
    });
    const route = await t.mutation(api.downloads.createRoute, {
      apiSecret: API_SECRET,
      authUserId: 'auth-download-owner',
      guildId: 'guild-linked',
      guildLinkId,
      sourceChannelId: 'channel-source-test',
      archiveChannelId: 'channel-archive-test',
      messageTitle: 'Downloads',
      messageBody: 'Protected downloads',
      requiredRoleIds: ['role-download-test'],
      roleLogic: 'all',
      allowedExtensions: ['zip'],
    });

    const { artifactId } = await t.mutation(api.downloads.createArtifact, {
      apiSecret: API_SECRET,
      authUserId: 'auth-download-owner',
      guildId: 'guild-other',
      routeId: route.routeId,
      sourceChannelId: 'channel-source-other',
      sourceMessageId: 'message-source-test',
      sourceMessageUrl: 'https://discord.test/messages/source',
      sourceAuthorId: 'discord-author-test',
      archiveChannelId: 'channel-archive-other',
      archiveMessageId: 'message-archive-test',
      requiredRoleIds: ['role-other'],
      roleLogic: 'any',
      files: [
        {
          filename: 'archive.zip',
          url: 'https://downloads.test/archive.zip',
          extension: 'zip',
        },
      ],
    });

    const artifact = await t.run(async (ctx) => {
      return await ctx.db.get(artifactId);
    });

    expect(artifact).toMatchObject({
      guildId: 'guild-linked',
      sourceChannelId: 'channel-source-test',
      archiveChannelId: 'channel-archive-test',
      requiredRoleIds: ['role-download-test'],
      roleLogic: 'all',
    });
  });
});
