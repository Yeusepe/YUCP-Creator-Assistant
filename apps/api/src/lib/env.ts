// Environment loader with Infisical integration
// Fetches secrets from Infisical when INFISICAL_PROJECT_ID + machine identity are set

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnvConfig } from '@yucp/shared';
import { resolveConvexSiteUrl as resolveSharedConvexSiteUrl } from '@yucp/shared';
import { parse as parseDotenv } from 'dotenv';
import { logger } from './logger';

export interface LocalEnv {
  NODE_ENV: 'development' | 'production' | 'test';
  /** Canonical public API origin used for request-bound authorization such as DPoP htu. */
  API_BASE_URL?: string;
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
  PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON?: string;
  INTERNAL_SERVICE_AUTH_SECRET?: string;
  INTERNAL_RPC_SHARED_SECRET?: string;
  INTERNAL_SERVICE_TOKEN?: string;
  /** Optional creator-upload signing key. The upload route returns 503 when unavailable. */
  UPLOAD_HMAC_KEY?: string;
  /** Optional tus ingest origin. The upload route returns 503 when unavailable. */
  INGEST_TUS_URL?: string;
  /** Internal catalog control origin owned by the ingest service. */
  PACKAGE_CATALOG_CONTROL_INTERNAL_BASE_URL?: string;
  /** Purpose-separated credential for package catalog control commands. */
  PACKAGE_CATALOG_CONTROL_SHARED_SECRET?: string;
  /** Internal package catalog control timeout in milliseconds. */
  PACKAGE_CATALOG_CONTROL_TIMEOUT_MS?: string;
  /** Delivery Worker origin bound into v2 package grants. */
  PACKAGE_DELIVERY_AUDIENCE?: string;
  /** Base64url 32-byte secret used only to authenticate resource-server DPoP nonces. */
  PACKAGE_INSTALL_DPOP_NONCE_SECRET?: string;
  /** Canonical public API origin bound into v2 package grants. */
  PACKAGE_INSTALL_ISSUER?: string;
  /** Purpose-separated Ed25519 key identifier for package install contracts. */
  PACKAGE_INSTALL_SIGNING_KEY_ID?: string;
  /** Base64url Ed25519 seed for package install contract signing. */
  PACKAGE_INSTALL_SIGNING_PRIVATE_KEY?: string;
  /** PostgreSQL workflow store for one-time package operation authorizations and DPoP replay state. */
  PACKAGE_OPERATION_AUTHORIZATION_DATABASE_URL?: string;
  /** PostgreSQL workflow store for immutable public VPM alias artifacts. */
  VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL?: string;
  /** Internal materialization control-plane origin. */
  MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL?: string;
  /** API-only credential for durable materialization job control. */
  MATERIALIZATION_API_SHARED_SECRET?: string;
  /** Internal materialization request timeout in milliseconds. */
  MATERIALIZATION_CONTROL_PLANE_TIMEOUT_MS?: string;
  /** Absolute root containing signed TUF metadata and targets directories. */
  PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT?: string;
  /** Read-only PostgreSQL catalog connection for published TUF exact versions. */
  PACKAGE_INSTALLER_TUF_CATALOG_DATABASE_URL?: string;
  /** Stable TUF repository identifier. */
  PACKAGE_INSTALLER_TUF_REPOSITORY_ID?: string;
  /** Read-only metadata storage credential for the TUF repository. */
  PACKAGE_INSTALLER_TUF_S3_ACCESS_KEY_ID?: string;
  PACKAGE_INSTALLER_TUF_S3_BUCKET?: string;
  PACKAGE_INSTALLER_TUF_S3_ENDPOINT?: string;
  PACKAGE_INSTALLER_TUF_S3_REGION?: string;
  PACKAGE_INSTALLER_TUF_S3_REQUEST_TIMEOUT_MS?: string;
  PACKAGE_INSTALLER_TUF_S3_SECRET_ACCESS_KEY?: string;
  /** Read-only metadata storage used to serve exact bootstrap media versions. */
  METADATA_S3_ACCESS_KEY_ID?: string;
  METADATA_S3_BUCKET?: string;
  METADATA_S3_ENDPOINT?: string;
  METADATA_S3_REGION?: string;
  METADATA_S3_REQUEST_TIMEOUT_MS?: string;
  METADATA_S3_SECRET_ACCESS_KEY?: string;
  METADATA_INDEX_PREFIX?: string;
  /** Optional public API origin used for buyer VPM index URLs. VPM routes return 503 when unavailable. */
  VPM_BASE_URL?: string;
  /** Account that owns the Worker receiving creator private VPM Custom Domains. */
  PRIVATE_VPM_CLOUDFLARE_ACCOUNT_ID?: string;
  /** Purpose-scoped token with Workers Scripts read/write for Custom Domain reconciliation. */
  PRIVATE_VPM_CLOUDFLARE_API_TOKEN?: string;
  /** Worker service that receives exact creator private VPM hostnames. */
  PRIVATE_VPM_CLOUDFLARE_SERVICE?: string;
  /** yucp.club zone identifier used for exact creator Custom Domains. */
  PRIVATE_VPM_CLOUDFLARE_ZONE_ID?: string;
  PRIVATE_VPM_CLOUDFLARE_ZONE_NAME?: string;
  /** Parent DNS name used to derive creatorname.private.yucp.club. */
  PRIVATE_VPM_ROOT_DOMAIN?: string;
  /** Exact release ledger for a generated local importer package. Production uses the committed ledger. */
  VPM_IMPORTER_RELEASE_LEDGER_JSON?: string;
  /** Public first-party VPM index that supplies the generic importer package. */
  VPM_PUBLIC_INDEX_URL?: string;
  /** JSON array of public VPM repository URLs that package releases can reference. */
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
  ITCHIO_CLIENT_ID?: string;
  PATREON_CLIENT_ID?: string;
  PATREON_CLIENT_SECRET?: string;
  // Legacy aliases (kept for backward compat)
  GUMROAD_API_KEY?: string;
  GUMROAD_SECRET_KEY?: string;
  JINXXY_API_BASE_URL?: string;
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
  POLAR_SERVER?: string;
  YUCP_COUPLING_SERVICE_BASE_URL?: string;
  YUCP_COUPLING_SERVICE_SHARED_SECRET?: string;
  HYPERDX_API_KEY?: string;
  HYPERDX_APP_URL?: string;
  HYPERDX_OTLP_HTTP_URL?: string;
  HYPERDX_OTLP_GRPC_URL?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_EXPORTER_OTLP_PROTOCOL?: string;
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

async function loadLocalInfisicalEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): Promise<{ count: number; loadedKeys: Set<string> }> {
  const envFilePath = path.join(cwd, '.env.infisical');
  if (!existsSync(envFilePath)) {
    return { count: 0, loadedKeys: new Set() };
  }

  const envFile = await readFile(envFilePath, 'utf8');
  const parsed = parseDotenv(envFile);
  let loaded = 0;
  const loadedKeys = new Set<string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && isEnvValueMissing(env[key])) {
      env[key] = value;
      loaded += 1;
      loadedKeys.add(key);
    }
  }
  return { count: loaded, loadedKeys };
}

