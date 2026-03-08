/**
 * Connect Routes - Creator onboarding without dashboard
 *
 * Flow:
 * 1. User visits /connect?guild_id=XXX or /connect#s=TOKEN (from bot link)
 * 2. If not logged in -> redirect to Discord OAuth with redirect_uri back to /connect
 * 3. After login -> show Connect page (Gumroad, Jinxxy, etc.)
 * 4. User clicks Done -> POST /api/connect/complete -> create tenant + guild link
 * 5. Close page, continue setup in Discord
 */

import { createLogger } from '@yucp/shared';
import type { Auth } from '../auth';
import { getConvexClient, getConvexApiSecret, getConvexClientFromUrl } from '../lib/convex';
import { getStateStore } from '../lib/stateStore';
import { encrypt } from '../lib/encrypt';
import { createSetupSession, resolveSetupSession } from '../lib/setupSession';
import {
  buildCookie,
  clearCookie,
  CONNECT_TOKEN_COOKIE,
  DISCORD_ROLE_SETUP_COOKIE,
  getCookieValue,
  JINXXY_PENDING_WEBHOOK_PREFIX,
  JINXXY_PENDING_WEBHOOK_TTL_MS,
  SETUP_SESSION_COOKIE,
} from '../lib/browserSessions';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const CONNECT_TOKEN_PREFIX = 'connect:';

const GUMROAD_STATE_PREFIX = 'connect_gumroad:';
const JINXXY_TEST_PREFIX = 'jinxxy_test:';
const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const GUMROAD_STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const JINXXY_TEST_TTL_MS = 60 * 1000; // 60 seconds

const DISCORD_ROLE_SETUP_PREFIX = 'discord_role_setup:';
const DISCORD_ROLE_OAUTH_STATE_PREFIX = 'discord_role_oauth:';
const DISCORD_ROLE_SETUP_TTL_MS = 30 * 60 * 1000; // 30 minutes

const HTML_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://db.onlinewebfonts.com; " +
    "img-src 'self' data: blob: https:; " +
    "font-src 'self' data: https://fonts.gstatic.com https://db.onlinewebfonts.com https://r2cdn.perplexity.ai; " +
    "connect-src 'self' https: wss:; " +
    "worker-src 'self'; " +
    "child-src 'self'; " +
    "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

