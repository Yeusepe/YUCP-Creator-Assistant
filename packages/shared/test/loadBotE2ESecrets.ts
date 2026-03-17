/**
 * Load the secret contract for real Discord bot end-to-end tests.
 *
 * The bot E2E suite is intentionally strict:
 * - no mocks
 * - no fake Discord actors
 * - no synthetic provider data
 *
 * When any required key is missing, callers should fail fast and report the
 * exact missing variables.
 */

export interface BotE2ESecrets {
  discordBotToken: string;
  discordClientId: string;
  discordClientSecret: string;
  convexUrl: string;
  convexApiSecret: string;
  apiBaseUrl: string;
  apiInternalUrl: string;
  frontendUrl: string;
  betterAuthSecret: string;
  targetGuildId: string;
  sourceGuildId: string;
  authUserId: string;
  guildLinkId: string;
  adminUserId: string;
  memberUserId: string;
  adminStorageStateB64: string;
  memberStorageStateB64: string;
  gumroadProductUrl: string;
  gumroadTestPurchaser: string;
  jinxxyProductId: string;
  jinxxyLicenseKey: string;
  collabJinxxyApiKey: string;
}

type RawSecretMap = Record<string, string | undefined>;

const REQUIRED_KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'CONVEX_URL',
  'CONVEX_API_SECRET',
  'API_BASE_URL',
  'API_INTERNAL_URL',
  'FRONTEND_URL',
  'BETTER_AUTH_SECRET',
  'BOT_E2E_TARGET_GUILD_ID',
  'BOT_E2E_SOURCE_GUILD_ID',
  'BOT_E2E_AUTH_USER_ID',
  'BOT_E2E_GUILD_LINK_ID',
  'BOT_E2E_ADMIN_USER_ID',
  'BOT_E2E_MEMBER_USER_ID',
  'BOT_E2E_ADMIN_STORAGE_STATE_B64',
  'BOT_E2E_MEMBER_STORAGE_STATE_B64',
  'BOT_E2E_GUMROAD_PRODUCT_URL',
  'BOT_E2E_GUMROAD_TEST_PURCHASER',
  'BOT_E2E_JINXXY_PRODUCT_ID',
  'BOT_E2E_JINXXY_LICENSE_KEY',
  'BOT_E2E_COLLAB_JINXXY_API_KEY',
] as const;

function toRawMap(value: Record<string, string>): RawSecretMap {
  return {
    DISCORD_BOT_TOKEN: value.DISCORD_BOT_TOKEN,
    DISCORD_CLIENT_ID: value.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: value.DISCORD_CLIENT_SECRET,
    CONVEX_URL: value.CONVEX_URL ?? value.CONVEX_DEPLOYMENT_URL,
    CONVEX_API_SECRET: value.CONVEX_API_SECRET,
    API_BASE_URL: value.API_BASE_URL,
    API_INTERNAL_URL: value.API_INTERNAL_URL,
    FRONTEND_URL: value.FRONTEND_URL,
    BETTER_AUTH_SECRET: value.BETTER_AUTH_SECRET,
    BOT_E2E_TARGET_GUILD_ID: value.BOT_E2E_TARGET_GUILD_ID,
    BOT_E2E_SOURCE_GUILD_ID: value.BOT_E2E_SOURCE_GUILD_ID,
    BOT_E2E_AUTH_USER_ID: value.BOT_E2E_AUTH_USER_ID,
    BOT_E2E_GUILD_LINK_ID: value.BOT_E2E_GUILD_LINK_ID,
    BOT_E2E_ADMIN_USER_ID: value.BOT_E2E_ADMIN_USER_ID,
    BOT_E2E_MEMBER_USER_ID: value.BOT_E2E_MEMBER_USER_ID,
    BOT_E2E_ADMIN_STORAGE_STATE_B64: value.BOT_E2E_ADMIN_STORAGE_STATE_B64,
    BOT_E2E_MEMBER_STORAGE_STATE_B64: value.BOT_E2E_MEMBER_STORAGE_STATE_B64,
    BOT_E2E_GUMROAD_PRODUCT_URL: value.BOT_E2E_GUMROAD_PRODUCT_URL,
    BOT_E2E_GUMROAD_TEST_PURCHASER: value.BOT_E2E_GUMROAD_TEST_PURCHASER,
    BOT_E2E_JINXXY_PRODUCT_ID: value.BOT_E2E_JINXXY_PRODUCT_ID,
    BOT_E2E_JINXXY_LICENSE_KEY: value.BOT_E2E_JINXXY_LICENSE_KEY,
    BOT_E2E_COLLAB_JINXXY_API_KEY: value.BOT_E2E_COLLAB_JINXXY_API_KEY,
  };
}

