// API entrypoint
// Convex hosts Better Auth for creator authentication.
// This Bun server hosts the app pages, connect flows, and integration routes.

import path from 'node:path';
import { createLogger, getInternalRpcSharedSecret } from '@yucp/shared';
import { buildAllowedBrowserOrigins } from '@yucp/shared/authOrigins';
import { type Auth, createAuth } from './auth';
import { createInternalRpcRouter, INTERNAL_RPC_PATH } from './internalRpc/router';
import { getConfiguredConvexSiteUrlForProxy } from './lib/convexSiteProxy';
import { getRequired, loadEnv, loadEnvAsync } from './lib/env';
import {
  createLegacyFrontendMovedResponse,
  HTML_RESPONSE_SECURITY_HEADERS,
  isLegacyFrontendAsset,
} from './lib/legacyFrontend';
import { detectTunnelUrl } from './lib/tunnel';
import {
  createConnectRoutes,
  createProviderPlatformRoutes,
  createVerificationRoutes,
  createWebhookHandler,
  type InstallConfig,
  mountInstallRoutes,
  mountVerificationRouteHandlers,
  type VerificationConfig,
} from './routes';
import { createCollabRoutes } from './routes/collab';
import { createPublicRoutes } from './routes/public';
import { createPublicV2Routes } from './routes/publicV2';
import { createSuiteRoutes } from './routes/suite';
import { createVersionRouteHandler } from './routes/version';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// Global auth instance
let auth: Auth | null = null;

// Route handlers (initialized after auth)
let installRoutes: Map<string, (request: Request) => Promise<Response>> | null = null;
let verificationRoutes: Map<string, (request: Request) => Promise<Response>> | null = null;
let verificationHandlers: ReturnType<typeof createVerificationRoutes> | null = null;
let connectRoutes: ReturnType<typeof createConnectRoutes> | null = null;
let providerPlatformRoutes: ReturnType<typeof createProviderPlatformRoutes> | null = null;
let webhookHandler: ReturnType<typeof createWebhookHandler> | null = null;
let collabRoutes: ReturnType<typeof createCollabRoutes> | null = null;
let publicRoutes: ReturnType<typeof createPublicRoutes> | null = null;
let publicV2Routes: ReturnType<typeof createPublicV2Routes> | null = null;
let suiteRoutes: ReturnType<typeof createSuiteRoutes> | null = null;
let internalRpcRouter: ReturnType<typeof createInternalRpcRouter> | null = null;
let allowedCorsOrigins = new Set<string>();

// Resolved after initializeAuth - used for apiBase injection and CORS
let resolvedApiBaseUrl = 'http://localhost:3001';
let resolvedFrontendOrigin: string | null = null;
const RATE_LIMIT_BUCKETS = new Map<string, { count: number; resetAt: number }>();
const PUBLIC_BASE_DIR = path.resolve(import.meta.dir, '..', 'public');

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

