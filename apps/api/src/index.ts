// API entrypoint
// Convex hosts Better Auth for creator authentication.
// This Bun server hosts the app pages, connect flows, and integration routes.

import path from 'node:path';
import { createLogger } from '@yucp/shared';
import { type Auth, createAuth } from './auth';
import { createInternalRpcRouter, INTERNAL_RPC_PATH } from './internalRpc/router';
import {
  clearCookie,
  DISCORD_ROLE_SETUP_COOKIE,
  getCookieValue,
  SETUP_SESSION_COOKIE,
} from './lib/browserSessions';
import { getRequired, loadEnv, loadEnvAsync } from './lib/env';
import { resolveSetupSession } from './lib/setupSession';
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

// Source: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
function escapeForSingleQuotedJsString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/<\/script/gi, '<\\/script');
}

// Source: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function redirectPreservingFragment(targetUrl: string): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirecting...</title></head><body><p>Redirecting...</p><script>window.location.replace(${JSON.stringify(targetUrl)} + window.location.hash);</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Source: https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html
function getSafeRelativeRedirectTarget(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (!value.startsWith('/')) {
    return null;
  }

  if (value.startsWith('//')) {
    return null;
  }

  return value;
}

function getRelativeRequestTarget(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function buildSignInRouteUrl(browserBase: string, redirectTo: string): string {
  const signInUrl = new URL('/sign-in', `${browserBase.replace(/\/$/, '')}/`);
  signInUrl.searchParams.set('redirectTo', redirectTo);
  return signInUrl.toString();
}

async function handleAppSignOut(request: Request, url: URL, pathname: string): Promise<Response> {
  const signOutHeaders = new Headers({ 'Content-Type': 'application/json' });
  let revokedOnAuthServer = false;

  if (auth) {
    const { ok, setCookieHeaders } = await auth
      .signOut(request)
      .catch(() => ({ ok: false, setCookieHeaders: [] as string[] }));
    revokedOnAuthServer = ok;
    for (const cookie of setCookieHeaders) {
      signOutHeaders.append('Set-Cookie', cookie);
    }
  }

  // Clear the exact cookie names configured in auth/session.ts: yucp_session_token, yucp_csrf_token.
  // Legacy dot-notation names kept for belt-and-suspenders in case of prior config.
  for (const name of [
    'yucp_session_token',
    '__Secure-yucp_session_token',
    'yucp_csrf_token',
    '__Secure-yucp_csrf_token',
    // legacy dot-notation names from previous configuration
    'yucp.session_token',
    '__Secure-yucp.session_token',
    'yucp.session_data',
    '__Secure-yucp.session_data',
  ]) {
    signOutHeaders.append('Set-Cookie', clearCookie(name, request));
  }
  signOutHeaders.append('Set-Cookie', clearCookie(SETUP_SESSION_COOKIE, request));

  const redirectTo =
    getSafeRelativeRedirectTarget(url.searchParams.get('redirectTo')) ?? '/sign-in';
  const acceptsHtml =
    pathname === '/sign-out' || (request.headers.get('accept') ?? '').includes('text/html');

  if (acceptsHtml) {
    signOutHeaders.set('Location', redirectTo);
    return new Response(null, {
      status: 303,
      headers: signOutHeaders,
    });
  }

  return new Response(JSON.stringify({ success: revokedOnAuthServer, redirectTo }), {
    status: revokedOnAuthServer ? 200 : 502,
    headers: signOutHeaders,
  });
}

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

  getRequired('BETTER_AUTH_SECRET');
  getRequired('INTERNAL_RPC_SHARED_SECRET');
  if ((env.NODE_ENV ?? 'development') === 'production') {
    getRequired('INTERNAL_SERVICE_AUTH_SECRET');
    getRequired('VRCHAT_PENDING_STATE_SECRET');
    // ENCRYPTION_SECRET must be set independently from BETTER_AUTH_SECRET in production.
    // The fallback exists only for initial migration; using BETTER_AUTH_SECRET for
    // encryption means key rotation is impossible without re-encrypting all credentials.
    if (!env.ENCRYPTION_SECRET) {
      logger.error(
        'SECURITY: ENCRYPTION_SECRET is not set. Falling back to BETTER_AUTH_SECRET for ' +
          'credential encryption — set ENCRYPTION_SECRET to an independent secret to allow ' +
          'key rotation without a full credential re-encryption migration.'
      );
    }
  }
  const siteUrl = env.SITE_URL ?? 'http://localhost:3001';
  // Use a tunnel only for externally reachable webhook/install callbacks.
  const publicBaseUrl = webhookBaseUrl ?? siteUrl;
  const frontendUrl = siteUrl;

  resolvedApiBaseUrl = publicBaseUrl;
  resolvedFrontendOrigin = new URL(frontendUrl).origin;
  allowedCorsOrigins = new Set(
    [
      frontendUrl,
      publicBaseUrl,
      env.FRONTEND_URL,
      // Allow localhost origins only outside of production to avoid broadening
      // the cross-origin trust surface in deployed environments.
      ...((env.NODE_ENV ?? 'development') !== 'production'
        ? ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173']
        : []),
    ]
      .map(normalizeOrigin)
      .filter((origin): origin is string => Boolean(origin))
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
  if (env.FRONTEND_URL && env.FRONTEND_URL !== frontendUrl) {
    logger.warn('Ignoring FRONTEND_URL in favor of SITE_URL', {
      configuredFrontendUrl: env.FRONTEND_URL,
      siteUrl,
    });
  }

  auth = createAuth({
    baseUrl: siteUrl,
    convexSiteUrl,
  });

  // Initialize install routes for bot installation
  const installConfig: InstallConfig = {
    discordClientId: env.DISCORD_CLIENT_ID ?? '',
    discordClientSecret: env.DISCORD_CLIENT_SECRET ?? '',
    discordBotToken: env.DISCORD_BOT_TOKEN ?? '',
    baseUrl: publicBaseUrl,
    frontendUrl,
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
  };
  installRoutes = mountInstallRoutes(auth, installConfig);

  // Initialize verification routes
  const verificationConfig: VerificationConfig = {
    baseUrl: publicBaseUrl,
    frontendUrl,
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    gumroadClientId: env.GUMROAD_CLIENT_ID ?? env.GUMROAD_API_KEY,
    gumroadClientSecret: env.GUMROAD_CLIENT_SECRET ?? env.GUMROAD_SECRET_KEY,
    discordClientId: env.DISCORD_CLIENT_ID,
    discordClientSecret: env.DISCORD_CLIENT_SECRET,
    jinxxyClientId: env.JINXXY_API_KEY,
    jinxxyClientSecret: env.JINXXY_SECRET_KEY,
    // MIGRATION: When first deploying, existing encrypted data uses BETTER_AUTH_SECRET as the
    // encryption key. Re-encrypt all stored provider credentials after updating this env var.
    encryptionSecret: env.ENCRYPTION_SECRET ?? env.BETTER_AUTH_SECRET ?? '',
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
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    gumroadClientId: env.GUMROAD_CLIENT_ID ?? env.GUMROAD_API_KEY,
    gumroadClientSecret: env.GUMROAD_CLIENT_SECRET ?? env.GUMROAD_SECRET_KEY,
    // MIGRATION: When first deploying, existing encrypted data uses BETTER_AUTH_SECRET as the
    // encryption key. Re-encrypt all stored provider credentials after updating this env var.
    encryptionSecret: env.ENCRYPTION_SECRET ?? env.BETTER_AUTH_SECRET ?? '',
  } satisfies Parameters<typeof createConnectRoutes>[1];
  connectRoutes = createConnectRoutes(auth, connectConfig);

  providerPlatformRoutes = createProviderPlatformRoutes(auth, {
    apiBaseUrl: publicBaseUrl,
    frontendBaseUrl: frontendUrl,
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    // MIGRATION: When first deploying, existing encrypted data uses BETTER_AUTH_SECRET as the
    // encryption key. Re-encrypt all stored provider credentials after updating this env var.
    encryptionSecret: env.ENCRYPTION_SECRET ?? env.BETTER_AUTH_SECRET ?? '',
  });

  webhookHandler = createWebhookHandler({
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    // MIGRATION: When first deploying, existing encrypted data uses BETTER_AUTH_SECRET as the
    // encryption key. Re-encrypt all stored provider credentials after updating this env var.
    encryptionSecret: env.ENCRYPTION_SECRET ?? env.BETTER_AUTH_SECRET ?? '',
  });

  const collabConfig = {
    auth,
    apiBaseUrl: publicBaseUrl,
    frontendBaseUrl: frontendUrl,
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    // MIGRATION: When first deploying, existing encrypted data uses BETTER_AUTH_SECRET as the
    // encryption key. Re-encrypt all stored provider credentials after updating this env var.
    encryptionSecret: env.ENCRYPTION_SECRET ?? env.BETTER_AUTH_SECRET ?? '',
    discordClientId: env.DISCORD_CLIENT_ID ?? '',
    discordClientSecret: env.DISCORD_CLIENT_SECRET ?? '',
  } satisfies Parameters<typeof createCollabRoutes>[0];
  collabRoutes = createCollabRoutes(collabConfig);

  suiteRoutes = createSuiteRoutes({
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexSiteUrl,
  });

  publicRoutes = createPublicRoutes({
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexSiteUrl,
  });

  publicV2Routes = createPublicV2Routes({
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexSiteUrl,
    encryptionSecret: env.ENCRYPTION_SECRET ?? env.BETTER_AUTH_SECRET ?? '',
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
      convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
      encryptionSecret: env.ENCRYPTION_SECRET ?? env.BETTER_AUTH_SECRET ?? '',
      internalRpcSharedSecret: env.INTERNAL_RPC_SHARED_SECRET ?? '',
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
    if (isRateLimited(`connect:${clientAddress}`, 30, 60_000)) {
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

  if (pathname === '/dashboard-components.css') {
    const file = Bun.file(`${import.meta.dir}/../public/dashboard-components.css`);
    return new Response(file, {
      headers: { 'Content-Type': 'text/css; charset=utf-8' },
    });
  }

  if (pathname === '/dashboard.css') {
    const file = Bun.file(`${import.meta.dir}/../public/dashboard.css`);
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

  if (pathname === '/api/auth/sign-in/discord') {
    const callbackURL = url.searchParams.get('callbackURL');
    if (!callbackURL) {
      logger.warn('Discord sign-in bridge missing callbackURL', { pathname });
      return new Response(JSON.stringify({ error: 'callbackURL is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate callbackURL: must be a parseable absolute URL whose origin is in our allowlist.
    let callbackOrigin: string;
    try {
      const parsed = new URL(callbackURL);
      callbackOrigin = parsed.origin;
    } catch {
      logger.warn('Discord sign-in bridge received malformed callbackURL');
      return new Response(JSON.stringify({ error: 'Invalid callbackURL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!allowedCorsOrigins.has(callbackOrigin)) {
      logger.warn('Discord sign-in bridge rejected callbackURL with disallowed origin', {
        callbackOrigin,
      });
      return new Response(JSON.stringify({ error: 'callbackURL origin is not allowed' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const env = loadEnv();
    const convexSiteUrl = env.CONVEX_SITE_URL ?? '';
    if (!convexSiteUrl) {
      logger.error('Discord sign-in bridge missing CONVEX_SITE_URL');
      return new Response(JSON.stringify({ error: 'CONVEX_SITE_URL must be set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info('Starting Discord sign-in bridge', {
      callbackOrigin,
      requestOrigin: url.origin,
    });

    const authResponse = await fetch(
      `${convexSiteUrl.replace(/\/$/, '')}/api/auth/sign-in/social`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'discord',
          callbackURL,
        }),
      }
    );

    const payloadText = await authResponse.text();
    let payload: { url?: string; error?: { message?: string } } | null = null;
    try {
      payload = payloadText
        ? (JSON.parse(payloadText) as { url?: string; error?: { message?: string } })
        : null;
    } catch {
      logger.warn('Discord sign-in bridge received non-JSON response', {
        status: authResponse.status,
        statusText: authResponse.statusText,
        bodyPreview: payloadText.slice(0, 300),
      });
    }
    const redirectUrl = payload?.url;
    if (!authResponse.ok || !redirectUrl) {
      logger.error('Discord sign-in bridge failed', {
        callbackOrigin,
        status: authResponse.status,
        statusText: authResponse.statusText,
        responseError: payload?.error?.message,
        responseBodyPreview: payloadText.slice(0, 300),
      });
      return new Response(
        JSON.stringify({
          error: payload?.error?.message ?? 'Failed to start Discord sign-in',
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    let discordRedirectUri: string | null = null;
    let discordClientId: string | null = null;
    let discordScope: string | null = null;
    try {
      const parsedRedirect = new URL(redirectUrl);
      discordRedirectUri = parsedRedirect.searchParams.get('redirect_uri');
      discordClientId = parsedRedirect.searchParams.get('client_id');
      discordScope = parsedRedirect.searchParams.get('scope');
    } catch {
      // Ignore parse failures; keep the raw redirect URL preview below.
    }

    logger.info('Discord sign-in bridge redirecting', {
      callbackOrigin,
      redirectOrigin: new URL(redirectUrl).origin,
      redirectUri: discordRedirectUri,
      clientId: discordClientId,
      scope: discordScope,
    });

    return Response.redirect(redirectUrl, 302);
  }

  if (
    (pathname === '/sign-out' || pathname === '/api/auth/sign-out') &&
    request.method === 'POST'
  ) {
    return handleAppSignOut(request, url, pathname);
  }

  // Proxy /api/auth/*, /api/yucp/*, and /v1/* requests to Convex.
  // Auth, YUCP OAuth, and the versioned public API (/v1/) all live on Convex .site.
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
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/yucp/') ||
    pathname.startsWith('/v1/')
  ) {
    const env = loadEnv();
    const raw = env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '';
    const cloudUrl = raw.startsWith('http')
      ? raw
      : raw
        ? `https://${raw.includes(':') ? raw.split(':')[1] : raw}.convex.cloud`
        : '';
    const convexSiteUrl = (
      process.env.CONVEX_SITE_URL ||
      (cloudUrl ? cloudUrl.replace('.convex.cloud', '.convex.site') : '')
    ).replace(/\/$/, '');
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
  if (pathname === '/api/connect/user/guilds' && connectRoutes) {
    return connectRoutes.getUserGuilds(request);
  }
  if (pathname === '/api/connect/user/accounts' && connectRoutes) {
    if (request.method === 'GET') return connectRoutes.getUserAccounts(request);
    if (request.method === 'DELETE') return connectRoutes.deleteUserAccount(request);
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
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

  // Source: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/09-Testing_for_Clickjacking
  // Source: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
  const HTML_SECURITY_HEADERS: Record<string, string> = {
    'Content-Security-Policy':
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self' data: https://fonts.gstatic.com https://db.onlinewebfonts.com https://r2cdn.perplexity.ai; " +
      "connect-src 'self' https: wss:; " +
      "worker-src 'self' blob:; " +
      "child-src 'self'; " +
      "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  const DASHBOARD_HTML_SECURITY_HEADERS: Record<string, string> = {
    'Content-Security-Policy':
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' blob: https://ga.jspm.io https://unpkg.com https://esm.sh; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self' data: https://fonts.gstatic.com https://db.onlinewebfonts.com https://r2cdn.perplexity.ai; " +
      "connect-src 'self' https: wss:; " +
      "worker-src 'self' blob:; " +
      "child-src 'self'; " +
      "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  const COLLAB_HTML_SECURITY_HEADERS: Record<string, string> = {
    'Content-Security-Policy':
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "img-src 'self' data:; " +
      "font-src 'self' data: https://fonts.gstatic.com https://r2cdn.perplexity.ai; " +
      "connect-src 'self' https:; " +
      "worker-src 'self' blob:; " +
      "child-src 'self'; " +
      "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };

  if (pathname === '/api/oauth/session-check' && request.method === 'GET') {
    if (!auth) {
      return new Response(JSON.stringify({ session: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const session = await auth.getSession(request);
    return new Response(
      JSON.stringify({
        session: !!session,
        user: session?.user ? { id: session.user.id } : undefined,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (pathname === '/oauth/login') {
    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    const filePath = `${import.meta.dir}/../public/oauth-login.html`;
    let html = await Bun.file(filePath).text();
    html = html.replace(/__API_BASE__/g, browserApiBase.replace(/\/$/, ''));
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  if (pathname === '/oauth/error') {
    const filePath = `${import.meta.dir}/../public/oauth-error.html`;
    const html = await Bun.file(filePath).text();
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...HTML_SECURITY_HEADERS },
    });
  }

  if (pathname === '/oauth/consent') {
    const clientId = url.searchParams.get('client_id') ?? '';
    const scope = url.searchParams.get('scope') ?? '';
    const escapedClientId = escapeHtmlAttribute(clientId || 'unknown client');
    const escapedScope = escapeForSingleQuotedJsString(
      escapeHtmlAttribute(scope || 'openid verification:read')
    );
    const convexSiteUrl = (process.env.CONVEX_SITE_URL ?? '').replace(/\/$/, '');
    const consentAction = '/api/auth/oauth2/consent';
    const escapedConsentAction = escapeForSingleQuotedJsString(consentAction);
    const filePath = `${import.meta.dir}/../public/oauth-consent.html`;
    let html = await Bun.file(filePath).text();
    html = html.replace(/__CLIENT_ID__/g, escapedClientId);
    html = html.replace(/__SCOPE__/g, escapedScope);
    html = html.replace(/__CONSENT_CODE__/g, '');
    html = html.replace(/__CONSENT_ACTION__/g, escapedConsentAction);
    const consentHeaders = {
      ...HTML_SECURITY_HEADERS,
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com https://db.onlinewebfonts.com https://r2cdn.perplexity.ai; connect-src 'self' https: wss:; worker-src 'self'; child-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self' ${convexSiteUrl ? new URL(convexSiteUrl).origin : ''}`,
    };
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...consentHeaders },
    });
  }

  async function maybeServeSetupAuthRedirect(
    request: Request,
    pathname: string,
    authUserId: string,
    guildId: string,
    setupCookieToken: string
  ): Promise<Response | null> {
    if (!setupCookieToken || !auth) {
      return null;
    }

    const encryptionSecret = loadEnv().ENCRYPTION_SECRET ?? loadEnv().BETTER_AUTH_SECRET ?? '';
    const setupSession = await resolveSetupSession(setupCookieToken, encryptionSecret);
    if (!setupSession) {
      return null;
    }

    const authSession = await auth.getSession(request);
    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    const callbackUrl = `${browserApiBase}${pathname}?tenant_id=${encodeURIComponent(authUserId)}&guild_id=${encodeURIComponent(guildId)}`;

    if (!authSession) {
      const filePath = `${import.meta.dir}/../public/sign-in-redirect.html`;
      let html = await Bun.file(filePath).text();
      const signInUrl = `${resolvedApiBaseUrl.replace(/\/$/, '')}/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl)}`;
      html = html.replace('__SIGN_IN_URL__', JSON.stringify(signInUrl));
      html = html.replace('__CALLBACK_URL__', JSON.stringify(callbackUrl));
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
      });
    }

    const authDiscordUserId = await auth.getDiscordUserId(request);
    if (!authDiscordUserId) {
      const filePath = `${import.meta.dir}/../public/sign-in-redirect.html`;
      let html = await Bun.file(filePath).text();
      const signInUrl = `${resolvedApiBaseUrl.replace(/\/$/, '')}/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl)}`;
      html = html.replace('__SIGN_IN_URL__', JSON.stringify(signInUrl));
      html = html.replace('__CALLBACK_URL__', JSON.stringify(callbackUrl));
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
      });
    }

    if (authDiscordUserId !== setupSession.discordUserId) {
      return new Response('This setup link belongs to a different Discord account.', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return null;
  }

  if (pathname === '/discord-role-setup' || pathname === '/discord-role-setup.html') {
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return redirectPreservingFragment(redirectUrl.toString());
    }
    const filePath = `${import.meta.dir}/../public/discord-role-setup.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    const setupCookieToken = getCookieValue(request, DISCORD_ROLE_SETUP_COOKIE) ?? '';
    const resolvedSetupToken = setupCookieToken;
    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
    html = html.replaceAll('__SETUP_TOKEN__', '');
    html = html.replaceAll('__HAS_SETUP_SESSION__', resolvedSetupToken ? 'true' : 'false');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  if (pathname === '/collab-invite' || pathname === '/collab-invite.html') {
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return redirectPreservingFragment(redirectUrl.toString());
    }
    const filePath = `${import.meta.dir}/../public/collab-invite.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...COLLAB_HTML_SECURITY_HEADERS },
    });
  }

  if (pathname === '/vrchat-verify' || pathname === '/vrchat-verify.html') {
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return redirectPreservingFragment(redirectUrl.toString());
    }
    const filePath = `${import.meta.dir}/../public/vrchat-verify.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  if (pathname === '/jinxxy-setup' || pathname === '/jinxxy-setup.html') {
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return redirectPreservingFragment(redirectUrl.toString());
    }
    const filePath = `${import.meta.dir}/../public/jinxxy-setup.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    let authUserId = url.searchParams.get('tenant_id') ?? url.searchParams.get('authUserId') ?? '';
    let guildId = url.searchParams.get('guild_id') ?? url.searchParams.get('guildId') ?? '';
    const ott = url.searchParams.get('ott');
    const setupCookieToken = getCookieValue(request, SETUP_SESSION_COOKIE) ?? '';

    if (ott && auth) {
      const { session, setCookieHeaders } = await auth.exchangeOTT(ott);
      if (session && setCookieHeaders.length > 0) {
        const redirectUrl = new URL(url);
        redirectUrl.searchParams.delete('ott');
        const headers = new Headers({ Location: redirectUrl.toString() });
        for (const cookie of setCookieHeaders) {
          headers.append('Set-Cookie', cookie);
        }
        return new Response(null, { status: 302, headers });
      }
      logger.warn('OTT exchange failed for jinxxy setup page', {
        authUserId: authUserId || undefined,
        guildId: guildId || undefined,
      });
    }

    // Resolve setup token if present
    let resolvedSetupSession = false;
    if (setupCookieToken) {
      const encryptionSecret = loadEnv().ENCRYPTION_SECRET ?? loadEnv().BETTER_AUTH_SECRET ?? '';
      const setupSession = await resolveSetupSession(setupCookieToken, encryptionSecret);
      if (setupSession) {
        authUserId = setupSession.authUserId;
        guildId = setupSession.guildId;
        resolvedSetupSession = true;
      }
    }

    const setupAuthRedirect = await maybeServeSetupAuthRedirect(
      request,
      '/jinxxy-setup',
      authUserId,
      guildId,
      setupCookieToken
    );
    if (setupAuthRedirect) {
      return setupAuthRedirect;
    }

    // Guard: regular web sessions require a valid BetterAuth session.
    // Bot-initiated setup flows use the setup cookie and are exempt.
    if (!resolvedSetupSession && auth) {
      const webSession = await auth.getSession(request);
      if (!webSession) {
        const browserBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
        return Response.redirect(
          buildSignInRouteUrl(browserBase, getRelativeRequestTarget(url)),
          302
        );
      }
    }

    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    html = html.replaceAll('__TENANT_ID__', escapeForSingleQuotedJsString(authUserId));
    html = html.replaceAll('__GUILD_ID__', escapeForSingleQuotedJsString(guildId));
    html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
    html = html.replaceAll('__SETUP_TOKEN__', '');
    html = html.replaceAll('__HAS_SETUP_SESSION__', resolvedSetupSession ? 'true' : 'false');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  if (pathname === '/lemonsqueezy-setup' || pathname === '/lemonsqueezy-setup.html') {
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return redirectPreservingFragment(redirectUrl.toString());
    }
    const filePath = `${import.meta.dir}/../public/lemonsqueezy-setup.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    let authUserId = url.searchParams.get('tenant_id') ?? url.searchParams.get('authUserId') ?? '';
    let guildId = url.searchParams.get('guild_id') ?? url.searchParams.get('guildId') ?? '';
    const ott = url.searchParams.get('ott');
    const setupCookieToken = getCookieValue(request, SETUP_SESSION_COOKIE) ?? '';

    if (ott && auth) {
      const { session, setCookieHeaders } = await auth.exchangeOTT(ott);
      if (session && setCookieHeaders.length > 0) {
        const redirectUrl = new URL(url);
        redirectUrl.searchParams.delete('ott');
        const headers = new Headers({ Location: redirectUrl.toString() });
        for (const cookie of setCookieHeaders) {
          headers.append('Set-Cookie', cookie);
        }
        return new Response(null, { status: 302, headers });
      }
      logger.warn('OTT exchange failed for lemonsqueezy setup page', {
        authUserId: authUserId || undefined,
        guildId: guildId || undefined,
      });
    }

    let resolvedSetupSession: Awaited<ReturnType<typeof resolveSetupSession>> = null;
    if (setupCookieToken) {
      const encryptionSecret = loadEnv().ENCRYPTION_SECRET ?? loadEnv().BETTER_AUTH_SECRET ?? '';
      resolvedSetupSession = await resolveSetupSession(setupCookieToken, encryptionSecret);
      if (resolvedSetupSession) {
        authUserId = resolvedSetupSession.authUserId;
        guildId = resolvedSetupSession.guildId;
      }
    }

    const setupAuthRedirect = await maybeServeSetupAuthRedirect(
      request,
      '/lemonsqueezy-setup',
      authUserId,
      guildId,
      setupCookieToken
    );
    if (setupAuthRedirect) {
      return setupAuthRedirect;
    }

    // Guard: regular web sessions require a valid BetterAuth session.
    // Bot-initiated setup flows use the setup cookie and are exempt.
    if (!resolvedSetupSession && auth) {
      const webSession = await auth.getSession(request);
      if (!webSession) {
        const browserBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
        return Response.redirect(
          buildSignInRouteUrl(browserBase, getRelativeRequestTarget(url)),
          302
        );
      }
    }

    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    html = html.replaceAll('__TENANT_ID__', escapeForSingleQuotedJsString(authUserId));
    html = html.replaceAll('__GUILD_ID__', escapeForSingleQuotedJsString(guildId));
    html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
    html = html.replaceAll('__SETUP_TOKEN__', '');
    html = html.replaceAll('__HAS_SETUP_SESSION__', resolvedSetupSession ? 'true' : 'false');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  if (pathname === '/payhip-setup' || pathname === '/payhip-setup.html') {
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return redirectPreservingFragment(redirectUrl.toString());
    }
    const filePath = `${import.meta.dir}/../public/payhip-setup.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    let authUserId = url.searchParams.get('tenant_id') ?? url.searchParams.get('authUserId') ?? '';
    let guildId = url.searchParams.get('guild_id') ?? url.searchParams.get('guildId') ?? '';
    const ott = url.searchParams.get('ott');
    const setupCookieToken = getCookieValue(request, SETUP_SESSION_COOKIE) ?? '';

    if (ott && auth) {
      const { session, setCookieHeaders } = await auth.exchangeOTT(ott);
      if (session && setCookieHeaders.length > 0) {
        const redirectUrl = new URL(url);
        redirectUrl.searchParams.delete('ott');
        const headers = new Headers({ Location: redirectUrl.toString() });
        for (const cookie of setCookieHeaders) {
          headers.append('Set-Cookie', cookie);
        }
        return new Response(null, { status: 302, headers });
      }
      logger.warn('OTT exchange failed for payhip setup page', {
        authUserId: authUserId || undefined,
        guildId: guildId || undefined,
      });
    }

    let resolvedSetupSession: Awaited<ReturnType<typeof resolveSetupSession>> = null;
    if (setupCookieToken) {
      const encryptionSecret = loadEnv().ENCRYPTION_SECRET ?? loadEnv().BETTER_AUTH_SECRET ?? '';
      resolvedSetupSession = await resolveSetupSession(setupCookieToken, encryptionSecret);
      if (resolvedSetupSession) {
        authUserId = resolvedSetupSession.authUserId;
        guildId = resolvedSetupSession.guildId;
      }
    }

    const setupAuthRedirect = await maybeServeSetupAuthRedirect(
      request,
      '/payhip-setup',
      authUserId,
      guildId,
      setupCookieToken
    );
    if (setupAuthRedirect) {
      return setupAuthRedirect;
    }

    // Guard: regular web sessions require a valid BetterAuth session.
    // Bot-initiated setup flows use the setup cookie and are exempt.
    if (!resolvedSetupSession && auth) {
      const webSession = await auth.getSession(request);
      if (!webSession) {
        const browserBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
        return Response.redirect(
          buildSignInRouteUrl(browserBase, getRelativeRequestTarget(url)),
          302
        );
      }
    }

    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    html = html.replaceAll('__TENANT_ID__', escapeForSingleQuotedJsString(authUserId));
    html = html.replaceAll('__GUILD_ID__', escapeForSingleQuotedJsString(guildId));
    html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
    html = html.replaceAll('__SETUP_TOKEN__', '');
    html = html.replaceAll('__HAS_SETUP_SESSION__', resolvedSetupSession ? 'true' : 'false');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  // ── /sign-in ──────────────────────────────────────────────────────────────
  // Standalone sign-in entry-point for users arriving from docs/index.html.
  // BetterAuth security model (all controls are server-side):
  //   • callbackURL=/sign-in is validated against trustedOrigins before OAuth starts
  //     Ref: https://better-auth.com/docs/reference/security#disableorigincheck
  //   • PKCE + state generated and stored in DB by BetterAuth during sign-in initiation
  //     Ref: https://better-auth.com/docs/concepts/oauth
  //   • OTT exchange sets HttpOnly + Secure + SameSite=Strict session cookie
  //     Ref: https://better-auth.com/docs/concepts/cookies
  //   • Session expiry: 7d with 1d refresh window  Ref: https://better-auth.com/docs/concepts/session-management
  if (pathname === '/sign-in') {
    // Rate-limit the sign-in route to prevent automated abuse.
    const clientIp = getClientAddress(request);
    if (isRateLimited(`sign-in:${clientIp}`, 30, 60_000)) {
      return new Response('Too many requests', { status: 429 });
    }

    // Redirect to the correct host if the frontend origin differs from the API origin
    // (same host-normalisation pattern used by /dashboard and /jinxxy-setup etc.)
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return Response.redirect(redirectUrl.toString(), 302);
    }

    const ott = url.searchParams.get('ott');
    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    const redirectTo =
      getSafeRelativeRedirectTarget(url.searchParams.get('redirectTo')) ?? '/dashboard';

    // Step 1: Exchange OTT for a session cookie.
    // The OTT arrives here as ?ott=<token> after BetterAuth's Discord OAuth callback
    // redirects to this callbackURL. auth.exchangeOTT() verifies the single-use token,
    // creates the session in Convex, and returns Set-Cookie headers.
    // On success we 302 back to /sign-in (strips ?ott from URL) so the browser
    // stores the cookie and then lands on a clean URL.
    if (ott && auth) {
      const { session, setCookieHeaders } = await auth.exchangeOTT(ott);
      if (session && setCookieHeaders.length > 0) {
        const redirectUrl = new URL(url);
        redirectUrl.searchParams.delete('ott');
        const headers = new Headers({ Location: redirectUrl.toString() });
        for (const cookie of setCookieHeaders) {
          headers.append('Set-Cookie', cookie);
        }
        return new Response(null, { status: 302, headers });
      }
      logger.warn('OTT exchange failed for /sign-in', { clientIp });
      // OTT was stale or already used — serve the page; client-side JS will detect
      // the remaining ?ott= param and show the error state.
    }

    // Step 2: If the user already has a valid session, redirect straight to the requested page.
    if (auth) {
      const session = await auth.getSession(request);
      if (session) {
        return Response.redirect(`${browserApiBase}${redirectTo}`, 302);
      }
    }

    // Step 3: No session — serve the sign-in page.
    // The callbackURL is /sign-in so the OTT comes back here (Step 1 above),
    // carrying the original destination through redirectTo.
    const callbackUrl = new URL(`${browserApiBase}/sign-in`);
    callbackUrl.searchParams.set('redirectTo', redirectTo);
    const signInUrl = `${resolvedApiBaseUrl.replace(/\/$/, '')}/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl.toString())}`;
    const filePath = `${import.meta.dir}/../public/sign-in.html`;
    let html = await Bun.file(filePath).text();
    html = html.replaceAll('__SIGN_IN_URL__', JSON.stringify(signInUrl));
    html = html.replaceAll('__API_BASE__', escapeHtmlAttribute(browserApiBase.replace(/\/$/, '')));
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  if (pathname === '/dashboard' || pathname === '/dashboard.html') {
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return redirectPreservingFragment(redirectUrl.toString());
    }
    const filePath = `${import.meta.dir}/../public/dashboard.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    let authUserId = url.searchParams.get('tenant_id') ?? url.searchParams.get('authUserId') ?? '';
    let guildId = url.searchParams.get('guild_id') ?? url.searchParams.get('guildId') ?? '';
    const ott = url.searchParams.get('ott');
    const setupCookieToken = getCookieValue(request, SETUP_SESSION_COOKIE) ?? '';

    if (ott && auth) {
      const { session, setCookieHeaders } = await auth.exchangeOTT(ott);
      if (session && setCookieHeaders.length > 0) {
        const redirectUrl = new URL(url);
        redirectUrl.searchParams.delete('ott');
        const headers = new Headers({ Location: redirectUrl.toString() });
        for (const cookie of setCookieHeaders) {
          headers.append('Set-Cookie', cookie);
        }
        return new Response(null, { status: 302, headers });
      }
      logger.warn('OTT exchange failed for dashboard page', {
        authUserId: authUserId || undefined,
        guildId: guildId || undefined,
      });
    }

    let resolvedSetupSession = false;
    if (setupCookieToken) {
      const encryptionSecret = loadEnv().ENCRYPTION_SECRET ?? loadEnv().BETTER_AUTH_SECRET ?? '';
      const setupSession = await resolveSetupSession(setupCookieToken, encryptionSecret);
      if (setupSession) {
        authUserId = setupSession.authUserId;
        guildId = setupSession.guildId;
        resolvedSetupSession = true;
      }
    }

    const setupAuthRedirect = await maybeServeSetupAuthRedirect(
      request,
      '/dashboard',
      authUserId,
      guildId,
      setupCookieToken
    );
    if (setupAuthRedirect) {
      return setupAuthRedirect;
    }

    // Guard: regular web sessions require a valid BetterAuth session.
    // Bot-initiated setup flows use the setup cookie and are exempt.
    if (!resolvedSetupSession && auth) {
      const webSession = await auth.getSession(request);
      if (!webSession) {
        const browserBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
        return Response.redirect(
          buildSignInRouteUrl(browserBase, getRelativeRequestTarget(url)),
          302
        );
      }
    }

    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    html = html.replaceAll('__TENANT_ID__', escapeForSingleQuotedJsString(authUserId));
    html = html.replaceAll('__GUILD_ID__', escapeForSingleQuotedJsString(guildId));
    html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
    html = html.replaceAll('__HAS_SETUP_SESSION__', resolvedSetupSession ? 'true' : 'false');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...DASHBOARD_HTML_SECURITY_HEADERS },
    });
  }

  // Verification callback routes (pattern matching)
  if (pathname.startsWith('/api/verification/callback/')) {
    const handler = verificationRoutes?.get(pathname);
    if (handler) {
      return handler(request);
    }
  }

  const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;

  // Legal: Terms of Service
  if (pathname === '/legal/terms-of-service' || pathname === '/legal/terms-of-service.html') {
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return Response.redirect(redirectUrl.toString(), 302);
    }
    const filePath = `${import.meta.dir}/../public/termsofservice.html`;
    let html = await Bun.file(filePath).text();
    html = html.replaceAll('__API_BASE__', browserApiBase);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  // Legal: Privacy Policy
  if (pathname === '/legal/privacy-policy' || pathname === '/legal/privacy-policy.html') {
    if (resolvedFrontendOrigin && url.host !== new URL(resolvedFrontendOrigin).host) {
      const redirectUrl = new URL(request.url);
      redirectUrl.protocol = new URL(resolvedFrontendOrigin).protocol;
      redirectUrl.host = new URL(resolvedFrontendOrigin).host;
      return Response.redirect(redirectUrl.toString(), 302);
    }
    const filePath = `${import.meta.dir}/../public/privacypolicy.html`;
    let html = await Bun.file(filePath).text();
    html = html.replaceAll('__API_BASE__', browserApiBase);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  // Static verification result pages
  if (pathname === '/verify-success' || pathname === '/verify-success.html') {
    const filePath = `${import.meta.dir}/../public/verify-success.html`;
    let html = await Bun.file(filePath).text();
    html = html.replaceAll('__API_BASE__', browserApiBase);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }
  if (pathname === '/verify-error' || pathname === '/verify-error.html') {
    const filePath = `${import.meta.dir}/../public/verify-error.html`;
    let html = await Bun.file(filePath).text();
    html = html.replaceAll('__API_BASE__', browserApiBase);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
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
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...HTML_SECURITY_HEADERS },
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