function rawFromProcessEnv(): RawSecretMap {
  return toRawMap(process.env as Record<string, string>);
}

async function rawFromInfisical(): Promise<RawSecretMap | null> {
  const projectId = process.env.INFISICAL_PROJECT_ID;
  const machineId = process.env.INFISICAL_MACHINE_IDENTITY_ID;
  const machineSecret = process.env.INFISICAL_MACHINE_IDENTITY_SECRET;

  if (!projectId || !machineId || !machineSecret) {
    return null;
  }

  try {
    const { fetchInfisicalSecrets } = await import('../src/infisical/fetchSecrets');
    return toRawMap(await fetchInfisicalSecrets());
  } catch (error) {
    console.warn('[loadBotE2ESecrets] Infisical fetch failed, falling back to process.env:', error);
    return null;
  }
}

export function getMissingBotE2ESecretKeys(raw: RawSecretMap): string[] {
  return REQUIRED_KEYS.filter((key) => !raw[key]);
}

function requireRawSecret(raw: RawSecretMap, key: (typeof REQUIRED_KEYS)[number]): string {
  const value = raw[key];
  if (!value) {
    throw new Error(`Missing required bot E2E secret: ${key}`);
  }
  return value;
}

function normalizeBotE2ESecrets(raw: RawSecretMap): BotE2ESecrets {
  return {
    discordBotToken: requireRawSecret(raw, 'DISCORD_BOT_TOKEN'),
    discordClientId: requireRawSecret(raw, 'DISCORD_CLIENT_ID'),
    discordClientSecret: requireRawSecret(raw, 'DISCORD_CLIENT_SECRET'),
    convexUrl: requireRawSecret(raw, 'CONVEX_URL'),
    convexApiSecret: requireRawSecret(raw, 'CONVEX_API_SECRET'),
    apiBaseUrl: requireRawSecret(raw, 'API_BASE_URL'),
    apiInternalUrl: requireRawSecret(raw, 'API_INTERNAL_URL'),
    frontendUrl: requireRawSecret(raw, 'FRONTEND_URL'),
    betterAuthSecret: requireRawSecret(raw, 'BETTER_AUTH_SECRET'),
    targetGuildId: requireRawSecret(raw, 'BOT_E2E_TARGET_GUILD_ID'),
    sourceGuildId: requireRawSecret(raw, 'BOT_E2E_SOURCE_GUILD_ID'),
    authUserId: requireRawSecret(raw, 'BOT_E2E_AUTH_USER_ID'),
    guildLinkId: requireRawSecret(raw, 'BOT_E2E_GUILD_LINK_ID'),
    adminUserId: requireRawSecret(raw, 'BOT_E2E_ADMIN_USER_ID'),
    memberUserId: requireRawSecret(raw, 'BOT_E2E_MEMBER_USER_ID'),
    adminStorageStateB64: requireRawSecret(raw, 'BOT_E2E_ADMIN_STORAGE_STATE_B64'),
    memberStorageStateB64: requireRawSecret(raw, 'BOT_E2E_MEMBER_STORAGE_STATE_B64'),
    gumroadProductUrl: requireRawSecret(raw, 'BOT_E2E_GUMROAD_PRODUCT_URL'),
    gumroadTestPurchaser: requireRawSecret(raw, 'BOT_E2E_GUMROAD_TEST_PURCHASER'),
    jinxxyProductId: requireRawSecret(raw, 'BOT_E2E_JINXXY_PRODUCT_ID'),
    jinxxyLicenseKey: requireRawSecret(raw, 'BOT_E2E_JINXXY_LICENSE_KEY'),
    collabJinxxyApiKey: requireRawSecret(raw, 'BOT_E2E_COLLAB_JINXXY_API_KEY'),
  };
}

export async function loadBotE2ESecrets(): Promise<{
  raw: RawSecretMap;
  missing: string[];
}> {
  const infisicalRaw = await rawFromInfisical();
  const raw = {
    ...infisicalRaw,
    ...rawFromProcessEnv(),
  };

  return {
    raw,
    missing: getMissingBotE2ESecretKeys(raw),
  };
}

export async function requireBotE2ESecrets(): Promise<BotE2ESecrets> {
  const loaded = await loadBotE2ESecrets();
  if (loaded.missing.length > 0) {
    throw new Error(`Missing required bot E2E secrets: ${loaded.missing.join(', ')}`);
  }
  return normalizeBotE2ESecrets(loaded.raw);
}
