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
  };
  verificationRoutes = mountVerificationRoutes(verificationConfig);

  connectRoutes = createConnectRoutes(auth, {
    baseUrl: publicBaseUrl,
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
 * Request handler for the Bun HTTP server
 */
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Health check endpoint
  if (pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json' },
    });
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
  if (pathname === '/api/setup/create-session' && connectRoutes) {
    return connectRoutes.createSessionEndpoint(request);
  }
  // Connections API
  if (pathname === '/api/connections' && connectRoutes) {
    if (request.method === 'DELETE') {
      return connectRoutes.disconnectConnectionHandler(request);
    }
    return connectRoutes.listConnectionsHandler(request);
  }
  if (pathname === '/jinxxy-setup' || pathname === '/jinxxy-setup.html') {
    const filePath = `${import.meta.dir}/../public/jinxxy-setup.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    const url = new URL(request.url);
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

    const apiBase = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001';
    html = html.replace(/__TENANT_ID__/g, tenantId);
    html = html.replace(/__GUILD_ID__/g, guildId);
    html = html.replace(/__API_BASE__/g, apiBase);
    html = html.replace(/__SETUP_TOKEN__/g, setupToken);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
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
      headers: { 'Content-Type': 'text/html' },
    });
  }
  if (pathname === '/verify-error' || pathname === '/verify-error.html') {
    const filePath = `${import.meta.dir}/../public/verify-error.html`;
    const file = Bun.file(filePath);
    return new Response(file, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // 404 for unknown routes
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Main entry point
 */
async function main() {
  const env = await loadEnvAsync();

  logger.info('Starting YUCP API server', {
    nodeEnv: env.NODE_ENV,
    infisicalUrl: env.INFISICAL_URL,
  });

  // Detect tunnel URL for webhook callbacks (Tailscale Funnel or ngrok)
  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  const tunnel = await detectTunnelUrl(port);
  if (tunnel.provider !== 'none') {
    logger.info(`🚇 Tunnel detected (${tunnel.provider})`, { publicUrl: tunnel.url });
  }

  // Initialize Better Auth (pass tunnel URL for webhook base if detected)
  auth = initializeAuth(tunnel.provider !== 'none' ? tunnel.url : undefined);

  // Start HTTP server
  Bun.serve({
    port,
    fetch: handleRequest,
  });

  logger.info('API server ready', {
    port,
    publicUrl: tunnel.provider !== 'none' ? tunnel.url : `http://localhost:${port}`,
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
