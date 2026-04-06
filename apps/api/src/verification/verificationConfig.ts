/**
 * Stable configuration contracts for verification flows.
 *
 * Keep mode mapping and runtime config here so other modules do not need to
 * depend on sessionManager.ts just to answer simple configuration questions.
 */

export interface VerificationConfig {
  /** Base URL for the API */
  baseUrl: string;
  /** Frontend URL for redirects */
  frontendUrl: string;
  /** Convex URL for backend calls */
  convexUrl: string;
  /** Convex API secret for authenticated mutations */
  convexApiSecret: string;
  /** Gumroad client ID */
  gumroadClientId?: string;
  /** Gumroad client secret */
  gumroadClientSecret?: string;
  /** Discord client ID */
  discordClientId?: string;
  /** Discord client secret */
  discordClientSecret?: string;
  /** Jinxxy client ID */
  jinxxyClientId?: string;
  /** Jinxxy client secret */
  jinxxyClientSecret?: string;
  /** Secret for decrypting tenant-stored keys (e.g. Jinxxy API key) */
  encryptionSecret?: string;
  /**
   * Generic OAuth client IDs for additional providers.
   * Keys are verification modes (e.g. 'myprovider'); values are client IDs.
   * Add new OAuth providers here without changing the interface.
   */
  providerClientIds?: Record<string, string>;
  /**
   * Generic OAuth client secrets for additional providers.
   * Keys are verification modes; values are client secrets.
   * Add new OAuth providers here without changing the interface.
   */
  providerClientSecrets?: Record<string, string>;
  /**
   * Extra OAuth query params per mode (e.g. { discord_role: { prompt: 'consent' } }).
   */
  providerExtraOAuthParams?: Record<string, Record<string, string>>;
}

/**
 * Verification mode configuration.
 */
export interface VerificationModeConfig {
  /** OAuth authorization URL */
  authUrl: string;
  /** OAuth token URL */
  tokenUrl: string;
  /** Required OAuth scopes */
  scopes: string[];
  /** Callback path */
  callbackPath: string;
  /**
   * Key in VerificationConfig for the OAuth client ID.
   * If omitted, falls back to providerClientIds[mode].
   */
  clientIdKey?: keyof VerificationConfig;
  /**
   * Key in VerificationConfig for the OAuth client secret.
   * If omitted, falls back to providerClientSecrets[mode].
   */
  clientSecretKey?: keyof VerificationConfig;
  /**
   * Extra OAuth query params appended to the authorization URL for this mode.
   * Merged with (and overridden by) providerExtraOAuthParams[mode] from VerificationConfig.
   */
  extraOAuthParams?: Record<string, string>;
}

export const GUMROAD_CONFIG: VerificationModeConfig = {
  authUrl: 'https://gumroad.com/oauth/authorize',
  tokenUrl: 'https://api.gumroad.com/oauth/token',
  scopes: ['view_profile', 'view_sales'],
  callbackPath: '/api/verification/callback/gumroad',
  clientIdKey: 'gumroadClientId',
  clientSecretKey: 'gumroadClientSecret',
};

export const DISCORD_ROLE_CONFIG: VerificationModeConfig = {
  authUrl: 'https://discord.com/api/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  scopes: ['identify', 'guilds', 'guilds.members.read'],
  callbackPath: '/api/verification/callback/discord',
  clientIdKey: 'discordClientId',
  clientSecretKey: 'discordClientSecret',
  extraOAuthParams: { prompt: 'consent' },
};

const VERIFICATION_CONFIGS: Record<string, VerificationModeConfig> = {
  gumroad: GUMROAD_CONFIG,
  discord: DISCORD_ROLE_CONFIG,
  discord_role: DISCORD_ROLE_CONFIG,
};

export function getVerificationConfig(mode: string): VerificationModeConfig | null {
  return VERIFICATION_CONFIGS[mode] ?? null;
}

const MODE_TO_PROVIDER_MAP: Record<string, string> = {
  gumroad: 'gumroad',
  discord: 'discord',
  discord_role: 'discord',
};

export function modeToProvider(mode: string): string | null {
  return MODE_TO_PROVIDER_MAP[mode] ?? null;
}