// Load from process.env
function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/$/, '');
}

function isEnvValueMissing(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
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
    API_BASE_URL: normalizeUrl(process.env.API_BASE_URL),
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
    PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON: process.env.PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON,
    INTERNAL_SERVICE_AUTH_SECRET: process.env.INTERNAL_SERVICE_AUTH_SECRET,
    INTERNAL_RPC_SHARED_SECRET: process.env.INTERNAL_RPC_SHARED_SECRET,
    INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN,
    UPLOAD_HMAC_KEY: process.env.UPLOAD_HMAC_KEY,
    INGEST_TUS_URL: process.env.INGEST_TUS_URL,
    PACKAGE_CATALOG_CONTROL_INTERNAL_BASE_URL:
      process.env.PACKAGE_CATALOG_CONTROL_INTERNAL_BASE_URL,
    PACKAGE_CATALOG_CONTROL_SHARED_SECRET: process.env.PACKAGE_CATALOG_CONTROL_SHARED_SECRET,
    PACKAGE_CATALOG_CONTROL_TIMEOUT_MS: process.env.PACKAGE_CATALOG_CONTROL_TIMEOUT_MS,
    PACKAGE_DELIVERY_AUDIENCE: process.env.PACKAGE_DELIVERY_AUDIENCE,
    PACKAGE_INSTALL_DPOP_NONCE_SECRET: process.env.PACKAGE_INSTALL_DPOP_NONCE_SECRET,
    PACKAGE_INSTALL_ISSUER: process.env.PACKAGE_INSTALL_ISSUER,
    PACKAGE_INSTALL_SIGNING_KEY_ID: process.env.PACKAGE_INSTALL_SIGNING_KEY_ID,
    PACKAGE_INSTALL_SIGNING_PRIVATE_KEY: process.env.PACKAGE_INSTALL_SIGNING_PRIVATE_KEY,
    PACKAGE_OPERATION_AUTHORIZATION_DATABASE_URL:
      process.env.PACKAGE_OPERATION_AUTHORIZATION_DATABASE_URL,
    VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL:
      process.env.VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL,
    MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL:
      process.env.MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL,
    MATERIALIZATION_API_SHARED_SECRET: process.env.MATERIALIZATION_API_SHARED_SECRET,
    MATERIALIZATION_CONTROL_PLANE_TIMEOUT_MS: process.env.MATERIALIZATION_CONTROL_PLANE_TIMEOUT_MS,
    PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT: process.env.PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT,
    PACKAGE_INSTALLER_TUF_CATALOG_DATABASE_URL:
      process.env.PACKAGE_INSTALLER_TUF_CATALOG_DATABASE_URL,
    PACKAGE_INSTALLER_TUF_REPOSITORY_ID: process.env.PACKAGE_INSTALLER_TUF_REPOSITORY_ID,
    PACKAGE_INSTALLER_TUF_S3_ACCESS_KEY_ID: process.env.PACKAGE_INSTALLER_TUF_S3_ACCESS_KEY_ID,
    PACKAGE_INSTALLER_TUF_S3_BUCKET: process.env.PACKAGE_INSTALLER_TUF_S3_BUCKET,
    PACKAGE_INSTALLER_TUF_S3_ENDPOINT: process.env.PACKAGE_INSTALLER_TUF_S3_ENDPOINT,
    PACKAGE_INSTALLER_TUF_S3_REGION: process.env.PACKAGE_INSTALLER_TUF_S3_REGION,
    PACKAGE_INSTALLER_TUF_S3_REQUEST_TIMEOUT_MS:
      process.env.PACKAGE_INSTALLER_TUF_S3_REQUEST_TIMEOUT_MS,
    PACKAGE_INSTALLER_TUF_S3_SECRET_ACCESS_KEY:
      process.env.PACKAGE_INSTALLER_TUF_S3_SECRET_ACCESS_KEY,
    METADATA_S3_ACCESS_KEY_ID: process.env.METADATA_S3_ACCESS_KEY_ID,
    METADATA_S3_BUCKET: process.env.METADATA_S3_BUCKET,
    METADATA_S3_ENDPOINT: process.env.METADATA_S3_ENDPOINT,
    METADATA_S3_REGION: process.env.METADATA_S3_REGION,
    METADATA_S3_REQUEST_TIMEOUT_MS: process.env.METADATA_S3_REQUEST_TIMEOUT_MS,
    METADATA_S3_SECRET_ACCESS_KEY: process.env.METADATA_S3_SECRET_ACCESS_KEY,
    METADATA_INDEX_PREFIX: process.env.METADATA_INDEX_PREFIX,
    VPM_BASE_URL: process.env.VPM_BASE_URL,
    PRIVATE_VPM_CLOUDFLARE_ACCOUNT_ID: process.env.PRIVATE_VPM_CLOUDFLARE_ACCOUNT_ID,
    PRIVATE_VPM_CLOUDFLARE_API_TOKEN: process.env.PRIVATE_VPM_CLOUDFLARE_API_TOKEN,
    PRIVATE_VPM_CLOUDFLARE_SERVICE: process.env.PRIVATE_VPM_CLOUDFLARE_SERVICE,
    PRIVATE_VPM_CLOUDFLARE_ZONE_ID: process.env.PRIVATE_VPM_CLOUDFLARE_ZONE_ID,
    PRIVATE_VPM_CLOUDFLARE_ZONE_NAME: process.env.PRIVATE_VPM_CLOUDFLARE_ZONE_NAME,
    PRIVATE_VPM_ROOT_DOMAIN: process.env.PRIVATE_VPM_ROOT_DOMAIN,
    VPM_IMPORTER_RELEASE_LEDGER_JSON: process.env.VPM_IMPORTER_RELEASE_LEDGER_JSON,
    VPM_PUBLIC_INDEX_URL: process.env.VPM_PUBLIC_INDEX_URL,
    VRCHAT_PENDING_STATE_SECRET: process.env.VRCHAT_PENDING_STATE_SECRET,
    VRCHAT_PROVIDER_SESSION_SECRET: process.env.VRCHAT_PROVIDER_SESSION_SECRET,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    GUMROAD_ACCESS_TOKEN: process.env.GUMROAD_ACCESS_TOKEN,
    GUMROAD_CLIENT_ID: process.env.GUMROAD_CLIENT_ID,
    GUMROAD_CLIENT_SECRET: process.env.GUMROAD_CLIENT_SECRET,
    ITCHIO_CLIENT_ID: process.env.ITCHIO_CLIENT_ID,
    PATREON_CLIENT_ID: process.env.PATREON_CLIENT_ID,
    PATREON_CLIENT_SECRET: process.env.PATREON_CLIENT_SECRET,
    GUMROAD_API_KEY: process.env.GUMROAD_API_KEY,
    GUMROAD_SECRET_KEY: process.env.GUMROAD_SECRET_KEY,
    JINXXY_API_BASE_URL: process.env.JINXXY_API_BASE_URL,
    JINXXY_API_KEY: process.env.JINXXY_API_KEY,
    JINXXY_SECRET_KEY: process.env.JINXXY_SECRET_KEY,
    LOG_LEVEL: process.env.LOG_LEVEL,
    DRAGONFLY_URI: process.env.DRAGONFLY_URI,
    REDIS_URL: process.env.REDIS_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    POLAR_ACCESS_TOKEN: process.env.POLAR_ACCESS_TOKEN,
    POLAR_WEBHOOK_SECRET: process.env.POLAR_WEBHOOK_SECRET,
    POLAR_SERVER: process.env.POLAR_SERVER,
    YUCP_COUPLING_SERVICE_BASE_URL: process.env.YUCP_COUPLING_SERVICE_BASE_URL,
    YUCP_COUPLING_SERVICE_SHARED_SECRET: process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET,
    HYPERDX_API_KEY: process.env.HYPERDX_API_KEY,
    HYPERDX_APP_URL: process.env.HYPERDX_APP_URL,
    HYPERDX_OTLP_HTTP_URL: process.env.HYPERDX_OTLP_HTTP_URL,
    HYPERDX_OTLP_GRPC_URL: process.env.HYPERDX_OTLP_GRPC_URL,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
    OTEL_EXPORTER_OTLP_PROTOCOL: process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
  };
}

