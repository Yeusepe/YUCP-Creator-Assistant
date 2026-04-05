import { describe, expect, it } from 'bun:test';
import type {
  DashboardGuildRecord,
  GuildDirectoryRepositoryPort,
  GuildMetadataResolverPort,
} from '../ports/guildDirectory';
import { GuildDirectoryService } from './guildDirectoryService';

function createRepository(guilds: DashboardGuildRecord[]): GuildDirectoryRepositoryPort & {
  readonly persisted: Array<{
    guildId: string;
    discordGuildName: string;
    discordGuildIcon?: string;
  }>;
} {
  const persisted: Array<{
    guildId: string;
    discordGuildName: string;
    discordGuildIcon?: string;
  }> = [];

  return {
    persisted,
    async listUserGuilds() {
      return guilds.map((guild) => ({ ...guild }));
    },
    async persistGuildMetadata(input) {
      persisted.push(input);
    },
  };
}

describe('GuildDirectoryService', () => {
  it('returns guilds unchanged when metadata backfill is disabled', async () => {
    const repository = createRepository([
      {
        authUserId: 'user-1',
        guildId: 'guild-1',
        name: 'Guild One',
        icon: null,
      },
    ]);
    const service = new GuildDirectoryService({ repository });

    const result = await service.listDashboardGuilds({ authUserId: 'user-1' });

    expect(result).toEqual({
      guilds: [
        {
          authUserId: 'user-1',
          guildId: 'guild-1',
          name: 'Guild One',
          icon: null,
        },
      ],
      backfillFailures: 0,
    });
    expect(repository.persisted).toEqual([]);
  });

  it('backfills missing guild metadata and persists successful enrichments', async () => {
    const repository = createRepository([
      {
        authUserId: 'user-1',
        guildId: 'guild-1',
        name: 'Creator guild-1',
        icon: null,
      },
      {
        authUserId: 'user-1',
        guildId: 'guild-2',
        name: 'Already Named',
        icon: null,
      },
    ]);
    const metadataResolver: GuildMetadataResolverPort = {
      async getGuildMetadata(guildId) {
        if (guildId === 'guild-1') {
          return {
            discordGuildName: 'Real Guild',
            discordGuildIcon: 'icon-hash',
          };
        }
        return null;
      },
    };
    const service = new GuildDirectoryService({
      repository,
      metadataResolver,
    });

    const result = await service.listDashboardGuilds({ authUserId: 'user-1' });

    expect(result.guilds).toEqual([
      {
        authUserId: 'user-1',
        guildId: 'guild-1',
        name: 'Real Guild',
        icon: 'icon-hash',
      },
      {
        authUserId: 'user-1',
        guildId: 'guild-2',
        name: 'Already Named',
        icon: null,
      },
    ]);
    expect(result.backfillFailures).toBe(0);
    expect(repository.persisted).toEqual([
      {
        guildId: 'guild-1',
        discordGuildName: 'Real Guild',
        discordGuildIcon: 'icon-hash',
      },
    ]);
  });

  it('tracks metadata backfill failures without aborting the whole guild list', async () => {
    const repository = createRepository([
      {
        authUserId: 'user-1',
        guildId: 'guild-1',
        name: 'Creator guild-1',
        icon: null,
      },
      {
        authUserId: 'user-1',
        guildId: 'guild-2',
        name: 'Creator guild-2',
        icon: null,
      },
    ]);
    const metadataResolver: GuildMetadataResolverPort = {
      async getGuildMetadata(guildId) {
        if (guildId === 'guild-1') {
          return {
            discordGuildName: 'Recovered Guild',
          };
        }

        throw new Error('Discord temporarily unavailable');
      },
    };
    const service = new GuildDirectoryService({
      repository,
      metadataResolver,
    });

    const result = await service.listDashboardGuilds({ authUserId: 'user-1' });

    expect(result.guilds).toEqual([
      {
        authUserId: 'user-1',
        guildId: 'guild-1',
        name: 'Recovered Guild',
        icon: null,
      },
      {
        authUserId: 'user-1',
        guildId: 'guild-2',
        name: 'Creator guild-2',
        icon: null,
      },
    ]);
    expect(result.backfillFailures).toBe(1);
    expect(repository.persisted).toEqual([
      {
        guildId: 'guild-1',
        discordGuildName: 'Recovered Guild',
      },
    ]);
  });
});
