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
    exchangeOTT: async () => ({ session: null, setCookieHeaders: [] as string[] }),
    signOut: async () => ({ ok: false, setCookieHeaders: [] as string[] }),
  } as unknown as Auth;
}

export async function createServer(config: TestServerConfig): Promise<TestServer> {
  const baseUrl = config.baseUrl ?? `http://localhost:${config.port}`;

  const stubAuth = config.auth ?? createStubAuth();

  const verificationConfig: VerificationConfig = {
    baseUrl,
    frontendUrl: baseUrl,
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
    frontendBaseUrl: baseUrl,
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
    frontendBaseUrl: baseUrl,
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
    frontendBaseUrl: baseUrl,
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
    const browserApiBase = baseUrl;

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
      pathname === '/loading.css' ||
      pathname === '/dashboard.css' ||
      pathname === '/dashboard-components.css'
    ) {
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

    // Connect routes
    if (pathname === '/connect') return connectRoutes.serveConnectPage(request);
    if (pathname === '/api/connect/complete') return connectRoutes.completeSetup(request);
    if (pathname === '/api/connect/bootstrap')
      return connectRoutes.exchangeConnectBootstrap(request);
    if (pathname === '/api/connect/session-status')
      return connectRoutes.getDashboardSessionStatus(request);
    if (pathname === '/api/connect/ensure-tenant') return connectRoutes.ensureTenant(request);
    if (pathname === '/api/connect/user/guilds') return connectRoutes.getUserGuilds(request);
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

    if (pathname === '/verify-success' || pathname === '/verify-success.html') {
      const filePath = `${import.meta.dir}/../public/verify-success.html`;
      let html = await Bun.file(filePath).text();
      html = html.replaceAll('__API_BASE__', browserApiBase);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...HTML_SECURITY_HEADERS },
      });
    }

    if (pathname === '/verify-error' || pathname === '/verify-error.html') {
      const filePath = `${import.meta.dir}/../public/verify-error.html`;
      let html = await Bun.file(filePath).text();
      html = html.replaceAll('__API_BASE__', browserApiBase);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...HTML_SECURITY_HEADERS },
      });
    }

    if (pathname === '/sign-in') {
      const redirectTo =
        getSafeRelativeRedirectTarget(url.searchParams.get('redirectTo')) ?? '/dashboard';
      const callbackUrl = new URL(`${browserApiBase}/sign-in`);
      callbackUrl.searchParams.set('redirectTo', redirectTo);
      const signInUrl = `${browserApiBase.replace(/\/$/, '')}/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl.toString())}`;
      const filePath = `${import.meta.dir}/../public/sign-in.html`;
      let html = await Bun.file(filePath).text();
      html = html.replaceAll('__SIGN_IN_URL__', JSON.stringify(signInUrl));
      html = html.replaceAll(
        '__API_BASE__',
        escapeHtmlAttribute(browserApiBase.replace(/\/$/, ''))
      );
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...HTML_SECURITY_HEADERS },
      });
    }

    if (pathname === '/dashboard' || pathname === '/dashboard.html') {
      const filePath = `${import.meta.dir}/../public/dashboard.html`;
      let html = await Bun.file(filePath).text();
      const authUserId =
        url.searchParams.get('tenant_id') ?? url.searchParams.get('authUserId') ?? '';
      const guildId = url.searchParams.get('guild_id') ?? url.searchParams.get('guildId') ?? '';
      html = html.replaceAll('__TENANT_ID__', escapeForSingleQuotedJsString(authUserId));
      html = html.replaceAll('__GUILD_ID__', escapeForSingleQuotedJsString(guildId));
      html = html.replaceAll('__API_BASE__', escapeForSingleQuotedJsString(browserApiBase));
      html = html.replaceAll('__HAS_SETUP_SESSION__', 'false');
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          ...DASHBOARD_HTML_SECURITY_HEADERS,
        },
      });
    }

    if (pathname === '/oauth/consent') {
      const clientId = url.searchParams.get('client_id') ?? '';
      const scope = url.searchParams.get('scope') ?? '';
      const consentAction = '/api/auth/oauth2/consent';
      const filePath = `${import.meta.dir}/../public/oauth-consent.html`;
      let html = await Bun.file(filePath).text();
      html = html.replace(/__CLIENT_ID__/g, escapeHtmlAttribute(clientId || 'unknown client'));
      html = html.replace(
        /__SCOPE__/g,
        escapeForSingleQuotedJsString(escapeHtmlAttribute(scope || 'openid verification:read'))
      );
      html = html.replace(/__CONSENT_CODE__/g, '');
      html = html.replace(/__CONSENT_ACTION__/g, escapeForSingleQuotedJsString(consentAction));
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...HTML_SECURITY_HEADERS },
      });
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
