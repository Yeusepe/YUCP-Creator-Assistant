// Environment loader with Infisical integration
// Fetches secrets from Infisical when INFISICAL_PROJECT_ID + machine identity are set

import { createLogger } from '@yucp/shared';
import type { EnvConfig } from '@yucp/shared';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export interface LocalEnv {
  NODE_ENV: 'development' | 'production' | 'test';
  INFISICAL_URL?: string;
  INFISICAL_TOKEN?: string;
  // Convex (auth runs on Convex)
  CONVEX_DEPLOYMENT?: string;
  CONVEX_URL?: string;
  CONVEX_API_SECRET?: string;
  // Auth
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  FRONTEND_URL?: string;
  // Discord
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  // Gumroad
  GUMROAD_ACCESS_TOKEN?: string;
  GUMROAD_CLIENT_ID?: string;
  GUMROAD_CLIENT_SECRET?: string;
  // Legacy aliases (kept for backward compat)
  GUMROAD_API_KEY?: string;
  GUMROAD_SECRET_KEY?: string;
  JINXXY_API_KEY?: string;
  JINXXY_SECRET_KEY?: string;
  // Logging
  LOG_LEVEL?: string;
  // State store (OAuth/install flows)
  DRAGONFLY_URI?: string;
  REDIS_URL?: string;
}

async function fetchFromInfisical(): Promise<Record<string, string>> {
  try {
    const { fetchInfisicalSecrets } = await import('@yucp/shared/infisical/fetchSecrets');
    return await fetchInfisicalSecrets();
  } catch (err) {
    const errObj = err as { message?: string; statusCode?: number; name?: string };
    const msg = errObj.message ?? String(err);
    const is401 = msg.includes('StatusCode=401') || msg.includes('Invalid credentials');
    logger.warn('Infisical fetch failed, using process.env only', {
      message: msg,
      hint: is401
        ? 'Credentials may be expired. Create a new client secret in Infisical: Project Settings → Machine Identities → your identity → Create Client Secret'
        : undefined,
    });
    return {};
  }
}

// Load from process.env
function loadFromEnv(): LocalEnv {
  return {
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
    INFISICAL_URL: process.env.INFISICAL_URL,
    INFISICAL_TOKEN: process.env.INFISICAL_TOKEN,
    CONVEX_DEPLOYMENT: process.env.CONVEX_DEPLOYMENT,
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_API_SECRET: process.env.CONVEX_API_SECRET,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL:
      process.env.BETTER_AUTH_URL ??
      process.env.RENDER_EXTERNAL_URL,
    FRONTEND_URL: process.env.FRONTEND_URL,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    GUMROAD_ACCESS_TOKEN: process.env.GUMROAD_ACCESS_TOKEN,
    GUMROAD_CLIENT_ID: process.env.GUMROAD_CLIENT_ID,
    GUMROAD_CLIENT_SECRET: process.env.GUMROAD_CLIENT_SECRET,
    GUMROAD_API_KEY: process.env.GUMROAD_API_KEY,
    GUMROAD_SECRET_KEY: process.env.GUMROAD_SECRET_KEY,
    JINXXY_API_KEY: process.env.JINXXY_API_KEY,
    JINXXY_SECRET_KEY: process.env.JINXXY_SECRET_KEY,
    LOG_LEVEL: process.env.LOG_LEVEL,
    DRAGONFLY_URI: process.env.DRAGONFLY_URI,
    REDIS_URL: process.env.REDIS_URL,
  };
}

let infisicalLoaded = false;

/**
 * Load env, optionally fetching from Infisical first when configured.
 * Call this at startup before any code that needs secrets.
 */
export async function loadEnvAsync(): Promise<LocalEnv> {
  const infisicalSecrets = await fetchFromInfisical();
  if (Object.keys(infisicalSecrets).length > 0 && !infisicalLoaded) {
    infisicalLoaded = true;
    for (const [key, value] of Object.entries(infisicalSecrets)) {
      if (value !== undefined && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    // Map CONVEX_DEPLOYMENT_URL -> CONVEX_URL for API compatibility
    if (process.env.CONVEX_DEPLOYMENT_URL && !process.env.CONVEX_URL) {
      process.env.CONVEX_URL = process.env.CONVEX_DEPLOYMENT_URL;
    }
    logger.info('Loaded secrets from Infisical', {
      count: Object.keys(infisicalSecrets).length,
      infisicalEnv: process.env.INFISICAL_ENV ?? 'dev (default)',
    });
  }
  return loadFromEnv();
}

export function loadEnv(): LocalEnv {
  return loadFromEnv();
}

export function getRequired(key: keyof LocalEnv): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

export function getOptional(key: keyof LocalEnv): string | undefined {
  return process.env[key];
}
