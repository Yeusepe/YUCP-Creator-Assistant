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

import { randomBytes } from 'node:crypto';
import { createLogger, getProviderDescriptor, timingSafeStringEqual } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import {
  buildCookie,
  CONNECT_TOKEN_COOKIE,
  clearCookie,
  DISCORD_ROLE_SETUP_COOKIE,
  getCookieValue,
  SETUP_SESSION_COOKIE,
} from '../lib/browserSessions';
import { getConvexApiSecret, getConvexClient, getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { encrypt } from '../lib/encrypt';
import { createLegacyFrontendMovedResponse } from '../lib/legacyFrontend';
import { PUBLIC_API_KEY_PREFIX } from '../lib/publicApiKeys';
import { createSetupSession, resolveSetupSession } from '../lib/setupSession';
import { getStateStore } from '../lib/stateStore';
import { PROVIDERS } from '../providers/index';
import type { ConnectConfig, ConnectContext } from '../providers/types';

// Re-exported for backwards compatibility — ConnectConfig is defined in providers/types.ts
export type { ConnectConfig } from '../providers/types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

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
const ALLOWED_PUBLIC_API_SCOPES = new Set(['verification:read', 'subjects:read']);
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';
const PUBLIC_API_KEY_METADATA_KIND = 'public-api';
const DEFAULT_PUBLIC_API_SCOPES = ['verification:read', 'subjects:read'];
const DEFAULT_OAUTH_APP_SCOPES = ['verification:read'];

const DISCORD_ROLE_SETUP_PREFIX = 'discord_role_setup:';
const DISCORD_ROLE_OAUTH_STATE_PREFIX = 'discord_role_oauth:';
const DISCORD_ROLE_SETUP_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface DiscordRoleSetupSession {
  authUserId: string;
  guildId: string;
  adminDiscordUserId: string;
  guilds?: Array<{
    id: string;
    name: string;
    icon: string | null;
    owner: boolean;
    permissions: string;
  }>;
  sourceGuildId?: string;
  sourceGuildName?: string;
  sourceRoleId?: string;
  sourceRoleIds?: string[];
  requiredRoleMatchMode?: 'any' | 'all';
  completed: boolean;
}

interface BetterAuthPermissionStatements {
  [key: string]: string[];
}

interface BetterAuthApiKey {
  id: string;
  name?: string | null;
  start?: string | null;
  prefix?: string | null;
  enabled?: boolean;
  permissions?: BetterAuthPermissionStatements | null;
  metadata?: unknown;
  lastRequest?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
}

interface BetterAuthOAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  scope?: string;
  client_id_issued_at?: number;
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none';
  grant_types?: Array<'authorization_code' | 'refresh_token' | 'client_credentials'>;
  response_types?: Array<'code'>;
  disabled?: boolean;
}

interface OAuthAppMappingRecord {
  _id: string;
  _creationTime: number;
  authUserId: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  scopes: string[];
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return undefined;
}

function normalizePublicApiScopes(scopes: unknown): string[] {
  const values =
    Array.isArray(scopes) && scopes.length > 0
      ? scopes.map((scope) => (typeof scope === 'string' ? scope.trim() : '')).filter(Boolean)
      : [...DEFAULT_PUBLIC_API_SCOPES];

  if (values.some((scope) => !ALLOWED_PUBLIC_API_SCOPES.has(scope))) {
    throw new Error('Invalid API key scopes');
  }

  return Array.from(new Set(values));
}

function parsePublicApiKeyMetadata(value: unknown): { kind?: string; authUserId?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const metadata = value as Record<string, unknown>;
  return {
    kind: typeof metadata.kind === 'string' ? metadata.kind : undefined,
    authUserId: typeof metadata.authUserId === 'string' ? metadata.authUserId : undefined,
  };
}

function getPublicApiKeyScopes(
  permissions: BetterAuthPermissionStatements | null | undefined
): string[] {
  if (!permissions || typeof permissions !== 'object') {
    return [];
  }

  const scopes = permissions[PUBLIC_API_KEY_PERMISSION_NAMESPACE];
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
}

function _buildPublicApiPermissions(scopes: string[]): BetterAuthPermissionStatements {
  return {
    [PUBLIC_API_KEY_PERMISSION_NAMESPACE]: scopes,
  };
}

function getPublicApiKeyExpiresIn(expiresAt: number | null | undefined): number | null | undefined {
  if (expiresAt === null) {
    return null;
  }
  if (expiresAt === undefined) {
    return undefined;
  }

  const expiresIn = Math.floor((expiresAt - Date.now()) / 1000);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('expiresAt must be in the future');
  }
  return expiresIn;
}

