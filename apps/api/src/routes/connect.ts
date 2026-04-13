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

import {
  ConnectionService,
  DashboardShellService,
  GuildDirectoryService,
} from '@yucp/application/services';
import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import { timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { type Auth } from '../auth';
import {
  buildCookie,
  CONNECT_TOKEN_COOKIE,
  clearCookie,
  getCookieValue,
  SETUP_SESSION_COOKIE,
} from '../lib/browserSessions';
import { getConvexApiSecret, getConvexClient, getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { encrypt } from '../lib/encrypt';
import { createLegacyFrontendMovedResponse } from '../lib/legacyFrontend';
import { loadRequestScoped, requestScopeKey } from '../lib/requestScope';
import { buildTimedResponse, RouteTimingCollector } from '../lib/requestTiming';
import { createSetupSession, resolveSetupSession } from '../lib/setupSession';
import { getStateStore } from '../lib/stateStore';
import { listDashboardProviderDisplays } from '../providers/display';
import { getProviderHooks, getProviderRuntime, listConnectPlugins } from '../providers/index';
import type { ConnectConfig, ConnectContext } from '../providers/types';
import { createConnectApiAccessRoutes } from './connectApiAccess';
import { createConnectCertificateRoutes } from './connectCertificateRoutes';
import { createConnectDiscordRoleRoutes } from './connectDiscordRoleRoutes';
import { createConnectUserAccountRoutes } from './connectUserAccountRoutes';
import { createConnectUserVerificationRoutes } from './connectUserVerification';

// Re-exported for backwards compatibility, ConnectConfig is defined in providers/types.ts
export type { ConnectConfig } from '../providers/types';

import { logger } from '../lib/logger';

type CreatorProfileRecord = { authUserId: string; policy?: Record<string, unknown> } | null;

const TOKEN_MAX_LEN = 256;
const TOKEN_PATTERN = /^[a-zA-Z0-9._-]+$/;

function validateToken(token: string | undefined, name: string): string | null {
  if (!token) return null;
  if (token.length > TOKEN_MAX_LEN || !TOKEN_PATTERN.test(token)) {
    throw new Error(`Invalid ${name} format`);
  }
  return token;
}

const CONNECT_TOKEN_PREFIX = 'connect:';

const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

interface DashboardShellResponse {
  viewer: {
    authUserId: string;
    name: string | null;
    email: string | null;
    image: string | null;
    discordUserId: string | null;
  };
  branding?: {
    isPlus: boolean;
    billingStatus?: string;
  };
  guilds: Array<{
    authUserId: string;
    guildId: string;
    name: string;
    icon: string | null;
  }>;
  home?: {
    providers: Array<{
      key: string;
      setupExperience: 'automatic' | 'guided' | 'manual';
      setupHint: string;
      label?: string;
      icon?: string;
      iconBg?: string;
      quickStartBg?: string;
      quickStartBorder?: string;
      serverTileHint?: string;
      connectPath?: string;
      connectParamStyle?: 'camelCase' | 'snakeCase';
    }>;
    userAccounts: Array<{
      id: string;
      provider: string;
      label: string;
      connectionType: string;
      status: string;
      webhookConfigured: boolean;
      hasApiKey: boolean;
      hasAccessToken: boolean;
      authUserId?: string;
      createdAt: number;
      updatedAt: number;
    }>;
    connectionStatusAuthUserId: string;
    connectionStatusByProvider: Record<string, boolean>;
  };
  selectedServer?: {
    authUserId: string;
    guildId: string;
    policy: Record<string, unknown>;
  };
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

function toCookieAge(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
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
    'logChannelId',
    'announcementsChannelId',
  ]);

  const connectionService = new ConnectionService({
    connections: {
      async listUserAccounts(authUserId) {
        return (await getConvexClientFromUrl(config.convexUrl).query(
          api.providerConnections.listConnectionsForUser,
          {
            apiSecret: config.convexApiSecret,
            authUserId,
          }
        )) as DashboardShellResponse['home'] extends { userAccounts: infer T } ? T : never;
      },
      async getConnectionStatus(authUserId) {
        return (await getConvexClientFromUrl(config.convexUrl).query(
          api.providerConnections.getConnectionStatus,
          {
            apiSecret: config.convexApiSecret,
            authUserId,
          }
        )) as Record<string, boolean>;
      },
    },
    providerDisplays: {
      listDashboardProviderDisplays,
    },
  });
  const guildDirectoryService = new GuildDirectoryService({
    repository: {
      async listUserGuilds(authUserId) {
        return (await getConvexClientFromUrl(config.convexUrl).query(api.guildLinks.getUserGuilds, {
          apiSecret: config.convexApiSecret,
          authUserId,
        })) as DashboardShellResponse['guilds'];
      },
      async persistGuildMetadata(input) {
        await getConvexClientFromUrl(config.convexUrl).mutation(
          api.guildLinks.updateGuildLinkStatus,
          {
            apiSecret: config.convexApiSecret,
            discordGuildId: input.guildId,
            status: 'active',
            botPresent: true,
            discordGuildName: input.discordGuildName,
            ...(input.discordGuildIcon ? { discordGuildIcon: input.discordGuildIcon } : {}),
          }
        );
      },
    },
    ...(config.discordBotToken
      ? {
          metadataResolver: {
            async getGuildMetadata(guildId) {
              const metadata = await fetchGuildMeta(guildId);
              return metadata.discordGuildName ? metadata : null;
            },
          },
        }
      : {}),
  });
  function hasValidApiSecret(value: string | undefined): boolean {
    return typeof value === 'string' && timingSafeStringEqual(value, config.convexApiSecret);
  }

  /**
   * Fetches guild name/icon from Discord's API using the bot token.
   * Returns an object suitable for spreading into the upsertGuildLink call.
   * Never throws, returns empty object on failure so the flow is unaffected.
   */
  async function fetchGuildMeta(
    guildId: string
  ): Promise<{ discordGuildName?: string; discordGuildIcon?: string }> {
    if (!config.discordBotToken) return {};
    try {
      const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
      });
      if (res.ok) {
        const guild = (await res.json()) as { name?: string; icon?: string | null };
        return {
          ...(guild.name ? { discordGuildName: guild.name } : {}),
          ...(guild.icon ? { discordGuildIcon: guild.icon } : {}),
        };
      }
    } catch (e) {
      logger.warn('Failed to fetch guild meta', {
        guildId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return {};
  }

  async function getAuthenticatedDiscordUserId(request: Request): Promise<string | null> {
    return auth.getDiscordUserId(request);
  }

  interface ConnectSession {
    discordUserId: string;
    guildId?: string;
  }

  async function resolveSetupSessionFromRequest(
    request: Request
  ): Promise<{ authUserId: string; guildId: string; discordUserId: string } | null> {
    return loadRequestScoped(request, 'connect:setup-session', async () => {
      const token = getSetupSessionTokenFromRequest(request);
      if (!token) return null;
      return resolveSetupSession(token, config.encryptionSecret);
    });
  }

  function getSetupSessionTokenFromRequest(request: Request): string | null {
    const authHeader = request.headers.get('authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = getCookieValue(request, SETUP_SESSION_COOKIE);
    return bearerToken ?? cookieToken;
  }

  async function resolveConnectSession(request: Request): Promise<ConnectSession | null> {
    return loadRequestScoped(request, 'connect:browser-session', async () => {
      const token = getCookieValue(request, CONNECT_TOKEN_COOKIE);
      if (!token) return null;
      const store = getStateStore();
      const raw = await store.get(`${CONNECT_TOKEN_PREFIX}${token}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as ConnectSession;
      } catch {
        return null;
      }
    });
  }

  async function getCreatorProfile(
    request: Request,
    authUserId: string
  ): Promise<CreatorProfileRecord> {
    return loadRequestScoped(
      request,
      requestScopeKey('connect:creator-profile', { authUserId }),
      async () => {
        const convex = getConvexClientFromUrl(config.convexUrl);
        return (await convex.query(api.creatorProfiles.getCreatorProfile, {
          apiSecret: config.convexApiSecret,
          authUserId,
        })) as CreatorProfileRecord;
      }
    );
  }

  async function _resolveConnectDiscordUserId(request: Request): Promise<string | null> {
    const session = await resolveConnectSession(request);
    return session?.discordUserId ?? null;
  }

  /**
   * Helper: resolve a setup token from Authorization header (preferred) or URL ?s= (fallback).
   */
  async function _resolveToken(
    request: Request
  ): Promise<{ authUserId: string; guildId: string; discordUserId: string } | null> {
    return resolveSetupSessionFromRequest(request);
  }

  async function requireBoundSetupSession(
    request: Request
  ): Promise<
    | { ok: true; setupSession: { authUserId: string; guildId: string; discordUserId: string } }
    | { ok: false; response: Response }
  > {
    const setupSession = await resolveSetupSessionFromRequest(request);
    if (!setupSession) {
      return {
        ok: false,
        response: Response.json({ error: 'Valid setup session required' }, { status: 401 }),
      };
    }

    return { ok: true, setupSession };
  }

  async function getDashboardSessionStatus(request: Request): Promise<Response> {
    const setupSession = await resolveSetupSessionFromRequest(request);
    if (!setupSession) {
      return Response.json({ hasSetupSession: false, authenticated: false });
    }

    return Response.json({
      hasSetupSession: true,
      authenticated: true,
      guildId: setupSession.guildId,
      discordUserId: setupSession.discordUserId,
      authUserId: setupSession.authUserId,
    });
  }

  async function isTenantOwnedBySessionUser(
    request: Request,
    sessionUserId: string,
    profileAuthUserId: string
  ): Promise<boolean> {
    const profile = await getCreatorProfile(request, profileAuthUserId);
    return !!profile && profile.authUserId === sessionUserId;
  }

  async function requireOwnerSessionForTenant(
    request: Request,
    authUserId: string | undefined
  ): Promise<
    | { ok: true; session: NonNullable<Awaited<ReturnType<Auth['getSession']>>> }
    | { ok: false; response: Response }
  > {
    // Check authentication first, unauthenticated requests always get 401,
    // regardless of whether authUserId was supplied.
    let session: Awaited<ReturnType<Auth['getSession']>>;
    try {
      session = await auth.getSession(request);
    } catch (error) {
      logger.error('Session resolution failed', {
        authUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        response: Response.json({ error: 'Failed to resolve session' }, { status: 503 }),
      };
    }

    if (!session) {
      return {
        ok: false,
        response: Response.json({ error: 'Authentication required' }, { status: 401 }),
      };
    }

    if (!authUserId) {
      return {
        ok: false,
        response: Response.json({ error: 'authUserId is required' }, { status: 400 }),
      };
    }

    let tenantOwned: boolean;
    try {
      tenantOwned = await isTenantOwnedBySessionUser(request, session.user.id, authUserId);
    } catch (error) {
      logger.error('Tenant ownership resolution failed', {
        sessionUserId: session.user.id,
        authUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        response: Response.json({ error: 'Failed to resolve tenant ownership' }, { status: 503 }),
      };
    }

    if (!tenantOwned) {
      return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) };
    }

    return { ok: true, session };
  }

  /**
   * ConnectContext, injected into every provider connect plugin route handler.
   * Built from the auth instance and config that were passed to createConnectRoutes.
   */
  function createConnectContext(request: Request): ConnectContext {
    return {
      config,
      auth,
      requireBoundSetupSession,
      getSetupSessionTokenFromRequest,
      isTenantOwnedBySessionUser: (sessionUserId, authUserId) =>
        isTenantOwnedBySessionUser(request, sessionUserId, authUserId),
    };
  }

  /**
   * Dispatches a request to the matching provider connect plugin route.
   * Returns null when no plugin matches, so the caller can fall through.
   */
  function dispatchPlugin(
    method: string,
    pathname: string,
    request: Request
  ): Promise<Response> | null {
    for (const connect of listConnectPlugins()) {
      for (const route of connect.routes) {
        if (route.method === method && route.path === pathname) {
          return route.handler(request, createConnectContext(request));
        }
      }
    }
    return null;
  }

  /**
   * POST /api/setup/create-session
   * Creates a setup session and returns the token. Called by the bot.
   * Body: { authUserId, guildId, discordUserId, apiSecret }
   */
  async function createSessionEndpoint(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let body: { authUserId: string; guildId: string; discordUserId: string; apiSecret: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!hasValidApiSecret(body.apiSecret)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!body.authUserId || !body.guildId || !body.discordUserId) {
      return Response.json(
        { error: 'authUserId, guildId, and discordUserId are required' },
        { status: 400 }
      );
    }
    const token = await createSetupSession(
      body.authUserId,
      body.guildId,
      body.discordUserId,
      config.encryptionSecret
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
    let body: { discordUserId: string; guildId: string; apiSecret: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!hasValidApiSecret(body.apiSecret)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!body.discordUserId || !body.guildId) {
      return Response.json({ error: 'discordUserId and guildId are required' }, { status: 400 });
    }
    const token = generateToken();
    await storeConnectToken(token, body.discordUserId, body.guildId);
    return Response.json({ token });
  }

  /**
   * GET /connect
   * Legacy Bun page entrypoint. The TanStack web app owns the connect UI.
   */
  async function serveConnectPage(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const _frontendUrl = new URL(config.frontendBaseUrl);
    const redirectUrl = new URL('/connect', `${config.frontendBaseUrl.replace(/\/$/, '')}/`);
    redirectUrl.search = url.search;

    if (redirectUrl.origin === url.origin && redirectUrl.pathname === url.pathname) {
      return createLegacyFrontendMovedResponse();
    }

    return Response.redirect(redirectUrl.toString(), 302);
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

    let setupToken: string | null;
    let connectToken: string | null;
    try {
      setupToken = validateToken(body.setupToken?.trim(), 'setupToken');
      connectToken = validateToken(body.connectToken?.trim(), 'connectToken');
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid token format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

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
              toCookieAge(60 * 60 * 1000)
            ),
          },
        }
      );
    }

    const store = getStateStore();
    const raw = await store.get(`${CONNECT_TOKEN_PREFIX}${connectToken}`);
    if (!raw) {
      logger.warn('Connect token not found or expired', {
        tokenPrefix: `${connectToken?.slice(0, 8)}...`,
        hint: 'Ensure DRAGONFLY_URI/REDIS_URL is set so token storage is shared across instances',
      });
      return Response.json({ error: 'Invalid or expired connect token' }, { status: 401 });
    }

    if (!connectToken) {
      return Response.json({ error: 'Connect token is required' }, { status: 400 });
    }
    const activeConnectToken = connectToken;

    return Response.json(
      { success: true },
      {
        headers: {
          'Set-Cookie': buildCookie(
            CONNECT_TOKEN_COOKIE,
            activeConnectToken,
            request,
            toCookieAge(TOKEN_EXPIRY_MS)
          ),
        },
      }
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

    const connectSession = await resolveConnectSession(request);
    const connectDiscordUserId = connectSession?.discordUserId ?? null;
    const sessionDiscordUserId = await getAuthenticatedDiscordUserId(request);
    if (
      connectDiscordUserId &&
      sessionDiscordUserId &&
      connectDiscordUserId !== sessionDiscordUserId
    ) {
      logger.warn('Connect token Discord identity mismatch', {
        expectedDiscordUserId: connectDiscordUserId,
        actualDiscordUserId: sessionDiscordUserId,
        guildId,
      });
      return Response.json(
        { error: 'This setup link belongs to a different Discord account' },
        { status: 403 }
      );
    }

    const discordUserId: string | null = connectDiscordUserId ?? sessionDiscordUserId;
    if (!connectSession?.discordUserId || connectSession.guildId !== guildId) {
      return Response.json(
        {
          error:
            'A valid setup link for this server is required. Run `/creator-admin setup start` again.',
        },
        { status: 403 }
      );
    }

    const convex = getConvexClient();
    const apiSecret = getConvexApiSecret();
    const existing = await convex.query(api.creatorProfiles.getCreatorByAuthUser, {
      apiSecret,
      authUserId: session.user.id,
    });

    if (!existing && !discordUserId) {
      return Response.json(
        { error: 'Session expired. Please sign in again from Discord.' },
        { status: 400 }
      );
    }

    try {
      if (!existing) {
        if (!discordUserId) {
          return Response.json(
            { error: 'Session expired. Please sign in again from Discord.' },
            { status: 400 }
          );
        }
        await convex.mutation(api.creatorProfiles.createCreatorProfile, {
          apiSecret,
          name: `Creator ${discordUserId.slice(0, 8)}`,
          ownerDiscordUserId: discordUserId,
          authUserId: session.user.id,
          policy: {},
        });
      }
      const authUserId = session.user.id;

      await convex.mutation(api.guildLinks.upsertGuildLink, {
        apiSecret,
        authUserId,
        discordGuildId: guildId,
        ...(await fetchGuildMeta(guildId)),
        installedByAuthUserId: session.user.id,
        botPresent: true,
        status: 'active',
      });

      logger.info('Connect flow completed', {
        guildId,
        authUserId: session.user.id,
      });

      const clearedCookie = clearCookie(CONNECT_TOKEN_COOKIE, request);
      return new Response(JSON.stringify({ success: true, authUserId, isFirstTime: !existing }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearedCookie },
      });
    } catch (err) {
      logger.error('Connect complete failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to complete setup' }, { status: 500 });
    }
  }

  /**
   * GET /api/connect/ensure-tenant?guildId=XXX&token=XXX
   * Returns { authUserId }, creating tenant + guild link if missing.
   */
  async function ensureTenant(request: Request): Promise<Response> {
    // This GET endpoint performs state mutations (createCreatorProfile, upsertGuildLink).
    // Reject cross-site requests to prevent CSRF exploitation.
    const allowedOrigins = new Set([
      new URL(config.apiBaseUrl).origin,
      new URL(config.frontendBaseUrl).origin,
    ]);
    const csrfBlock = rejectCrossSiteRequest(request, allowedOrigins);
    if (csrfBlock) return csrfBlock;

    const session = await auth.getSession(request);
    if (!session) {
      const url = new URL(request.url);
      logger.warn('Ensure tenant rejected due to missing session', {
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
    const apiSecret = getConvexApiSecret();
    const existingGuildLink = await convex.query(api.guildLinks.getGuildLinkForUninstall, {
      apiSecret,
      discordGuildId: guildId,
    });

    if (existingGuildLink) {
      if (existingGuildLink.authUserId !== session.user.id) {
        return Response.json(
          { error: 'This server is already linked to another account.' },
          { status: 403 }
        );
      }
      return Response.json({ authUserId: existingGuildLink.authUserId });
    }

    const connectSession = await resolveConnectSession(request);
    const connectDiscordUserId = connectSession?.discordUserId ?? null;
    const sessionDiscordUserId = await getAuthenticatedDiscordUserId(request);
    if (
      connectDiscordUserId &&
      sessionDiscordUserId &&
      connectDiscordUserId !== sessionDiscordUserId
    ) {
      logger.warn('Ensure tenant connect token Discord identity mismatch', {
        expectedDiscordUserId: connectDiscordUserId,
        actualDiscordUserId: sessionDiscordUserId,
        guildId,
      });
      return Response.json(
        { error: 'This setup link belongs to a different Discord account' },
        { status: 403 }
      );
    }

    if (!connectSession?.discordUserId || connectSession.guildId !== guildId) {
      return Response.json(
        {
          error:
            'A valid setup link for this server is required. Run `/creator-admin setup start` again.',
        },
        { status: 403 }
      );
    }

    const discordUserId: string | null = connectDiscordUserId ?? sessionDiscordUserId;

    const existing = await convex.query(api.creatorProfiles.getCreatorByAuthUser, {
      apiSecret,
      authUserId: session.user.id,
    });

    // 4. If we STILL don't have a discordUserId and no existing profile, we can't create one
    if (!existing && !discordUserId) {
      return Response.json(
        {
          error: 'Session expired or Discord link lost. Please sign in again from Discord.',
          details: 'Cannot create profile: missing Discord ID',
        },
        { status: 400 }
      );
    }

    try {
      if (!existing) {
        if (!discordUserId) {
          return Response.json(
            {
              error: 'Session expired or Discord link lost. Please sign in again from Discord.',
              details: 'Cannot create profile: missing Discord ID',
            },
            { status: 400 }
          );
        }
        await convex.mutation(api.creatorProfiles.createCreatorProfile, {
          apiSecret,
          name: `Creator ${discordUserId.slice(0, 8)}`,
          ownerDiscordUserId: discordUserId,
          authUserId: session.user.id,
          policy: {},
        });
      }
      const authUserId = session.user.id;

      await convex.mutation(api.guildLinks.upsertGuildLink, {
        apiSecret,
        authUserId,
        discordGuildId: guildId,
        ...(await fetchGuildMeta(guildId)),
        installedByAuthUserId: session.user.id,
        botPresent: true,
        status: 'active',
      });

      return Response.json({ authUserId });
    } catch (err) {
      logger.error('Ensure tenant failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to ensure tenant' }, { status: 500 });
    }
  }

  /**
   * GET /api/connect/status?authUserId=XXX
   * Returns { gumroad: boolean, jinxxy: boolean }.
   * When authUserId is omitted, returns status for the authenticated user across all their connections.
   */
  async function getStatus(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const url = new URL(request.url);
    const authUserId = url.searchParams.get('authUserId');

    try {
      if (!authUserId) {
        // User-scoped status: check all connections owned by this user
        const status = await connectionService.getConnectionStatus(session.user.id);
        return Response.json(status);
      }

      const tenantOwned = await isTenantOwnedBySessionUser(request, session.user.id, authUserId);
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }

      const status = await connectionService.getConnectionStatus(authUserId);
      return Response.json(status);
    } catch (err) {
      logger.error('Get status failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to retrieve status' }, { status: 500 });
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
      const result = (await convex.query(api.providerConnections.listConnections, {
        apiSecret: config.convexApiSecret,
        authUserId: session.authUserId,
      })) as { allowMismatchedEmails: boolean; connections: unknown[] };
      return Response.json(result);
    } catch (err) {
      logger.error('List connections failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to list connections' }, { status: 500 });
    }
  }

  /**
   * Best-effort provider cleanup before a connection is soft-deleted.
   * Looks up the provider plugin and calls onDisconnect if implemented.
   * Failures are logged but never block the local disconnect.
   */
  async function runProviderDisconnectHook(
    convex: ReturnType<typeof getConvexClientFromUrl>,
    connectionId: string,
    authUserId: string
  ): Promise<void> {
    try {
      const connInfo = await convex.query(api.providerConnections.getConnectionForDisconnect, {
        apiSecret: config.convexApiSecret,
        connectionId: connectionId as Id<'provider_connections'>,
        authUserId,
      });
      if (!connInfo) return;

      const onDisconnect = getProviderHooks(connInfo.provider)?.onDisconnect;
      if (!onDisconnect) return;

      await onDisconnect({
        credentials: connInfo.credentials,
        encryptionSecret: config.encryptionSecret,
        apiBaseUrl: config.apiBaseUrl,
        remoteWebhookId: connInfo.remoteWebhookId ?? undefined,
      });
    } catch (err) {
      logger.warn('Provider onDisconnect hook failed (continuing disconnect)', {
        connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * DELETE /api/connections?id=CONNECTION_ID
   * Disconnects a connection.
   * Auth: setup session token OR Better Auth web session with authUserId query param.
   */
  async function disconnectConnectionHandler(request: Request): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get('id');
    if (!connectionId) {
      return Response.json({ error: 'Connection id is required' }, { status: 400 });
    }

    let authUserId: string;

    const tentativeSetupSession = await resolveSetupSessionFromRequest(request);
    if (tentativeSetupSession) {
      const bound = await requireBoundSetupSession(request);
      if (!bound.ok) return bound.response;
      authUserId = bound.setupSession.authUserId;
    } else {
      const requestedAuthUserId = url.searchParams.get('authUserId') ?? undefined;
      const ownerCheck = await requireOwnerSessionForTenant(request, requestedAuthUserId);
      if (!ownerCheck.ok) return ownerCheck.response;
      if (!requestedAuthUserId) {
        return Response.json({ error: 'authUserId is required' }, { status: 400 });
      }
      authUserId = requestedAuthUserId;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);

      // Call provider onDisconnect hook (e.g. unregister external webhooks)
      await runProviderDisconnectHook(convex, connectionId, authUserId);

      await convex.mutation(api.providerConnections.disconnectConnection, {
        apiSecret: config.convexApiSecret,
        connectionId,
        authUserId,
      });
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Disconnect connection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to disconnect' }, { status: 500 });
    }
  }

  /**
   * GET /api/connect/settings
   * Returns the current tenant policy settings.
   * Accepts either a bound setup session (bot-initiated flow) or a Better Auth
   * web session with `?authUserId=<id>` (regular web login).
   */
  async function getSettingsHandler(request: Request): Promise<Response> {
    let authUserId: string;

    const tentativeSetupSession = await resolveSetupSessionFromRequest(request);
    if (tentativeSetupSession) {
      const bound = await requireBoundSetupSession(request);
      if (!bound.ok) return bound.response;
      authUserId = bound.setupSession.authUserId;
    } else {
      const url = new URL(request.url);
      const requestedAuthUserId = url.searchParams.get('authUserId') ?? undefined;
      const ownerCheck = await requireOwnerSessionForTenant(request, requestedAuthUserId);
      if (!ownerCheck.ok) return ownerCheck.response;
      if (!requestedAuthUserId) {
        return Response.json({ error: 'authUserId is required' }, { status: 400 });
      }
      authUserId = requestedAuthUserId;
    }

    try {
      const tenant = await getCreatorProfile(request, authUserId);
      return Response.json({ policy: tenant?.policy ?? {} });
    } catch (err) {
      logger.error('Get settings failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to get settings' }, { status: 500 });
    }
  }

  /**
   * GET /api/connect/guild/channels
   * Returns text and announcement channels for the setup session's guild.
   * Used to populate the logs/announcements channel dropdowns in the dashboard.
   */
  async function getGuildChannels(request: Request): Promise<Response> {
    // Prefer setup session (bot-initiated flow); fall back to Better Auth web session.
    let guildId: string | null = null;
    let authorizedAuthUserId: string | null = null;

    const tentativeSetupSession = await resolveSetupSessionFromRequest(request);
    if (tentativeSetupSession) {
      const bound = await requireBoundSetupSession(request);
      if (!bound.ok) return bound.response;
      guildId = bound.setupSession.guildId;
      authorizedAuthUserId = bound.setupSession.authUserId;
    } else {
      const url = new URL(request.url);
      const requestedAuthUserId = url.searchParams.get('authUserId') ?? undefined;
      const ownerCheck = await requireOwnerSessionForTenant(request, requestedAuthUserId);
      if (!ownerCheck.ok) {
        return ownerCheck.response;
      }
      if (!requestedAuthUserId) {
        return Response.json({ error: 'authUserId is required' }, { status: 400 });
      }
      authorizedAuthUserId = requestedAuthUserId;
      guildId = url.searchParams.get('guildId') ?? url.searchParams.get('guild_id');
      if (!guildId) {
        return Response.json({ error: 'guildId is required' }, { status: 400 });
      }

      // Verify the requested tenant owns this guild
      try {
        const convex = getConvexClientFromUrl(config.convexUrl);
        const guildLink = await convex.query(api.guildLinks.getGuildLinkForUninstall, {
          apiSecret: config.convexApiSecret,
          discordGuildId: guildId,
        });
        if (!guildLink || guildLink.authUserId !== authorizedAuthUserId) {
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        }
      } catch (err) {
        logger.error('Guild ownership check failed', {
          guildId,
          authUserId: authorizedAuthUserId,
          error: err instanceof Error ? err.message : String(err),
        });
        return Response.json({ error: 'Failed to resolve guild ownership' }, { status: 503 });
      }
    }

    if (!config.discordBotToken) {
      return Response.json({ channels: [] });
    }

    try {
      const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
      });
      if (!res.ok) {
        logger.warn('Failed to fetch guild channels from Discord', {
          guildId,
          status: res.status,
        });
        return Response.json({ channels: [] });
      }
      const raw = (await res.json()) as Array<{ id: string; name: string; type: number }>;
      // 0 = GuildText, 5 = GuildAnnouncement
      const channels = raw
        .filter((ch) => ch.type === 0 || ch.type === 5)
        .map((ch) => ({ id: ch.id, name: ch.name, type: ch.type }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return Response.json({ channels });
    } catch (err) {
      logger.error('Error fetching guild channels', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ channels: [] });
    }
  }

  /**
   * POST /api/connect/settings
   * Body: { key: string, value: unknown, authUserId?: string }
   * Accepts either a bound setup session (bot-initiated flow) or a Better Auth
   * web session with `authUserId` in the request body (regular web login).
   */
  async function updateSettingHandler(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    let body: { key: string; value: unknown; authUserId?: string };
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

    let authUserId: string;

    const tentativeSetupSession = await resolveSetupSessionFromRequest(request);
    if (tentativeSetupSession) {
      const bound = await requireBoundSetupSession(request);
      if (!bound.ok) return bound.response;
      authUserId = bound.setupSession.authUserId;
    } else {
      if (!body.authUserId) {
        return Response.json({ error: 'authUserId is required' }, { status: 400 });
      }
      const ownerCheck = await requireOwnerSessionForTenant(request, body.authUserId);
      if (!ownerCheck.ok) return ownerCheck.response;
      authUserId = body.authUserId;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation(api.providerConnections.updateTenantSetting, {
        apiSecret: config.convexApiSecret,
        authUserId,
        key: body.key,
        value: body.value,
      });
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Update setting failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to update setting' }, { status: 500 });
    }
  }

  const {
    listPublicApiKeys,
    createPublicApiKey,
    revokePublicApiKey,
    rotatePublicApiKey,
    listOAuthApps,
    createOAuthApp,
    regenerateOAuthAppSecret,
    updateOAuthApp,
    deleteOAuthApp,
  } = createConnectApiAccessRoutes({
    auth,
    config,
    logger,
    requireOwnerSessionForTenant,
  });

  const {
    createDiscordRoleSession,
    exchangeDiscordRoleSetupSession,
    discordRoleOAuthBegin,
    discordRoleOAuthCallback,
    getDiscordRoleGuilds,
    saveDiscordRoleSelection,
    getDiscordRoleResult,
  } = createConnectDiscordRoleRoutes({
    config,
    logger,
    hasValidApiSecret: (apiSecret) => hasValidApiSecret(apiSecret ?? undefined),
    generateToken,
    generateSecureRandom,
  });

  const {
    getUserCertificates,
    getViewerBranding,
    createUserCertificateCheckout,
    reconcileUserCertificateBilling,
    getUserCertificatePortal,
    revokeUserCertificate,
  } = createConnectCertificateRoutes({
    auth,
    config,
    logger,
  });

  const {
    revokeUserEntitlement,
    getUserOAuthGrants,
    revokeUserOAuthGrant,
    getUserDataExport,
    requestUserAccountDeletion,
  } = createConnectUserAccountRoutes({
    auth,
    config,
    logger,
    runProviderDisconnectHook,
  });

  const {
    getUserConnections,
    getUserAccounts,
    deleteUserAccount,
    getUserProviders,
    postUserVerifyStart,
    getUserVerificationIntent,
    postUserVerificationEntitlement,
    postUserVerificationManualLicense,
    postUserVerificationProviderLink,
  } = createConnectUserVerificationRoutes({
    auth,
    config,
    isTenantOwnedBySessionUser,
  });

  async function loadDashboardPolicyForAuthUser(
    request: Request,
    authUserId: string,
    timing?: RouteTimingCollector
  ): Promise<Record<string, unknown>> {
    const profile = timing
      ? await timing.measure(
          'selected_policy',
          () => getCreatorProfile(request, authUserId),
          'load selected server policy'
        )
      : await getCreatorProfile(request, authUserId);
    return profile?.policy ?? {};
  }

  /**
   * GET /api/connect/user/guilds
   * Returns a list of servers the user is an admin of
   */
  async function loadUserGuildsForAuthUser(
    authUserId: string,
    timing?: RouteTimingCollector
  ): Promise<DashboardShellResponse['guilds']> {
    const result = (
      timing
        ? await timing.measure(
            'convex_guilds',
            () => guildDirectoryService.listDashboardGuilds({ authUserId }),
            'load dashboard guilds'
          )
        : await guildDirectoryService.listDashboardGuilds({ authUserId })
    ) as { guilds: DashboardShellResponse['guilds']; backfillFailures: number };

    if (result.backfillFailures > 0) {
      logger.warn('Some guild name backfills failed', { count: result.backfillFailures });
    }

    return result.guilds;
  }

  async function getUserGuilds(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    const session = await timing.measure(
      'session',
      () => auth.getSession(request),
      'resolve session'
    );
    if (!session) {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Authentication required' }, { status: 401 }),
        'serialize guild response'
      );
    }

    try {
      const userGuilds = await loadUserGuildsForAuthUser(session.user.id, timing);
      return buildTimedResponse(
        timing,
        () => Response.json({ guilds: userGuilds }),
        'serialize guild response'
      );
    } catch (err) {
      logger.error('Failed to get user guilds', {
        error: err instanceof Error ? err.message : String(err),
      });
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Failed to fetch user guilds' }, { status: 500 }),
        'serialize guild response'
      );
    }
  }

  async function getDashboardShell(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    const session = await timing.measure(
      'session',
      () => auth.getSession(request),
      'resolve dashboard shell session'
    );
    if (!session) {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Authentication required' }, { status: 401 }),
        'serialize dashboard shell'
      );
    }

    try {
      const url = new URL(request.url);
      const requestedAuthUserId =
        url.searchParams.get('authUserId') ??
        url.searchParams.get('tenantId') ??
        url.searchParams.get('tenant_id') ??
        undefined;
      const requestedGuildId =
        url.searchParams.get('guildId') ?? url.searchParams.get('guild_id') ?? undefined;
      const includeHomeData =
        url.searchParams.get('includeHomeData') === 'true' || Boolean(requestedGuildId);
      const [guilds, initialDashboardHome, branding] = await Promise.all([
        loadUserGuildsForAuthUser(session.user.id, timing),
        includeHomeData
          ? timing.measure(
              'convex_home_connections',
              () =>
                connectionService.getDashboardHome({
                  viewerAuthUserId: session.user.id,
                }),
              'load dashboard home'
            )
          : Promise.resolve(null),
        timing.measure(
          'convex_shell_branding',
          () =>
            getConvexClientFromUrl(config.convexUrl).query(
              api.certificateBilling.getShellBrandingForAuthUser,
              {
                apiSecret: config.convexApiSecret,
                authUserId: session.user.id,
              }
            ),
          'load dashboard shell branding'
        ) as Promise<NonNullable<DashboardShellResponse['branding']>>,
      ]);
      const dashboardShellService = new DashboardShellService({
        ownership: {
          async viewerOwnsTenant(viewerAuthUserId, tenantAuthUserId) {
            return timing.measure(
              'selected_owner',
              () => isTenantOwnedBySessionUser(request, viewerAuthUserId, tenantAuthUserId),
              'resolve selected tenant ownership'
            );
          },
        },
        policy: {
          async getPolicy(authUserId) {
            return loadDashboardPolicyForAuthUser(request, authUserId, timing);
          },
        },
      });
      let home: DashboardShellResponse['home'] | undefined;
      let selectedServer: DashboardShellResponse['selectedServer'] | undefined;

      if (includeHomeData) {
        const selection = await dashboardShellService.resolveSelection({
          viewerAuthUserId: session.user.id,
          guilds,
          requestedAuthUserId,
          requestedGuildId,
        });
        const connectionStatusAuthUserId = selection.connectionStatusAuthUserId;
        selectedServer = selection.selectedServer;

        const dashboardHome =
          connectionStatusAuthUserId === session.user.id
            ? initialDashboardHome
            : await timing.measure(
                'convex_home_connections',
                () =>
                  connectionService.getDashboardHome({
                    viewerAuthUserId: session.user.id,
                    connectionStatusAuthUserId,
                  }),
                'load dashboard home'
              );
        if (!dashboardHome) {
          throw new Error('Dashboard home data was not loaded');
        }

        home = {
          providers: [...dashboardHome.providers],
          userAccounts: [...dashboardHome.userAccounts],
          connectionStatusAuthUserId: dashboardHome.connectionStatusAuthUserId,
          connectionStatusByProvider: dashboardHome.connectionStatusByProvider,
        };
      }

      const payload: DashboardShellResponse = {
        viewer: {
          authUserId: session.user.id,
          name: session.user.name ?? null,
          email: session.user.email ?? null,
          image: session.user.image ?? null,
          discordUserId: session.discordUserId ?? null,
        },
        branding,
        guilds,
        ...(home ? { home } : {}),
        ...(selectedServer ? { selectedServer } : {}),
      };

      return buildTimedResponse(timing, () => Response.json(payload), 'serialize dashboard shell');
    } catch (err) {
      logger.error('Failed to get dashboard shell', {
        error: err instanceof Error ? err.message : String(err),
      });
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Failed to fetch dashboard shell' }, { status: 500 }),
        'serialize dashboard shell'
      );
    }
  }

  /**
   * GET /api/connect/user/licenses
   * Returns the authenticated user's verified subjects and entitlements.
   */
  async function getUserLicenses(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const subjectsResult = await convex.query(api.subjects.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
        limit: 50,
      });
      const subjects = subjectsResult.data ?? [];

      const subjectsWithEntitlements = await Promise.all(
        subjects.map(async (subject: { _id: string; displayName?: string; status: string }) => {
          const entitlementsResult = await convex.query(api.entitlements.listByAuthUser, {
            apiSecret: config.convexApiSecret,
            authUserId: session.user.id,
            subjectId: subject._id,
            limit: 50,
          });
          return {
            id: subject._id,
            displayName: subject.displayName ?? null,
            status: subject.status,
            entitlements: (entitlementsResult.data ?? []).map(
              (e: {
                id: string;
                sourceProvider: string;
                productId: string;
                sourceReference?: string;
                status: string;
                grantedAt: number;
                revokedAt?: number | null;
              }) => ({
                id: e.id,
                sourceProvider: e.sourceProvider,
                productId: e.productId,
                sourceReference: e.sourceReference ?? null,
                status: e.status,
                grantedAt: e.grantedAt,
                revokedAt: e.revokedAt ?? null,
              })
            ),
          };
        })
      );

      return Response.json({ subjects: subjectsWithEntitlements });
    } catch (err) {
      logger.error('Failed to get user licenses', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to fetch licenses' }, { status: 500 });
    }
  }

  /**
   * POST /api/connect/:provider/product-credential
   * Body: { authUserId?, productId, productSecretKey }
   *
   * Generic handler for providers that declare `perProductCredential` in their descriptor.
   * Stores an encrypted per-product secret key so license verification works for that product.
   * The `productId` is provider-specific (e.g. Payhip permalink "RGsF").
   */
  async function genericProductCredential(
    request: Request,
    providerKey: string
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const descriptor = getProviderDescriptor(providerKey);
    if (!descriptor?.perProductCredential) {
      return Response.json(
        { error: `Provider "${providerKey}" does not support per-product credentials` },
        { status: 400 }
      );
    }

    const setupBinding = await requireBoundSetupSession(request);
    const setupSession = setupBinding.ok ? setupBinding.setupSession : null;
    if (!setupBinding.ok && getSetupSessionTokenFromRequest(request)) {
      return setupBinding.response;
    }
    const authSession = setupSession ? null : await auth.getSession(request);
    if (!authSession && !setupSession) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: { authUserId?: string; productId: string; productSecretKey: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = setupSession?.authUserId ?? body.authUserId ?? authSession?.user?.id ?? null;
    const { productId, productSecretKey } = body;
    if (!productId || !productSecretKey) {
      return Response.json(
        { error: 'productId and productSecretKey are required' },
        { status: 400 }
      );
    }
    if (!authUserId) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (body.authUserId && !setupSession) {
      if (!authSession) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }
      const tenantOwned = await isTenantOwnedBySessionUser(
        request,
        authSession.user.id,
        body.authUserId
      );
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    try {
      const runtime = getProviderRuntime(providerKey);
      const credentialPurpose = runtime?.productCredentialPurpose;
      if (!credentialPurpose) {
        logger.error('Provider missing productCredentialPurpose for per-product credential', {
          providerKey,
        });
        return Response.json({ error: 'Provider credential configuration error' }, { status: 500 });
      }
      const encryptedSecretKey = await encrypt(
        productSecretKey,
        config.encryptionSecret,
        credentialPurpose
      );
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation(api.providerConnections.upsertProductCredential, {
        apiSecret: config.convexApiSecret,
        authUserId,
        providerKey: descriptor.providerKey,
        productId,
        credentialKeyPrefix: descriptor.perProductCredential.credentialKeyPrefix,
        encryptedSecretKey,
      });

      if (runtime?.onProductCredentialAdded) {
        const providerCtx = {
          convex,
          apiSecret: config.convexApiSecret,
          authUserId,
          encryptionSecret: config.encryptionSecret,
        };
        runtime.onProductCredentialAdded(productId, providerCtx).catch((err) => {
          logger.warn('onProductCredentialAdded hook failed (non-fatal)', {
            providerKey,
            productId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      return Response.json({ success: true });
    } catch (err) {
      logger.error('Product credential store failed', {
        providerKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to save product credential' }, { status: 500 });
    }
  }

  /**
   * POST /api/connect/payhip/product-key
   * Body: { authUserId?, permalink, productSecretKey }
   *
   * @deprecated Use POST /api/connect/payhip/product-credential instead.
   * Kept for backwards compatibility, delegates to genericProductCredential.
   */
  async function payhipProductKey(request: Request): Promise<Response> {
    // Translate legacy `permalink` field to `productId` and delegate to the generic handler.
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let rawBody: Record<string, unknown>;
    try {
      rawBody = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    // Map legacy `permalink` → `productId`
    const normalized = {
      ...rawBody,
      productId: rawBody.productId ?? rawBody.permalink,
    };
    const syntheticRequest = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(normalized),
    });
    return genericProductCredential(syntheticRequest, 'payhip');
  }

  return {
    serveConnectPage,
    exchangeConnectBootstrap,
    getDashboardSessionStatus,
    createSessionEndpoint,
    createTokenEndpoint,
    completeSetup,
    ensureTenant,
    dispatchPlugin,
    getStatus,
    payhipProductKey,
    genericProductCredential,
    listConnectionsHandler,
    disconnectConnectionHandler,
    getSettingsHandler,
    updateSettingHandler,
    getGuildChannels,
    listPublicApiKeys,
    createPublicApiKey,
    revokePublicApiKey,
    rotatePublicApiKey,
    listOAuthApps,
    createOAuthApp,
    updateOAuthApp,
    deleteOAuthApp,
    regenerateOAuthAppSecret,
    createDiscordRoleSession,
    exchangeDiscordRoleSetupSession,
    discordRoleOAuthBegin,
    discordRoleOAuthCallback,
    getDiscordRoleGuilds,
    saveDiscordRoleSelection,
    getDiscordRoleResult,
    getDashboardShell,
    getViewerBranding,
    getUserGuilds,
    getUserConnections,
    getUserProviders,
    postUserVerifyStart,
    getUserVerificationIntent,
    postUserVerificationEntitlement,
    postUserVerificationProviderLink,
    postUserVerificationManualLicense,
    getUserAccounts,
    deleteUserAccount,
    getUserCertificates,
    getCreatorCertificates: getUserCertificates,
    createUserCertificateCheckout,
    createCreatorCertificateCheckout: createUserCertificateCheckout,
    getUserCertificatePortal,
    getCreatorCertificatePortal: getUserCertificatePortal,
    reconcileUserCertificateBilling,
    reconcileCreatorCertificateBilling: reconcileUserCertificateBilling,
    revokeUserCertificate,
    revokeCreatorCertificate: revokeUserCertificate,
    getUserLicenses,
    revokeUserEntitlement,
    getUserOAuthGrants,
    revokeUserOAuthGrant,
    getUserDataExport,
    requestUserAccountDeletion,
    serverUpsertProductCredential,
  };

  /**
   * Server-to-server variant of genericProductCredential.
   * No session required, called by internal RPC with trusted authUserId.
   * Encrypts the plaintext secret key and stores it via the generic Convex mutation.
   */
  async function serverUpsertProductCredential(params: {
    authUserId: string;
    providerKey: string;
    productId: string;
    plaintextSecretKey: string;
  }): Promise<{ success: boolean; error?: string }> {
    const descriptor = getProviderDescriptor(params.providerKey);
    if (!descriptor?.perProductCredential) {
      return {
        success: false,
        error: `Provider "${params.providerKey}" does not support per-product credentials`,
      };
    }
    try {
      const runtime = getProviderRuntime(params.providerKey);
      const credentialPurpose = runtime?.productCredentialPurpose;
      if (!credentialPurpose) {
        return {
          success: false,
          error: `Provider "${params.providerKey}" is missing productCredentialPurpose`,
        };
      }
      const encryptedSecretKey = await encrypt(
        params.plaintextSecretKey,
        config.encryptionSecret,
        credentialPurpose
      );
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation(api.providerConnections.upsertProductCredential, {
        apiSecret: config.convexApiSecret,
        authUserId: params.authUserId,
        providerKey: descriptor.providerKey,
        productId: params.productId,
        credentialKeyPrefix: descriptor.perProductCredential.credentialKeyPrefix,
        encryptedSecretKey,
      });

      if (runtime?.onProductCredentialAdded) {
        const providerCtx = {
          convex,
          apiSecret: config.convexApiSecret,
          authUserId: params.authUserId,
          encryptionSecret: config.encryptionSecret,
        };
        runtime.onProductCredentialAdded(params.productId, providerCtx).catch((err) => {
          logger.warn('onProductCredentialAdded hook failed (non-fatal)', {
            providerKey: params.providerKey,
            productId: params.productId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to save product credential',
      };
    }
  }
}

export function storeConnectToken(
  token: string,
  discordUserId: string,
  guildId: string
): Promise<void> {
  const store = getStateStore();
  return store.set(
    `${CONNECT_TOKEN_PREFIX}${token}`,
    JSON.stringify({ discordUserId, guildId }),
    TOKEN_EXPIRY_MS
  );
}

export { generateToken };
