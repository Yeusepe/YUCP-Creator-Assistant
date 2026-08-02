import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ConvexHttpClient } from 'convex/browser';
import type { GuildMember } from 'discord.js';

const mutationMock = mock(async () => ({ queued: true, jobCount: 1 }));

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    guildMemberAdd: {
      handleGuildMemberJoin: 'guildMemberAdd:handleGuildMemberJoin',
    },
  },
}));

import { handleGuildMemberAdd } from '../../src/handlers/guildMemberAdd';

describe('guildMemberAdd consumer', () => {
  beforeEach(() => {
    mutationMock.mockClear();
  });

  it('forwards the joining Discord identity and reports recovered role work', async () => {
    const member = {
      id: 'discord-user-recovered-on-join',
      guild: { id: 'discord-guild-recovered-on-join' },
    } as GuildMember;
    const convex = { mutation: mutationMock } as unknown as ConvexHttpClient;

    await handleGuildMemberAdd(member, {
      convex,
      apiSecret: 'test-api-secret',
    });

    expect(mutationMock).toHaveBeenCalledWith('guildMemberAdd:handleGuildMemberJoin', {
      apiSecret: 'test-api-secret',
      discordGuildId: 'discord-guild-recovered-on-join',
      discordUserId: 'discord-user-recovered-on-join',
    });
  });
});
