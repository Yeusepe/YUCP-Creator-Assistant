// Environment loader with Infisical integration for local development
// This module loads environment variables from .env files and optionally from Infisical

import { createLogger } from '@yucp/shared';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export interface LocalEnv {
  NODE_ENV: 'development' | 'production' | 'test';
  INFISICAL_URL?: string;
  INFISICAL_TOKEN?: string;
  /** Infisical environment (dev/production). Defaults to 'dev' when NODE_ENV is development. */
  INFISICAL_ENV?: string;
  // Discord
  DISCORD_BOT_TOKEN?: string;
  DISCORD_GUILD_ID?: string;
  // Convex (role sync)
  CONVEX_URL?: string;
  CONVEX_API_SECRET?: string;
  CONVEX_DEPLOYMENT?: string;
  // Logging
  LOG_LEVEL?: string;
  // PostHog analytics
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  API_BASE_URL?: string;
  API_INTERNAL_URL?: string;
  BETTER_AUTH_SECRET?: string;
  ERROR_REFERENCE_SECRET?: string;
}

// Load from process.env
function loadFromEnv(): LocalEnv {
  return {
    NODE_ENV: (process.env.NODE_ENV as LocalEnv['NODE_ENV']) || 'development',
    INFISICAL_URL: process.env.INFISICAL_URL,
    INFISICAL_TOKEN: process.env.INFISICAL_TOKEN,
    INFISICAL_ENV: process.env.INFISICAL_ENV,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
    CONVEX_URL: process.env.CONVEX_URL ?? process.env.CONVEX_DEPLOYMENT_URL,
    CONVEX_API_SECRET: process.env.CONVEX_API_SECRET,
    CONVEX_DEPLOYMENT: process.env.CONVEX_DEPLOYMENT,
    LOG_LEVEL: process.env.LOG_LEVEL,
    POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
    POSTHOG_HOST: process.env.POSTHOG_HOST,
    API_BASE_URL: process.env.API_BASE_URL,
    API_INTERNAL_URL: process.env.API_INTERNAL_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    ERROR_REFERENCE_SECRET: process.env.ERROR_REFERENCE_SECRET,
  };
}

/** Validate required bot env vars. Throws if any are missing. */
export function validateBotEnv(env: LocalEnv): void {
  const required = ['DISCORD_BOT_TOKEN', 'CONVEX_URL', 'CONVEX_API_SECRET'] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

let infisicalLoaded = false;

async function fetchFromInfisical(): Promise<Record<string, string>> {
  try {
    const { fetchInfisicalSecrets } = await import('@yucp/shared/infisical/fetchSecrets');
    return await fetchInfisicalSecrets();
  } catch (err) {
    logger.warn('Infisical fetch failed, using process.env only', { err });
    return {};
  }
}

/** Load env, optionally fetching from Infisical first when configured. */
export async function loadEnvAsync(): Promise<LocalEnv> {
  const infisicalSecrets = await fetchFromInfisical();
  if (Object.keys(infisicalSecrets).length > 0 && !infisicalLoaded) {
    infisicalLoaded = true;
    for (const [key, value] of Object.entries(infisicalSecrets)) {
      if (value !== undefined && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
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
