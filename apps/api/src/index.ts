// API entrypoint
// Convex hosts Better Auth for creator authentication.
// This Bun server hosts the app pages, connect flows, and integration routes.

import path from 'node:path';
import { getInternalRpcSharedSecret } from '@yucp/shared';
import {
  Catalog,
  type CatalogDatabase,
  openCatalogDatabase,
  PackageOperationAuthorizationStore,
} from '../../../ops/catalog';
import { type Auth, createAuth } from './auth';
import { createInternalRpcRouter, INTERNAL_RPC_PATH } from './internalRpc/router';
import { loadCatalogControlClient } from './lib/catalogControlClient';
import { getClientAddress } from './lib/clientAddress';
import { getConfiguredConvexSiteUrlForProxy } from './lib/convexSiteProxy';
import { buildApiAllowedCorsOrigins, buildApiCorsHeaders } from './lib/cors';
import { validateCouplingServiceBaseUrl } from './lib/couplingServiceConfig';
import { getRequired, loadEnv, loadEnvAsync } from './lib/env';
import { applyResponseSecurityHeaders } from './lib/httpSecurity';
import {
  createLegacyFrontendMovedResponse,
  HTML_RESPONSE_SECURITY_HEADERS,
  isLegacyFrontendAsset,
} from './lib/legacyFrontend';
import { logger } from './lib/logger';
import { loadMaterializationControlClient } from './lib/materializationControlClient';
import { bindDefaultOAuthResource } from './lib/oauthTokenResource';
import {
  annotateApiSpan,
  getActiveTraceIds,
  initApiObservability,
  setApiDiagnosticsConsentResolver,
  withApiRequestSpan,
} from './lib/observability';
import { verifyPackageBrokerAccessRequest } from './lib/packageBrokerAccessToken';
import { createConvexPackageInstallAccess } from './lib/packageInstallAccess';
import {
  buildPackageInstallerTufRepository,
  loadPackageInstallerTufRepositoryConfig,
  type PackageInstallerTufRepositoryRuntime,
} from './lib/packageInstallerTufRepository';
import { loadPackageInstallSessionConfig } from './lib/packageInstallSessionConfig';
import { createConfiguredPrivateVpmDomainProvisioner } from './lib/privateVpmDomain';
import { applyPublicOriginForwardingHeaders } from './lib/proxyForwardedOrigin';
import {
  buildPublicApiRateLimitKey,
  checkPublicApiRateLimit,
  getPublicApiRateLimitStore,
} from './lib/publicApiRateLimit';
import { resolvePublicRuntimeOrigins } from './lib/publicRuntimeOrigins';
import { detectTunnelUrl } from './lib/tunnel';
import { createConfiguredVpmAliasArtifactStore } from './lib/vpmAliasArtifactStore';
import { loadVpmBootstrapMediaReader } from './lib/vpmBootstrapMediaReader';
import { buildYucpKeysResponse } from './lib/yucpKeys';
import {
  createAccountSecurityRoutes,
  createConnectRoutes,
  createCreatorPackageRoutes,
  createCreatorUploadRoutes,
  createForensicsRoutes,
  createProviderPlatformRoutes,
  createVerificationRoutes,
  createVpmRoutes,
  createWebhookHandler,
  type InstallConfig,
  mountInstallRoutes,
  mountVerificationRouteHandlers,
  type VerificationConfig,
} from './routes';
import { handleBrowserTelemetry } from './routes/browserTelemetry';
import { createCollabRoutes } from './routes/collab';
import { handleConvexTelemetry } from './routes/convexTelemetry';
import { handleNativeTelemetry } from './routes/nativeTelemetry';
import { createPackageInstallerTufRoute } from './routes/packageInstallerTuf';
import {
  createPackageInstallSessionRenewalRoute,
  createPackageInstallSessionRoute,
  createPackageMaterializationStatusRoute,
  createPackageOperationAuthorizationRoute,
  PACKAGE_MATERIALIZATION_STATUS_PATH,
} from './routes/packageInstallSessions';
import { createPublicRoutes } from './routes/public';
import { createPublicV2Routes } from './routes/publicV2';
import { createSuiteRoutes } from './routes/suite';
import { createVersionRouteHandler } from './routes/version';

// Global auth instance
let auth: Auth | null = null;

// Route handlers (initialized after auth)
let installRoutes: Map<string, (request: Request) => Promise<Response>> | null = null;
let verificationRoutes: Map<string, (request: Request) => Promise<Response>> | null = null;
let verificationHandlers: ReturnType<typeof createVerificationRoutes> | null = null;
let connectRoutes: ReturnType<typeof createConnectRoutes> | null = null;
let creatorPackageRoutes: ReturnType<typeof createCreatorPackageRoutes> | null = null;
let creatorUploadRoutes: ReturnType<typeof createCreatorUploadRoutes> | null = null;
let vpmRoutes: ReturnType<typeof createVpmRoutes> | null = null;
let accountSecurityRoutes: ReturnType<typeof createAccountSecurityRoutes> | null = null;
let forensicsRoutes: ReturnType<typeof createForensicsRoutes> | null = null;
let providerPlatformRoutes: ReturnType<typeof createProviderPlatformRoutes> | null = null;
let webhookHandler: ReturnType<typeof createWebhookHandler> | null = null;
let collabRoutes: ReturnType<typeof createCollabRoutes> | null = null;
let publicRoutes: ReturnType<typeof createPublicRoutes> | null = null;
let publicV2Routes: ReturnType<typeof createPublicV2Routes> | null = null;
let suiteRoutes: ReturnType<typeof createSuiteRoutes> | null = null;
let internalRpcRouter: ReturnType<typeof createInternalRpcRouter> | null = null;
let packageInstallSessionRoute: ((request: Request) => Promise<Response>) | null = null;
let packageInstallSessionRenewalRoute: ((request: Request) => Promise<Response>) | null = null;
let packageOperationAuthorizationRoute: ((request: Request) => Promise<Response>) | null = null;
let packageOperationAuthorizationDatabase: CatalogDatabase | null = null;
let vpmAliasPublicationDatabase: CatalogDatabase | null = null;
let packageMaterializationStatusRoute: ((request: Request) => Promise<Response>) | null = null;
let packageInstallerTufRoute: ((request: Request) => Promise<Response>) | null = null;
let packageInstallerTufRuntime: PackageInstallerTufRepositoryRuntime | null = null;
let nativeDiagnosticsConsentResolver: (diagnosticsSessionId: string) => Promise<boolean> =
  async () => false;
let allowedCorsOrigins = new Set<string>();

// Resolved after initializeAuth - used for apiBase injection and CORS
let resolvedApiBaseUrl = 'http://localhost:3001';
let resolvedFrontendOrigin: string | null = null;
const RATE_LIMIT_BUCKETS = new Map<string, { count: number; resetAt: number }>();
const PUBLIC_BASE_DIR = path.resolve(import.meta.dir, '..', 'public');

function parseBearerToken(authHeader: string | null): string | null {
  return (
    authHeader
      ?.trim()
      .match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim() ?? null
  );
}

function getCouplingServiceSharedSecret(env: ReturnType<typeof loadEnv>): string {
  return env.YUCP_COUPLING_SERVICE_SHARED_SECRET?.trim() ?? '';
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function badPathEncodingResponse(): Response {
  return Response.json({ error: 'Malformed path parameter encoding' }, { status: 400 });
}

function withExtraHeaders(
  response: Response,
  headers: Record<string, string> | undefined
): Response {
  if (!headers) return response;
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) {
    next.headers.set(key, value);
  }
  return next;
}

function getPublicApiRouteFamily(pathname: string): string {
  if (pathname.startsWith('/api/public/v2/downloads')) return 'public-v2-downloads';
  if (pathname.startsWith('/api/public/v2/products')) return 'public-v2-products';
  if (pathname.startsWith('/api/public/v2/verification')) return 'public-v2-verification';
  if (pathname.startsWith('/api/public/v2/webhooks')) return 'public-v2-webhooks';
  if (pathname.startsWith('/api/public/v2/')) return 'public-v2-general';
  return 'public-v1-general';
}

function getPublicApiRateLimitPolicy(routeFamily: string): { limit: number; windowMs: number } {
  switch (routeFamily) {
    case 'public-v2-downloads':
      return { limit: 30, windowMs: 60_000 };
    case 'public-v2-products':
      return { limit: 120, windowMs: 60_000 };
    case 'public-v2-verification':
      return { limit: 120, windowMs: 60_000 };
    case 'public-v2-webhooks':
      return { limit: 60, windowMs: 60_000 };
    default:
      return { limit: 240, windowMs: 60_000 };
  }
}