interface DiscordRoleSetupSession {
  tenantId: string;
  guildId: string;
  adminDiscordUserId: string;
  guilds?: Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;
  sourceGuildId?: string;
  sourceGuildName?: string;
  sourceRoleId?: string;
  sourceRoleIds?: string[];
  requiredRoleMatchMode?: 'any' | 'all';
  completed: boolean;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function generateSecureRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

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

function toCookieAge(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export interface ConnectConfig {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  /** Convex .site URL for direct auth (e.g. https://rare-squid-409.convex.site) */
  convexSiteUrl: string;
  discordClientId: string;
  discordClientSecret: string;
  convexApiSecret: string;
  convexUrl: string;
  gumroadClientId?: string;
  gumroadClientSecret?: string;
  encryptionSecret: string;
}

export function createConnectRoutes(auth: Auth, config: ConnectConfig) {
  const ALLOWED_SETTING_KEYS = new Set([
    'allowMismatchedEmails',
    'autoVerifyOnJoin',
    'shareVerificationWithServers',
    'enableDiscordRoleFromOtherServers',
    'verificationScope',
    'duplicateVerificationBehavior',
    'suspiciousAccountBehavior',
  ]);

  async function getAuthenticatedDiscordUserId(request: Request): Promise<string | null> {
    return auth.getDiscordUserId(request);
  }

  async function resolveSetupSessionFromRequest(
    request: Request
  ): Promise<{ tenantId: string; guildId: string; discordUserId: string } | null> {
    const authHeader = request.headers.get('authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = getCookieValue(request, SETUP_SESSION_COOKIE);
    const token = bearerToken ?? cookieToken;
    if (!token) return null;
    return resolveSetupSession(token, config.encryptionSecret);
  }

  async function resolveConnectDiscordUserId(
    request: Request
  ): Promise<string | null> {
    const token = getCookieValue(request, CONNECT_TOKEN_COOKIE);
    if (!token) return null;
    const store = getStateStore();
    const raw = await store.get(`${CONNECT_TOKEN_PREFIX}${token}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as { discordUserId: string };
    return data.discordUserId;
  }

  /**
   * Helper: resolve a setup token from Authorization header (preferred) or URL ?s= (fallback).
   */
  async function resolveToken(request: Request): Promise<{ tenantId: string; guildId: string; discordUserId: string } | null> {
    return resolveSetupSessionFromRequest(request);
  }

  async function requireBoundSetupSession(
    request: Request
  ): Promise<
    | {
        ok: true;
        setupSession: { tenantId: string; guildId: string; discordUserId: string };
        authSession: NonNullable<Awaited<ReturnType<typeof auth.getSession>>>;
        authDiscordUserId: string;
      }
    | { ok: false; response: Response }
  > {
    const setupSession = await resolveSetupSessionFromRequest(request);
    if (!setupSession) {
      return { ok: false, response: Response.json({ error: 'Valid setup session required' }, { status: 401 }) };
    }

    const authSession = await auth.getSession(request);
    if (!authSession) {
      return { ok: false, response: Response.json({ error: 'Authentication required' }, { status: 401 }) };
    }

    const authDiscordUserId = await getAuthenticatedDiscordUserId(request);
    if (!authDiscordUserId) {
      return { ok: false, response: Response.json({ error: 'Discord account required' }, { status: 401 }) };
    }

    if (authDiscordUserId !== setupSession.discordUserId) {
      logger.warn('Setup session Discord identity mismatch', {
        expectedDiscordUserId: setupSession.discordUserId,
        actualDiscordUserId: authDiscordUserId,
        guildId: setupSession.guildId,
        tenantId: setupSession.tenantId,
      });
      return { ok: false, response: Response.json({ error: 'This setup link belongs to a different Discord account' }, { status: 403 }) };
    }

    return { ok: true, setupSession, authSession, authDiscordUserId };
  }

  /**
   * Requires a valid Discord role setup session (cookie from exchange or OAuth callback).
   * Does NOT use Better Auth - the role setup flow uses its own OAuth and session.
   */
  async function requireBoundDiscordRoleSetupSession(
    request: Request
  ): Promise<
    | { ok: true; sessionToken: string; roleSession: DiscordRoleSetupSession }
    | { ok: false; response: Response }
  > {
    const token = getCookieValue(request, DISCORD_ROLE_SETUP_COOKIE);
    if (!token) {
      return { ok: false, response: Response.json({ error: 'Valid setup session required' }, { status: 401 }) };
    }

    const store = getStateStore();
    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    if (!raw) {
      return { ok: false, response: Response.json({ error: 'Invalid or expired session' }, { status: 401 }) };
    }

    const roleSession = JSON.parse(raw) as DiscordRoleSetupSession;
    return { ok: true, sessionToken: token, roleSession };
  }

  async function isTenantOwnedBySessionUser(authUserId: string, tenantId: string): Promise<boolean> {
    const convex = getConvexClientFromUrl(config.convexUrl);
    const ownedTenant = await convex.query('tenants:getTenantByOwnerAuth' as any, {
      apiSecret: config.convexApiSecret,
      ownerAuthUserId: authUserId,
    }) as { _id?: string } | null;
    return ownedTenant?._id === tenantId;
  }

  /**
   * POST /api/setup/create-session
   * Creates a setup session and returns the token. Called by the bot.
   * Body: { tenantId, guildId, discordUserId, apiSecret }
   */
  async function createSessionEndpoint(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let body: { tenantId: string; guildId: string; discordUserId: string; apiSecret: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (body.apiSecret !== config.convexApiSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!body.tenantId || !body.guildId || !body.discordUserId) {
      return Response.json({ error: 'tenantId, guildId, and discordUserId are required' }, { status: 400 });
    }
    const token = await createSetupSession(
      body.tenantId, body.guildId, body.discordUserId, config.encryptionSecret,
    );
    return Response.json({ token });
  }

  /**
   * POST /api/connect/create-token
   * Creates a short-lived token for initial connect flows (sign-in redirect).
   * Called by the bot. Body: { discordUserId, apiSecret }
   */
  async function createTokenEndpoint(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let body: { discordUserId: string; apiSecret: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (body.apiSecret !== config.convexApiSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!body.discordUserId) {
      return Response.json({ error: 'discordUserId is required' }, { status: 400 });
    }
    const token = generateToken();
    await storeConnectToken(token, body.discordUserId);
    return Response.json({ token });
  }

  /**
   * GET /connect
   * Serves the connect page. Supports fragment bootstrap handled by the browser.
   */
  async function serveConnectPage(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestHost = url.host;
    const frontendUrl = new URL(config.frontendBaseUrl);
    const apiUrl = new URL(config.apiBaseUrl);
    if (frontendUrl.host !== apiUrl.host && requestHost === apiUrl.host) {
      const redirectUrl = new URL(url);
      redirectUrl.protocol = frontendUrl.protocol;
      redirectUrl.host = frontendUrl.host;
      const targetUrl = redirectUrl.toString();
      // Use client-side redirect to preserve the URL fragment (#token= or #s=).
      // Fragments are never sent to the server, so a 302 would drop them.
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirecting...</title></head><body><p>Redirecting...</p><script>window.location.replace(${JSON.stringify(targetUrl)} + window.location.hash);</script></body></html>`;
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    const legacyGuildId = url.searchParams.get('guild_id');
    const legacyTenantId = url.searchParams.get('tenant_id');
    const ott = url.searchParams.get('ott');

    // Resolve setup token if present
    let resolvedGuildId = legacyGuildId ?? '';
    let resolvedTenantId = legacyTenantId ?? '';
    let hasSetupSession = false;

    const setupSession = await resolveSetupSessionFromRequest(request);
    if (setupSession) {
      resolvedGuildId = setupSession.guildId;
      resolvedTenantId = setupSession.tenantId;
      hasSetupSession = true;
    }

    // Step 1: If we have a one-time-token (from OAuth callback), exchange it for a session.
    if (ott) {
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
      logger.warn('OTT exchange failed, showing sign-in page', { guildId: resolvedGuildId });
    }

    // Step 2: Check for existing session and bind any setup session to the signed-in Discord account.
    const session = await auth.getSession(request);
    if (hasSetupSession && session) {
      const authDiscordUserId = await getAuthenticatedDiscordUserId(request);
      if (!authDiscordUserId || authDiscordUserId !== setupSession!.discordUserId) {
        return new Response('This setup link belongs to a different Discord account.', { status: 403 });
      }
    }

    if (!session) {
      // Build callback URL preserving the setup token
      const callbackParams = `guild_id=${encodeURIComponent(resolvedGuildId)}${resolvedTenantId ? '&tenant_id=' + encodeURIComponent(resolvedTenantId) : ''}`;
      const callbackUrl = `${config.frontendBaseUrl}/connect?${callbackParams}`;
      const filePath = `${import.meta.dir}/../../public/sign-in-redirect.html`;
      let html = await Bun.file(filePath).text();
      const signInUrl = `${config.apiBaseUrl.replace(/\/$/, '')}/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl)}`;
      logger.info('Serving connect sign-in redirect', {
        requestUrl: request.url,
        guildId: resolvedGuildId || undefined,
        tenantId: resolvedTenantId || undefined,
        hasSetupToken: hasSetupSession,
        frontendBaseUrl: config.frontendBaseUrl,
        apiBaseUrl: config.apiBaseUrl,
        callbackUrl,
        callbackProtocol: new URL(callbackUrl).protocol,
      });
      html = html.replace('__SIGN_IN_URL__', JSON.stringify(signInUrl));
      html = html.replace('__CALLBACK_URL__', JSON.stringify(callbackUrl));
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Use the frontend origin for browser-initiated API calls so auth cookies
    // set during OTT exchange remain same-origin and are actually sent.
    const apiBase = config.frontendBaseUrl;

    const filePath = `${import.meta.dir}/../../public/connect.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    const templateValues: Record<string, string> = {
      '__GUILD_ID__': resolvedGuildId,
      '__TOKEN__': '',
      '__API_BASE__': apiBase,
      '__SETUP_TOKEN__': '',
      '__HAS_SETUP_SESSION__': hasSetupSession ? 'true' : 'false',
      '__TENANT_ID__': resolvedTenantId,
    };
    for (const [placeholder, rawValue] of Object.entries(templateValues)) {
      html = html.replaceAll(placeholder, escapeForSingleQuotedJsString(rawValue));
    }

    return new Response(html, {
      headers: { 'Content-Type': 'text/html', ...HTML_SECURITY_HEADERS },
    });
  }

  /**
   * POST /api/connect/bootstrap
   * Exchanges a fragment-delivered setup/connect token into an HTTP-only cookie.
   */
  async function exchangeConnectBootstrap(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    let body: { setupToken?: string; connectToken?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const setupToken = body.setupToken?.trim();
    const connectToken = body.connectToken?.trim();

    if ((!setupToken && !connectToken) || (setupToken && connectToken)) {
      return Response.json({ error: 'Provide exactly one token' }, { status: 400 });
    }

    if (setupToken) {
      const session = await resolveSetupSession(setupToken, config.encryptionSecret);
      if (!session) {
        return Response.json({ error: 'Invalid or expired setup token' }, { status: 401 });
      }

      return Response.json(
        { success: true },
        {
          headers: {
            'Set-Cookie': buildCookie(
              SETUP_SESSION_COOKIE,
              setupToken,
              request,
              toCookieAge(60 * 60 * 1000),
            ),
          },
        },
      );
    }

    const store = getStateStore();
    const raw = await store.get(`${CONNECT_TOKEN_PREFIX}${connectToken}`);
    if (!raw) {
      logger.warn('Connect token not found or expired', {
        tokenPrefix: connectToken?.slice(0, 8) + '...',
        hint: 'Ensure DRAGONFLY_URI/REDIS_URL is set so token storage is shared across instances',
      });
      return Response.json({ error: 'Invalid or expired connect token' }, { status: 401 });
    }

    return Response.json(
      { success: true },
      {
        headers: {
          'Set-Cookie': buildCookie(
            CONNECT_TOKEN_COOKIE,
            connectToken!,
            request,
            toCookieAge(TOKEN_EXPIRY_MS),
          ),
        },
      },
    );
  }

  /**
   * POST /api/connect/complete
   * Creates tenant + guild link. Requires session and valid token (from OAuth callback).
   */
  async function completeSetup(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: { guildId: string };
    try {
      body = (await request.json()) as { guildId: string; token?: string };
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { guildId } = body;
    if (!guildId) {
      return Response.json({ error: 'guildId is required' }, { status: 400 });
    }

    const connectDiscordUserId = await resolveConnectDiscordUserId(request);
    const sessionDiscordUserId = await getAuthenticatedDiscordUserId(request);
    if (connectDiscordUserId && sessionDiscordUserId && connectDiscordUserId !== sessionDiscordUserId) {
      logger.warn('Connect token Discord identity mismatch', {
        expectedDiscordUserId: connectDiscordUserId,
        actualDiscordUserId: sessionDiscordUserId,
        guildId,
      });
      return Response.json({ error: 'This setup link belongs to a different Discord account' }, { status: 403 });
    }

    let discordUserId: string | null = connectDiscordUserId ?? sessionDiscordUserId;

    const convex = getConvexClient();
    const apiSecret = getConvexApiSecret();
    const existing = await convex.query('tenants:getTenantByOwnerAuth' as any, {
      apiSecret,
      ownerAuthUserId: session.user.id,
    });

    if (!existing && !discordUserId) {
      return Response.json(
        { error: 'Session expired. Please sign in again from Discord.' },
        { status: 400 }
      );
    }

    try {
      let tenantId: string;

      if (!existing) {
        tenantId = await convex.mutation('tenants:createTenant' as any, {
          apiSecret,
          name: `Creator ${discordUserId!.slice(0, 8)}`,
          ownerDiscordUserId: discordUserId!,
          ownerAuthUserId: session.user.id,
        });
      } else {
        tenantId = existing._id;
      }

      await convex.mutation('guildLinks:upsertGuildLink' as any, {
        apiSecret,
        tenantId,
        discordGuildId: guildId,
        installedByAuthUserId: session.user.id,
        botPresent: true,
        status: 'active',
      });

      logger.info('Connect flow completed', {
        guildId,
        tenantId,
        authUserId: session.user.id,
      });

      const headers = new Headers();
      headers.append('Set-Cookie', clearCookie(CONNECT_TOKEN_COOKIE, request));
      return new Response(JSON.stringify({ success: true, tenantId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': headers.get('Set-Cookie')! },
      });
    } catch (err) {
      logger.error('Connect complete failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: 'Failed to complete setup' },
        { status: 500 }
      );
    }
  }

  /**
   * GET /api/connect/ensure-tenant?guildId=XXX&token=XXX
   * Returns { tenantId }, creating tenant + guild link if missing.
   */
  async function ensureTenant(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      const url = new URL(request.url);
      logger.warn('Ensure tenant rejected due to missing session', {
        requestUrl: request.url,
        requestOrigin: request.headers.get('origin'),
        requestHost: request.headers.get('host'),
        hasCookieHeader: Boolean(request.headers.get('cookie')),
        hasAuthorizationHeader: Boolean(request.headers.get('authorization')),
        guildId: url.searchParams.get('guildId'),
        hasTokenParam: Boolean(url.searchParams.get('token')),
      });
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const url = new URL(request.url);
    const guildId = url.searchParams.get('guildId') ?? url.searchParams.get('guild_id');

    if (!guildId) {
      return Response.json({ error: 'guildId is required' }, { status: 400 });
    }

    const convex = getConvexClient();

    const connectDiscordUserId = await resolveConnectDiscordUserId(request);
    const sessionDiscordUserId = await getAuthenticatedDiscordUserId(request);
    if (connectDiscordUserId && sessionDiscordUserId && connectDiscordUserId !== sessionDiscordUserId) {
      logger.warn('Ensure tenant connect token Discord identity mismatch', {
        expectedDiscordUserId: connectDiscordUserId,
        actualDiscordUserId: sessionDiscordUserId,
        guildId,
      });
      return Response.json({ error: 'This setup link belongs to a different Discord account' }, { status: 403 });
    }

    let discordUserId: string | null = connectDiscordUserId ?? sessionDiscordUserId;

    const apiSecret = getConvexApiSecret();
    const existing = await convex.query('tenants:getTenantByOwnerAuth' as any, {
      apiSecret,
      ownerAuthUserId: session.user.id,
    });

    // 4. If we STILL don't have a discordUserId and no existing tenant, we can't create one
    if (!existing && !discordUserId) {
      return Response.json({
        error: 'Session expired or Discord link lost. Please sign in again from Discord.',
        details: 'Cannot create tenant: missing Discord ID'
      }, { status: 400 });
    }

    try {
      let tenantId: string;

      if (!existing) {
        tenantId = await convex.mutation('tenants:createTenant' as any, {
          apiSecret,
          name: `Creator ${discordUserId!.slice(0, 8)}`,
          ownerDiscordUserId: discordUserId!,
          ownerAuthUserId: session.user.id,
        });
      } else {
        tenantId = existing._id;
      }

      await convex.mutation('guildLinks:upsertGuildLink' as any, {
        apiSecret,
        tenantId,
        discordGuildId: guildId,
        installedByAuthUserId: session.user.id,
        botPresent: true,
        status: 'active',
      });

      return Response.json({ tenantId });
    } catch (err) {
      logger.error('Ensure tenant failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: 'Failed to ensure tenant' },
        { status: 500 }
      );
    }
  }

  /**
   * GET /api/connect/gumroad/begin?tenantId=XXX&guildId=XXX
   * Redirects to Gumroad OAuth.
   */
  async function gumroadBegin(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let tenantId = url.searchParams.get('tenantId');
    let guildId = url.searchParams.get('guildId');

    const setupBinding = await requireBoundSetupSession(request);
    const setupSession = setupBinding.ok ? setupBinding.setupSession : null;
    const session = setupBinding.ok ? setupBinding.authSession : await auth.getSession(request);
    const authenticatedViaSetupToken = Boolean(setupSession);
    if (setupSession) {
      tenantId = tenantId || setupSession.tenantId;
      guildId = guildId || setupSession.guildId;
    }

    if (!session && !authenticatedViaSetupToken) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    const hasSetupSession = Boolean(await resolveSetupSessionFromRequest(request));
    if (!setupBinding.ok && hasSetupSession) {
      return setupBinding.response;
    }

    if (!tenantId || !guildId || !config.gumroadClientId || !config.gumroadClientSecret) {
      return Response.json(
        { error: 'tenantId, guildId, and Gumroad config required' },
        { status: 400 }
      );
    }

    if (!authenticatedViaSetupToken && session) {
      const tenantOwned = await isTenantOwnedBySessionUser(session.user.id, tenantId);
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const state = `connect_gumroad:${tenantId}:${generateSecureRandom(48)}`;
    const store = getStateStore();
    await store.set(
      `${GUMROAD_STATE_PREFIX}${state}`,
      JSON.stringify({ tenantId, guildId, setupToken: getCookieValue(request, SETUP_SESSION_COOKIE) ?? '' }),
      GUMROAD_STATE_EXPIRY_MS
    );

    const authUrl = new URL('https://gumroad.com/oauth/authorize');
    authUrl.searchParams.set('client_id', config.gumroadClientId);
    authUrl.searchParams.set('redirect_uri', `${config.apiBaseUrl}/api/connect/gumroad/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'view_profile view_sales');
    authUrl.searchParams.set('state', state);

    return Response.redirect(authUrl.toString(), 302);
  }

  /**
   * GET /api/connect/gumroad/callback?code=XXX&state=XXX
   * Exchanges code for tokens, stores in provider_connections.
   */
  async function gumroadCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      logger.error('Gumroad OAuth error', { error });
      return Response.redirect(
        `${config.frontendBaseUrl}/connect?error=${encodeURIComponent(error)}`,
        302
      );
    }

    if (!code || !state) {
      return Response.redirect(
        `${config.frontendBaseUrl}/connect?error=missing_parameters`,
        302
      );
    }

    const store = getStateStore();
    const raw = await store.get(`${GUMROAD_STATE_PREFIX}${state}`);
    if (!raw) {
      return Response.redirect(
        `${config.frontendBaseUrl}/connect?error=invalid_state`,
        302
      );
    }
    await store.delete(`${GUMROAD_STATE_PREFIX}${state}`);

    const { tenantId, guildId, setupToken: storedSetupToken } = JSON.parse(raw) as { tenantId: string; guildId: string; setupToken?: string };

    try {
      const tokenRes = await fetch('https://api.gumroad.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.gumroadClientId!,
          client_secret: config.gumroadClientSecret!,
          code,
          redirect_uri: `${config.apiBaseUrl}/api/connect/gumroad/callback`,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        logger.error('Gumroad token exchange failed', { status: tokenRes.status, body: errText });
        return Response.redirect(
          `${config.frontendBaseUrl}/connect?guild_id=${guildId}&error=token_exchange_failed`,
          302
        );
      }

      const tokens = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
      };
      const accessToken = tokens.access_token;
      const refreshToken = tokens.refresh_token;
      if (!accessToken) {
        return Response.redirect(
          `${config.frontendBaseUrl}/connect?guild_id=${guildId}&error=no_access_token`,
          302
        );
      }

      const meRes = await fetch(`https://api.gumroad.com/v2/user?access_token=${encodeURIComponent(accessToken)}`);
      if (!meRes.ok) {
        return Response.redirect(
          `${config.frontendBaseUrl}/connect?guild_id=${guildId}&error=failed_to_fetch_user`,
          302
        );
      }
      const me = (await meRes.json()) as { success?: boolean; user?: { user_id?: string; name?: string; email?: string } };
      const gumroadUserId = me.user?.user_id ?? '';

      const accessEncrypted = await encrypt(accessToken, config.encryptionSecret);
      const refreshEncrypted = refreshToken
        ? await encrypt(refreshToken, config.encryptionSecret)
        : undefined;

      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation('providerConnections:upsertGumroadConnection' as any, {
        apiSecret: config.convexApiSecret,
        tenantId,
        gumroadAccessTokenEncrypted: accessEncrypted,
        gumroadRefreshTokenEncrypted: refreshEncrypted,
        gumroadUserId,
      });

      // Register Gumroad resource_subscriptions so we receive sale/refund webhooks
      const postUrl = `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/gumroad/${tenantId}`;
      for (const resourceName of ['sale', 'refund']) {
        try {
          const subRes = await fetch('https://api.gumroad.com/v2/resource_subscriptions', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              access_token: accessToken,
              resource_name: resourceName,
              post_url: postUrl,
            }).toString(),
          });
          if (!subRes.ok) {
            const errText = await subRes.text();
            logger.warn('Gumroad resource_subscription failed', {
              resourceName,
              status: subRes.status,
              body: errText,
              tenantId,
            });
          }
        } catch (subErr) {
          logger.warn('Gumroad resource_subscription error', {
            resourceName,
            error: subErr instanceof Error ? subErr.message : String(subErr),
            tenantId,
          });
        }
      }

