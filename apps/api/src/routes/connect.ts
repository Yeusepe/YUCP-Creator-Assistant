/**
 * Connect Routes - Creator onboarding without dashboard
 *
 * Flow:
 * 1. User visits /connect?guild_id=XXX (from bot link when server not configured)
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

interface DiscordRoleSetupSession {
  tenantId: string;
  guildId: string;
  adminDiscordUserId: string;
  guilds?: Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;
  sourceGuildId?: string;
  sourceRoleId?: string;
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

export interface ConnectConfig {
  baseUrl: string;
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
  const ALLOWED_SETTING_KEYS = new Set(['allowMismatchedEmails']);

  /**
   * Helper: resolve a setup token from Authorization header (preferred) or URL ?s= (fallback).
   */
  async function resolveToken(request: Request): Promise<{ tenantId: string; guildId: string; discordUserId: string } | null> {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : new URL(request.url).searchParams.get('s');
    if (!token) return null;
    return resolveSetupSession(token, config.encryptionSecret);
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
   * GET /connect
   * Serves the connect page. Accepts ?s=TOKEN or legacy ?guild_id=XXX.
   */
  async function serveConnectPage(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const setupToken = url.searchParams.get('s');
    const legacyGuildId = url.searchParams.get('guild_id');
    const legacyTenantId = url.searchParams.get('tenant_id');
    const token = url.searchParams.get('token');
    const ott = url.searchParams.get('ott');

    // Resolve setup token if present
    let resolvedGuildId = legacyGuildId ?? '';
    let resolvedTenantId = legacyTenantId ?? '';
    let resolvedSetupToken = setupToken ?? '';

    if (setupToken) {
      const session = await resolveSetupSession(setupToken, config.encryptionSecret);
      if (session) {
        resolvedGuildId = session.guildId;
        resolvedTenantId = session.tenantId;
        resolvedSetupToken = setupToken;
      } else {
        logger.warn('Invalid or expired setup token', { tokenPrefix: setupToken.slice(0, 8) + '...' });
      }
    }

    if (!resolvedGuildId && !resolvedTenantId && !setupToken) {
      return new Response('Missing setup token or guild_id', { status: 400 });
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

    // Step 2: Check for existing session (skip if setup token already authenticated us).
    const hasValidSetupToken = !!(setupToken && resolvedTenantId);
    const session = hasValidSetupToken ? null : await auth.getSession(request);

    if (!session && !hasValidSetupToken) {
      // Build callback URL preserving the setup token
      const callbackParams = setupToken
        ? `s=${encodeURIComponent(setupToken)}`
        : `guild_id=${encodeURIComponent(resolvedGuildId)}${resolvedTenantId ? '&tenant_id=' + encodeURIComponent(resolvedTenantId) : ''}`;
      const callbackUrl = `${config.baseUrl}/connect?${callbackParams}`;
      const filePath = `${import.meta.dir}/../../public/sign-in-redirect.html`;
      let html = await Bun.file(filePath).text();
      html = html.replace('__CONVEX_SITE_URL__', JSON.stringify(config.convexSiteUrl));
      html = html.replace('__CALLBACK_URL__', JSON.stringify(callbackUrl));
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const proto = request.headers.get('x-forwarded-proto') ?? (url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? 'http' : 'https');
    const apiBase =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1'
        ? (process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`)
        : `${proto}://${url.hostname}`;

    const filePath = `${import.meta.dir}/../../public/dashboard.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    html = html.replace('__GUILD_ID__', resolvedGuildId);
    html = html.replace('__TOKEN__', token ?? '');
    html = html.replace('__API_BASE__', apiBase);
    html = html.replace('__SETUP_TOKEN__', resolvedSetupToken);
    html = html.replace('__TENANT_ID__', resolvedTenantId);

    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    });
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

    let body: { guildId: string; token?: string };
    try {
      body = (await request.json()) as { guildId: string; token?: string };
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { guildId, token } = body;
    if (!guildId) {
      return Response.json({ error: 'guildId is required' }, { status: 400 });
    }

    let discordUserId: string | null = null;
    if (token) {
      const store = getStateStore();
      const raw = await store.get(`${CONNECT_TOKEN_PREFIX}${token}`);
      if (raw) {
        await store.delete(`${CONNECT_TOKEN_PREFIX}${token}`);
        const data = JSON.parse(raw) as { discordUserId: string };
        discordUserId = data.discordUserId;
      }
    }

    // Fallback: get Discord ID from the Better Auth linked accounts
    if (!discordUserId) {
      discordUserId = await auth.getDiscordUserId(request);
    }

    const convex = getConvexClient();
    const apiSecret = getConvexApiSecret();
    const existing = await convex.query('tenants:getTenantByOwnerAuth' as any, {
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

      return Response.json({ success: true, tenantId });
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
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const url = new URL(request.url);
    const guildId = url.searchParams.get('guildId');
    const token = url.searchParams.get('token');

    if (!guildId) {
      return Response.json({ error: 'guildId is required' }, { status: 400 });
    }

    let discordUserId: string | null = null;
    const convex = getConvexClient();

    if (token) {
      const store = getStateStore();
      const raw = await store.get(`${CONNECT_TOKEN_PREFIX}${token}`);
      if (raw) {
        await store.delete(`${CONNECT_TOKEN_PREFIX}${token}`);
        const data = JSON.parse(raw) as { discordUserId: string };
        discordUserId = data.discordUserId;
      }
    } else if (session?.user?.id) {
      // Look up the linked Discord account via the Better Auth API (cross-domain pattern)
      discordUserId = await auth.getDiscordUserId(request);
    }

    const apiSecret = getConvexApiSecret();
    const existing = await convex.query('tenants:getTenantByOwnerAuth' as any, {
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
    const setupToken = url.searchParams.get('s');

    // Accept either a browser session OR a valid setup token as authentication
    const session = await auth.getSession(request);
    let authenticatedViaSetupToken = false;

    if (setupToken) {
      const resolved = await resolveSetupSession(setupToken, config.encryptionSecret);
      if (resolved) {
        tenantId = tenantId || resolved.tenantId;
        guildId = guildId || resolved.guildId;
        authenticatedViaSetupToken = true;
      }
    }

    if (!session && !authenticatedViaSetupToken) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (!tenantId || !guildId || !config.gumroadClientId || !config.gumroadClientSecret) {
      return Response.json(
        { error: 'tenantId, guildId, and Gumroad config required' },
        { status: 400 }
      );
    }

    const state = `connect_gumroad:${tenantId}:${generateSecureRandom(48)}`;
    const store = getStateStore();
    await store.set(
      `${GUMROAD_STATE_PREFIX}${state}`,
      JSON.stringify({ tenantId, guildId, setupToken: setupToken ?? '' }),
      GUMROAD_STATE_EXPIRY_MS
    );

    const authUrl = new URL('https://gumroad.com/oauth/authorize');
    authUrl.searchParams.set('client_id', config.gumroadClientId);
    authUrl.searchParams.set('redirect_uri', `${config.baseUrl}/api/connect/gumroad/callback`);
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
        `${config.baseUrl}/connect?error=${encodeURIComponent(error)}`,
        302
      );
    }

    if (!code || !state) {
      return Response.redirect(
        `${config.baseUrl}/connect?error=missing_parameters`,
        302
      );
    }

    const store = getStateStore();
    const raw = await store.get(`${GUMROAD_STATE_PREFIX}${state}`);
    if (!raw) {
      return Response.redirect(
        `${config.baseUrl}/connect?error=invalid_state`,
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
          redirect_uri: `${config.baseUrl}/api/connect/gumroad/callback`,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        logger.error('Gumroad token exchange failed', { status: tokenRes.status, body: errText });
        return Response.redirect(
          `${config.baseUrl}/connect?guild_id=${guildId}&error=token_exchange_failed`,
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
          `${config.baseUrl}/connect?guild_id=${guildId}&error=no_access_token`,
          302
        );
      }

      const meRes = await fetch(`https://api.gumroad.com/v2/user?access_token=${encodeURIComponent(accessToken)}`);
      if (!meRes.ok) {
        return Response.redirect(
          `${config.baseUrl}/connect?guild_id=${guildId}&error=failed_to_fetch_user`,
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

      const redirectUrl = storedSetupToken
        ? `${config.baseUrl}/connect?s=${encodeURIComponent(storedSetupToken)}&gumroad=connected`
        : `${config.baseUrl}/connect?guild_id=${guildId}&gumroad=connected`;
      return Response.redirect(redirectUrl, 302);
    } catch (err) {
      logger.error('Gumroad callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.redirect(
        `${config.baseUrl}/connect?guild_id=${guildId}&error=internal_error`,
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
   * Returns { callbackUrl, signingSecret }.
   */
  async function jinxxyWebhookConfig(request: Request): Promise<Response> {
    // Validate via setup token or tenantId
    const url = new URL(request.url);
    let tenantId = url.searchParams.get('tenantId');
    const setupToken = url.searchParams.get('s');

    if (setupToken) {
      const session = await resolveSetupSession(setupToken, config.encryptionSecret);
      if (session) tenantId = session.tenantId;
      else return Response.json({ error: 'Invalid or expired setup token' }, { status: 401 });
    }

    if (!tenantId) {
      return Response.json({ error: 'tenantId or setup token is required' }, { status: 400 });
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const configResult = await convex.mutation(
        'providerConnections:getOrCreateJinxxyWebhookConfig' as any,
        {
          apiSecret: config.convexApiSecret,
          tenantId,
          baseUrl: config.baseUrl,
        }
      );
      return Response.json(configResult);
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
    const setupToken = url.searchParams.get('s');

    if (setupToken) {
      const session = await resolveSetupSession(setupToken, config.encryptionSecret);
      if (session) tenantId = session.tenantId;
      else return Response.json({ error: 'Invalid or expired setup token' }, { status: 401 });
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
   * Body: { tenantId, apiKey, webhookSecret, callbackUrl }
   */
  async function jinxxyStore(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: { tenantId: string; apiKey: string; webhookSecret?: string; callbackUrl?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { tenantId, apiKey, webhookSecret, callbackUrl } = body;
    if (!tenantId || !apiKey) {
      return Response.json({ error: 'tenantId and apiKey are required' }, { status: 400 });
    }

    try {
      const apiKeyEncrypted = await encrypt(apiKey, config.encryptionSecret);
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation('providerConnections:upsertJinxxyConnection' as any, {
        apiSecret: config.convexApiSecret,
        tenantId,
        jinxxyApiKeyEncrypted: apiKeyEncrypted,
        webhookSecretRef: webhookSecret,
        webhookEndpoint: callbackUrl,
      });
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
    const session = await resolveToken(request);
    if (!session) {
      return Response.json({ error: 'Valid setup token required' }, { status: 401 });
    }
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
    const session = await resolveToken(request);
    if (!session) {
      return Response.json({ error: 'Valid setup token required' }, { status: 401 });
    }
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
    const session = await resolveToken(request);
    if (!session) {
      return Response.json({ error: 'Valid setup token required' }, { status: 401 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const tenant = await convex.query('tenants:getTenant' as any, {
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
    const session = await resolveToken(request);
    if (!session) {
      return Response.json({ error: 'Valid setup token required' }, { status: 401 });
    }

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
   * GET /api/setup/discord-role-oauth/begin?s={token}
   * Redirects admin to Discord OAuth with guilds scope.
   */
  async function discordRoleOAuthBegin(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('s');
    if (!token) return Response.json({ error: 'Missing token' }, { status: 400 });

    const store = getStateStore();
    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    if (!raw) return Response.json({ error: 'Invalid or expired session' }, { status: 401 });

    const state = `${token}:${generateSecureRandom(16)}`;
    await store.set(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`, token, DISCORD_ROLE_SETUP_TTL_MS);

    const authUrl = new URL('https://discord.com/api/oauth2/authorize');
    authUrl.searchParams.set('client_id', config.discordClientId);
    authUrl.searchParams.set('redirect_uri', `${config.baseUrl}/api/setup/discord-role-oauth/callback`);
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
      return Response.redirect(`${config.baseUrl}/discord-role-setup?error=${encodeURIComponent(error)}`, 302);
    }
    if (!code || !state) {
      return Response.redirect(`${config.baseUrl}/discord-role-setup?error=missing_parameters`, 302);
    }

    const store = getStateStore();
    const setupToken = await store.get(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`);
    if (!setupToken) {
      return Response.redirect(`${config.baseUrl}/discord-role-setup?error=invalid_state`, 302);
    }
    await store.delete(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`);

    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${setupToken}`);
    if (!raw) {
      return Response.redirect(`${config.baseUrl}/discord-role-setup?error=session_expired`, 302);
    }

    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.discordClientId,
          client_secret: config.discordClientSecret,
          code,
          redirect_uri: `${config.baseUrl}/api/setup/discord-role-oauth/callback`,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        logger.error('Discord role OAuth token exchange failed', { status: tokenRes.status });
        return Response.redirect(`${config.baseUrl}/discord-role-setup?s=${encodeURIComponent(setupToken)}&error=token_exchange_failed`, 302);
      }

      const tokens = (await tokenRes.json()) as { access_token?: string };
      if (!tokens.access_token) {
        return Response.redirect(`${config.baseUrl}/discord-role-setup?s=${encodeURIComponent(setupToken)}&error=no_token`, 302);
      }

      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!guildsRes.ok) {
        return Response.redirect(`${config.baseUrl}/discord-role-setup?s=${encodeURIComponent(setupToken)}&error=guilds_fetch_failed`, 302);
      }

      const guilds = (await guildsRes.json()) as Array<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }>;

      const session = JSON.parse(raw) as DiscordRoleSetupSession;
      session.guilds = guilds.sort((a, b) => a.name.localeCompare(b.name));
      await store.set(`${DISCORD_ROLE_SETUP_PREFIX}${setupToken}`, JSON.stringify(session), DISCORD_ROLE_SETUP_TTL_MS);

      return Response.redirect(`${config.baseUrl}/discord-role-setup?s=${encodeURIComponent(setupToken)}`, 302);
    } catch (err) {
      logger.error('Discord role OAuth callback failed', { error: err instanceof Error ? err.message : String(err) });
      return Response.redirect(`${config.baseUrl}/discord-role-setup?s=${encodeURIComponent(setupToken)}&error=internal_error`, 302);
    }
  }

  /**
   * GET /api/setup/discord-role-guilds?s={token}
   * Returns the stored guild list for this session.
   */
  async function getDiscordRoleGuilds(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : url.searchParams.get('s');
    if (!token) return Response.json({ error: 'Missing token' }, { status: 400 });

    const store = getStateStore();
    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    if (!raw) return Response.json({ error: 'Invalid or expired session' }, { status: 401 });

    const session = JSON.parse(raw) as DiscordRoleSetupSession;
    return Response.json({
      guilds: session.guilds ?? null,
      completed: session.completed,
      sourceGuildId: session.sourceGuildId,
      sourceRoleId: session.sourceRoleId,
    });
  }

  /**
   * POST /api/setup/discord-role-save
   * Saves the admin's chosen sourceGuildId and sourceRoleId.
   * Body: { s: token, sourceGuildId, sourceRoleId }
   */
  async function saveDiscordRoleSelection(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let body: { s?: string; sourceGuildId: string; sourceRoleId: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (body.s ?? null);
    const { sourceGuildId, sourceRoleId } = body;
    if (!token || !sourceGuildId || !sourceRoleId) {
      return Response.json({ error: 'token, sourceGuildId, and sourceRoleId are required' }, { status: 400 });
    }

    const store = getStateStore();
    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    if (!raw) return Response.json({ error: 'Invalid or expired session' }, { status: 401 });

    const session = JSON.parse(raw) as DiscordRoleSetupSession;
    session.sourceGuildId = sourceGuildId;
    session.sourceRoleId = sourceRoleId;
    session.completed = true;
    await store.set(`${DISCORD_ROLE_SETUP_PREFIX}${token}`, JSON.stringify(session), DISCORD_ROLE_SETUP_TTL_MS);

    return Response.json({ success: true });
  }

  /**
   * GET /api/setup/discord-role-result?s={token}
   * Called by the bot's "Done" button handler. Returns the saved selection if complete.
   */
  async function getDiscordRoleResult(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('s');
    if (!token) return Response.json({ error: 'Missing token' }, { status: 400 });

    const store = getStateStore();
    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    if (!raw) return Response.json({ error: 'Invalid or expired session' }, { status: 401 });

    const session = JSON.parse(raw) as DiscordRoleSetupSession;
    if (!session.completed || !session.sourceGuildId || !session.sourceRoleId) {
      return Response.json({ completed: false });
    }

    // Clean up after bot reads the result
    await store.delete(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    return Response.json({ completed: true, sourceGuildId: session.sourceGuildId, sourceRoleId: session.sourceRoleId });
  }

  return {
    serveConnectPage,
    createSessionEndpoint,
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