function getConfiguredConvexUrl(env: ReturnType<typeof loadEnv>): string {
  const convexUrl = env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT;
  if (!convexUrl) {
    throw new Error('CONVEX_URL or CONVEX_DEPLOYMENT must be set');
  }
  return convexUrl;
}

function getEncryptionSecret(env: ReturnType<typeof loadEnv>): string {
  if (env.ENCRYPTION_SECRET) {
    return env.ENCRYPTION_SECRET;
  }
  if ((env.NODE_ENV ?? 'development') === 'production') {
    throw new Error('ENCRYPTION_SECRET must be set in production');
  }
  return env.BETTER_AUTH_SECRET ?? '';
}

function redirectToFrontendRoute(
  requestUrl: URL,
  frontendUrl: string,
  pathname: string
): Response | null {
  const target = new URL(pathname, `${frontendUrl.replace(/\/$/, '')}/`);
  target.search = requestUrl.search;
  if (target.origin === requestUrl.origin && target.pathname === requestUrl.pathname) {
    return null;
  }
  return Response.redirect(target.toString(), 302);
}

// Periodically evict stale rate-limit buckets (every 5 minutes) to prevent unbounded growth.
setInterval(
  () => {
    const now = Date.now();
    for (const [key, bucket] of RATE_LIMIT_BUCKETS) {
      if (now >= bucket.resetAt) {
        RATE_LIMIT_BUCKETS.delete(key);
      }
    }
  },
  5 * 60 * 1000
).unref();

function isRateLimited(bucketKey: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = RATE_LIMIT_BUCKETS.get(bucketKey);
  if (!existing || now >= existing.resetAt) {
    RATE_LIMIT_BUCKETS.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return false;
  }
  existing.count += 1;
  RATE_LIMIT_BUCKETS.set(bucketKey, existing);
  return existing.count > maxRequests;
}

/**
 * Initialize the auth service and routes
 * @param webhookBaseUrl - If a tunnel is detected, use this as the public URL for webhooks
 */
