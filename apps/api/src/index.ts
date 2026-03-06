// API entrypoint
// This hosts Better Auth for creator authentication
// Discord bot installation routes
// Convex functions will be added later

import { createLogger } from '@yucp/shared';
import { type Auth, createAuth } from './auth';
import { getRequired, loadEnv, loadEnvAsync } from './lib/env';
import { detectTunnelUrl } from './lib/tunnel';
import { resolveSetupSession } from './lib/setupSession';
import {
  mountInstallRoutes,
  mountVerificationRoutes,
  createConnectRoutes,
  createWebhookHandler,
  type InstallConfig,
  type VerificationConfig,
} from './routes';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// Global auth instance
let auth: Auth | null = null;

// Route handlers (initialized after auth)
let installRoutes: Map<string, (request: Request) => Promise<Response>> | null = null;
let verificationRoutes: Map<string, (request: Request) => Promise<Response>> | null = null;
let connectRoutes: ReturnType<typeof createConnectRoutes> | null = null;
let webhookHandler: ReturnType<typeof createWebhookHandler> | null = null;

// Resolved after initializeAuth — used for apiBase injection and CORS
let resolvedApiBaseUrl = 'http://localhost:3001';
let resolvedFrontendOrigin: string | null = null;
const RATE_LIMIT_BUCKETS = new Map<string, { count: number; resetAt: number }>();

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