let infisicalLoaded = false;

/**
 * Load env, optionally fetching from Infisical first when configured.
 * Call this at startup before any code that needs secrets.
 */
export async function loadEnvAsync(): Promise<LocalEnv> {
  const localInfisical = await loadLocalInfisicalEnvFile();
  if (localInfisical.count > 0) {
    logger.info('Loaded fallback secrets from local .env.infisical', {
      count: localInfisical.count,
    });
  }

  const infisicalSecrets = await fetchFromInfisical();
  const infisicalSecretCount = Object.keys(infisicalSecrets).length;
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (infisicalSecretCount === 0) {
    const message =
      'Infisical secrets did not load; environment is using process.env and local fallback files only.';
    if (nodeEnv === 'production') {
      throw new Error(`${message} Refusing production startup.`);
    }
    logger.warn(message, {
      infisicalEnv: process.env.INFISICAL_ENV ?? 'dev (default)',
    });
  }
  if (infisicalSecretCount > 0 && !infisicalLoaded) {
    infisicalLoaded = true;
    for (const [key, value] of Object.entries(infisicalSecrets)) {
      if (
        value !== undefined &&
        (isEnvValueMissing(process.env[key]) || localInfisical.loadedKeys.has(key))
      ) {
        process.env[key] = value;
      }
    }
    // Map CONVEX_DEPLOYMENT_URL -> CONVEX_URL for API compatibility
    if (process.env.CONVEX_DEPLOYMENT_URL && !process.env.CONVEX_URL) {
      process.env.CONVEX_URL = process.env.CONVEX_DEPLOYMENT_URL;
    }
    logger.info('Loaded secrets from Infisical', {
      count: infisicalSecretCount,
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