function initializeAuth(webhookBaseUrl?: string) {
  const env = loadEnv();
  const convexUrl = getConfiguredConvexUrl(env);
  const encryptionSecret = getEncryptionSecret(env);
  const internalRpcSharedSecret = getInternalRpcSharedSecret(env);
  const couplingServiceSharedSecret = getCouplingServiceSharedSecret(env);

  getRequired('BETTER_AUTH_SECRET');
  if ((env.NODE_ENV ?? 'development') === 'production') {
    getRequired('INTERNAL_SERVICE_AUTH_SECRET');
    getRequired('VRCHAT_PENDING_STATE_SECRET');
    getRequired('ENCRYPTION_SECRET');
    getRequired('YUCP_COUPLING_SERVICE_BASE_URL');
    getPublicApiRateLimitStore();
    if (!couplingServiceSharedSecret) {
      throw new Error('YUCP_COUPLING_SERVICE_SHARED_SECRET must be configured in production');
    }
  }
  const configuredPolarKeys = [env.POLAR_ACCESS_TOKEN, env.POLAR_WEBHOOK_SECRET].filter(
    (value) => typeof value === 'string' && value.trim()
  ).length;
  if (configuredPolarKeys > 0 && configuredPolarKeys < 2) {
    throw new Error('POLAR_ACCESS_TOKEN and POLAR_WEBHOOK_SECRET must be configured together');
  }
  // DPoP htu verification must use the externally visible API origin. The
  // browser frontend is a separate authority and cannot be used as a fallback.
  const {
    frontendUrl,
    publicApiBaseUrl: publicBaseUrl,
    siteUrl,
  } = resolvePublicRuntimeOrigins(env, webhookBaseUrl);
  validateCouplingServiceBaseUrl({
    apiBaseUrl: publicBaseUrl,
    convexSiteUrl: env.CONVEX_SITE_URL,
    couplingServiceBaseUrl: env.YUCP_COUPLING_SERVICE_BASE_URL,
  });

  resolvedApiBaseUrl = publicBaseUrl;
  resolvedFrontendOrigin = new URL(frontendUrl).origin;
  allowedCorsOrigins = buildApiAllowedCorsOrigins({
    siteUrl,
    frontendUrl,
    publicBaseUrl,
    nodeEnv: env.NODE_ENV,
  });

  const convexSiteUrl = env.CONVEX_SITE_URL ?? '';
  if (!convexSiteUrl) {
    throw new Error('CONVEX_SITE_URL must be set for auth (Convex hosts auth)');
  }
  if (env.BETTER_AUTH_URL && env.BETTER_AUTH_URL !== convexSiteUrl) {
    // Lowered to info to avoid noisy warnings when CONVEX_SITE_URL is authoritative.
    logger.info('Ignoring BETTER_AUTH_URL in favor of CONVEX_SITE_URL', {
      configuredBetterAuthUrl: env.BETTER_AUTH_URL,
      convexSiteUrl,
    });
  }
  if (!env.FRONTEND_URL) {
    logger.warn('FRONTEND_URL not set, falling back to SITE_URL for frontend origin', { siteUrl });
  }

  auth = createAuth({
    baseUrl: siteUrl,
    trustedOrigin: frontendUrl,
    convexSiteUrl,
    convexUrl,
  });

  // Initialize install routes for bot installation
  const installConfig: InstallConfig = {
    discordClientId: env.DISCORD_CLIENT_ID ?? '',
    discordClientSecret: env.DISCORD_CLIENT_SECRET ?? '',
    discordBotToken: env.DISCORD_BOT_TOKEN ?? '',
    baseUrl: publicBaseUrl,
    frontendUrl,
    convexUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
  };
  installRoutes = mountInstallRoutes(auth, installConfig);

  // Initialize verification routes
  const verificationConfig: VerificationConfig = {
    baseUrl: publicBaseUrl,
    frontendUrl,
    convexUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    gumroadClientId: env.GUMROAD_CLIENT_ID ?? env.GUMROAD_API_KEY,
    gumroadClientSecret: env.GUMROAD_CLIENT_SECRET ?? env.GUMROAD_SECRET_KEY,
    discordClientId: env.DISCORD_CLIENT_ID,
    discordClientSecret: env.DISCORD_CLIENT_SECRET,
    jinxxyClientId: env.JINXXY_API_KEY,
    jinxxyClientSecret: env.JINXXY_SECRET_KEY,
    encryptionSecret,
    providerClientIds: {
      itchio: env.ITCHIO_CLIENT_ID ?? '',
      patreon: env.PATREON_CLIENT_ID ?? '',
    },
    providerClientSecrets: {
      patreon: env.PATREON_CLIENT_SECRET ?? '',
    },
  };
  verificationHandlers = createVerificationRoutes(verificationConfig);
  verificationRoutes = mountVerificationRouteHandlers(verificationHandlers);

  const privateVpmDomainProvisioner = createConfiguredPrivateVpmDomainProvisioner(env);
  if (Boolean(env.PRIVATE_VPM_ROOT_DOMAIN?.trim()) !== Boolean(privateVpmDomainProvisioner)) {
    throw new Error(
      'PRIVATE_VPM_ROOT_DOMAIN and the complete private VPM Cloudflare configuration must be configured together'
    );
  }

  const connectConfig = {
    apiBaseUrl: publicBaseUrl,
    frontendBaseUrl: frontendUrl,
    convexSiteUrl,
    discordClientId: env.DISCORD_CLIENT_ID ?? '',
    discordClientSecret: env.DISCORD_CLIENT_SECRET ?? '',
    discordBotToken: env.DISCORD_BOT_TOKEN,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexUrl,
    gumroadClientId: env.GUMROAD_CLIENT_ID ?? env.GUMROAD_API_KEY,
    gumroadClientSecret: env.GUMROAD_CLIENT_SECRET ?? env.GUMROAD_SECRET_KEY,
    itchioClientId: env.ITCHIO_CLIENT_ID,
    patreonClientId: env.PATREON_CLIENT_ID,
    patreonClientSecret: env.PATREON_CLIENT_SECRET,
    encryptionSecret,
    privateVpmRootDomain: env.PRIVATE_VPM_ROOT_DOMAIN,
  } satisfies Parameters<typeof createConnectRoutes>[1];
  connectRoutes = createConnectRoutes(
    auth,
    connectConfig,
    privateVpmDomainProvisioner ? { privateDomainProvisioner: privateVpmDomainProvisioner } : {}
  );

  const catalogControl = loadCatalogControlClient(env);
  creatorPackageRoutes = createCreatorPackageRoutes({
    auth,
    catalogControl,
    config: {
      apiBaseUrl: publicBaseUrl,
      frontendBaseUrl: frontendUrl,
      convexApiSecret: env.CONVEX_API_SECRET ?? '',
      convexUrl,
    },
  });

  creatorUploadRoutes = createCreatorUploadRoutes({
    auth,
    config: {
      apiBaseUrl: publicBaseUrl,
      frontendBaseUrl: frontendUrl,
      convexApiSecret: env.CONVEX_API_SECRET ?? '',
      convexUrl,
      ingestTusUrl: env.INGEST_TUS_URL,
      uploadHmacKey: env.UPLOAD_HMAC_KEY,
    },
  });

  vpmAliasPublicationDatabase?.end({ timeout: 1 }).catch(() => undefined);
  vpmAliasPublicationDatabase = env.VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL
    ? openCatalogDatabase(env.VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL)
    : null;
  const vpmAliasArtifactStore = vpmAliasPublicationDatabase
    ? createConfiguredVpmAliasArtifactStore(env as NodeJS.ProcessEnv, vpmAliasPublicationDatabase)
    : undefined;
  const packageInstallConfig = loadPackageInstallSessionConfig(env);
  vpmRoutes = createVpmRoutes({
    auth,
    ...(vpmAliasArtifactStore ? { aliasArtifactStore: vpmAliasArtifactStore } : {}),
    ...(privateVpmDomainProvisioner
      ? { privateDomainProvisioner: privateVpmDomainProvisioner }
      : {}),
    bootstrapMediaReader: loadVpmBootstrapMediaReader(env as NodeJS.ProcessEnv),
    ...(packageInstallConfig
      ? {
          bootstrapIntentSigning: {
            keyId: packageInstallConfig.keyId,
            privateKey: packageInstallConfig.privateKey,
          },
        }
      : {}),
    config: {
      apiBaseUrl: publicBaseUrl,
      frontendBaseUrl: frontendUrl,
      internalRpcSharedSecret,
      convexApiSecret: env.CONVEX_API_SECRET ?? '',
      convexUrl,
      publicVpmIndexUrl: env.VPM_PUBLIC_INDEX_URL,
      privateVpmRootDomain: env.PRIVATE_VPM_ROOT_DOMAIN,
      vpmBaseUrl: env.VPM_BASE_URL,
    },
  });

  const materializationControl = loadMaterializationControlClient(env);
  packageOperationAuthorizationDatabase?.end({ timeout: 1 }).catch(() => undefined);
  packageOperationAuthorizationDatabase = env.PACKAGE_OPERATION_AUTHORIZATION_DATABASE_URL
    ? openCatalogDatabase(env.PACKAGE_OPERATION_AUTHORIZATION_DATABASE_URL)
    : null;
  const operationAuthorizationStore = packageOperationAuthorizationDatabase
    ? new PackageOperationAuthorizationStore(packageOperationAuthorizationDatabase)
    : null;
  const packagePublicationAuthority = packageOperationAuthorizationDatabase
    ? new Catalog(packageOperationAuthorizationDatabase)
    : null;
  nativeDiagnosticsConsentResolver = async () => false;
  setApiDiagnosticsConsentResolver(nativeDiagnosticsConsentResolver);
  const packageInstallRouteOptions =
    packageInstallConfig && operationAuthorizationStore && packagePublicationAuthority
      ? {
          accessPort: createConvexPackageInstallAccess({
            convexApiSecret: env.CONVEX_API_SECRET ?? '',
            convexUrl,
            publicationAuthority: packagePublicationAuthority,
          }),
          authorizationPort: operationAuthorizationStore,
          audience: packageInstallConfig.audience,
          issuer: packageInstallConfig.issuer,
          keyId: packageInstallConfig.keyId,
          verificationBaseUrl: frontendUrl,
          ...(materializationControl ? { materializationControl } : {}),
          ...(catalogControl ? { releasePins: catalogControl } : {}),
          privateKey: packageInstallConfig.privateKey,
          async verifyAccessRequest(request: Request) {
            const result = await verifyPackageBrokerAccessRequest(request, {
              convexSiteUrl,
              dpopReplayStore: operationAuthorizationStore.dpopReplayStore(),
              logger,
              logContext: 'Package install DPoP verification failed',
              publicResourceBaseUrl: publicBaseUrl,
              requiredAuthorizedParty: 'yucp-package-broker',
              requiredScopes: ['package:operate'],
            });
            return result.ok
              ? {
                  buyerId: result.token.sub,
                  deviceKeyThumbprint: result.token.deviceKeyThumbprint,
                  ok: true as const,
                }
              : {
                  ok: false as const,
                  status:
                    result.reason === 'insufficient_scope'
                      ? (403 as const)
                      : result.reason === 'unavailable'
                        ? (503 as const)
                        : (401 as const),
                };
          },
        }
      : null;
  if (packageInstallRouteOptions?.accessPort.resolveDiagnosticsSessionConsent) {
    nativeDiagnosticsConsentResolver =
      packageInstallRouteOptions.accessPort.resolveDiagnosticsSessionConsent;
    setApiDiagnosticsConsentResolver(nativeDiagnosticsConsentResolver);
  }
  packageOperationAuthorizationRoute = packageInstallRouteOptions
    ? createPackageOperationAuthorizationRoute(packageInstallRouteOptions)
    : null;
  packageInstallSessionRoute = packageInstallRouteOptions
    ? createPackageInstallSessionRoute(packageInstallRouteOptions)
    : null;
  packageInstallSessionRenewalRoute = packageInstallRouteOptions
    ? createPackageInstallSessionRenewalRoute(packageInstallRouteOptions)
    : null;
  packageMaterializationStatusRoute =
    packageInstallConfig && materializationControl
      ? createPackageMaterializationStatusRoute({
          audience: packageInstallConfig.audience,
          issuer: packageInstallConfig.issuer,
          keyId: packageInstallConfig.keyId,
          materializationControl,
          privateKey: packageInstallConfig.privateKey,
        })
      : null;
  packageInstallerTufRuntime = buildPackageInstallerTufRepository(
    loadPackageInstallerTufRepositoryConfig(env)
  );
  packageInstallerTufRoute = packageInstallerTufRuntime
    ? createPackageInstallerTufRoute(packageInstallerTufRuntime.repository)
    : null;

  accountSecurityRoutes = createAccountSecurityRoutes(auth, {
    convexUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
  });

  forensicsRoutes = createForensicsRoutes(auth, {
    apiBaseUrl: publicBaseUrl,
    frontendBaseUrl: frontendUrl,
    couplingServiceBaseUrl: env.YUCP_COUPLING_SERVICE_BASE_URL ?? '',
    couplingServiceSharedSecret,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexUrl,
    encryptionSecret,
    ...(materializationControl ? { materializationControl } : {}),
  });

  providerPlatformRoutes = createProviderPlatformRoutes(auth, {
    apiBaseUrl: publicBaseUrl,
    frontendBaseUrl: frontendUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexUrl,
    encryptionSecret,
  });

  webhookHandler = createWebhookHandler({
    convexUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    encryptionSecret,
  });

  const collabConfig = {
    auth,
    apiBaseUrl: publicBaseUrl,
    frontendBaseUrl: frontendUrl,
    convexUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    encryptionSecret,
    discordClientId: env.DISCORD_CLIENT_ID ?? '',
    discordClientSecret: env.DISCORD_CLIENT_SECRET ?? '',
  } satisfies Parameters<typeof createCollabRoutes>[0];
  collabRoutes = createCollabRoutes(collabConfig);

  suiteRoutes = createSuiteRoutes({
    convexUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexSiteUrl,
  });

  publicRoutes = createPublicRoutes({
    convexUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexSiteUrl,
  });

  publicV2Routes = createPublicV2Routes({
    apiBaseUrl: publicBaseUrl,
    convexUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexSiteUrl,
    encryptionSecret,
    frontendBaseUrl: frontendUrl,
  });

  internalRpcRouter = createInternalRpcRouter({
    connectRoutes,
    verificationHandlers,
    collabRoutes,
    connectConfig,
    collabConfig,
    config: {
      apiBaseUrl: publicBaseUrl,
      convexApiSecret: env.CONVEX_API_SECRET ?? '',
      convexSiteUrl,
      convexUrl,
      encryptionSecret,
      internalRpcSharedSecret,
      logLevel: env.LOG_LEVEL,
    },
  });

  logger.info('Better Auth initialized', {
    installRoutes: installRoutes.size,
    verificationRoutes: verificationRoutes.size,
    siteUrl,
    publicBaseUrl,
    authBaseUrl: `${convexSiteUrl}/api/auth`,
    convexSiteUrl,
    frontendUrl,
    discordEnabled: !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
    gumroadConfigured: !!(env.GUMROAD_CLIENT_ID ?? env.GUMROAD_API_KEY),
    patreonConfigured: !!(env.PATREON_CLIENT_ID && env.PATREON_CLIENT_SECRET),
  });

  return auth;
}