function getClientAddress(request: Request): string {
  const cloudflareConnectingIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cloudflareConnectingIp) {
    return cloudflareConnectingIp;
  }

  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) {
    return realIp;
  }

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || 'unknown';
  }
  return 'unknown';
}

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

  getRequired('BETTER_AUTH_SECRET');
  if ((env.NODE_ENV ?? 'development') === 'production') {
    getRequired('INTERNAL_SERVICE_AUTH_SECRET');
    getRequired('VRCHAT_PENDING_STATE_SECRET');
    getRequired('ENCRYPTION_SECRET');
  }
  const configuredPolarKeys = [
    env.POLAR_ACCESS_TOKEN,
    env.POLAR_WEBHOOK_SECRET,
    env.POLAR_CERT_PRODUCTS_JSON,
  ].filter((value) => typeof value === 'string' && value.trim()).length;
  if (configuredPolarKeys > 0 && configuredPolarKeys < 3) {
    throw new Error(
      'POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET, and POLAR_CERT_PRODUCTS_JSON must be configured together'
    );
  }
  const siteUrl = env.SITE_URL ?? 'http://localhost:3001';
  // Use a tunnel only for externally reachable webhook/install callbacks.
  const publicBaseUrl = webhookBaseUrl ?? siteUrl;
  const frontendUrl = env.FRONTEND_URL ?? siteUrl;

  resolvedApiBaseUrl = publicBaseUrl;
  resolvedFrontendOrigin = new URL(frontendUrl).origin;
  allowedCorsOrigins = new Set(
    buildAllowedBrowserOrigins({
      siteUrl,
      frontendUrl,
      additionalOrigins: [publicBaseUrl],
    })
  );

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
  };
  verificationHandlers = createVerificationRoutes(verificationConfig);
  verificationRoutes = mountVerificationRouteHandlers(verificationHandlers);

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
    encryptionSecret,
  } satisfies Parameters<typeof createConnectRoutes>[1];
  connectRoutes = createConnectRoutes(auth, connectConfig);

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
    if (isRateLimited(`public:${clientAddress}`, 120, 60_000)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
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

  // Version endpoint — used by the web dashboard for version skew detection
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

      // ── RFC 8252 loopback redirect_uri rewrite for token exchange ──────────
      // During authorize, /api/yucp/oauth/authorize already replaced the
      // loopback redirect_uri with the fixed Convex callback URL so that
      // Better Auth can validate it.  During token exchange the client sends
      // the original loopback URI again (as required by RFC 6749 §4.1.3), but
      // Better Auth will reject it because it no longer matches what was stored.
      // Solution: when we see a loopback (127.0.0.1 or ::1) redirect_uri in the
      // token exchange body we silently rewrite it to the same fixed URL.
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
        const params = new URLSearchParams(text);
        const redir = params.get('redirect_uri') ?? '';
        const hadResource = params.has('resource');
        if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(redir)) {
          params.set('redirect_uri', `${convexSiteUrl}/api/yucp/oauth/callback`);
        }
        // Always inject the resource parameter so the oauth-provider issues a
        // JWT access token (audience-bound) rather than an opaque token.
        // Without `resource`, isJwtAccessToken is false and verifyAccessToken
        // later fails with "no token payload".
        if (!hadResource) {
          params.set('resource', 'yucp-public-api');
        }
        const rewritten = params.toString();
        logger.info('Token exchange rewrite', {
          grant_type: params.get('grant_type'),
          redirect_uri_rewritten: redir ? redir.substring(0, 40) : '(none)',
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
      // For redirect responses pass them through — but differently per method:
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

  // Provider products route — generic handler for all providers (/api/:provider/products)
  const productsMatch = pathname.match(/^\/api\/([^/]+)\/products$/);
  if (productsMatch && request.method === 'POST') {
    const providerSlug = productsMatch[1];
    const { handleProviderProducts } = await import('./routes/products');
    return handleProviderProducts(request, providerSlug);
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
  const userVerificationIntentMatch = pathname.match(
    /^\/api\/connect\/user\/verification-intents\/([^/]+)$/
  );
  if (userVerificationIntentMatch && connectRoutes) {
    if (request.method === 'GET') {
      return connectRoutes.getUserVerificationIntent(
        request,
        decodeURIComponent(userVerificationIntentMatch[1])
      );
    }
  }
  const userVerificationEntitlementMatch = pathname.match(
    /^\/api\/connect\/user\/verification-intents\/([^/]+)\/verify-entitlement$/
  );
  if (userVerificationEntitlementMatch && connectRoutes) {
    return connectRoutes.postUserVerificationEntitlement(
      request,
      decodeURIComponent(userVerificationEntitlementMatch[1])
    );
  }
  const userVerificationProviderLinkMatch = pathname.match(
    /^\/api\/connect\/user\/verification-intents\/([^/]+)\/verify-provider-link$/
  );
  if (userVerificationProviderLinkMatch && connectRoutes) {
    return connectRoutes.postUserVerificationProviderLink(
      request,
      decodeURIComponent(userVerificationProviderLinkMatch[1])
    );
  }
  const userVerificationManualMatch = pathname.match(
    /^\/api\/connect\/user\/verification-intents\/([^/]+)\/manual-license$/
  );
  if (userVerificationManualMatch && connectRoutes) {
    return connectRoutes.postUserVerificationManualLicense(
      request,
      decodeURIComponent(userVerificationManualMatch[1])
    );
  }
  if (pathname === '/api/connect/user/guilds' && connectRoutes) {
    return connectRoutes.getUserGuilds(request);
  }
  if (pathname === '/api/connect/dashboard/shell' && connectRoutes) {
    return connectRoutes.getDashboardShell(request);
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
  // Pre-intercept: Gumroad callback is dual-purpose — may be a verification flow, not a connect flow
  if (pathname === '/api/connect/gumroad/callback') {
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    if (state?.startsWith('verify_gumroad:')) {
      const handler = verificationRoutes?.get('/api/verification/callback/gumroad');
      if (handler) {
        // Rewrite the URL so handleVerificationCallback extracts the correct mode 'gumroad'
        const verifyUrl = new URL(request.url);
        verifyUrl.pathname = '/api/verification/callback/gumroad';
        const verifyRequest = new Request(verifyUrl.toString(), request);
        return handler(verifyRequest);
      }
    }
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
    if (pathname.endsWith('/revoke')) {
      return connectRoutes.revokePublicApiKey(request, decodeURIComponent(keyId));
    }
    if (pathname.endsWith('/rotate')) {
      return connectRoutes.rotatePublicApiKey(request, decodeURIComponent(keyId));
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
    return connectRoutes.regenerateOAuthAppSecret(request, decodeURIComponent(appId));
  }
  if (pathname.startsWith('/api/connect/oauth-apps/') && connectRoutes) {
    const appId = decodeURIComponent(pathname.replace(/^\/api\/connect\/oauth-apps\//, ''));
    if (request.method === 'PUT') return connectRoutes.updateOAuthApp(request, appId);
    if (request.method === 'DELETE') return connectRoutes.deleteOAuthApp(request, appId);
  }

  // Collab routes
  if (pathname.startsWith('/api/collab/') && collabRoutes) {
    return collabRoutes.handleCollabRequest(request);
  }

  // Public API v2 — must be checked before v1 since both share /api/public/ prefix
  if (pathname.startsWith('/api/public/v2/') && publicV2Routes) {
    const response = await publicV2Routes.handleRequest(request, pathname);
    if (response) return response;
  }

  // Public verification API
  if (pathname.startsWith('/api/public/') && publicRoutes) {
    const response = await publicRoutes.handleRequest(request, pathname);
    if (response) return response;
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
  // Build CORS headers for approved browser origins used by the app UI.
  const corsHeaders: Record<string, string> = {};
  const origin = request.headers.get('origin');
  if (origin && allowedCorsOrigins.has(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
    corsHeaders['Access-Control-Allow-Credentials'] = 'true';
    corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
    corsHeaders['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    corsHeaders.Vary = 'Origin';
  }

  // CORS preflight - respond immediately.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const response = await routeRequest(request);

  // Append CORS headers to every response when the request came from the frontend origin.
  if (Object.keys(corsHeaders).length > 0) {
    const next = new Response(response.body, response);
    for (const [k, v] of Object.entries(corsHeaders)) next.headers.set(k, v);
    return next;
  }
  return response;
}

/**
 * Main entry point
 */
async function main() {
  const env = await loadEnvAsync();

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

  // Initialize Better Auth (pass tunnel URL for webhook base if detected)
  auth = initializeAuth(tunnel.provider !== 'none' ? tunnel.url : undefined);

  // Start HTTP server
  Bun.serve({
    hostname,
    port,
    fetch: handleRequest,
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

main().catch((err) => {
  logger.error('Failed to start API server', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});

// Export auth utilities for external use
export { auth };
export type { Auth };
