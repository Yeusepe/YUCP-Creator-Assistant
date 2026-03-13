/**
 * Discord OAuth provider configuration for Better Auth
 * Handles creator sign-in via Discord
 */

export interface DiscordProviderConfig {
  clientId: string;
  clientSecret: string;
  enabled: boolean;
}

/**
 * Creates Discord OAuth provider configuration for Better Auth
 */
export function createDiscordProvider(config: DiscordProviderConfig):
  | {
      discord: { clientId: string; clientSecret: string };
    }
  | Record<string, never> {
  if (!config.enabled || !config.clientId || !config.clientSecret) {
    return {};
  }

  return {
    discord: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
  };
}

/**
 * Validates Discord OAuth configuration
 */
export function validateDiscordConfig(env: {
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
}): DiscordProviderConfig {
  return {
    clientId: env.DISCORD_CLIENT_ID ?? '',
    clientSecret: env.DISCORD_CLIENT_SECRET ?? '',
    enabled: !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
  };
}