/**
 * Core routing logic - called by handleRequest after CORS is handled.
 */
async function routeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const clientAddress = getClientAddress(request);
  let publicApiRateLimitHeaders: Record<string, string> | undefined;

  if (pathname === '/api/telemetry/browser-error') {
    if (isRateLimited(`browser-telemetry:${clientAddress}`, 60, 60_000)) {
      return new Response(null, { status: 429 });
    }
    return handleBrowserTelemetry(request);
  }
  if (pathname === '/api/telemetry/convex') {
    return handleConvexTelemetry(request);
  }
  if (pathname === '/api/telemetry/native') {
    if (isRateLimited(`native-telemetry:${clientAddress}`, 120, 60_000)) {
      return new Response(null, { status: 429 });
    }
    return handleNativeTelemetry(request, nativeDiagnosticsConsentResolver);
  }

  // Basic in-memory guardrails for abuse-prone routes.
  if (pathname === INTERNAL_RPC_PATH && internalRpcRouter) {
    return internalRpcRouter.handle(request, undefined);
  }

  if (pathname.startsWith('/api/verification/')) {
    if (isRateLimited(`verification:${clientAddress}`, 60, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (pathname.startsWith('/api/connect/')) {
    if (isRateLimited(`connect:${clientAddress}`, 120, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (pathname.startsWith('/api/account-recovery/')) {
    if (isRateLimited(`account-recovery:${clientAddress}`, 15, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (pathname.startsWith('/api/forensics/')) {
    if (isRateLimited(`forensics:${clientAddress}`, 30, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (pathname.startsWith('/api/vpm/')) {
    if (isRateLimited(`vpm:${clientAddress}`, 120, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (pathname.startsWith('/api/creator/uploads/authorize')) {
    if (isRateLimited(`creator-upload-authorize:${clientAddress}`, 30, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (pathname.startsWith('/api/creator/packages')) {
    if (isRateLimited(`creator-packages:${clientAddress}`, 120, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (pathname.startsWith('/api/collab/')) {
    if (isRateLimited(`collab:${clientAddress}`, 30, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (pathname.startsWith('/api/suite/')) {
    if (isRateLimited(`suite:${clientAddress}`, 120, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (pathname.startsWith('/api/public/')) {
    const routeFamily = getPublicApiRouteFamily(pathname);
    const policy = getPublicApiRateLimitPolicy(routeFamily);
    const authHeader = request.headers.get('authorization')?.trim() ?? null;
    const bearerToken = parseBearerToken(authHeader);
    const rateLimit = await checkPublicApiRateLimit({
      store: getPublicApiRateLimitStore(),
      key: buildPublicApiRateLimitKey({
        routeFamily,
        clientAddress,
        publicApiKey: request.headers.get('x-api-key')?.trim() ?? null,
        bearerToken,
        userAgent: request.headers.get('user-agent'),
      }),
      ...policy,
    });
    publicApiRateLimitHeaders = rateLimit.headers;
    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...rateLimit.headers },
      });
    }
  }
  if (pathname.startsWith('/v1/')) {
    if (isRateLimited(`v1:${clientAddress}`, 120, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Redirect root to frontend
  if (pathname === '/') {
    return Response.redirect('https://creators.yucp.club/', 302);
  }

  // Health check endpoint
  if (pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Version endpoint, used by the web dashboard for version skew detection
  const versionResponse = createVersionRouteHandler()(request);
  if (versionResponse) return versionResponse;

  if (pathname === '/tokens.css') {
    const file = Bun.file(`${import.meta.dir}/../public/tokens.css`);
    return new Response(file, {
      headers: { 'Content-Type': 'text/css; charset=utf-8' },
    });
  }

  if (pathname === '/loading.css') {
    const file = Bun.file(`${import.meta.dir}/../public/loading.css`);
    return new Response(file, {
      headers: { 'Content-Type': 'text/css; charset=utf-8' },
    });
  }

  if (pathname === '/v1/keys' && request.method === 'GET') {
    return buildYucpKeysResponse();
  }

  // Handle /Icons/ even with path prefix (e.g. /api/Icons/ when API has base path)
  const iconsPath = pathname.includes('/Icons/')
    ? pathname.slice(pathname.indexOf('/Icons/'))
    : pathname;
  if (iconsPath.startsWith('/Icons/')) {
    if (iconsPath.includes('..')) {
      return new Response(null, { status: 404 });
    }
    const assetPath = `${import.meta.dir}/../public${iconsPath}`;
    const resolvedIconsPath = path.resolve(assetPath);
    if (
      !resolvedIconsPath.startsWith(PUBLIC_BASE_DIR + path.sep) &&
      resolvedIconsPath !== PUBLIC_BASE_DIR
    ) {
      return new Response(null, { status: 404 });
    }
    const file = Bun.file(assetPath);
    if (await file.exists()) {
      const ext = iconsPath.split('.').pop()?.toLowerCase();
      const contentType =
        ext === 'png'
          ? 'image/png'
          : ext === 'svg'
            ? 'image/svg+xml'
            : ext === 'ico'
              ? 'image/x-icon'
              : ext === 'jpg' || ext === 'jpeg'
                ? 'image/jpeg'
                : 'application/octet-stream';
      return new Response(file, {
        headers: { 'Content-Type': contentType },
      });
    }
  }

  if (pathname.startsWith('/assets/')) {
    if (isLegacyFrontendAsset(pathname)) {
      return new Response(null, { status: 404 });
    }
    if (pathname.includes('..')) {
      return new Response(null, { status: 404 });
    }
    const assetPath = `${import.meta.dir}/../public${pathname}`;
    const resolvedAssetPath = path.resolve(assetPath);
    if (
      !resolvedAssetPath.startsWith(PUBLIC_BASE_DIR + path.sep) &&
      resolvedAssetPath !== PUBLIC_BASE_DIR
    ) {
      return new Response(null, { status: 404 });
    }
    const file = Bun.file(assetPath);
    if (await file.exists()) {
      const ext = pathname.split('.').pop()?.toLowerCase();
      const contentType =
        ext === 'js'
          ? 'text/javascript; charset=utf-8'
          : ext === 'css'
            ? 'text/css; charset=utf-8'
            : ext === 'map'
              ? 'application/json; charset=utf-8'
              : ext === 'png'
                ? 'image/png'
                : ext === 'svg'
                  ? 'image/svg+xml'
                  : 'application/octet-stream';
      return new Response(file, {
        headers: { 'Content-Type': contentType },
      });
    }
  }

  // Proxy the root OAuth discovery document, /api/auth/*, /api/yucp/*, and /v1/*
  // requests to Convex. Auth, YUCP OAuth, and the versioned public API (/v1/)
  // all live on Convex .site.
  // When the API runs on localhost, proxy so everything works from a single origin.
  if (pathname.startsWith('/v1/') && providerPlatformRoutes) {
    const localV1Response = await providerPlatformRoutes.handleRequest(request);
    if (localV1Response) {
      return localV1Response;
    }
  }

  if (pathname === '/api/providers' && request.method === 'GET' && providerPlatformRoutes) {
    const response = await providerPlatformRoutes.handleRequest(request);
    if (response) return response;
  }

  if (
    pathname === '/.well-known/oauth-authorization-server/api/auth' ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/yucp/') ||
    pathname.startsWith('/v1/')
  ) {
    const env = loadEnv();
    const convexSiteUrl = getConfiguredConvexSiteUrlForProxy(env);
    if (convexSiteUrl) {
      const targetUrl = `${convexSiteUrl}${pathname}${url.search}`;
      const proxyHeaders = new Headers(request.headers);
      proxyHeaders.delete('host');
      proxyHeaders.set('host', new URL(convexSiteUrl).host);

      applyPublicOriginForwardingHeaders(proxyHeaders, url);

      let proxyBody: BodyInit | undefined =
        request.method !== 'GET' && request.method !== 'HEAD'
          ? ((request.body as BodyInit | null | undefined) ?? undefined)
          : undefined;

      if (
        pathname === '/api/auth/oauth2/token' &&
        request.method === 'POST' &&
        (request.headers.get('content-type') ?? '').includes('x-www-form-urlencoded')
      ) {
        const text = await request.text();
        const requestParams = new URLSearchParams(text);
        const hadResource = requestParams.has('resource');
        // Always inject the resource parameter so the oauth-provider issues a
        // JWT access token (audience-bound) rather than an opaque token.
        // Without `resource`, isJwtAccessToken is false and verifyAccessToken
        // later fails with "no token payload".
        const params = bindDefaultOAuthResource(requestParams);
        const rewritten = params.toString();
        logger.info('Token exchange resource binding', {
          grant_type: params.get('grant_type'),
          resource_was_present: hadResource,
          resource_now: params.get('resource'),
        });
        proxyBody = rewritten;
        proxyHeaders.set('content-type', 'application/x-www-form-urlencoded');
        proxyHeaders.set('content-length', String(Buffer.byteLength(rewritten)));
      }

      // Use 'manual' so 3xx responses are passed directly to the browser.
      // 'follow' (the default) would silently consume redirects server-side,
      // which breaks OAuth flows that depend on the browser seeing the Location header.
      const proxyRes = await fetch(targetUrl, {
        method: request.method,
        headers: proxyHeaders,
        body: proxyBody,
        redirect: 'manual',
      });
      // For redirect responses pass them through, but differently per method:
      // - GET 3xx: pass Location header as-is so the browser navigates natively
      // - POST 3xx: browsers can't read Location from a cross-origin opaque redirect,
      //   so return JSON { redirectTo } instead; the client JS reads it and navigates.
      if (proxyRes.status >= 300 && proxyRes.status < 400) {
        const location = proxyRes.headers.get('location') ?? '';
        if (request.method === 'POST') {
          return Response.json(
            { redirectTo: location },
            { headers: { 'cache-control': 'no-store' } }
          );
        }
        return new Response(null, {
          status: proxyRes.status,
          headers: { location, 'cache-control': 'no-store' },
        });
      }
      return new Response(proxyRes.body, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: proxyRes.headers,
      });
    }
  }

  // Install routes for bot installation
  if (installRoutes?.has(pathname)) {
    const handler = installRoutes.get(pathname);
    if (!handler) {
      return Response.json({ error: 'Route handler not found' }, { status: 500 });
    }
    return handler(request);
  }

  // Health check for guild installation
  if (pathname.startsWith('/api/install/health/')) {
    const handler = installRoutes?.get('/api/install/health');
    if (handler) {
      return handler(request);
    }
  }

  // Uninstall route
  if (pathname.startsWith('/api/install/uninstall/')) {
    const handler = installRoutes?.get('/api/install/uninstall');
    if (handler) {
      return handler(request);
    }
  }

  // Verification routes
  if (verificationRoutes?.has(pathname)) {
    const handler = verificationRoutes.get(pathname);
    if (!handler) {
      return Response.json({ error: 'Route handler not found' }, { status: 500 });
    }
    return handler(request);
  }

  // Internal backfill route (called by Convex action when BACKFILL_API_URL is set)
  if (pathname === '/api/internal/backfill-product' && request.method === 'POST') {
    const { handleBackfillProduct } = await import('./routes/backfill');
    return handleBackfillProduct(request);
  }

  // Internal notify route (called by Discord bot to push dashboard toasts)
  if (pathname === '/api/internal/notify') {
    const { handleInternalNotify } = await import('./routes/notify');
    return handleInternalNotify(request);
  }

  // Provider products route, generic handler for all providers (/api/:provider/products)
  const productsMatch = pathname.match(/^\/api\/([^/]+)\/products$/);
  if (productsMatch && request.method === 'POST') {
    const providerSlug = productsMatch[1];
    const { handleProviderProducts } = await import('./routes/products');
    return handleProviderProducts(request, providerSlug);
  }

  const tiersMatch = pathname.match(/^\/api\/([^/]+)\/tiers$/);
  if (tiersMatch && request.method === 'POST') {
    const providerSlug = tiersMatch[1];
    const { handleProviderTiers } = await import('./routes/tiers');
    return handleProviderTiers(request, providerSlug);
  }

  // Webhook routes (Gumroad, Jinxxy)
  if (pathname.startsWith('/webhooks/') && webhookHandler) {
    return webhookHandler(request);
  }

  // Connect routes (creator onboarding without dashboard)
  if (pathname === '/connect' && connectRoutes) {
    return connectRoutes.serveConnectPage(request);
  }
  if (pathname === '/api/connect/complete' && connectRoutes) {
    return connectRoutes.completeSetup(request);
  }
  if (pathname === '/api/creator/packages' && creatorPackageRoutes) {
    return creatorPackageRoutes.listPackages(request);
  }
  const creatorPackagePublicLinkMatch = pathname.match(
    /^\/api\/creator\/packages\/by-package\/([^/]+)\/public-link$/
  );
  if (creatorPackagePublicLinkMatch && creatorPackageRoutes) {
    const packageId = safeDecodeURIComponent(creatorPackagePublicLinkMatch[1] ?? '');
    if (packageId === null) {
      return badPathEncodingResponse();
    }
    return creatorPackageRoutes.managePublicLink(request, packageId);
  }
  const creatorPackageVersionPageMatch = pathname.match(
    /^\/api\/creator\/packages\/by-package\/([^/]+)\/editions\/([^/]+)\/versions$/
  );
  if (creatorPackageVersionPageMatch && creatorPackageRoutes) {
    const packageId = safeDecodeURIComponent(creatorPackageVersionPageMatch[1] ?? '');
    const editionId = safeDecodeURIComponent(creatorPackageVersionPageMatch[2] ?? '');
    if (packageId === null || editionId === null) {
      return badPathEncodingResponse();
    }
    return creatorPackageRoutes.listVersions(request, packageId, editionId);
  }
  const creatorPackageMatch = pathname.match(/^\/api\/creator\/packages\/([^/]+)$/);
  if (creatorPackageMatch && creatorPackageRoutes) {
    const catalogProductId = safeDecodeURIComponent(creatorPackageMatch[1] ?? '');
    if (catalogProductId === null) {
      return badPathEncodingResponse();
    }
    return creatorPackageRoutes.getPackage(request, catalogProductId);
  }
  const creatorPackageVersionMatch = pathname.match(
    /^\/api\/creator\/packages\/by-package\/([^/]+)\/editions\/([^/]+)\/versions\/([^/]+)$/
  );
  if (creatorPackageVersionMatch && creatorPackageRoutes) {
    const packageId = safeDecodeURIComponent(creatorPackageVersionMatch[1] ?? '');
    const editionId = safeDecodeURIComponent(creatorPackageVersionMatch[2] ?? '');
    const versionId = safeDecodeURIComponent(creatorPackageVersionMatch[3] ?? '');
    if (packageId === null || editionId === null || versionId === null) {
      return badPathEncodingResponse();
    }
    return creatorPackageRoutes.deleteVersion(request, packageId, editionId, versionId);
  }
  const creatorPackageVersionCancelMatch = pathname.match(
    /^\/api\/creator\/packages\/by-package\/([^/]+)\/editions\/([^/]+)\/versions\/([^/]+)\/cancel$/
  );
  if (creatorPackageVersionCancelMatch && creatorPackageRoutes) {
    const packageId = safeDecodeURIComponent(creatorPackageVersionCancelMatch[1] ?? '');
    const editionId = safeDecodeURIComponent(creatorPackageVersionCancelMatch[2] ?? '');
    const versionId = safeDecodeURIComponent(creatorPackageVersionCancelMatch[3] ?? '');
    if (packageId === null || editionId === null || versionId === null) {
      return badPathEncodingResponse();
    }
    return creatorPackageRoutes.cancelVersion(request, packageId, editionId, versionId);
  }
  const creatorPackageVersionStatusMatch = pathname.match(
    /^\/api\/creator\/packages\/by-package\/([^/]+)\/editions\/([^/]+)\/versions\/([^/]+)\/status$/
  );
  if (creatorPackageVersionStatusMatch && creatorPackageRoutes) {
    const packageId = safeDecodeURIComponent(creatorPackageVersionStatusMatch[1] ?? '');
    const editionId = safeDecodeURIComponent(creatorPackageVersionStatusMatch[2] ?? '');
    const versionId = safeDecodeURIComponent(creatorPackageVersionStatusMatch[3] ?? '');
    if (packageId === null || editionId === null || versionId === null) {
      return badPathEncodingResponse();
    }
    return creatorPackageRoutes.getVersionStatus(request, packageId, editionId, versionId);
  }
  const creatorPackageEditionMatch = pathname.match(
    /^\/api\/creator\/packages\/([^/]+)\/editions\/([^/]+)$/
  );
  if (creatorPackageEditionMatch && creatorPackageRoutes) {
    const catalogProductId = safeDecodeURIComponent(creatorPackageEditionMatch[1] ?? '');
    const editionId = safeDecodeURIComponent(creatorPackageEditionMatch[2] ?? '');
    if (catalogProductId === null || editionId === null) {
      return badPathEncodingResponse();
    }
    return creatorPackageRoutes.manageEdition(request, catalogProductId, editionId);
  }
  const creatorPackageStorefrontMatch = pathname.match(
    /^\/api\/creator\/packages\/([^/]+)\/storefronts\/([^/]+)$/
  );
  if (creatorPackageStorefrontMatch && creatorPackageRoutes) {
    const catalogProductId = safeDecodeURIComponent(creatorPackageStorefrontMatch[1] ?? '');
    const targetCatalogProductId = safeDecodeURIComponent(creatorPackageStorefrontMatch[2] ?? '');
    if (catalogProductId === null || targetCatalogProductId === null) {
      return badPathEncodingResponse();
    }
    return creatorPackageRoutes.manageStorefrontBinding(
      request,
      catalogProductId,
      targetCatalogProductId
    );
  }
  const creatorPackagePresentationMatch = pathname.match(
    /^\/api\/creator\/packages\/by-package\/([^/]+)\/presentation$/
  );
  if (creatorPackagePresentationMatch && vpmRoutes) {
    const packageId = safeDecodeURIComponent(creatorPackagePresentationMatch[1] ?? '');
    if (packageId === null) {
      return badPathEncodingResponse();
    }
    return vpmRoutes.manageCreatorPresentation(request, packageId);
  }
  const creatorPackageVccLinkMatch = pathname.match(
    /^\/api\/creator\/packages\/by-package\/([^/]+)\/vcc-link$/
  );
  if (creatorPackageVccLinkMatch && vpmRoutes) {
    const packageId = safeDecodeURIComponent(creatorPackageVccLinkMatch[1] ?? '');
    if (packageId === null) {
      return badPathEncodingResponse();
    }
    return vpmRoutes.manageCreatorLink(request, packageId);
  }
  const creatorPackageBootstrapMatch = pathname.match(
    /^\/api\/creator\/packages\/by-package\/([^/]+)\/bootstrap$/
  );
  if (creatorPackageBootstrapMatch && vpmRoutes) {
    const packageId = safeDecodeURIComponent(creatorPackageBootstrapMatch[1] ?? '');
    if (packageId === null) {
      return badPathEncodingResponse();
    }
    return vpmRoutes.downloadCreatorBootstrap(request, packageId);
  }
  const creatorPackageUnityBootstrapMatch = pathname.match(
    /^\/api\/creator\/packages\/by-package\/([^/]+)\/bootstrap\.unitypackage$/
  );
  if (creatorPackageUnityBootstrapMatch && vpmRoutes) {
    const packageId = safeDecodeURIComponent(creatorPackageUnityBootstrapMatch[1] ?? '');
    if (packageId === null) {
      return badPathEncodingResponse();
    }
    return vpmRoutes.downloadCreatorUnityPackage(request, packageId);
  }
  if (pathname === '/api/creator/uploads/authorize' && creatorUploadRoutes) {
    return creatorUploadRoutes.authorizeUpload(request);
  }
  if (pathname === '/api/v2/package-installs/sessions') {
    if (!packageInstallSessionRoute) {
      return Response.json(
        { error: 'Package install sessions are not configured' },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
      );
    }
    return packageInstallSessionRoute(request);
  }
  if (pathname === '/api/v2/package-installs/renewals') {
    if (!packageInstallSessionRenewalRoute) {
      return Response.json(
        { error: 'Package install session renewal is not configured' },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
      );
    }
    return packageInstallSessionRenewalRoute(request);
  }
  if (pathname === '/api/v2/package-installs/authorizations') {
    if (!packageOperationAuthorizationRoute) {
      return Response.json(
        { error: 'Package operation authorizations are not configured' },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
      );
    }
    return packageOperationAuthorizationRoute(request);
  }
  if (pathname === PACKAGE_MATERIALIZATION_STATUS_PATH) {
    if (!packageMaterializationStatusRoute) {
      return Response.json(
        { error: 'Protected materialization is not configured' },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
      );
    }
    return packageMaterializationStatusRoute(request);
  }
  if (pathname.startsWith('/api/v2/package-installer/tuf/')) {
    if (!packageInstallerTufRoute) {
      return Response.json(
        { error: 'Package installer trust repository is not configured' },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
      );
    }
    return packageInstallerTufRoute(request);
  }
  const vpmAliasPublicationMatch = pathname.match(
    /^\/api\/vpm\/alias-publications\/([^/]+)\/([^/]+)\.zip$/
  );
  if (vpmAliasPublicationMatch && vpmRoutes) {
    const publicationId = safeDecodeURIComponent(vpmAliasPublicationMatch[1] ?? '');
    const version = safeDecodeURIComponent(vpmAliasPublicationMatch[2] ?? '');
    if (publicationId === null || version === null) {
      return badPathEncodingResponse();
    }
    return vpmRoutes.serveAliasPublication(request, publicationId, version);
  }
  const creatorVpmIndexMatch = pathname.match(/^\/api\/vpm\/access\/([^/]+)\/index\.json$/);
  if (creatorVpmIndexMatch && vpmRoutes) {
    const linkId = safeDecodeURIComponent(creatorVpmIndexMatch[1] ?? '');
    if (linkId === null) {
      return badPathEncodingResponse();
    }
    return vpmRoutes.serveCreatorLinkIndex(request, linkId);
  }
  if (pathname === '/api/connect/bootstrap' && connectRoutes) {
    return connectRoutes.exchangeConnectBootstrap(request);
  }
  if (pathname === '/api/connect/session-status' && connectRoutes) {
    return connectRoutes.getDashboardSessionStatus(request);
  }
  if (pathname === '/api/connect/ensure-tenant' && connectRoutes) {
    return connectRoutes.ensureTenant(request);
  }
  if (pathname === '/api/connect/user/providers' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getUserProviders(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/connect/user/verify/start' && connectRoutes) {
    return connectRoutes.postUserVerifyStart(request);
  }
  const buyerProductAccessMatch = pathname.match(/^\/api\/connect\/user\/product-access\/([^/]+)$/);
  if (buyerProductAccessMatch && connectRoutes) {
    const catalogProductId = safeDecodeURIComponent(buyerProductAccessMatch[1]);
    if (catalogProductId === null) {
      return badPathEncodingResponse();
    }
    if (request.method === 'GET') {
      return connectRoutes.getBuyerProductAccess(request, catalogProductId);
    }
    if (request.method === 'POST') {
      return connectRoutes.postBuyerProductAccessVerificationIntent(request, catalogProductId);
    }
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const userVerificationIntentMatch = pathname.match(
    /^\/api\/connect\/user\/verification-intents\/([^/]+)$/
  );
  if (userVerificationIntentMatch && connectRoutes) {
    const intentId = safeDecodeURIComponent(userVerificationIntentMatch[1]);
    if (intentId === null) {
      return badPathEncodingResponse();
    }
    if (request.method === 'GET') {
      return connectRoutes.getUserVerificationIntent(request, intentId);
    }
  }
  const userVerificationEntitlementMatch = pathname.match(
    /^\/api\/connect\/user\/verification-intents\/([^/]+)\/verify-entitlement$/
  );
  if (userVerificationEntitlementMatch && connectRoutes) {
    const intentId = safeDecodeURIComponent(userVerificationEntitlementMatch[1]);
    if (intentId === null) {
      return badPathEncodingResponse();
    }
    return connectRoutes.postUserVerificationEntitlement(request, intentId);
  }
  const userVerificationProviderLinkMatch = pathname.match(
    /^\/api\/connect\/user\/verification-intents\/([^/]+)\/verify-provider-link$/
  );
  if (userVerificationProviderLinkMatch && connectRoutes) {
    const intentId = safeDecodeURIComponent(userVerificationProviderLinkMatch[1]);
    if (intentId === null) {
      return badPathEncodingResponse();
    }
    return connectRoutes.postUserVerificationProviderLink(request, intentId);
  }
  const userVerificationManualMatch = pathname.match(
    /^\/api\/connect\/user\/verification-intents\/([^/]+)\/manual-license$/
  );
  if (userVerificationManualMatch && connectRoutes) {
    const intentId = safeDecodeURIComponent(userVerificationManualMatch[1]);
    if (intentId === null) {
      return badPathEncodingResponse();
    }
    return connectRoutes.postUserVerificationManualLicense(request, intentId);
  }
  if (pathname === '/api/connect/user/guilds' && connectRoutes) {
    return connectRoutes.getUserGuilds(request);
  }
  if (pathname === '/api/connect/dashboard/shell' && connectRoutes) {
    return connectRoutes.getDashboardShell(request);
  }
  if (pathname === '/api/connect/creator-account' && connectRoutes) {
    return connectRoutes.activateCreatorAccount(request);
  }
  if (pathname === '/api/connect/branding' && connectRoutes) {
    return connectRoutes.getViewerBranding(request);
  }
  if (pathname === '/api/connect/user/connections' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getUserConnections(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/connect/user/accounts' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getUserAccounts(request);
    if (request.method === 'DELETE') return connectRoutes.deleteUserAccount(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/connect/user/accounts/refresh' && connectRoutes) {
    if (request.method === 'POST') return connectRoutes.refreshUserAccounts(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/connect/user/certificates' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getUserCertificates(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/connect/creator/certificates' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getCreatorCertificates(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/connect/user/certificates/checkout' && connectRoutes) {
    return connectRoutes.createUserCertificateCheckout(request);
  }
  if (pathname === '/api/connect/creator/certificates/checkout' && connectRoutes) {
    return connectRoutes.createCreatorCertificateCheckout(request);
  }
  if (pathname === '/api/connect/user/certificates/portal' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getUserCertificatePortal(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/connect/creator/certificates/portal' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getCreatorCertificatePortal(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/account-recovery/start' && accountSecurityRoutes) {
    return accountSecurityRoutes.startRecovery(request);
  }
  if (pathname === '/api/account-recovery/verify-email' && accountSecurityRoutes) {
    return accountSecurityRoutes.verifyRecoveryEmail(request);
  }
  if (pathname === '/api/account-recovery/verify-backup-code' && accountSecurityRoutes) {
    return accountSecurityRoutes.verifyRecoveryBackupCode(request);
  }
  if (pathname === '/api/account-security/recovery-email/verify' && accountSecurityRoutes) {
    return accountSecurityRoutes.verifyRecoveryContactEnrollment(request);
  }
  if (pathname === '/api/connect/user/certificates/reconcile' && connectRoutes) {
    return connectRoutes.reconcileUserCertificateBilling(request);
  }
  if (pathname === '/api/connect/creator/certificates/reconcile' && connectRoutes) {
    return connectRoutes.reconcileCreatorCertificateBilling(request);
  }
  if (pathname === '/api/connect/user/certificates/revoke' && connectRoutes) {
    return connectRoutes.revokeUserCertificate(request);
  }
  if (pathname === '/api/connect/creator/certificates/revoke' && connectRoutes) {
    return connectRoutes.revokeCreatorCertificate(request);
  }
  if (pathname === '/api/connect/user/licenses' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getUserLicenses(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/forensics/packages' && forensicsRoutes) {
    if (request.method === 'GET') return forensicsRoutes.listPackages(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/forensics/lookup' && forensicsRoutes) {
    if (request.method === 'POST') return forensicsRoutes.lookup(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const entitlementRevokeMatch = pathname.match(/^\/api\/connect\/user\/entitlements\/([^/]+)$/);
  if (entitlementRevokeMatch && connectRoutes) {
    return connectRoutes.revokeUserEntitlement(request, entitlementRevokeMatch[1]);
  }
  if (pathname === '/api/connect/user/oauth/grants' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getUserOAuthGrants(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const oauthGrantRevokeMatch = pathname.match(/^\/api\/connect\/user\/oauth\/grants\/([^/]+)$/);
  if (oauthGrantRevokeMatch && connectRoutes) {
    return connectRoutes.revokeUserOAuthGrant(request, oauthGrantRevokeMatch[1]);
  }
  if (pathname === '/api/connect/user/data-export' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getUserDataExport(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  if (pathname === '/api/connect/user/gdpr-delete' && connectRoutes) {
    return connectRoutes.requestUserAccountDeletion(request);
  }
  // Dispatch to provider connect plugins (gumroad, jinxxy, lemonsqueezy, payhip, ...)
  // Adding a new provider: add it to apps/api/src/providers/connect/index.ts only
  if (connectRoutes) {
    const pluginResponse = await connectRoutes.dispatchPlugin(request.method, pathname, request);
    if (pluginResponse) return pluginResponse;
  }
  if (pathname === '/api/connect/status' && connectRoutes) {
    return connectRoutes.getStatus(request);
  }
  if (pathname === '/api/connect/payhip/product-key' && connectRoutes) {
    return connectRoutes.payhipProductKey(request);
  }
  // Generic per-product credential route: POST /api/connect/:provider/product-credential
  const productCredentialMatch = pathname.match(/^\/api\/connect\/([^/]+)\/product-credential$/);
  if (productCredentialMatch && connectRoutes) {
    return connectRoutes.genericProductCredential(request, productCredentialMatch[1]);
  }
  // Setup session management
  if (pathname === '/api/connect/create-token' && connectRoutes) {
    return connectRoutes.createTokenEndpoint(request);
  }
  if (pathname === '/api/setup/create-session' && connectRoutes) {
    return connectRoutes.createSessionEndpoint(request);
  }
  if (pathname === '/api/setup/discord-role-session' && connectRoutes) {
    return connectRoutes.createDiscordRoleSession(request);
  }
  if (pathname === '/api/setup/discord-role-session/exchange' && connectRoutes) {
    return connectRoutes.exchangeDiscordRoleSetupSession(request);
  }
  if (pathname === '/api/setup/discord-role-oauth/begin' && connectRoutes) {
    return connectRoutes.discordRoleOAuthBegin(request);
  }
  if (pathname === '/api/setup/discord-role-oauth/callback' && connectRoutes) {
    return connectRoutes.discordRoleOAuthCallback(request);
  }
  if (pathname === '/api/setup/discord-role-guilds' && connectRoutes) {
    return connectRoutes.getDiscordRoleGuilds(request);
  }
  if (pathname === '/api/setup/discord-role-save' && connectRoutes) {
    return connectRoutes.saveDiscordRoleSelection(request);
  }
  if (pathname === '/api/setup/discord-role-result' && connectRoutes) {
    return connectRoutes.getDiscordRoleResult(request);
  }
  // Connections API
  if (pathname === '/api/connections' && connectRoutes) {
    if (request.method === 'DELETE') {
      return connectRoutes.disconnectConnectionHandler(request);
    }
    return connectRoutes.listConnectionsHandler(request);
  }
  if (pathname === '/api/connect/settings' && connectRoutes) {
    if (request.method === 'POST') {
      return connectRoutes.updateSettingHandler(request);
    }
    return connectRoutes.getSettingsHandler(request);
  }
  if (pathname === '/api/connect/creator-identity' && connectRoutes) {
    return connectRoutes.manageCreatorIdentity(request);
  }
  if (pathname === '/api/connect/guild/channels' && connectRoutes) {
    return connectRoutes.getGuildChannels(request);
  }
  if (pathname === '/api/connect/public-api/keys' && connectRoutes) {
    if (request.method === 'POST') {
      return connectRoutes.createPublicApiKey(request);
    }
    return connectRoutes.listPublicApiKeys(request);
  }
  if (
    pathname.startsWith('/api/connect/public-api/keys/') &&
    connectRoutes &&
    request.method === 'POST'
  ) {
    const keyId = pathname.replace(/^\/api\/connect\/public-api\/keys\//, '').split('/')[0];
    const decodedKeyId = safeDecodeURIComponent(keyId);
    if (decodedKeyId === null) {
      return badPathEncodingResponse();
    }
    if (pathname.endsWith('/revoke')) {
      return connectRoutes.revokePublicApiKey(request, decodedKeyId);
    }
    if (pathname.endsWith('/rotate')) {
      return connectRoutes.rotatePublicApiKey(request, decodedKeyId);
    }
  }
  if (pathname === '/api/connect/oauth-apps' && connectRoutes) {
    if (request.method === 'POST') {
      return connectRoutes.createOAuthApp(request);
    }
    return connectRoutes.listOAuthApps(request);
  }
  if (
    pathname.startsWith('/api/connect/oauth-apps/') &&
    pathname.endsWith('/regenerate-secret') &&
    connectRoutes &&
    request.method === 'POST'
  ) {
    const appId = pathname
      .replace(/^\/api\/connect\/oauth-apps\//, '')
      .replace(/\/regenerate-secret$/, '');
    const decodedAppId = safeDecodeURIComponent(appId);
    if (decodedAppId === null) {
      return badPathEncodingResponse();
    }
    return connectRoutes.regenerateOAuthAppSecret(request, decodedAppId);
  }
  if (pathname.startsWith('/api/connect/oauth-apps/') && connectRoutes) {
    const appId = safeDecodeURIComponent(pathname.replace(/^\/api\/connect\/oauth-apps\//, ''));
    if (appId === null) {
      return badPathEncodingResponse();
    }
    if (request.method === 'PUT') return connectRoutes.updateOAuthApp(request, appId);
    if (request.method === 'DELETE') return connectRoutes.deleteOAuthApp(request, appId);
  }

  // Collab routes
  if (pathname.startsWith('/api/collab/') && collabRoutes) {
    return collabRoutes.handleCollabRequest(request);
  }

  // Public API v2, must be checked before v1 since both share /api/public/ prefix
  if (pathname.startsWith('/api/public/v2/') && publicV2Routes) {
    const response = await publicV2Routes.handleRequest(request, pathname);
    if (response) return withExtraHeaders(response, publicApiRateLimitHeaders);
  }

  // Public verification API
  if (pathname.startsWith('/api/public/') && publicRoutes) {
    const response = await publicRoutes.handleRequest(request, pathname);
    if (response) return withExtraHeaders(response, publicApiRateLimitHeaders);
  }

  // Suite verification API (OAuth 2.1 protected)
  if (pathname.startsWith('/api/suite/') && suiteRoutes) {
    const response = await suiteRoutes.handleRequest(request, pathname);
    if (response) return response;
  }

  const legacyFrontendRoute =
    pathname === '/connect'
      ? '/connect'
      : pathname === '/sign-in'
        ? '/sign-in'
        : pathname === '/dashboard' || pathname === '/dashboard.html'
          ? '/dashboard'
          : pathname === '/oauth/login'
            ? '/oauth/login'
            : pathname === '/oauth/error'
              ? '/oauth/error'
              : pathname === '/oauth/consent'
                ? '/oauth/consent'
                : pathname === '/verify-success' || pathname === '/verify-success.html'
                  ? '/verify/success'
                  : pathname === '/verify-error' || pathname === '/verify-error.html'
                    ? '/verify/error'
                    : pathname === '/legal/privacy-policy' ||
                        pathname === '/legal/privacy-policy.html'
                      ? '/legal/privacy-policy'
                      : pathname === '/legal/terms-of-service' ||
                          pathname === '/legal/terms-of-service.html'
                        ? '/legal/terms-of-service'
                        : pathname === '/discord-role-setup' ||
                            pathname === '/discord-role-setup.html'
                          ? '/setup/discord-role'
                          : pathname === '/jinxxy-setup' || pathname === '/jinxxy-setup.html'
                            ? '/setup/jinxxy'
                            : pathname === '/lemonsqueezy-setup' ||
                                pathname === '/lemonsqueezy-setup.html'
                              ? '/setup/lemonsqueezy'
                              : pathname === '/payhip-setup' || pathname === '/payhip-setup.html'
                                ? '/setup/payhip'
                                : pathname === '/vrchat-verify' ||
                                    pathname === '/vrchat-verify.html'
                                  ? '/setup/vrchat'
                                  : pathname === '/collab-invite' ||
                                      pathname === '/collab-invite.html'
                                    ? '/collab-invite'
                                    : null;

  if (legacyFrontendRoute && resolvedFrontendOrigin) {
    const response = redirectToFrontendRoute(url, resolvedFrontendOrigin, legacyFrontendRoute);
    if (response) {
      return response;
    }
    return createLegacyFrontendMovedResponse();
  }

  // Verification callback routes (pattern matching)
  if (pathname.startsWith('/api/verification/callback/')) {
    const handler = verificationRoutes?.get(pathname);
    if (handler) {
      return handler(request);
    }
  }

  // 404 for unknown routes
  // API routes get JSON; page requests get styled HTML 404
  if (pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const filePath = `${import.meta.dir}/../public/404.html`;
  let html = await Bun.file(filePath).text();
  html = html.replaceAll('__API_BASE__', resolvedFrontendOrigin ?? resolvedApiBaseUrl);
  return new Response(html, {
    status: 404,
    headers: HTML_RESPONSE_SECURITY_HEADERS,
  });
}

/**
 * Request handler for the Bun HTTP server.
 * Handles CORS for the frontend subdomain, then delegates to routeRequest.
 */
async function handleRequest(request: Request): Promise<Response> {
  const requestId = request.headers.get('x-request-id')?.trim() || crypto.randomUUID();
  const origin = request.headers.get('origin');

  return withApiRequestSpan(request, requestId, async () => {
    // Build CORS headers for approved browser origins used by the app UI.
    const corsHeaders = buildApiCorsHeaders({ allowedOrigins: allowedCorsOrigins, origin });

    annotateApiSpan({
      requestId,
      origin: origin ?? 'none',
    });

    // CORS preflight - respond immediately.
    if (request.method === 'OPTIONS') {
      const preflightResponse = new Response(null, { status: 204, headers: corsHeaders });
      preflightResponse.headers.set('X-Request-Id', requestId);
      return preflightResponse;
    }

    const response = await routeRequest(request);
    const traceIds = getActiveTraceIds();

    const next = new Response(response.body, response);
    next.headers.set('X-Request-Id', requestId);
    if (traceIds.traceId) {
      next.headers.set('X-Trace-Id', traceIds.traceId);
    }
    for (const [k, v] of Object.entries(corsHeaders)) {
      next.headers.set(k, v);
    }
    return applyResponseSecurityHeaders(next);
  });
}

/**
 * Builds the same request handler used by the production Bun server.
 */
export function createApiRequestHandler(
  webhookBaseUrl?: string
): (request: Request) => Promise<Response> {
  auth = initializeAuth(webhookBaseUrl);
  return handleRequest;
}

/**
 * Main entry point
 */
async function main() {
  const env = await loadEnvAsync();
  initApiObservability(process.env);

  logger.info('Starting YUCP API server', {
    nodeEnv: env.NODE_ENV,
    infisicalUrl: env.INFISICAL_URL,
    infisicalEnv: process.env.INFISICAL_ENV ?? 'dev (default)',
  });

  // Detect tunnel URL for webhook callbacks (Tailscale Funnel or ngrok)
  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  const hostname = process.env.HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const tunnel = await detectTunnelUrl(port);
  if (tunnel.provider !== 'none') {
    logger.info(`Tunnel detected (${tunnel.provider})`, { publicUrl: tunnel.url });
  }

  const publicBaseUrl =
    tunnel.provider !== 'none' ? tunnel.url : (env.SITE_URL ?? `http://localhost:${port}`);

  const requestHandler = createApiRequestHandler(
    tunnel.provider !== 'none' ? tunnel.url : undefined
  );

  // Start HTTP server
  const server = Bun.serve({
    hostname,
    port,
    fetch: requestHandler,
  });

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await server.stop(false);
    await packageInstallerTufRuntime?.close?.();
    await packageOperationAuthorizationDatabase?.end({ timeout: 1 });
    await vpmAliasPublicationDatabase?.end({ timeout: 1 });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', () => {
    void stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    void stop('SIGTERM');
  });

  logger.info('API server ready', {
    port,
    hostname,
    publicUrl: publicBaseUrl,
    tunnelProvider: tunnel.provider,
    authProvider: 'Convex (direct)',
    authBaseUrl: `${env.CONVEX_SITE_URL ?? '(missing)'}/api/auth`,
    installRoutes: '/api/install/*',
    healthCheck: '/health',
  });
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error('Failed to start API server', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}

// Export auth utilities for external use
export { auth };
export type { Auth };
