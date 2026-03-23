// Environment loader with Infisical integration
// Fetches secrets from Infisical when INFISICAL_PROJECT_ID + machine identity are set

import type { EnvConfig } from '@yucp/shared';
import { createLogger, resolveConvexSiteUrl as resolveSharedConvexSiteUrl } from '@yucp/shared';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

export interface LocalEnv {
  NODE_ENV: 'development' | 'production' | 'test';
  INFISICAL_URL?: string;
  INFISICAL_TOKEN?: string;
  // Convex (auth runs on Convex)
  CONVEX_DEPLOYMENT?: string;
  CONVEX_URL?: string;
  CONVEX_SITE_URL?: string;
  CONVEX_API_SECRET?: string;
  // Auth
  SITE_URL?: string;
  BETTER_AUTH_SECRET?: string;
  ENCRYPTION_SECRET?: string;
  ERROR_REFERENCE_SECRET?: string;
  /** Legacy alias for CONVEX_SITE_URL. Avoid using for new config. */
  BETTER_AUTH_URL?: string;
  /** Legacy alias for SITE_URL. Avoid using for new config. */
  FRONTEND_URL?: string;
  PUBLIC_API_KEY_PEPPER?: string;
  PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON?: string;
  INTERNAL_SERVICE_AUTH_SECRET?: string;
  INTERNAL_RPC_SHARED_SECRET?: string;
  INTERNAL_SERVICE_TOKEN?: string;
  VRCHAT_PENDING_STATE_SECRET?: string;
  VRCHAT_PROVIDER_SESSION_SECRET?: string;
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
  // Email (Resend)
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  // Polar certificate billing
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  POLAR_CERT_PRODUCTS_JSON?: string;
  POLAR_SERVER?: string;
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
function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/$/, '');
}

export function resolveConvexSiteUrl(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return resolveSharedConvexSiteUrl(env);
}

export function resolveSiteUrl(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return normalizeUrl(
    env.SITE_URL ?? env.FRONTEND_URL ?? env.RENDER_EXTERNAL_URL ?? env.BETTER_AUTH_URL
  );
}

function loadFromEnv(): LocalEnv {
  const convexSiteUrl = resolveConvexSiteUrl();
  const siteUrl = resolveSiteUrl();

  return {
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
    INFISICAL_URL: process.env.INFISICAL_URL,
    INFISICAL_TOKEN: process.env.INFISICAL_TOKEN,
    CONVEX_DEPLOYMENT: process.env.CONVEX_DEPLOYMENT,
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_SITE_URL: convexSiteUrl,
    CONVEX_API_SECRET: process.env.CONVEX_API_SECRET,
    SITE_URL: siteUrl,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    ENCRYPTION_SECRET: process.env.ENCRYPTION_SECRET,
    ERROR_REFERENCE_SECRET: process.env.ERROR_REFERENCE_SECRET,
    BETTER_AUTH_URL: normalizeUrl(process.env.BETTER_AUTH_URL),
    FRONTEND_URL: process.env.FRONTEND_URL,
    PUBLIC_API_KEY_PEPPER: process.env.PUBLIC_API_KEY_PEPPER,
    PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON: process.env.PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON,
    INTERNAL_SERVICE_AUTH_SECRET: process.env.INTERNAL_SERVICE_AUTH_SECRET,
    INTERNAL_RPC_SHARED_SECRET: process.env.INTERNAL_RPC_SHARED_SECRET,
    INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN,
    VRCHAT_PENDING_STATE_SECRET: process.env.VRCHAT_PENDING_STATE_SECRET,
    VRCHAT_PROVIDER_SESSION_SECRET: process.env.VRCHAT_PROVIDER_SESSION_SECRET,
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
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    POLAR_ACCESS_TOKEN: process.env.POLAR_ACCESS_TOKEN,
    POLAR_WEBHOOK_SECRET: process.env.POLAR_WEBHOOK_SECRET,
    POLAR_CERT_PRODUCTS_JSON: process.env.POLAR_CERT_PRODUCTS_JSON,
    POLAR_SERVER: process.env.POLAR_SERVER,
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
