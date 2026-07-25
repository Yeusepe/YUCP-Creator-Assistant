import { createApiRequestHandler } from '../../src/index';

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'CONVEX_DEPLOYMENT',
  'CONVEX_URL',
  'CONVEX_SITE_URL',
  'CONVEX_API_SECRET',
  'SITE_URL',
  'FRONTEND_URL',
  'BETTER_AUTH_SECRET',
  'ENCRYPTION_SECRET',
  'ERROR_REFERENCE_SECRET',
  'BETTER_AUTH_URL',
  'PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON',
  'INTERNAL_SERVICE_AUTH_SECRET',
  'INTERNAL_RPC_SHARED_SECRET',
  'INTERNAL_SERVICE_TOKEN',
  'PACKAGE_DELIVERY_AUDIENCE',
  'PACKAGE_INSTALL_ISSUER',
  'PACKAGE_INSTALL_SIGNING_KEY_ID',
  'PACKAGE_INSTALL_SIGNING_PRIVATE_KEY',
  'VPM_BASE_URL',
  'VPM_PUBLIC_INDEX_URL',
  'VPM_TOKEN_KEY',
  'VRCHAT_PENDING_STATE_SECRET',
  'VRCHAT_PROVIDER_SESSION_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'GUMROAD_ACCESS_TOKEN',
  'GUMROAD_CLIENT_ID',
  'GUMROAD_CLIENT_SECRET',
  'GUMROAD_API_KEY',
  'GUMROAD_SECRET_KEY',
  'JINXXY_API_BASE_URL',
  'JINXXY_API_KEY',
  'JINXXY_SECRET_KEY',
  'ITCHIO_CLIENT_ID',
  'PATREON_CLIENT_ID',
  'PATREON_CLIENT_SECRET',
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'YUCP_COUPLING_SERVICE_BASE_URL',
  'YUCP_COUPLING_SERVICE_SHARED_SECRET',
  'COUPLING_SERVICE_SECRET',
  'DRAGONFLY_URI',
  'REDIS_URL',
  'LOG_LEVEL',
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];
type ManagedEnv = Partial<Record<ManagedEnvKey, string | undefined>>;

let appCreated = false;

export interface BuildAppConfig {
  baseUrl?: string;
  frontendUrl?: string;
  convexUrl?: string;
  convexSiteUrl?: string;
  convexApiSecret?: string;
  encryptionSecret?: string;
  betterAuthSecret?: string;
  errorReferenceSecret?: string;
  internalServiceAuthSecret?: string;
  internalRpcSharedSecret?: string;
  couplingServiceBaseUrl?: string;
  couplingServiceSharedSecret?: string;
  discordClientId?: string;
  discordClientSecret?: string;
  webhookBaseUrl?: string;
}

export interface BuiltApiApp {
  readonly baseUrl: string;
  dispose(): void;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  handle(request: Request): Promise<Response>;
}

