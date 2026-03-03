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

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const CONNECT_TOKEN_PREFIX = 'connect:';

const GUMROAD_STATE_PREFIX = 'connect_gumroad:';
const JINXXY_TEST_PREFIX = 'jinxxy_test:';
const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const GUMROAD_STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const JINXXY_TEST_TTL_MS = 60 * 1000; // 60 seconds

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
  discordClientId: string;
  discordClientSecret: string;
  convexApiSecret: string;
  convexUrl: string;
  gumroadClientId?: string;
  gumroadClientSecret?: string;
  encryptionSecret: string;
}

export function createConnectRoutes(auth: Auth, config: ConnectConfig) {
  /**
   * GET /connect
   * Serves the connect page. If no session, redirects to Discord OAuth.
   */
  async function serveConnectPage(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const guildId = url.searchParams.get('guild_id');
    const token = url.searchParams.get('token');

    if (!guildId) {
      return new Response('Missing guild_id', { status: 400 });
    }

    const session = await auth.getSession(request);

    if (!session) {
      // Use Better Auth client via sign-in-redirect.html (same design system as connect).
      const callbackUrl = `${config.baseUrl}/connect?guild_id=${encodeURIComponent(guildId)}`;
      const filePath = `${import.meta.dir}/../../public/sign-in-redirect.html`;
      let html = await Bun.file(filePath).text();
      html = html.replace('__BASE_URL__', JSON.stringify(config.baseUrl));
      html = html.replace('__CALLBACK_URL__', JSON.stringify(callbackUrl));
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const filePath = `${import.meta.dir}/../../public/connect.html`;
    const file = Bun.file(filePath);
    let html = await file.text();
    html = html.replace('__GUILD_ID__', guildId);
    html = html.replace('__TOKEN__', token ?? '');
    html = html.replace('__API_BASE__', config.baseUrl);

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
    if (token) {
      const store = getStateStore();
      const raw = await store.get(`${CONNECT_TOKEN_PREFIX}${token}`);
      if (raw) {
        const data = JSON.parse(raw) as { discordUserId: string };
        discordUserId = data.discordUserId;
      }
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
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId');
    const guildId = url.searchParams.get('guildId');

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
      JSON.stringify({ tenantId, guildId }),
      GUMROAD_STATE_EXPIRY_MS
    );

    const authUrl = new URL('https://gumroad.com/oauth/authorize');
    authUrl.searchParams.set('client_id', config.gumroadClientId);
    authUrl.searchParams.set('redirect_uri', `${config.baseUrl}/api/connect/gumroad/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'view_user view_products view_sales');
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

    const { tenantId, guildId } = JSON.parse(raw) as { tenantId: string; guildId: string };

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

      const meRes = await fetch('https://api.gumroad.com/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!meRes.ok) {
        return Response.redirect(
          `${config.baseUrl}/connect?guild_id=${guildId}&error=failed_to_fetch_user`,
          302
        );
      }
      const me = (await meRes.json()) as { id?: string };
      const gumroadUserId = me.id ?? '';

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

      return Response.redirect(
        `${config.baseUrl}/connect?guild_id=${guildId}&gumroad=connected`,
        302
      );
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
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId');
    if (!tenantId) {
      return Response.json({ error: 'tenantId is required' }, { status: 400 });
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

  return {
    serveConnectPage,
    completeSetup,
    ensureTenant,
    gumroadBegin,
    gumroadCallback,
    getStatus,
    jinxxyWebhookConfig,
    jinxxyTestWebhook,
    jinxxyStore,
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
