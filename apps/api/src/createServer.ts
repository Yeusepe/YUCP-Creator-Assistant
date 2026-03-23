/**
 * Testable server factory.
 *
 * This module provides createServer() which builds the same routes as index.ts
 * but accepts an explicit config object instead of reading from process.env.
 *
 * Usage in tests:
 *   import { createServer } from '../src/createServer';
 *   const srv = await createServer({ port: 0, convexUrl: '...', ... });
 *   await fetch(`${srv.url}/health`);
 *   srv.stop();
 *
 * For auth-guarded routes, the stub auth always returns null sessions,
 * so unauthenticated requests get 401/302 responses (exactly what auth-guard
 * tests need to verify).
 */

import path from 'node:path';
import type { Auth } from './auth';
import { createLegacyFrontendMovedResponse, isLegacyFrontendAsset } from './lib/legacyFrontend';
import {
  createVerificationRoutes,
  mountVerificationRouteHandlers,
  type VerificationConfig,
} from './routes';
import { createCollabRoutes } from './routes/collab';
import { createConnectRoutes } from './routes/connect';
import { createProviderPlatformRoutes } from './routes/providerPlatform';
import { createPublicRoutes } from './routes/public';
import { createSuiteRoutes } from './routes/suite';
import { createWebhookHandler } from './routes/webhooks';

const PUBLIC_BASE_DIR = path.resolve(import.meta.dir, '..', 'public');

function getContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

export interface TestServerConfig {
  /** 0 = OS assigns a free port */
  port: number;
  convexUrl: string;
  convexApiSecret: string;
  convexSiteUrl: string;
  encryptionSecret: string;
  /** Optional — connect/collab Discord OAuth flows are skipped in tests */
  discordClientId?: string;
  discordClientSecret?: string;
  /** Base URL reported to templates (defaults to http://localhost:<port>) */
  baseUrl?: string;
  /** Frontend/browser URL used for auth callback generation (defaults to baseUrl). */
  frontendUrl?: string;
  /**
   * Override the Auth implementation used by all routes.
   * When omitted, a stub that always returns null sessions is used (default
   * for auth-guard tests). Supply this when you need to test authenticated paths.
   */
  auth?: Auth;
}

export interface TestServer {
  port: number;
  url: string;
  stop(): void;
}

/**
 * Stub auth that always returns null session.
 * Routes guarded by auth will return 401/302 — exactly the behaviour
 * auth-guard integration tests need to assert.
 */