function buildEnv(config: BuildAppConfig): ManagedEnv {
  const baseUrl = config.baseUrl ?? 'http://localhost:3001';
  const frontendUrl = config.frontendUrl ?? baseUrl;
  const convexUrl = config.convexUrl ?? 'http://127.0.0.1:3210';
  const convexSiteUrl = config.convexSiteUrl ?? 'http://127.0.0.1:3211';

  return {
    NODE_ENV: 'test',
    CONVEX_DEPLOYMENT: undefined,
    CONVEX_URL: convexUrl,
    CONVEX_SITE_URL: convexSiteUrl,
    CONVEX_API_SECRET: config.convexApiSecret ?? 'test-api-secret-min-32-characters!!',
    SITE_URL: baseUrl,
    FRONTEND_URL: frontendUrl,
    BETTER_AUTH_SECRET: config.betterAuthSecret ?? 'test-better-auth-secret-32-chars!!',
    ENCRYPTION_SECRET: config.encryptionSecret ?? 'test-encryption-secret-32-chars!!',
    ERROR_REFERENCE_SECRET: config.errorReferenceSecret ?? 'test-error-reference-secret',
    BETTER_AUTH_URL: undefined,
    PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON: undefined,
    INTERNAL_SERVICE_AUTH_SECRET:
      config.internalServiceAuthSecret ?? 'test-internal-service-auth-secret',
    INTERNAL_RPC_SHARED_SECRET: config.internalRpcSharedSecret ?? 'test-internal-rpc-secret',
    INTERNAL_SERVICE_TOKEN: undefined,
    PACKAGE_DELIVERY_AUDIENCE: undefined,
    PACKAGE_INSTALL_ISSUER: undefined,
    PACKAGE_INSTALL_SIGNING_KEY_ID: undefined,
    PACKAGE_INSTALL_SIGNING_PRIVATE_KEY: undefined,
    VPM_BASE_URL: undefined,
    VPM_PUBLIC_INDEX_URL: undefined,
    VPM_TOKEN_KEY: undefined,
    VRCHAT_PENDING_STATE_SECRET: 'test-vrchat-pending-state-secret',
    VRCHAT_PROVIDER_SESSION_SECRET: 'test-vrchat-provider-session-secret',
    DISCORD_CLIENT_ID: config.discordClientId ?? 'test-discord-client-id',
    DISCORD_CLIENT_SECRET: config.discordClientSecret ?? 'test-discord-client-secret',
    DISCORD_BOT_TOKEN: undefined,
    GUMROAD_ACCESS_TOKEN: undefined,
    GUMROAD_CLIENT_ID: undefined,
    GUMROAD_CLIENT_SECRET: undefined,
    GUMROAD_API_KEY: undefined,
    GUMROAD_SECRET_KEY: undefined,
    JINXXY_API_BASE_URL: undefined,
    JINXXY_API_KEY: undefined,
    JINXXY_SECRET_KEY: undefined,
    ITCHIO_CLIENT_ID: undefined,
    PATREON_CLIENT_ID: undefined,
    PATREON_CLIENT_SECRET: undefined,
    POLAR_ACCESS_TOKEN: undefined,
    POLAR_WEBHOOK_SECRET: undefined,
    YUCP_COUPLING_SERVICE_BASE_URL: config.couplingServiceBaseUrl ?? 'http://127.0.0.1:8788',
    YUCP_COUPLING_SERVICE_SHARED_SECRET:
      config.couplingServiceSharedSecret ?? 'test-coupling-secret',
    COUPLING_SERVICE_SECRET: undefined,
    DRAGONFLY_URI: undefined,
    REDIS_URL: undefined,
    LOG_LEVEL: 'silent',
  };
}

function applyEnv(next: ManagedEnv): () => void {
  const previous = new Map<ManagedEnvKey, string | undefined>();

  for (const key of MANAGED_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const value = next[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export function buildApp(config: BuildAppConfig = {}): BuiltApiApp {
  if (appCreated) {
    throw new Error(
      'buildApp only supports one app per test worker while handler state is module-scoped'
    );
  }

  appCreated = true;
  const baseUrl = config.baseUrl ?? 'http://localhost:3001';
  const restoreEnv = applyEnv(buildEnv(config));
  let disposed = false;
  let handle: (request: Request) => Promise<Response>;

  try {
    handle = createApiRequestHandler(config.webhookBaseUrl);
  } catch (error) {
    restoreEnv();
    appCreated = false;
    throw error;
  }

  function call(request: Request): Promise<Response> {
    if (disposed) {
      throw new Error('buildApp handler used after dispose');
    }
    return handle(request);
  }

  return {
    baseUrl,
    dispose() {
      if (!disposed) {
        disposed = true;
        restoreEnv();
      }
    },
    fetch(path: string, init?: RequestInit): Promise<Response> {
      return call(new Request(new URL(path, baseUrl), init));
    },
    handle: call,
  };
}
