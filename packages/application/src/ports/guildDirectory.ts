export interface DashboardGuildRecord {
  authUserId: string;
  guildId: string;
  name: string;
  icon: string | null;
}

export interface GuildMetadataRecord {
  discordGuildName?: string;
  discordGuildIcon?: string;
}

export interface GuildDirectoryRepositoryPort {
  listUserGuilds(authUserId: string): Promise<DashboardGuildRecord[]>;
  persistGuildMetadata(input: {
    guildId: string;
    discordGuildName: string;
    discordGuildIcon?: string;
  }): Promise<void>;
}

export interface GuildMetadataResolverPort {
  getGuildMetadata(guildId: string): Promise<GuildMetadataRecord | null>;
}