function createStubAuth(): Auth {
  return {
    getSession: async () => null,
    getDiscordUserId: async () => null,
  } as unknown as Auth;
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

export async function createServer(config: TestServerConfig): Promise<TestServer> {
  const baseUrl = config.baseUrl ?? `http://localhost:${config.port}`;
  const frontendUrl = config.frontendUrl ?? baseUrl;

  const stubAuth = config.auth ?? createStubAuth();

  const verificationConfig: VerificationConfig = {
    baseUrl,
    frontendUrl,
    convexUrl: config.convexUrl,
    convexApiSecret: config.convexApiSecret,
    encryptionSecret: config.encryptionSecret,
    discordClientId: config.discordClientId,
    discordClientSecret: config.discordClientSecret,
  };
  const verificationHandlers = createVerificationRoutes(verificationConfig);
  const verificationRoutes = mountVerificationRouteHandlers(verificationHandlers);

  const connectRoutes = createConnectRoutes(stubAuth, {
    apiBaseUrl: baseUrl,
    frontendBaseUrl: frontendUrl,
    convexSiteUrl: config.convexSiteUrl,
    convexUrl: config.convexUrl,
    convexApiSecret: config.convexApiSecret,
    encryptionSecret: config.encryptionSecret,
    discordClientId: config.discordClientId ?? '',
    discordClientSecret: config.discordClientSecret ?? '',
  });

  const collabRoutes = createCollabRoutes({
    auth: stubAuth,
    apiBaseUrl: baseUrl,
    frontendBaseUrl: frontendUrl,
    convexUrl: config.convexUrl,
    convexApiSecret: config.convexApiSecret,
    encryptionSecret: config.encryptionSecret,
    discordClientId: config.discordClientId ?? '',
    discordClientSecret: config.discordClientSecret ?? '',
  });

  const publicRoutes = createPublicRoutes({
    convexUrl: config.convexUrl,
    convexApiSecret: config.convexApiSecret,
    convexSiteUrl: config.convexSiteUrl,
  });

  const suiteRoutes = createSuiteRoutes({
    convexUrl: config.convexUrl,
    convexApiSecret: config.convexApiSecret,
    convexSiteUrl: config.convexSiteUrl,
  });

  const providerPlatformRoutes = createProviderPlatformRoutes(stubAuth, {
    apiBaseUrl: baseUrl,
    frontendBaseUrl: frontendUrl,
    convexUrl: config.convexUrl,
    convexApiSecret: config.convexApiSecret,
    encryptionSecret: config.encryptionSecret,
  });

  const webhookHandler = createWebhookHandler({
    convexUrl: config.convexUrl,
    convexApiSecret: config.convexApiSecret,
    encryptionSecret: config.encryptionSecret,
  });

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    if (pathname === '/tokens.css') {
      const file = Bun.file(`${import.meta.dir}/../public/tokens.css`);
      return new Response(file, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
    }

    if (
      pathname.startsWith('/assets/') ||
      pathname.startsWith('/Icons/') ||
      pathname === '/loading.css'
    ) {
      if (pathname.startsWith('/assets/') && isLegacyFrontendAsset(pathname)) {
        return new Response('Not found', { status: 404 });
      }

      const relativePublicPath = pathname.replace(/^\/+/, '');
      const candidatePath = path.resolve(PUBLIC_BASE_DIR, relativePublicPath);
      if (
        candidatePath === PUBLIC_BASE_DIR ||
        !candidatePath.startsWith(`${PUBLIC_BASE_DIR}${path.sep}`)
      ) {
        return new Response('Not found', { status: 404 });
      }

      const file = Bun.file(candidatePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { 'Content-Type': getContentType(candidatePath) },
        });
      }
    }

    // Webhook routes (Gumroad, Jinxxy, Payhip, etc.)
    if (pathname.startsWith('/webhooks/')) {
      return webhookHandler(request);
    }

    // Provider platform routes (/v1/*)
    if (pathname.startsWith('/v1/')) {
      const local = await providerPlatformRoutes.handleRequest(request);
      if (local) return local;
    }

    // Verification routes (license key, OAuth callbacks)
    if (verificationRoutes.has(pathname)) {
      const handler = verificationRoutes.get(pathname);
      if (handler) return handler(request);
    }
    if (pathname.startsWith('/api/verification/callback/')) {
      const handler = verificationRoutes.get(pathname);
      if (handler) return handler(request);
    }
    if (pathname.startsWith('/api/verification/')) {
      const handler = verificationRoutes.get(pathname);
      if (handler) return handler(request);
    }

    // Internal backfill route
    if (pathname === '/api/internal/backfill-product' && request.method === 'POST') {
      const { handleBackfillProduct } = await import('./routes/backfill');
      return handleBackfillProduct(request);
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
              : pathname === '/oauth/consent'
                ? '/oauth/consent'
                : pathname === '/oauth/error'
                  ? '/oauth/error'
                  : pathname === '/collab-invite' || pathname === '/collab-invite.html'
                    ? '/collab-invite'
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
                                  : pathname === '/payhip-setup' ||
                                      pathname === '/payhip-setup.html'
                                    ? '/setup/payhip'
                                    : pathname === '/vrchat-verify' ||
                                        pathname === '/vrchat-verify.html'
                                      ? '/setup/vrchat'
                                      : null;

    if (legacyFrontendRoute) {
      if (config.frontendUrl) {
        const response = redirectToFrontendRoute(url, config.frontendUrl, legacyFrontendRoute);
        if (response) {
          return response;
        }
      }
      return createLegacyFrontendMovedResponse();
    }

    // Connect routes
    if (pathname === '/api/connect/complete') return connectRoutes.completeSetup(request);
    if (pathname === '/api/connect/bootstrap')
      return connectRoutes.exchangeConnectBootstrap(request);
    if (pathname === '/api/connect/session-status')
      return connectRoutes.getDashboardSessionStatus(request);
    if (pathname === '/api/connect/ensure-tenant') return connectRoutes.ensureTenant(request);
    if (pathname === '/api/connect/user/guilds') return connectRoutes.getUserGuilds(request);
    if (pathname === '/api/connect/dashboard/shell')
      return connectRoutes.getDashboardShell(request);
    if (pathname === '/api/connect/branding') return connectRoutes.getViewerBranding(request);
    if (pathname === '/api/connect/user/accounts') {
      if (request.method === 'GET') return connectRoutes.getUserAccounts(request);
      if (request.method === 'DELETE') return connectRoutes.deleteUserAccount(request);
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    if (pathname === '/api/connect/status') return connectRoutes.getStatus(request);
    if (pathname === '/api/connect/settings') {
      if (request.method === 'POST') return connectRoutes.updateSettingHandler(request);
      return connectRoutes.getSettingsHandler(request);
    }
    if (pathname === '/api/connect/guild/channels') return connectRoutes.getGuildChannels(request);
    if (pathname === '/api/connect/public-api/keys') {
      if (request.method === 'POST') return connectRoutes.createPublicApiKey(request);
      return connectRoutes.listPublicApiKeys(request);
    }
    if (pathname.startsWith('/api/connect/public-api/keys/')) {
      const keyId = pathname.replace(/^\/api\/connect\/public-api\/keys\//, '').split('/')[0];
      if (pathname.endsWith('/revoke') && request.method === 'POST')
        return connectRoutes.revokePublicApiKey(request, decodeURIComponent(keyId ?? ''));
      if (pathname.endsWith('/rotate') && request.method === 'POST')
        return connectRoutes.rotatePublicApiKey(request, decodeURIComponent(keyId ?? ''));
    }
    if (pathname === '/api/connect/oauth-apps') {
      if (request.method === 'POST') return connectRoutes.createOAuthApp(request);
      return connectRoutes.listOAuthApps(request);
    }
    if (
      pathname.startsWith('/api/connect/oauth-apps/') &&
      pathname.endsWith('/regenerate-secret') &&
      request.method === 'POST'
    ) {
      const appId = pathname
        .replace(/^\/api\/connect\/oauth-apps\//, '')
        .replace(/\/regenerate-secret$/, '');
      return connectRoutes.regenerateOAuthAppSecret(request, decodeURIComponent(appId));
    }
    if (pathname.startsWith('/api/connect/oauth-apps/')) {
      const appId = decodeURIComponent(pathname.replace(/^\/api\/connect\/oauth-apps\//, ''));
      if (request.method === 'PUT') return connectRoutes.updateOAuthApp(request, appId);
      if (request.method === 'DELETE') return connectRoutes.deleteOAuthApp(request, appId);
    }
    if (pathname === '/api/connections') {
      if (request.method === 'DELETE') return connectRoutes.disconnectConnectionHandler(request);
      return connectRoutes.listConnectionsHandler(request);
    }
    if (pathname === '/api/connect/platform-status') {
      const pluginResp = await connectRoutes.dispatchPlugin(request.method, pathname, request);
      if (pluginResp) return pluginResp;
    }
    if (pathname.startsWith('/api/connect/')) {
      const pluginResp = await connectRoutes.dispatchPlugin(request.method, pathname, request);
      if (pluginResp) return pluginResp;
    }

    // Collab routes
    if (pathname.startsWith('/api/collab/')) {
      return collabRoutes.handleCollabRequest(request);
    }

    // Public verification API
    if (pathname.startsWith('/api/public/')) {
      const response = await publicRoutes.handleRequest(request, pathname);
      if (response) return response;
    }

    // Suite API
    if (pathname.startsWith('/api/suite/')) {
      const response = await suiteRoutes.handleRequest(request, pathname);
      if (response) return response;
    }

    // 404 fallback
    if (pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return new Response('Not found', { status: 404 });
  }

  const server = Bun.serve({
    port: config.port,
    fetch: handleRequest,
  });

  const assignedPort = server.port ?? config.port;
  const assignedUrl = `http://localhost:${assignedPort}`;

  return {
    port: assignedPort,
    url: assignedUrl,
    stop() {
      server.stop(true);
    },
  };
}