      const redirectParams = new URLSearchParams();
      if (guildId) redirectParams.set('guild_id', guildId);
      redirectParams.set('gumroad', 'connected');
      const redirectUrl = `${config.frontendBaseUrl}/connect?${redirectParams.toString()}`;
      return Response.redirect(redirectUrl, 302);
    } catch (err) {
      logger.error('Gumroad callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.redirect(
        `${config.frontendBaseUrl}/connect?guild_id=${guildId}&error=internal_error`,
        302
      );
    }
  }

  /**
   * GET /api/connect/status?tenantId=XXX
   * Returns { gumroad: boolean, jinxxy: boolean }.
   */
  async function getStatus(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId');
    if (!tenantId) {
      return Response.json({ error: 'tenantId is required' }, { status: 400 });
    }

    const tenantOwned = await isTenantOwnedBySessionUser(session.user.id, tenantId);
    if (!tenantOwned) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const status = await convex.query('providerConnections:getConnectionStatus' as any, {
        apiSecret: config.convexApiSecret,
        tenantId,
      });
      return Response.json(status);
    } catch (err) {
      logger.error('Get status failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ gumroad: false, jinxxy: false });
    }
  }

  /**
   * GET /api/connect/jinxxy/webhook-config?tenantId=XXX
   * Returns { callbackUrl }.
   * POST /api/connect/jinxxy/webhook-config
   * Body: { tenantId?, webhookSecret }
   * Stores a pending encrypted webhook secret for test delivery.
   */
  async function jinxxyWebhookConfig(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let tenantId: string | null = null;
    const setupBinding = await requireBoundSetupSession(request);
    if (setupBinding.ok) {
      tenantId = setupBinding.setupSession.tenantId;
    } else {
      const session = await auth.getSession(request);
      if (!session) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }
      const requestedTenantId = url.searchParams.get('tenantId');
      if (!requestedTenantId) {
        return Response.json({ error: 'tenantId is required' }, { status: 400 });
      }
      const tenantOwned = await isTenantOwnedBySessionUser(session.user.id, requestedTenantId);
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
      tenantId = requestedTenantId;
    }

    try {
      const callbackUrl = `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/jinxxy/${tenantId}`;
      if (request.method === 'GET') {
        return Response.json({ callbackUrl });
      }
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 });
      }

      let body: { webhookSecret?: string };
      try {
        body = (await request.json()) as { webhookSecret?: string };
      } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
      }

      const webhookSecret = body.webhookSecret?.trim();
      if (!webhookSecret || webhookSecret.length < 16) {
        return Response.json({ error: 'Webhook secret must be at least 16 characters' }, { status: 400 });
      }
      if (webhookSecret.length > 40) {
        return Response.json({ error: 'Jinxxy limits the signing secret to 40 characters' }, { status: 400 });
      }

      const store = getStateStore();
      await store.set(
        `${JINXXY_PENDING_WEBHOOK_PREFIX}${tenantId}`,
        JSON.stringify({
          callbackUrl,
          signingSecretEncrypted: await encrypt(webhookSecret, config.encryptionSecret),
        }),
        JINXXY_PENDING_WEBHOOK_TTL_MS
      );
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Jinxxy webhook config failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: 'Failed to get webhook config' },
        { status: 500 }
      );
    }
  }

  /**
   * GET /api/connect/jinxxy/test-webhook?tenantId=XXX
   * Returns { received: boolean }.
   */
  async function jinxxyTestWebhook(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let tenantId = url.searchParams.get('tenantId');
    const setupBinding = await requireBoundSetupSession(request);

    if (setupBinding.ok) {
      tenantId = setupBinding.setupSession.tenantId;
    } else {
      const session = await auth.getSession(request);
      if (!session) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }
      if (!tenantId) {
        return Response.json({ error: 'tenantId is required' }, { status: 400 });
      }
      const tenantOwned = await isTenantOwnedBySessionUser(session.user.id, tenantId);
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    if (!tenantId) {
      return Response.json({ error: 'tenantId or setup token is required' }, { status: 400 });
    }

    const store = getStateStore();
    const raw = await store.get(`${JINXXY_TEST_PREFIX}${tenantId}`);
    return Response.json({ received: !!raw });
  }

  /**
   * POST /api/connect/jinxxy-store
   * Body: { tenantId?, apiKey }
   */
  async function jinxxyStore(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const setupBinding = await requireBoundSetupSession(request);
    const setupSession = setupBinding.ok ? setupBinding.setupSession : null;
    const authSession = setupBinding.ok ? setupBinding.authSession : await auth.getSession(request);
    if (!authSession && !setupSession) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: { tenantId?: string; apiKey: string; webhookSecret?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const tenantId = setupSession?.tenantId ?? body.tenantId ?? null;
    const { apiKey } = body;
    if (!tenantId || !apiKey) {
      return Response.json({ error: 'tenantId and apiKey are required' }, { status: 400 });
    }

    if (!setupSession) {
      if (!authSession) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }
      const tenantOwned = await isTenantOwnedBySessionUser(authSession.user.id, tenantId);
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    try {
      const apiKeyEncrypted = await encrypt(apiKey, config.encryptionSecret);
      const store = getStateStore();
      const pendingWebhookRaw = await store.get(`${JINXXY_PENDING_WEBHOOK_PREFIX}${tenantId}`);
      let webhookSecretRef: string | undefined;
      let webhookEndpoint: string | undefined;
      if (pendingWebhookRaw) {
        const pendingWebhook = JSON.parse(pendingWebhookRaw) as { callbackUrl: string; signingSecretEncrypted: string };
        webhookSecretRef = pendingWebhook.signingSecretEncrypted;
        webhookEndpoint = pendingWebhook.callbackUrl;
      } else {
        const webhookSecret = body.webhookSecret?.trim();
        if (!webhookSecret || webhookSecret.length < 16) {
          return Response.json(
            { error: 'Webhook secret is required and must be at least 16 characters' },
            { status: 400 }
          );
        }
        webhookSecretRef = await encrypt(webhookSecret, config.encryptionSecret);
        webhookEndpoint = `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/jinxxy/${tenantId}`;
      }
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation('providerConnections:upsertJinxxyConnection' as any, {
        apiSecret: config.convexApiSecret,
        tenantId,
        jinxxyApiKeyEncrypted: apiKeyEncrypted,
        webhookSecretRef,
        webhookEndpoint,
      });
      if (pendingWebhookRaw) {
        await store.delete(`${JINXXY_PENDING_WEBHOOK_PREFIX}${tenantId}`);
      }
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Jinxxy store failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: 'Failed to store Jinxxy connection' },
        { status: 500 }
      );
    }
  }

  /**
   * GET /api/connections?s=TOKEN
   * Returns all connections for the tenant with status info.
   */
  async function listConnectionsHandler(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const setupBinding = await requireBoundSetupSession(request);
    if (!setupBinding.ok) {
      return setupBinding.response;
    }
    const session = setupBinding.setupSession;
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const result = await convex.query('providerConnections:listConnections' as any, {
        apiSecret: config.convexApiSecret,
        tenantId: session.tenantId,
      }) as { allowMismatchedEmails: boolean, connections: any[] };
      return Response.json(result);
    } catch (err) {
      logger.error('List connections failed', { error: err instanceof Error ? err.message : String(err) });
      return Response.json({ error: 'Failed to list connections' }, { status: 500 });
    }
  }

  /**
   * DELETE /api/connections?s=TOKEN&id=CONNECTION_ID
   * Disconnects a connection.
   */
  async function disconnectConnectionHandler(request: Request): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const setupBinding = await requireBoundSetupSession(request);
    if (!setupBinding.ok) {
      return setupBinding.response;
    }
    const session = setupBinding.setupSession;
    const url = new URL(request.url);
    const connectionId = url.searchParams.get('id');
    if (!connectionId) {
      return Response.json({ error: 'Connection id is required' }, { status: 400 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation('providerConnections:disconnectConnection' as any, {
        apiSecret: config.convexApiSecret,
        connectionId,
        tenantId: session.tenantId,
      });
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Disconnect connection failed', { error: err instanceof Error ? err.message : String(err) });
      return Response.json({ error: 'Failed to disconnect' }, { status: 500 });
    }
  }

  /**
   * GET /api/connect/settings?s=TOKEN
   * Returns the current tenant policy settings.
   */
  async function getSettingsHandler(request: Request): Promise<Response> {
    const setupBinding = await requireBoundSetupSession(request);
    if (!setupBinding.ok) {
      return setupBinding.response;
    }
    const session = setupBinding.setupSession;
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const tenant = await convex.query('tenants:getTenant' as any, {
        apiSecret: config.convexApiSecret,
        tenantId: session.tenantId,
      }) as { policy?: any };
      return Response.json({ policy: tenant?.policy ?? {} });
    } catch (err) {
      logger.error('Get settings failed', { error: err instanceof Error ? err.message : String(err) });
      return Response.json({ error: 'Failed to get settings' }, { status: 500 });
    }
  }

  /**
   * POST /api/connect/settings?s=TOKEN
   * Body: { key: string, value: any }
   */
  async function updateSettingHandler(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const setupBinding = await requireBoundSetupSession(request);
    if (!setupBinding.ok) {
      return setupBinding.response;
    }
    const session = setupBinding.setupSession;

    let body: { key: string; value: any };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (!body.key) {
      return Response.json({ error: 'Setting key is required' }, { status: 400 });
    }

    if (!ALLOWED_SETTING_KEYS.has(body.key)) {
      return Response.json({ error: 'Invalid setting key' }, { status: 400 });
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation('providerConnections:updateTenantSetting' as any, {
        apiSecret: config.convexApiSecret,
        tenantId: session.tenantId,
        key: body.key,
        value: body.value,
      });
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Update setting failed', { error: err instanceof Error ? err.message : String(err) });
      return Response.json({ error: 'Failed to update setting' }, { status: 500 });
    }
  }

  /**
   * POST /api/setup/discord-role-session
   * Called by the bot. Creates a short-lived setup session for Discord Role admin flow.
   * Body: { tenantId, guildId, adminDiscordUserId, apiSecret }
   */
  async function createDiscordRoleSession(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let body: { tenantId: string; guildId: string; adminDiscordUserId: string; apiSecret: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (body.apiSecret !== config.convexApiSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!body.tenantId || !body.guildId || !body.adminDiscordUserId) {
      return Response.json({ error: 'tenantId, guildId, and adminDiscordUserId are required' }, { status: 400 });
    }

    const token = generateToken();
    const session: DiscordRoleSetupSession = {
      tenantId: body.tenantId,
      guildId: body.guildId,
      adminDiscordUserId: body.adminDiscordUserId,
      completed: false,
    };
    const store = getStateStore();
    await store.set(`${DISCORD_ROLE_SETUP_PREFIX}${token}`, JSON.stringify(session), DISCORD_ROLE_SETUP_TTL_MS);
    return Response.json({ token });
  }

  /**
   * GET /api/setup/discord-role-oauth/begin
   * Redirects admin to Discord OAuth with guilds scope.
   */
  async function discordRoleOAuthBegin(request: Request): Promise<Response> {
    const binding = await requireBoundDiscordRoleSetupSession(request);
    if (!binding.ok) return binding.response;

    const { sessionToken: token } = binding;
    const store = getStateStore();

    const state = `${token}:${generateSecureRandom(16)}`;
    await store.set(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`, token, DISCORD_ROLE_SETUP_TTL_MS);

    const authUrl = new URL('https://discord.com/api/oauth2/authorize');
    authUrl.searchParams.set('client_id', config.discordClientId);
    authUrl.searchParams.set('redirect_uri', `${config.apiBaseUrl}/api/setup/discord-role-oauth/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'identify guilds');
    authUrl.searchParams.set('state', state);
    return Response.redirect(authUrl.toString(), 302);
  }

  /**
   * GET /api/setup/discord-role-oauth/callback?code=...&state=...
   * Exchanges the OAuth code, fetches admin's guild list, stores it, redirects back.
   */
  async function discordRoleOAuthCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=${encodeURIComponent(error)}`, 302);
    }
    if (!code || !state) {
      return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=missing_parameters`, 302);
    }

    const store = getStateStore();
    const setupToken = await store.get(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`);
    if (!setupToken) {
      return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=invalid_state`, 302);
    }
    await store.delete(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`);

    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${setupToken}`);
    if (!raw) {
      return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=session_expired`, 302);
    }

    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.discordClientId,
          client_secret: config.discordClientSecret,
          code,
          redirect_uri: `${config.apiBaseUrl}/api/setup/discord-role-oauth/callback`,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        logger.error('Discord role OAuth token exchange failed', { status: tokenRes.status });
        return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=token_exchange_failed`, 302);
      }

      const tokens = (await tokenRes.json()) as { access_token?: string };
      if (!tokens.access_token) {
        return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=no_token`, 302);
      }

      const accessToken = tokens.access_token;

      // Fetch Discord user from OAuth token (not Better Auth - role setup uses its own OAuth)
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userRes.ok) {
        logger.error('Discord role OAuth user fetch failed', { status: userRes.status });
        return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=guilds_fetch_failed`, 302);
      }
      const discordUser = (await userRes.json()) as { id?: string };
      const oauthDiscordUserId = discordUser.id;

      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!guildsRes.ok) {
        return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=guilds_fetch_failed`, 302);
      }

      const guilds = (await guildsRes.json()) as Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;

      const session = JSON.parse(raw) as DiscordRoleSetupSession;
      if (!oauthDiscordUserId || oauthDiscordUserId !== session.adminDiscordUserId) {
        logger.warn('Discord role OAuth callback identity mismatch', {
          expectedDiscordUserId: session.adminDiscordUserId,
          actualDiscordUserId: oauthDiscordUserId,
          guildId: session.guildId,
          tenantId: session.tenantId,
        });
        return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=account_mismatch`, 302);
      }
      session.guilds = guilds.sort((a, b) => a.name.localeCompare(b.name));
      await store.set(`${DISCORD_ROLE_SETUP_PREFIX}${setupToken}`, JSON.stringify(session), DISCORD_ROLE_SETUP_TTL_MS);

      return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup`, 302);
    } catch (err) {
      logger.error('Discord role OAuth callback failed', { error: err instanceof Error ? err.message : String(err) });
      return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup?error=internal_error`, 302);
    }
  }

  /**
   * GET /api/setup/discord-role-guilds
   * Returns the stored guild list for this session.
   */
  async function getDiscordRoleGuilds(request: Request): Promise<Response> {
    const binding = await requireBoundDiscordRoleSetupSession(request);
    if (!binding.ok) return binding.response;

    const session = binding.roleSession;
    return Response.json({
      guilds: session.guilds ?? null,
      completed: session.completed,
      sourceGuildId: session.sourceGuildId,
      sourceGuildName: session.sourceGuildName,
      sourceRoleId: session.sourceRoleId,
      sourceRoleIds: session.sourceRoleIds,
      requiredRoleMatchMode: session.requiredRoleMatchMode,
    });
  }

  /**
   * POST /api/setup/discord-role-save
   * Saves the admin's chosen sourceGuildId and sourceRoleIds (or sourceRoleId).
   * Uses the setup session cookie or an Authorization bearer token.
   */
  async function saveDiscordRoleSelection(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let body: {
      sourceGuildId: string;
      sourceGuildName?: string;
      sourceRoleId?: string;
      sourceRoleIds?: string[];
      requiredRoleMatchMode?: 'any' | 'all';
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const { sourceGuildId, sourceGuildName, sourceRoleId, sourceRoleIds, requiredRoleMatchMode } = body;
    if (!sourceGuildId) {
      return Response.json({ error: 'sourceGuildId is required' }, { status: 400 });
    }
    const roleIds = sourceRoleIds ?? (sourceRoleId ? [sourceRoleId] : []);
    if (roleIds.length === 0) {
      return Response.json({ error: 'At least one role ID is required (sourceRoleId or sourceRoleIds)' }, { status: 400 });
    }
    const validId = /^\d{17,20}$/;
    for (const id of roleIds) {
      if (!validId.test(id)) {
        return Response.json({ error: `Invalid role ID: ${id}. Must be 17–20 digits.` }, { status: 400 });
      }
    }

    const binding = await requireBoundDiscordRoleSetupSession(request);
    if (!binding.ok) return binding.response;

    const store = getStateStore();
    const session = binding.roleSession;
    session.sourceGuildId = sourceGuildId;
    session.sourceGuildName = sourceGuildName;
    session.sourceRoleId = roleIds.length === 1 ? roleIds[0] : undefined;
    session.sourceRoleIds = roleIds.length > 1 ? roleIds : undefined;
    session.requiredRoleMatchMode = roleIds.length > 1 ? (requiredRoleMatchMode ?? 'any') : undefined;
    session.completed = true;
    await store.set(`${DISCORD_ROLE_SETUP_PREFIX}${binding.sessionToken}`, JSON.stringify(session), DISCORD_ROLE_SETUP_TTL_MS);

    return Response.json({ success: true });
  }

  /**
   * GET /api/setup/discord-role-result
   * Called by the bot's "Done" button handler. Returns the saved selection if complete.
   */
  async function getDiscordRoleResult(request: Request): Promise<Response> {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return Response.json({ error: 'Missing token' }, { status: 400 });

    const store = getStateStore();
    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    if (!raw) return Response.json({ error: 'Invalid or expired session' }, { status: 401 });

    const session = JSON.parse(raw) as DiscordRoleSetupSession;
    const roleIds = session.sourceRoleIds ?? (session.sourceRoleId ? [session.sourceRoleId] : []);
    if (!session.completed || !session.sourceGuildId || roleIds.length === 0) {
      return Response.json({ completed: false });
    }

    // Clean up after bot reads the result
    await store.delete(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    return Response.json({
      completed: true,
      sourceGuildId: session.sourceGuildId,
      sourceRoleId: session.sourceRoleId,
      sourceRoleIds: roleIds,
      requiredRoleMatchMode: session.requiredRoleMatchMode ?? 'any',
    });
  }

  /**
   * POST /api/setup/discord-role-session/exchange
   * Exchanges a fragment-delivered setup token into an HTTP-only cookie.
   */
  async function exchangeDiscordRoleSetupSession(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    let body: { token?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const token = body.token?.trim();
    if (!token) return Response.json({ error: 'Missing token' }, { status: 400 });

    const store = getStateStore();
    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    if (!raw) return Response.json({ error: 'Invalid or expired session' }, { status: 401 });

    return Response.json(
      { success: true },
      {
        headers: {
          'Set-Cookie': buildCookie(DISCORD_ROLE_SETUP_COOKIE, token, request, 30 * 60),
        },
      },
    );
  }

  return {
    serveConnectPage,
    exchangeConnectBootstrap,
    createSessionEndpoint,
    createTokenEndpoint,
    completeSetup,
    ensureTenant,
    gumroadBegin,
    gumroadCallback,
    getStatus,
    jinxxyWebhookConfig,
    jinxxyTestWebhook,
    jinxxyStore,
    listConnectionsHandler,
    disconnectConnectionHandler,
    getSettingsHandler,
    updateSettingHandler,
    createDiscordRoleSession,
    exchangeDiscordRoleSetupSession,
    discordRoleOAuthBegin,
    discordRoleOAuthCallback,
    getDiscordRoleGuilds,
    saveDiscordRoleSelection,
    getDiscordRoleResult,
  };
}

export function storeConnectToken(token: string, discordUserId: string): Promise<void> {
  const store = getStateStore();
  return store.set(
    `${CONNECT_TOKEN_PREFIX}${token}`,
    JSON.stringify({ discordUserId }),
    TOKEN_EXPIRY_MS
  );
}

export { generateToken };