async function createManagedPublicApiKey(
  config: ConnectConfig,
  ownerUserId: string,
  input: {
    name: string;
    scopes: string[];
    authUserId: string;
    expiresAt?: number | null;
  }
): Promise<{
  response: Response;
  data: (BetterAuthApiKey & { key?: string }) | null;
}> {
  const convex = getConvexClientFromUrl(config.convexUrl);
  try {
    const result = (await convex.mutation(api.betterAuthApiKeys.createApiKey, {
      apiSecret: config.convexApiSecret,
      userId: ownerUserId,
      authUserId: input.authUserId,
      name: input.name,
      scopes: input.scopes,
      expiresIn: getPublicApiKeyExpiresIn(input.expiresAt),
    })) as {
      key: string;
      apiKey: {
        id: string;
        name: string | null;
        start: string | null;
        prefix: string | null;
        enabled: boolean;
        permissions: BetterAuthPermissionStatements | null;
        metadata: { kind: string; authUserId: string } | null;
        lastRequestAt: number | null;
        expiresAt: number | null;
        createdAt: number | null;
      };
    };

    return {
      response: new Response(null, { status: 200 }),
      data: {
        id: result.apiKey.id,
        key: result.key,
        name: result.apiKey.name,
        start: result.apiKey.start,
        prefix: result.apiKey.prefix,
        enabled: result.apiKey.enabled,
        permissions: result.apiKey.permissions,
        metadata: result.apiKey.metadata,
        lastRequest: result.apiKey.lastRequestAt ?? undefined,
        expiresAt: result.apiKey.expiresAt ?? undefined,
        createdAt: result.apiKey.createdAt ?? undefined,
      },
    };
  } catch (error) {
    logger.error('Create API key via Convex failed', {
      authUserId: input.authUserId,
      userId: ownerUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      response: new Response(null, { status: 500 }),
      data: null,
    };
  }
}

function normalizeRedirectUris(redirectUris: unknown): string[] {
  const values = Array.isArray(redirectUris)
    ? redirectUris.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
    : [];

  if (values.length === 0) {
    throw new Error('At least one redirect URI is required');
  }

  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';

  for (const redirectUri of values) {
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      throw new Error(`Invalid redirect URI: ${redirectUri}`);
    }

    if (isProduction) {
      // In production, require HTTPS for all redirect URIs.
      if (parsed.protocol !== 'https:') {
        throw new Error(`Redirect URI must use HTTPS in production: ${redirectUri}`);
      }
    } else {
      // In development, allow localhost/127.0.0.1 over HTTP only.
      const isLocalhost =
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]';
      if (parsed.protocol !== 'https:' && !isLocalhost) {
        throw new Error(`Redirect URI must use HTTPS or target localhost: ${redirectUri}`);
      }
    }
  }

  return Array.from(new Set(values));
}

function normalizeOAuthScopes(scopes: unknown): string[] {
  const values = Array.isArray(scopes)
    ? scopes.map((scope) => (typeof scope === 'string' ? scope.trim() : '')).filter(Boolean)
    : [];

  return Array.from(new Set(values.length > 0 ? values : [...DEFAULT_OAUTH_APP_SCOPES]));
}

function getBetterAuthErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }

  const error = record.error;
  if (error && typeof error === 'object') {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === 'string' && errorRecord.message.trim()) {
      return errorRecord.message;
    }
    if (typeof errorRecord.error_description === 'string' && errorRecord.error_description.trim()) {
      return errorRecord.error_description;
    }
  }

  if (typeof record.error_description === 'string' && record.error_description.trim()) {
    return record.error_description;
  }

  return fallback;
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

  function hasValidApiSecret(value: string | undefined): boolean {
    return typeof value === 'string' && timingSafeStringEqual(value, config.convexApiSecret);
  }

  /**
   * Fetches guild name/icon from Discord's API using the bot token.
   * Returns an object suitable for spreading into the upsertGuildLink call.
   * Never throws — returns empty object on failure so the flow is unaffected.
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
    const token = getSetupSessionTokenFromRequest(request);
    if (!token) return null;
    return resolveSetupSession(token, config.encryptionSecret);
  }

  function getSetupSessionTokenFromRequest(request: Request): string | null {
    const authHeader = request.headers.get('authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = getCookieValue(request, SETUP_SESSION_COOKIE);
    return bearerToken ?? cookieToken;
  }

  async function resolveConnectSession(request: Request): Promise<ConnectSession | null> {
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
      return {
        ok: false,
        response: Response.json({ error: 'Valid setup session required' }, { status: 401 }),
      };
    }

    const store = getStateStore();
    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    if (!raw) {
      return {
        ok: false,
        response: Response.json({ error: 'Invalid or expired session' }, { status: 401 }),
      };
    }

    const roleSession = JSON.parse(raw) as DiscordRoleSetupSession;
    return { ok: true, sessionToken: token, roleSession };
  }

  async function isTenantOwnedBySessionUser(
    sessionUserId: string,
    profileAuthUserId: string
  ): Promise<boolean> {
    const convex = getConvexClientFromUrl(config.convexUrl);
    const profile = await convex.query(api.creatorProfiles.getCreatorProfile, {
      apiSecret: config.convexApiSecret,
      authUserId: profileAuthUserId,
    });
    return !!profile && profile.authUserId === sessionUserId;
  }

  async function requireOwnerSessionForTenant(
    request: Request,
    authUserId: string | undefined
  ): Promise<
    | { ok: true; session: NonNullable<Awaited<ReturnType<Auth['getSession']>>> }
    | { ok: false; response: Response }
  > {
    // Check authentication first — unauthenticated requests always get 401,
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
      tenantOwned = await isTenantOwnedBySessionUser(session.user.id, authUserId);
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
   * ConnectContext — injected into every provider connect plugin route handler.
   * Built from the auth instance and config that were passed to createConnectRoutes.
   */
  const connectContext: ConnectContext = {
    config,
    auth,
    requireBoundSetupSession,
    getSetupSessionTokenFromRequest,
    isTenantOwnedBySessionUser,
  };

  /**
   * Dispatches a request to the matching provider connect plugin route.
   * Returns null when no plugin matches, so the caller can fall through.
   */
  function dispatchPlugin(
    method: string,
    pathname: string,
    request: Request
  ): Promise<Response> | null {
    for (const plugin of PROVIDERS.values()) {
      if (!plugin.connect) continue;
      for (const route of plugin.connect.routes) {
        if (route.method === method && route.path === pathname) {
          return route.handler(request, connectContext);
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
      const convex = getConvexClientFromUrl(config.convexUrl);

      if (!authUserId) {
        // User-scoped status: check all connections owned by this user
        const status = await convex.query(api.providerConnections.getConnectionStatus, {
          apiSecret: config.convexApiSecret,
          authUserId: session.user.id,
        });
        return Response.json(status);
      }

      const tenantOwned = await isTenantOwnedBySessionUser(session.user.id, authUserId);
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }

      const status = await convex.query(api.providerConnections.getConnectionStatus, {
        apiSecret: config.convexApiSecret,
        authUserId,
      });
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
        connectionId: connectionId as any,
        authUserId,
      });
      if (!connInfo) return;

      const plugin = PROVIDERS.get(connInfo.provider);
      if (!plugin?.onDisconnect) return;

      await plugin.onDisconnect({
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
      const ownerCheck = await requireOwnerSessionForTenant(
        request,
        url.searchParams.get('authUserId') ?? undefined
      );
      if (!ownerCheck.ok) return ownerCheck.response;
      authUserId = url.searchParams.get('authUserId')!;
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
      const ownerCheck = await requireOwnerSessionForTenant(
        request,
        url.searchParams.get('authUserId') ?? undefined
      );
      if (!ownerCheck.ok) return ownerCheck.response;
      authUserId = url.searchParams.get('authUserId')!;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const tenant = (await convex.query(api.creatorProfiles.getCreatorProfile, {
        apiSecret: config.convexApiSecret,
        authUserId,
      })) as { policy?: Record<string, unknown> };
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
      authorizedAuthUserId = requestedAuthUserId!;
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
      const ownerCheck = await requireOwnerSessionForTenant(request, body.authUserId);
      if (!ownerCheck.ok) return ownerCheck.response;
      authUserId = body.authUserId!;
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

  async function listPublicApiKeys(request: Request): Promise<Response> {
    const authUserId = new URL(request.url).searchParams.get('authUserId') ?? undefined;
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const { apiKeys: data } = await auth.listApiKeys(request);

      const keys = data
        .filter((key) => {
          const metadata = parsePublicApiKeyMetadata(key.metadata);
          return (
            metadata?.kind === PUBLIC_API_KEY_METADATA_KIND && metadata.authUserId === authUserId
          );
        })
        .map((key) => ({
          _id: key.id,
          _creationTime: toTimestamp(key.createdAt) ?? Date.now(),
          authUserId,
          name: key.name ?? 'Unnamed',
          prefix: key.start ?? key.prefix ?? PUBLIC_API_KEY_PREFIX,
          status: key.enabled === false ? ('revoked' as const) : ('active' as const),
          scopes: getPublicApiKeyScopes(key.permissions),
          lastUsedAt: toTimestamp(key.lastRequest),
          expiresAt: toTimestamp(key.expiresAt),
        }))
        .sort((left, right) => right._creationTime - left._creationTime);

      return Response.json({ keys });
    } catch (err) {
      logger.error('List API keys failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to list API keys' }, { status: 500 });
    }
  }

  async function createPublicApiKey(request: Request): Promise<Response> {
    let body: {
      authUserId?: string;
      name?: string;
      scopes?: string[];
      expiresAt?: number | null;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if ('response' in required) {
      return required.response;
    }
    if (!authUserId) {
      return Response.json({ error: 'authUserId is required' }, { status: 400 });
    }

    const name = body.name?.trim();
    if (!name) {
      return Response.json({ error: 'name is required' }, { status: 400 });
    }

    try {
      const scopes = normalizePublicApiScopes(body.scopes);
      const expiresAt =
        typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
          ? body.expiresAt
          : undefined;
      const { response, data } = await createManagedPublicApiKey(config, required.session.user.id, {
        name,
        scopes,
        authUserId,
        expiresAt,
      });

      if (!response.ok || !data?.id || !data.key) {
        logger.warn('Create API key rejected by Better Auth', {
          authUserId,
          userId: required.session.user.id,
          status: response.status,
          error: getBetterAuthErrorMessage(data, 'Failed to create API key'),
          data,
        });
        return Response.json(
          { error: getBetterAuthErrorMessage(data, 'Failed to create API key') },
          { status: response.status || 500 }
        );
      }

      return Response.json({
        keyId: data.id,
        apiKey: data.key,
        name: data.name ?? name,
        prefix: data.start ?? data.prefix ?? PUBLIC_API_KEY_PREFIX,
        scopes,
        expiresAt: toTimestamp(data.expiresAt) ?? null,
      });
    } catch (err) {
      logger.error('Create API key failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to create API key' },
        { status: 400 }
      );
    }
  }

  async function revokePublicApiKey(request: Request, keyId: string): Promise<Response> {
    let body: { authUserId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if ('response' in required) {
      return required.response;
    }
    if (!authUserId) {
      return Response.json({ error: 'authUserId is required' }, { status: 400 });
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const existing = (await convex.query(api.betterAuthApiKeys.getApiKey, {
        keyId,
      })) as BetterAuthApiKey | null;

      if (!existing) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      const metadata = parsePublicApiKeyMetadata(existing.metadata);
      if (metadata?.kind !== PUBLIC_API_KEY_METADATA_KIND || metadata.authUserId !== authUserId) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      await convex.mutation(api.betterAuthApiKeys.updateApiKey, {
        keyId,
        enabled: false,
      });

      return Response.json({ success: true });
    } catch (err) {
      logger.error('Revoke API key failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to revoke API key' }, { status: 500 });
    }
  }

  async function listOAuthApps(request: Request): Promise<Response> {
    const authUserId = new URL(request.url).searchParams.get('authUserId') ?? undefined;
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mappings = (await convex.query(api.oauthApps.listOAuthApps, {
        apiSecret: config.convexApiSecret,
        authUserId,
      })) as OAuthAppMappingRecord[];
      const clients =
        mappings.length === 0
          ? []
          : ((await auth.listOAuthClients(request)) as BetterAuthOAuthClient[]);

      const clientMap = new Map(clients.map((client) => [client.client_id, client] as const));

      const apps = mappings
        .map((mapping) => {
          const client = clientMap.get(mapping.clientId);
          if (!client) {
            logger.warn('OAuth app mapping missing Better Auth client', {
              appId: mapping._id,
              clientId: mapping.clientId,
              authUserId,
            });
            return null;
          }

          const scopes = client.scope ? client.scope.split(/\s+/).filter(Boolean) : mapping.scopes;

          return {
            _id: mapping._id,
            _creationTime: mapping._creationTime,
            authUserId: mapping.authUserId,
            name: client.client_name ?? mapping.name,
            clientId: mapping.clientId,
            redirectUris: client.redirect_uris ?? mapping.redirectUris,
            scopes,
            tokenEndpointAuthMethod: client.token_endpoint_auth_method,
            grantTypes: client.grant_types,
            responseTypes: client.response_types,
            disabled: client.disabled ?? false,
          };
        })
        .filter((app): app is NonNullable<typeof app> => Boolean(app));

      return Response.json({ apps });
    } catch (err) {
      logger.error('List OAuth apps failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to list OAuth apps' }, { status: 500 });
    }
  }

  async function createOAuthApp(request: Request): Promise<Response> {
    let body: {
      authUserId?: string;
      name?: string;
      redirectUris?: string[];
      scopes?: string[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if ('response' in required) {
      return required.response;
    }

    const name = body.name?.trim();
    if (!name) {
      return Response.json({ error: 'name is required' }, { status: 400 });
    }

    try {
      const redirectUris = normalizeRedirectUris(body.redirectUris);
      const scopes = normalizeOAuthScopes(body.scopes);
      const convex = getConvexClientFromUrl(config.convexUrl);
      const createdClient = (await convex.mutation(api.oauthClients.createOAuthClient, {
        client_name: name,
        redirect_uris: redirectUris,
        scope: scopes.join(' '),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        type: 'web',
      })) as BetterAuthOAuthClient;

      if (!createdClient.client_id || !createdClient.client_secret) {
        return Response.json({ error: 'Failed to create OAuth app' }, { status: 500 });
      }

      try {
        const result = await convex.mutation(api.oauthApps.createOAuthAppMapping, {
          apiSecret: config.convexApiSecret,
          authUserId,
          name,
          clientId: createdClient.client_id,
          redirectUris,
          scopes,
          createdByAuthUserId: required.session.user.id,
        });

        return Response.json({
          appId: result._id,
          clientId: createdClient.client_id,
          clientSecret: createdClient.client_secret,
          name: result.name,
          redirectUris: result.redirectUris,
          scopes: result.scopes,
        });
      } catch (mappingError) {
        await convex.mutation(api.oauthClients.deleteOAuthClient, {
          clientId: createdClient.client_id,
        });
        throw mappingError;
      }
    } catch (err) {
      logger.error('Create OAuth app failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to create OAuth app' },
        { status: 400 }
      );
    }
  }

  async function regenerateOAuthAppSecret(request: Request, appId: string): Promise<Response> {
    let body: { authUserId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mapping = await convex.query(api.oauthApps.getOAuthApp, {
        apiSecret: config.convexApiSecret,
        authUserId,
        appId,
      });

      if (!mapping) {
        return Response.json({ error: 'OAuth app not found' }, { status: 404 });
      }

      const result = (await convex.mutation(api.oauthClients.rotateOAuthClientSecret, {
        clientId: mapping.clientId,
      })) as BetterAuthOAuthClient;

      if (!result.client_secret) {
        return Response.json({ error: 'Failed to regenerate secret' }, { status: 500 });
      }

      return Response.json({
        clientSecret: result.client_secret,
      });
    } catch (err) {
      logger.error('Regenerate OAuth app secret failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to regenerate secret' }, { status: 500 });
    }
  }

  async function updateOAuthApp(request: Request, appId: string): Promise<Response> {
    let body: {
      authUserId?: string;
      name?: string;
      redirectUris?: string[];
      scopes?: string[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mapping = await convex.query(api.oauthApps.getOAuthApp, {
        apiSecret: config.convexApiSecret,
        authUserId,
        appId,
      });

      if (!mapping) {
        return Response.json({ error: 'OAuth app not found' }, { status: 404 });
      }

      const nextName =
        body.name === undefined
          ? undefined
          : (() => {
              const value = body.name?.trim() ?? '';
              if (!value) {
                throw new Error('name cannot be empty');
              }
              return value;
            })();
      const nextRedirectUris =
        body.redirectUris === undefined ? undefined : normalizeRedirectUris(body.redirectUris);
      const nextScopes = body.scopes === undefined ? undefined : normalizeOAuthScopes(body.scopes);

      if (nextName === undefined && nextRedirectUris === undefined && nextScopes === undefined) {
        return Response.json({ error: 'No updates provided' }, { status: 400 });
      }

      await convex.mutation(api.oauthClients.updateOAuthClient, {
        clientId: mapping.clientId,
        update: {
          ...(nextName !== undefined ? { client_name: nextName } : {}),
          ...(nextRedirectUris !== undefined ? { redirect_uris: nextRedirectUris } : {}),
          ...(nextScopes !== undefined ? { scope: nextScopes.join(' ') } : {}),
        },
      });

      await convex.mutation(api.oauthApps.updateOAuthAppMapping, {
        apiSecret: config.convexApiSecret,
        authUserId,
        appId,
        name: nextName,
        redirectUris: nextRedirectUris,
        scopes: nextScopes,
      });

      return Response.json({ success: true });
    } catch (err) {
      logger.error('Update OAuth app failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to update OAuth app' },
        { status: 500 }
      );
    }
  }

  async function deleteOAuthApp(request: Request, appId: string): Promise<Response> {
    let body: { authUserId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mapping = await convex.query(api.oauthApps.getOAuthApp, {
        apiSecret: config.convexApiSecret,
        authUserId,
        appId,
      });

      if (!mapping) {
        return Response.json({ error: 'OAuth app not found' }, { status: 404 });
      }

      await convex.mutation(api.oauthClients.deleteOAuthClient, {
        clientId: mapping.clientId,
      });

      await convex.mutation(api.oauthApps.deleteOAuthAppMapping, {
        apiSecret: config.convexApiSecret,
        authUserId,
        appId,
      });

      return Response.json({ success: true });
    } catch (err) {
      logger.error('Delete OAuth app failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to delete OAuth app' },
        { status: 500 }
      );
    }
  }

  async function rotatePublicApiKey(request: Request, keyId: string): Promise<Response> {
    let body: {
      authUserId?: string;
      name?: string;
      scopes?: string[];
      expiresAt?: number | null;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if ('response' in required) {
      return required.response;
    }
    if (!authUserId) {
      return Response.json({ error: 'authUserId is required' }, { status: 400 });
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const existing = (await convex.query(api.betterAuthApiKeys.getApiKey, {
        keyId,
      })) as BetterAuthApiKey | null;

      if (!existing) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      const metadata = parsePublicApiKeyMetadata(existing.metadata);
      if (metadata?.kind !== PUBLIC_API_KEY_METADATA_KIND || metadata.authUserId !== authUserId) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      const scopes =
        body.scopes === undefined
          ? getPublicApiKeyScopes(existing.permissions)
          : normalizePublicApiScopes(body.scopes);
      const nextName = body.name?.trim() || existing.name || 'Rotated key';
      const resolvedExpiresAt =
        body.expiresAt === null
          ? null
          : typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
            ? body.expiresAt
            : toTimestamp(existing.expiresAt);
      const created = await createManagedPublicApiKey(config, required.session.user.id, {
        name: nextName,
        scopes,
        authUserId,
        expiresAt: resolvedExpiresAt,
      });

      if (!created.response.ok || !created.data?.id || !created.data.key) {
        logger.warn('Rotate API key rejected by Better Auth', {
          authUserId,
          keyId,
          userId: required.session.user.id,
          status: created.response.status,
          error: getBetterAuthErrorMessage(created.data, 'Failed to rotate API key'),
          data: created.data,
        });
        return Response.json(
          { error: getBetterAuthErrorMessage(created.data, 'Failed to rotate API key') },
          { status: created.response.status || 500 }
        );
      }

      await convex.mutation(api.betterAuthApiKeys.updateApiKey, {
        keyId,
        enabled: false,
      });

      return Response.json({
        keyId: created.data.id,
        apiKey: created.data.key,
        name: nextName,
        prefix: created.data.start ?? created.data.prefix ?? PUBLIC_API_KEY_PREFIX,
        scopes,
        expiresAt: toTimestamp(created.data.expiresAt) ?? null,
        rotatedFromKeyId: keyId,
      });
    } catch (err) {
      logger.error('Rotate API key failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to rotate API key' },
        { status: 400 }
      );
    }
  }

  /**
   * POST /api/setup/discord-role-session
   * Called by the bot. Creates a short-lived setup session for Discord Role admin flow.
   * Body: { authUserId, guildId, adminDiscordUserId, apiSecret }
   */
  async function createDiscordRoleSession(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let body: {
      authUserId: string;
      guildId: string;
      adminDiscordUserId: string;
      apiSecret: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!hasValidApiSecret(body.apiSecret)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!body.authUserId || !body.guildId || !body.adminDiscordUserId) {
      return Response.json(
        { error: 'authUserId, guildId, and adminDiscordUserId are required' },
        { status: 400 }
      );
    }

    const token = generateToken();
    const session: DiscordRoleSetupSession = {
      authUserId: body.authUserId,
      guildId: body.guildId,
      adminDiscordUserId: body.adminDiscordUserId,
      completed: false,
    };
    const store = getStateStore();
    await store.set(
      `${DISCORD_ROLE_SETUP_PREFIX}${token}`,
      JSON.stringify(session),
      DISCORD_ROLE_SETUP_TTL_MS
    );
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
    authUrl.searchParams.set(
      'redirect_uri',
      `${config.apiBaseUrl}/api/setup/discord-role-oauth/callback`
    );
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
      return Response.redirect(
        `${config.frontendBaseUrl}/setup/discord-role?error=${encodeURIComponent(error)}`,
        302
      );
    }
    if (!code || !state) {
      return Response.redirect(
        `${config.frontendBaseUrl}/setup/discord-role?error=missing_parameters`,
        302
      );
    }

    const store = getStateStore();
    const setupToken = await store.get(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`);
    if (!setupToken) {
      return Response.redirect(
        `${config.frontendBaseUrl}/setup/discord-role?error=invalid_state`,
        302
      );
    }
    await store.delete(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`);

    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${setupToken}`);
    if (!raw) {
      return Response.redirect(
        `${config.frontendBaseUrl}/setup/discord-role?error=session_expired`,
        302
      );
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
        return Response.redirect(
          `${config.frontendBaseUrl}/setup/discord-role?error=token_exchange_failed`,
          302
        );
      }

      const tokens = (await tokenRes.json()) as { access_token?: string };
      if (!tokens.access_token) {
        return Response.redirect(
          `${config.frontendBaseUrl}/setup/discord-role?error=no_token`,
          302
        );
      }

      const accessToken = tokens.access_token;

      // Fetch Discord user from OAuth token (not Better Auth - role setup uses its own OAuth)
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userRes.ok) {
        logger.error('Discord role OAuth user fetch failed', { status: userRes.status });
        return Response.redirect(
          `${config.frontendBaseUrl}/setup/discord-role?error=guilds_fetch_failed`,
          302
        );
      }
      const discordUser = (await userRes.json()) as { id?: string };
      const oauthDiscordUserId = discordUser.id;

      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!guildsRes.ok) {
        return Response.redirect(
          `${config.frontendBaseUrl}/setup/discord-role?error=guilds_fetch_failed`,
          302
        );
      }

      const guilds = (await guildsRes.json()) as Array<{
        id: string;
        name: string;
        icon: string | null;
        owner: boolean;
        permissions: string;
      }>;

      const session = JSON.parse(raw) as DiscordRoleSetupSession;
      if (!oauthDiscordUserId || oauthDiscordUserId !== session.adminDiscordUserId) {
        logger.warn('Discord role OAuth callback identity mismatch', {
          expectedDiscordUserId: session.adminDiscordUserId,
          actualDiscordUserId: oauthDiscordUserId,
          guildId: session.guildId,
          authUserId: session.authUserId,
        });
        return Response.redirect(
          `${config.frontendBaseUrl}/setup/discord-role?error=account_mismatch`,
          302
        );
      }
      session.guilds = guilds.sort((a, b) => a.name.localeCompare(b.name));
      await store.set(
        `${DISCORD_ROLE_SETUP_PREFIX}${setupToken}`,
        JSON.stringify(session),
        DISCORD_ROLE_SETUP_TTL_MS
      );

      return Response.redirect(`${config.frontendBaseUrl}/setup/discord-role`, 302);
    } catch (err) {
      logger.error('Discord role OAuth callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.redirect(
        `${config.frontendBaseUrl}/setup/discord-role?error=internal_error`,
        302
      );
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
    const { sourceGuildId, sourceGuildName, sourceRoleId, sourceRoleIds, requiredRoleMatchMode } =
      body;
    if (!sourceGuildId) {
      return Response.json({ error: 'sourceGuildId is required' }, { status: 400 });
    }
    const roleIds = sourceRoleIds ?? (sourceRoleId ? [sourceRoleId] : []);
    if (roleIds.length === 0) {
      return Response.json(
        { error: 'At least one role ID is required (sourceRoleId or sourceRoleIds)' },
        { status: 400 }
      );
    }
    const validId = /^\d{17,20}$/;
    for (const id of roleIds) {
      if (!validId.test(id)) {
        return Response.json(
          { error: `Invalid role ID: ${id}. Must be 17–20 digits.` },
          { status: 400 }
        );
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
    session.requiredRoleMatchMode =
      roleIds.length > 1 ? (requiredRoleMatchMode ?? 'any') : undefined;
    session.completed = true;
    await store.set(
      `${DISCORD_ROLE_SETUP_PREFIX}${binding.sessionToken}`,
      JSON.stringify(session),
      DISCORD_ROLE_SETUP_TTL_MS
    );

    return Response.json({ success: true });
  }

  /**
   * GET /api/connect/user/accounts
   * Returns all provider connections for the authenticated user (user-scoped + legacy tenant-scoped).
   */
  async function getUserAccounts(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const connections = await convex.query(api.providerConnections.listConnectionsForUser, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
      });
      return Response.json({ connections });
    } catch (err) {
      logger.error('Failed to get user accounts', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 });
    }
  }

  /**
   * DELETE /api/connect/user/accounts?id=XXX
   * Disconnects a provider connection owned by the authenticated user.
   */
  async function deleteUserAccount(request: Request): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);

      // Call provider onDisconnect hook (e.g. unregister external webhooks)
      await runProviderDisconnectHook(convex, id, session.user.id);

      await convex.mutation(api.providerConnections.disconnectConnection, {
        apiSecret: config.convexApiSecret,
        connectionId: id as Id<'provider_connections'>,
        authUserId: session.user.id,
      });
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Failed to delete user account', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to disconnect account' }, { status: 500 });
    }
  }

  /**
   * GET /api/connect/user/providers
   * Returns providers that support user-initiated identity linking (not creator store setup).
   * Only providers with `userSetupPath` in their displayMeta are returned.
   * Public — no credentials, no session required.
   */
  function getUserProviders(_request: Request): Response {
    const providers = Array.from(PROVIDERS.values())
      .flatMap((p) => {
        const displayMeta = p.displayMeta;
        if (!displayMeta?.userSetupPath) {
          return [];
        }

        return [
          {
            id: p.id,
            label: displayMeta.label,
            icon: displayMeta.icon,
            color: displayMeta.color,
            description: displayMeta.description,
            userSetupPath: displayMeta.userSetupPath,
          },
        ];
      });
    return Response.json({ providers });
  }

  /**
   * POST /api/connect/user/verify/start
   * Initiates a web-based verification session for the authenticated user.
   * Creates a Convex verification session and returns the URL the client should
   * navigate to in order to complete the identity link.
   */
  async function postUserVerifyStart(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: { providerKey?: string } = {};
    try {
      body = (await request.json()) as { providerKey?: string };
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { providerKey } = body;
    if (!providerKey) {
      return Response.json({ error: 'providerKey is required' }, { status: 400 });
    }

    const provider = PROVIDERS.get(providerKey);
    if (!provider?.displayMeta?.userSetupPath) {
      return Response.json(
        { error: `Provider '${providerKey}' does not support user identity linking` },
        { status: 400 }
      );
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const state = randomBytes(16).toString('hex');
      const result = await convex.mutation(api.verificationSessions.createVerificationSession, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
        mode: providerKey,
        providerKey,
        verificationMethod: 'account_link',
        state,
        redirectUri: `${config.apiBaseUrl.replace(/\/$/, '')}/verify-success?provider=${encodeURIComponent(providerKey)}`,
        successRedirectUri: `${config.frontendBaseUrl.replace(/\/$/, '')}/account/connections`,
      });

      const setupUrl = new URL(provider.displayMeta.userSetupPath, config.frontendBaseUrl);
      setupUrl.searchParams.set('token', result.sessionId);
      setupUrl.searchParams.set('returnUrl', '/account/connections');

      return Response.json({
        sessionId: result.sessionId,
        redirectUrl: setupUrl.pathname + setupUrl.search,
      });
    } catch (err) {
      logger.error('Failed to start user verify session', {
        providerKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to start verification session' }, { status: 500 });
    }
  }

  /**
   * GET /api/connect/user/guilds
   * Returns a list of servers the user is an admin of
   */
  async function getUserGuilds(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const userGuilds = await convex.query(api.guildLinks.getUserGuilds, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
      });

      // Backfill missing guild names from Discord
      if (config.discordBotToken) {
        const guilds = userGuilds as Array<{ guildId: string; name: string; icon?: string | null }>;
        const missing = guilds.filter((g) => !g.name || g.name.startsWith('Creator '));

        if (missing.length > 0) {
          const results = await Promise.allSettled(
            missing.map(async (g) => {
              const meta = await fetchGuildMeta(g.guildId);
              if (meta.discordGuildName) {
                g.name = meta.discordGuildName;
                if (meta.discordGuildIcon) g.icon = meta.discordGuildIcon;
                // Persist to DB in background so future loads are instant
                convex
                  .mutation(api.guildLinks.updateGuildLinkStatus, {
                    apiSecret: config.convexApiSecret,
                    discordGuildId: g.guildId,
                    status: 'active' as const,
                    botPresent: true,
                    discordGuildName: meta.discordGuildName,
                    ...(meta.discordGuildIcon ? { discordGuildIcon: meta.discordGuildIcon } : {}),
                  })
                  .catch((err) => {
                    logger.warn('Failed to persist backfilled guild name', {
                      guildId: g.guildId,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  });
              }
            })
          );
          const failures = results.filter((r) => r.status === 'rejected');
          if (failures.length > 0) {
            logger.warn('Some guild name backfills failed', { count: failures.length });
          }
        }
      }

      return Response.json({ guilds: userGuilds });
    } catch (err) {
      logger.error('Failed to get user guilds', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to fetch user guilds' }, { status: 500 });
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
   * DELETE /api/connect/user/entitlements/:entitlementId
   * Revokes a specific entitlement owned by the authenticated user.
   */
  async function revokeUserEntitlement(request: Request, entitlementId: string): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (!entitlementId) {
      return Response.json({ error: 'entitlementId is required' }, { status: 400 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation(api.entitlements.revokeEntitlement, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
        entitlementId: entitlementId as Id<'entitlements'>,
        reason: 'manual',
        details: 'User-initiated deactivation from account portal',
      });
      return Response.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unauthorized') || msg.includes('not the owner')) {
        return Response.json(
          { error: 'Not authorized to revoke this entitlement' },
          { status: 403 }
        );
      }
      logger.error('Failed to revoke entitlement', {
        entitlementId,
        error: msg,
      });
      return Response.json({ error: 'Failed to revoke entitlement' }, { status: 500 });
    }
  }

  /**
   * GET /api/connect/user/oauth/grants
   * Lists OAuth consents (authorized apps) for the authenticated user.
   */
  async function getUserOAuthGrants(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const grants = await convex.query(api.userPortal.listOAuthGrantsForUser, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
      });
      return Response.json({ grants });
    } catch (err) {
      logger.error('Failed to get user OAuth grants', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to fetch authorized apps' }, { status: 500 });
    }
  }

  /**
   * DELETE /api/connect/user/oauth/grants/:consentId
   * Revokes an OAuth grant (authorized app) for the authenticated user.
   */
  async function revokeUserOAuthGrant(request: Request, consentId: string): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (!consentId) {
      return Response.json({ error: 'consentId is required' }, { status: 400 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation(api.userPortal.revokeOAuthGrant, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
        consentId,
      });
      return Response.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unauthorized') || msg.includes('not belong')) {
        return Response.json({ error: 'Not authorized to revoke this grant' }, { status: 403 });
      }
      if (msg.includes('not found')) {
        return Response.json({ error: 'OAuth grant not found' }, { status: 404 });
      }
      logger.error('Failed to revoke OAuth grant', {
        consentId,
        error: msg,
      });
      return Response.json({ error: 'Failed to revoke authorized app' }, { status: 500 });
    }
  }

  /**
   * GET /api/connect/user/data-export
   * GDPR right to data portability. Returns a JSON file attachment containing
   * the user's profile, subjects, entitlements, and provider connections.
   * Credential values are never included.
   */
  async function getUserDataExport(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);

      const [subjectsResult, connectionsResult, grantsResult] = await Promise.all([
        convex.query(api.subjects.listByAuthUser, {
          apiSecret: config.convexApiSecret,
          authUserId: session.user.id,
          limit: 100,
        }),
        convex.query(api.providerConnections.listConnectionsForUser, {
          apiSecret: config.convexApiSecret,
          authUserId: session.user.id,
        }),
        convex.query(api.userPortal.listOAuthGrantsForUser, {
          apiSecret: config.convexApiSecret,
          authUserId: session.user.id,
        }),
      ]);

      const subjects = subjectsResult.data ?? [];
      const subjectsWithEntitlements = await Promise.all(
        subjects.map(
          async (subject: {
            _id: string;
            displayName?: string;
            status: string;
            primaryDiscordUserId?: string;
          }) => {
            const entitlementsResult = await convex.query(api.entitlements.listByAuthUser, {
              apiSecret: config.convexApiSecret,
              authUserId: session.user.id,
              subjectId: subject._id,
              limit: 100,
            });
            return {
              id: subject._id,
              displayName: subject.displayName ?? null,
              primaryDiscordUserId: subject.primaryDiscordUserId ?? null,
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
          }
        )
      );

      const sanitizedConnections = (
        connectionsResult as Array<{
          id?: string;
          provider?: string;
          connectionType?: string;
          status?: string;
          createdAt?: number;
          updatedAt?: number;
        }>
      ).map((c) => ({
        id: c.id,
        provider: c.provider,
        connectionType: c.connectionType,
        status: c.status,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));

      const exportPayload = {
        exportedAt: new Date().toISOString(),
        profile: {
          authUserId: session.user.id,
          name: session.user.name,
          email: session.user.email,
        },
        subjects: subjectsWithEntitlements,
        providerConnections: sanitizedConnections,
        authorizedApps: grantsResult,
      };

      const json = JSON.stringify(exportPayload, null, 2);
      return new Response(json, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="yucp-data-export.json"',
        },
      });
    } catch (err) {
      logger.error('Failed to generate data export', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to generate data export' }, { status: 500 });
    }
  }

  /**
   * DELETE /api/connect/user/gdpr-delete
   * GDPR right to erasure (Article 17). Revokes all entitlements and OAuth
   * tokens, disconnects all provider connections, and records a 30-day
   * deletion request. The user's Better Auth session expires naturally.
   */
  async function requestUserAccountDeletion(request: Request): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const authUserId = session.user.id;

      const subjectsResult = await convex.query(api.subjects.listByAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId,
        limit: 100,
      });
      const subjects = subjectsResult.data ?? [];

      for (const subject of subjects as Array<{ _id: string }>) {
        await convex.mutation(api.entitlements.revokeAllEntitlementsForSubject, {
          apiSecret: config.convexApiSecret,
          authUserId,
          subjectId: subject._id as Id<'subjects'>,
        });
      }

      await convex.mutation(api.userPortal.revokeAllOAuthGrantsForUser, {
        apiSecret: config.convexApiSecret,
        authUserId,
      });

      const connections = await convex.query(api.providerConnections.listConnectionsForUser, {
        apiSecret: config.convexApiSecret,
        authUserId,
      });
      for (const connection of (connections as Array<{ id?: string }>) ?? []) {
        if (!connection.id) continue;
        try {
          await runProviderDisconnectHook(convex, connection.id, authUserId);
          await convex.mutation(api.providerConnections.disconnectConnection, {
            apiSecret: config.convexApiSecret,
            connectionId: connection.id as Id<'provider_connections'>,
            authUserId,
          });
        } catch (disconnectErr) {
          logger.warn('Failed to disconnect provider connection during account deletion', {
            connectionId: connection.id,
            error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
          });
        }
      }

      await convex.mutation(api.userPortal.requestAccountDeletion, {
        apiSecret: config.convexApiSecret,
        authUserId,
      });

      return Response.json({
        message:
          'Deletion request received. Your account and associated data will be removed within 30 days.',
      });
    } catch (err) {
      logger.error('Failed to process account deletion request', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: 'Failed to process account deletion request' },
        { status: 500 }
      );
    }
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
      }
    );
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
      const tenantOwned = await isTenantOwnedBySessionUser(authSession.user.id, body.authUserId);
      if (!tenantOwned) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    try {
      const plugin = PROVIDERS.get(providerKey);
      const credentialPurpose = plugin?.productCredentialPurpose;
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
        providerKey: providerKey as any,
        productId,
        credentialKeyPrefix: descriptor.perProductCredential.credentialKeyPrefix,
        encryptedSecretKey,
      });
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
   * Kept for backwards compatibility — delegates to genericProductCredential.
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
    getUserGuilds,
    getUserProviders,
    postUserVerifyStart,
    getUserAccounts,
    deleteUserAccount,
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
   * No session required — called by internal RPC with trusted authUserId.
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
      const plugin = PROVIDERS.get(params.providerKey);
      const credentialPurpose = plugin?.productCredentialPurpose;
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
        providerKey: params.providerKey as any,
        productId: params.productId,
        credentialKeyPrefix: descriptor.perProductCredential.credentialKeyPrefix,
        encryptedSecretKey,
      });
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