function getClientAddress(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || 'unknown';
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
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
  const baseUrl = env.BETTER_AUTH_URL ?? 'http://localhost:3001';
  // Use detected tunnel URL for webhook callbacks; fall back to baseUrl
  const publicBaseUrl = webhookBaseUrl ?? baseUrl;
  const frontendUrl = env.FRONTEND_URL ?? baseUrl;

  resolvedApiBaseUrl = publicBaseUrl;
  resolvedFrontendOrigin = frontendUrl !== publicBaseUrl ? new URL(frontendUrl).origin : null;

  const convexUrl = env.CONVEX_URL ?? '';
  const convexSiteUrl = convexUrl
    ? convexUrl.replace('.convex.cloud', '.convex.site')
    : '';

  if (!convexSiteUrl) {
    throw new Error('CONVEX_URL must be set for auth (Convex hosts auth)');
  }

  auth = createAuth({
    baseUrl,
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
    encryptionSecret: env.BETTER_AUTH_SECRET ?? '',
  };
  verificationRoutes = mountVerificationRoutes(verificationConfig);

  connectRoutes = createConnectRoutes(auth, {
    apiBaseUrl: publicBaseUrl,
    frontendBaseUrl: frontendUrl,
    convexSiteUrl,
    discordClientId: env.DISCORD_CLIENT_ID ?? '',
    discordClientSecret: env.DISCORD_CLIENT_SECRET ?? '',
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    gumroadClientId: env.GUMROAD_CLIENT_ID ?? env.GUMROAD_API_KEY,
    gumroadClientSecret: env.GUMROAD_CLIENT_SECRET ?? env.GUMROAD_SECRET_KEY,
    encryptionSecret: env.BETTER_AUTH_SECRET ?? '',
  });

  webhookHandler = createWebhookHandler({
    convexUrl: env.CONVEX_URL ?? env.CONVEX_DEPLOYMENT ?? '',
    convexApiSecret: env.CONVEX_API_SECRET ?? '',
    encryptionSecret: env.BETTER_AUTH_SECRET ?? '',
  });

  logger.info('Better Auth initialized', {
    installRoutes: installRoutes.size,
    verificationRoutes: verificationRoutes.size,
    baseUrl,
    convexSiteUrl,
    discordEnabled: !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
    gumroadConfigured: !!(env.GUMROAD_CLIENT_ID ?? env.GUMROAD_API_KEY),
  });

  return auth;
}

/**
 * Core routing logic — called by handleRequest after CORS is handled.
 */
async function routeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const clientAddress = getClientAddress(request);

  // Basic in-memory guardrails for abuse-prone routes.
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

  if (pathname.startsWith('/Icons/')) {
    const assetPath = `${import.meta.dir}/../public${pathname}`;
    const file = Bun.file(assetPath);
    if (await file.exists()) {
      const ext = pathname.split('.').pop()?.toLowerCase();
      const contentType =
        ext === 'png' ? 'image/png' :
          ext === 'svg' ? 'image/svg+xml' :
            ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
              'application/octet-stream';
      return new Response(file, {
        headers: { 'Content-Type': contentType },
      });
    }
  }

  if (pathname === '/api/auth/sign-in/discord') {
    const callbackURL = url.searchParams.get('callbackURL');
    if (!callbackURL) {
      logger.warn('Discord sign-in bridge missing callbackURL', {
        pathname,
        requestUrl: request.url,
      });
      return new Response(JSON.stringify({ error: 'callbackURL is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const env = loadEnv();
    const convexUrl = env.CONVEX_URL ?? '';
    const convexSiteUrl = convexUrl
      ? convexUrl.replace('.convex.cloud', '.convex.site')
      : '';
    if (!convexSiteUrl) {
      logger.error('Discord sign-in bridge missing CONVEX_URL', {
        callbackURL,
        requestUrl: request.url,
      });
      return new Response(JSON.stringify({ error: 'CONVEX_URL must be set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info('Starting Discord sign-in bridge', {
      callbackURL,
      callbackProtocol: new URL(callbackURL).protocol,
      callbackOrigin: new URL(callbackURL).origin,
      requestOrigin: url.origin,
      convexSiteUrl,
    });

    const authResponse = await fetch(`${convexSiteUrl.replace(/\/$/, '')}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'discord',
        callbackURL,
      }),
    });

    const payloadText = await authResponse.text();
    let payload: { url?: string; error?: { message?: string } } | null = null;
    try {
      payload = payloadText ? JSON.parse(payloadText) as { url?: string; error?: { message?: string } } : null;
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
        callbackURL,
        status: authResponse.status,
        statusText: authResponse.statusText,
        responseError: payload?.error?.message,
        responseBodyPreview: payloadText.slice(0, 300),
      });
      return new Response(JSON.stringify({
        error: payload?.error?.message ?? 'Failed to start Discord sign-in',
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
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
      callbackURL,
      redirectOrigin: new URL(redirectUrl).origin,
      redirectUri: discordRedirectUri,
      clientId: discordClientId,
      scope: discordScope,
      redirectUrlPreview: redirectUrl.slice(0, 500),
    });

    return Response.redirect(redirectUrl, 302);
  }

  // Auth is handled directly by Convex (.site URL) — no proxy needed.
  // The browser talks to Convex for sign-in/callback, and the Bun server
  // verifies sessions by calling Convex directly.

  // Install routes for bot installation
  if (installRoutes?.has(pathname)) {
    const handler = installRoutes.get(pathname)!;
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
    const handler = verificationRoutes.get(pathname)!;
    return handler(request);
  }

  // Internal backfill route (called by Convex action when BACKFILL_API_URL is set)
  if (pathname === '/api/internal/backfill-product' && request.method === 'POST') {
    const { handleBackfillProduct } = await import('./routes/backfill');
    return handleBackfillProduct(request);
  }

  // Jinxxy products (for product add flow - fetches from Jinxxy API using tenant key)
  if (pathname === '/api/jinxxy/products' && request.method === 'POST') {
    const { handleJinxxyProducts } = await import('./routes/jinxxyProducts');
    return handleJinxxyProducts(request);
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
  if (pathname === '/api/connect/ensure-tenant' && connectRoutes) {
    return connectRoutes.ensureTenant(request);
  }
  if (pathname === '/api/connect/gumroad/begin' && connectRoutes) {
    return connectRoutes.gumroadBegin(request);
  }
  if (pathname === '/api/connect/gumroad/callback') {
    const url = new URL(request.url);
    const state = url.searchParams.get('state');

    if (state?.startsWith('verify_gumroad:')) {
      const handler = verificationRoutes?.get('/api/verification/callback/gumroad');
      if (handler) {
        // Rewrite the URL so handleVerificationCallback extracts the correct mode 'gumroad'
        // instead of 'callback' from the original /api/connect/gumroad/callback
        const verifyUrl = new URL(request.url);
        verifyUrl.pathname = '/api/verification/callback/gumroad';
        const verifyRequest = new Request(verifyUrl.toString(), request);
        return handler(verifyRequest);
      }
    }

    if (connectRoutes) {
      return connectRoutes.gumroadCallback(request);
    }
  }
  if (pathname === '/api/connect/status' && connectRoutes) {
    return connectRoutes.getStatus(request);
  }
  if (pathname === '/api/connect/jinxxy/webhook-config' && connectRoutes) {
    return connectRoutes.jinxxyWebhookConfig(request);
  }
  if (pathname === '/api/connect/jinxxy/test-webhook' && connectRoutes) {
    return connectRoutes.jinxxyTestWebhook(request);
  }
  if (pathname === '/api/connect/jinxxy-store' && connectRoutes) {
    return connectRoutes.jinxxyStore(request);
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
  const HTML_SECURITY_HEADERS: Record<string, string> = {
    'Content-Security-Policy':
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://ga.jspm.io https://esm.sh; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self' data: https://fonts.gstatic.com https://db.onlinewebfonts.com https://r2cdn.perplexity.ai; " +
      "connect-src 'self' https: wss:; " +
      "worker-src 'self' blob:; " +
      "child-src 'self' blob:; " +
      "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };

  if (pathname === '/discord-role-setup' || pathname === '/discord-role-setup.html') {
    const filePath = `${import.meta.dir}/../public/discord-role-setup.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    const setupToken = url.searchParams.get('s') ?? '';
    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
    html = html.replaceAll('__SETUP_TOKEN__', escapeForSingleQuotedJsString(setupToken));
    return new Response(html, { headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS } });
  }

  if (pathname === '/jinxxy-setup' || pathname === '/jinxxy-setup.html') {
    const filePath = `${import.meta.dir}/../public/jinxxy-setup.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    const setupToken = url.searchParams.get('s') ?? '';
    let tenantId = url.searchParams.get('tenant_id') ?? url.searchParams.get('tenantId') ?? '';
    let guildId = url.searchParams.get('guild_id') ?? url.searchParams.get('guildId') ?? '';

    // Resolve setup token if present
    if (setupToken) {
      const encryptionSecret = loadEnv().BETTER_AUTH_SECRET ?? '';
      const session = await resolveSetupSession(setupToken, encryptionSecret);
      if (session) {
        tenantId = session.tenantId;
        guildId = session.guildId;
      }
    }

    const browserApiBase = resolvedFrontendOrigin ?? resolvedApiBaseUrl;
    html = html.replaceAll('__TENANT_ID__', escapeForSingleQuotedJsString(tenantId));
    html = html.replaceAll('__GUILD_ID__', escapeForSingleQuotedJsString(guildId));
    html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
    html = html.replaceAll('__SETUP_TOKEN__', escapeForSingleQuotedJsString(setupToken));
    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  // Verification callback routes (pattern matching)
  if (pathname.startsWith('/api/verification/callback/')) {
    const handler = verificationRoutes?.get(pathname);
    if (handler) {
      return handler(request);
    }
  }

  // Static verification result pages
  if (pathname === '/verify-success' || pathname === '/verify-success.html') {
    const filePath = `${import.meta.dir}/../public/verify-success.html`;
    const file = Bun.file(filePath);
    return new Response(file, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }
  if (pathname === '/verify-error' || pathname === '/verify-error.html') {
    const filePath = `${import.meta.dir}/../public/verify-error.html`;
    const file = Bun.file(filePath);
    return new Response(file, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  // 404 for unknown routes
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Request handler for the Bun HTTP server.
 * Handles CORS for the frontend subdomain, then delegates to routeRequest.
 */
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Build CORS headers when the request comes from the configured frontend origin.
  const corsHeaders: Record<string, string> = {};
  if (resolvedFrontendOrigin) {
    const origin = request.headers.get('origin');
    if (origin === resolvedFrontendOrigin) {
      corsHeaders['Access-Control-Allow-Origin'] = resolvedFrontendOrigin;
      corsHeaders['Access-Control-Allow-Credentials'] = 'true';
      corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
      corsHeaders['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
      corsHeaders['Vary'] = 'Origin';
    }
  }

  // CORS preflight — respond immediately.
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
  const hostname =
    process.env.HOST ??
    (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const tunnel = await detectTunnelUrl(port);
  if (tunnel.provider !== 'none') {
    logger.info(`Tunnel detected (${tunnel.provider})`, { publicUrl: tunnel.url });
  }
  
  const publicBaseUrl =
    tunnel.provider !== 'none'
      ? tunnel.url
      : env.BETTER_AUTH_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`;

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
