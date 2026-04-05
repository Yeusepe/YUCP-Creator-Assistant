import type {
  DashboardGuildRecord,
  GuildDirectoryRepositoryPort,
  GuildMetadataResolverPort,
} from '../ports/guildDirectory';

export interface ListDashboardGuildsInput {
  readonly authUserId: string;
}

export interface ListDashboardGuildsResult {
  readonly guilds: DashboardGuildRecord[];
  readonly backfillFailures: number;
}

export interface GuildDirectoryServiceOptions {
  readonly repository: GuildDirectoryRepositoryPort;
  readonly metadataResolver?: GuildMetadataResolverPort;
}

function needsMetadataBackfill(guild: DashboardGuildRecord): boolean {
  return !guild.name || guild.name.startsWith('Creator ');
}

export class GuildDirectoryService {
  constructor(private readonly options: GuildDirectoryServiceOptions) {}

  async listDashboardGuilds(input: ListDashboardGuildsInput): Promise<ListDashboardGuildsResult> {
    const guilds = await this.options.repository.listUserGuilds(input.authUserId);
    const metadataResolver = this.options.metadataResolver;
    if (!metadataResolver) {
      return {
        guilds,
        backfillFailures: 0,
      };
    }

    const missingGuilds = guilds.filter(needsMetadataBackfill);
    if (missingGuilds.length === 0) {
      return {
        guilds,
        backfillFailures: 0,
      };
    }

    const results = await Promise.allSettled(
      missingGuilds.map(async (guild) => {
        const metadata = await metadataResolver.getGuildMetadata(guild.guildId);
        if (!metadata?.discordGuildName) {
          return;
        }

        guild.name = metadata.discordGuildName;
        guild.icon = metadata.discordGuildIcon ?? guild.icon;

        await this.options.repository.persistGuildMetadata({
          guildId: guild.guildId,
          discordGuildName: metadata.discordGuildName,
          ...(metadata.discordGuildIcon ? { discordGuildIcon: metadata.discordGuildIcon } : {}),
        });
      })
    );

    return {
      guilds,
      backfillFailures: results.filter((result) => result.status === 'rejected').length,
    };
  }
}
