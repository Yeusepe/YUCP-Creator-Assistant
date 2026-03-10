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
import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import {
  CONNECT_TOKEN_COOKIE,
  DISCORD_ROLE_SETUP_COOKIE,
  JINXXY_PENDING_WEBHOOK_PREFIX,
  JINXXY_PENDING_WEBHOOK_TTL_MS,
  SETUP_SESSION_COOKIE,
  buildCookie,
  clearCookie,
  getCookieValue,
} from '../lib/browserSessions';
import { getConvexApiSecret, getConvexClient, getConvexClientFromUrl } from '../lib/convex';
import { encrypt } from '../lib/encrypt';
import { PUBLIC_API_KEY_PREFIX } from '../lib/publicApiKeys';
import { createSetupSession, resolveSetupSession } from '../lib/setupSession';
import { getStateStore } from '../lib/stateStore';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const CONNECT_TOKEN_PREFIX = 'connect:';

const GUMROAD_STATE_PREFIX = 'connect_gumroad:';
const JINXXY_TEST_PREFIX = 'jinxxy_test:';
const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const GUMROAD_STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const JINXXY_TEST_TTL_MS = 60 * 1000; // 60 seconds
const ALLOWED_PUBLIC_API_SCOPES = new Set(['verification:read', 'subjects:read']);
const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';
const PUBLIC_API_KEY_METADATA_KIND = 'public-api';
const DEFAULT_PUBLIC_API_SCOPES = ['verification:read', 'subjects:read'];
const DEFAULT_OAUTH_APP_SCOPES = ['verification:read'];

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
  tenantId: string;
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

function parsePublicApiKeyMetadata(value: unknown): { kind?: string; tenantId?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const metadata = value as Record<string, unknown>;
  return {
    kind: typeof metadata.kind === 'string' ? metadata.kind : undefined,
    tenantId: typeof metadata.tenantId === 'string' ? metadata.tenantId : undefined,
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

function buildPublicApiPermissions(scopes: string[]): BetterAuthPermissionStatements {
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
    tenantId: string;
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
      tenantId: input.tenantId,
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
        metadata: { kind: string; tenantId: string } | null;
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
      tenantId: input.tenantId,
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

  for (const redirectUri of values) {
    try {
      new URL(redirectUri);
    } catch {
      throw new Error(`Invalid redirect URI: ${redirectUri}`);
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

  async function resolveConnectDiscordUserId(request: Request): Promise<string | null> {
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
  async function resolveToken(
    request: Request
  ): Promise<{ tenantId: string; guildId: string; discordUserId: string } | null> {
    return resolveSetupSessionFromRequest(request);
  }

  async function requireBoundSetupSession(request: Request): Promise<
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
      return {
        ok: false,
        response: Response.json({ error: 'Valid setup session required' }, { status: 401 }),
      };
    }

    const authSession = await auth.getSession(request);
    if (!authSession) {
      return {
        ok: false,
        response: Response.json({ error: 'Authentication required' }, { status: 401 }),
      };
    }

    const authDiscordUserId = await getAuthenticatedDiscordUserId(request);
    if (!authDiscordUserId) {
      return {
        ok: false,
        response: Response.json({ error: 'Discord account required' }, { status: 401 }),
      };
    }

    if (authDiscordUserId !== setupSession.discordUserId) {
      logger.warn('Setup session Discord identity mismatch', {
        expectedDiscordUserId: setupSession.discordUserId,
        actualDiscordUserId: authDiscordUserId,
        guildId: setupSession.guildId,
        tenantId: setupSession.tenantId,
      });
      return {
        ok: false,
        response: Response.json(
          { error: 'This setup link belongs to a different Discord account' },
          { status: 403 }
        ),
      };
    }

    return { ok: true, setupSession, authSession, authDiscordUserId };
  }

  function buildFrontendCallbackUrl(pathname: string, tenantId: string, guildId: string): string {
    const callbackUrl = new URL(`${config.frontendBaseUrl.replace(/\/$/, '')}${pathname}`);
    if (tenantId) callbackUrl.searchParams.set('tenant_id', tenantId);
    if (guildId) callbackUrl.searchParams.set('guild_id', guildId);
    return callbackUrl.toString();
  }

  function buildDiscordSignInUrl(callbackUrl: string): string {
    return `${config.apiBaseUrl.replace(/\/$/, '')}/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl)}`;
  }

  async function getDashboardSessionStatus(request: Request): Promise<Response> {
    const setupSession = await resolveSetupSessionFromRequest(request);
    if (!setupSession) {
      return Response.json({ hasSetupSession: false, authenticated: false });
    }

    const callbackUrl = buildFrontendCallbackUrl(
      '/dashboard',
      setupSession.tenantId,
      setupSession.guildId
    );
    const signInUrl = buildDiscordSignInUrl(callbackUrl);
    const authSession = await auth.getSession(request);
    if (!authSession) {
      return Response.json(
        {
          hasSetupSession: true,
          authenticated: false,
          tenantId: setupSession.tenantId,
          guildId: setupSession.guildId,
          signInUrl,
          callbackUrl,
          error: 'Authentication required',
        },
        { status: 401 }
      );
    }

    const authDiscordUserId = await getAuthenticatedDiscordUserId(request);
    if (!authDiscordUserId) {
      return Response.json(
        {
          hasSetupSession: true,
          authenticated: false,
          tenantId: setupSession.tenantId,
          guildId: setupSession.guildId,
          signInUrl,
          callbackUrl,
          error: 'Discord account required',
        },
        { status: 401 }
      );
    }

    if (authDiscordUserId !== setupSession.discordUserId) {
      return Response.json(
        {
          hasSetupSession: true,
          authenticated: false,
          tenantId: setupSession.tenantId,
          guildId: setupSession.guildId,
          error: 'This setup link belongs to a different Discord account',
        },
        { status: 403 }
      );
    }

    return Response.json({
      hasSetupSession: true,
      authenticated: true,
      tenantId: setupSession.tenantId,
      guildId: setupSession.guildId,
      discordUserId: authDiscordUserId,
      authUserId: authSession.user.id,
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
    authUserId: string,
    tenantId: string
  ): Promise<boolean> {
    const convex = getConvexClientFromUrl(config.convexUrl);
    const tenant = (await convex.query(api.tenants.getTenant, {
      apiSecret: config.convexApiSecret,
      tenantId,
    })) as { ownerAuthUserId?: string } | null;
    return tenant?.ownerAuthUserId === authUserId;
  }

  async function requireOwnerSessionForTenant(
    request: Request,
    tenantId: string | undefined
  ): Promise<
    | { ok: true; session: NonNullable<Awaited<ReturnType<Auth['getSession']>>> }
    | { ok: false; response: Response }
  > {
    if (!tenantId) {
      return {
        ok: false,
        response: Response.json({ error: 'tenantId is required' }, { status: 400 }),
      };
    }

    const session = await auth.getSession(request);
    if (!session) {
      return {
        ok: false,
        response: Response.json({ error: 'Authentication required' }, { status: 401 }),
      };
    }

    const tenantOwned = await isTenantOwnedBySessionUser(session.user.id, tenantId);
    if (!tenantOwned) {
      return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) };
    }

    return { ok: true, session };
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
      return Response.json(
        { error: 'tenantId, guildId, and discordUserId are required' },
        { status: 400 }
      );
    }
    const token = await createSetupSession(
      body.tenantId,
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
      if (!authDiscordUserId || authDiscordUserId !== setupSession?.discordUserId) {
        return new Response('This setup link belongs to a different Discord account.', {
          status: 403,
        });
      }
    }

    if (!session) {
      // Build callback URL preserving the setup token
      const callbackParams = `guild_id=${encodeURIComponent(resolvedGuildId)}${resolvedTenantId ? `&tenant_id=${encodeURIComponent(resolvedTenantId)}` : ''}`;
      const callbackUrl = `${config.frontendBaseUrl}/connect?${callbackParams}`;
      const filePath = `${import.meta.dir}/../../public/sign-in-redirect.html`;
      let html = await Bun.file(filePath).text();
      // The Bun app keeps a lightweight sign-in bridge for static pages, but auth itself runs
      // on Convex and the callback still lands on the frontend callbackURL below.
      const signInUrl = `${config.apiBaseUrl.replace(/\/$/, '')}/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl)}`;
      logger.info('Serving connect sign-in redirect', {
        requestUrl: request.url,
        guildId: resolvedGuildId || undefined,
        tenantId: resolvedTenantId || undefined,
        hasSetupToken: hasSetupSession,
        frontendBaseUrl: config.frontendBaseUrl,
        apiBaseUrl: config.apiBaseUrl,
        authBaseUrl: `${config.convexSiteUrl.replace(/\/$/, '')}/api/auth`,
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
      __GUILD_ID__: resolvedGuildId,
      __TOKEN__: '',
      __API_BASE__: apiBase,
      __SETUP_TOKEN__: '',
      __HAS_SETUP_SESSION__: hasSetupSession ? 'true' : 'false',
      __TENANT_ID__: resolvedTenantId,
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

    const connectDiscordUserId = await resolveConnectDiscordUserId(request);
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

    const convex = getConvexClient();
    const apiSecret = getConvexApiSecret();
    const existing = await convex.query(api.tenants.getTenantByOwnerAuth, {
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
        if (!discordUserId) {
          return Response.json(
            { error: 'Session expired. Please sign in again from Discord.' },
            { status: 400 }
          );
        }
        tenantId = await convex.mutation(api.tenants.createTenant, {
          apiSecret,
          name: `Creator ${discordUserId.slice(0, 8)}`,
          ownerDiscordUserId: discordUserId,
          ownerAuthUserId: session.user.id,
        });
      } else {
        tenantId = existing._id;
      }

      await convex.mutation(api.guildLinks.upsertGuildLink, {
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

      const clearedCookie = clearCookie(CONNECT_TOKEN_COOKIE, request);
      return new Response(JSON.stringify({ success: true, tenantId, isFirstTime: !existing }), {
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

    const discordUserId: string | null = connectDiscordUserId ?? sessionDiscordUserId;

    const apiSecret = getConvexApiSecret();
    const existing = await convex.query(api.tenants.getTenantByOwnerAuth, {
      apiSecret,
      ownerAuthUserId: session.user.id,
    });

    // 4. If we STILL don't have a discordUserId and no existing tenant, we can't create one
    if (!existing && !discordUserId) {
      return Response.json(
        {
          error: 'Session expired or Discord link lost. Please sign in again from Discord.',
          details: 'Cannot create tenant: missing Discord ID',
        },
        { status: 400 }
      );
    }

    try {
      let tenantId: string;

      if (!existing) {
        if (!discordUserId) {
          return Response.json(
            {
              error: 'Session expired or Discord link lost. Please sign in again from Discord.',
              details: 'Cannot create tenant: missing Discord ID',
            },
            { status: 400 }
          );
        }
        tenantId = await convex.mutation(api.tenants.createTenant, {
          apiSecret,
          name: `Creator ${discordUserId.slice(0, 8)}`,
          ownerDiscordUserId: discordUserId,
          ownerAuthUserId: session.user.id,
        });
      } else {
        tenantId = existing._id;
      }

      await convex.mutation(api.guildLinks.upsertGuildLink, {
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
      return Response.json({ error: 'Failed to ensure tenant' }, { status: 500 });
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
      JSON.stringify({
        tenantId,
        guildId,
        setupToken: getSetupSessionTokenFromRequest(request) ?? '',
      }),
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
    const buildDashboardRedirect = (
      params: Record<string, string | undefined>,
      setupToken?: string
    ): string => {
      const redirectUrl = new URL(`${config.frontendBaseUrl.replace(/\/$/, '')}/dashboard`);
      for (const [key, value] of Object.entries(params)) {
        if (value) redirectUrl.searchParams.set(key, value);
      }
      if (setupToken) {
        redirectUrl.hash = `s=${encodeURIComponent(setupToken)}`;
      }
      return redirectUrl.toString();
    };

    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      logger.error('Gumroad OAuth error', { error });
      return Response.redirect(buildDashboardRedirect({ error }), 302);
    }

    if (!code || !state) {
      return Response.redirect(buildDashboardRedirect({ error: 'missing_parameters' }), 302);
    }

    const store = getStateStore();
    const raw = await store.get(`${GUMROAD_STATE_PREFIX}${state}`);
    if (!raw) {
      return Response.redirect(buildDashboardRedirect({ error: 'invalid_state' }), 302);
    }
    await store.delete(`${GUMROAD_STATE_PREFIX}${state}`);

    const {
      tenantId,
      guildId,
      setupToken: storedSetupToken,
    } = JSON.parse(raw) as { tenantId: string; guildId: string; setupToken?: string };
    const gumroadClientId = config.gumroadClientId;
    const gumroadClientSecret = config.gumroadClientSecret;

    try {
      if (!gumroadClientId || !gumroadClientSecret) {
        return Response.redirect(
          buildDashboardRedirect(
            { tenant_id: tenantId, guild_id: guildId, error: 'gumroad_not_configured' },
            storedSetupToken
          ),
          302
        );
      }

      const tokenRes = await fetch('https://api.gumroad.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: gumroadClientId,
          client_secret: gumroadClientSecret,
          code,
          redirect_uri: `${config.apiBaseUrl}/api/connect/gumroad/callback`,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        logger.error('Gumroad token exchange failed', { status: tokenRes.status, body: errText });
        return Response.redirect(
          buildDashboardRedirect(
            { tenant_id: tenantId, guild_id: guildId, error: 'token_exchange_failed' },
            storedSetupToken
          ),
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
          buildDashboardRedirect(
            { tenant_id: tenantId, guild_id: guildId, error: 'no_access_token' },
            storedSetupToken
          ),
          302
        );
      }

      const meRes = await fetch(
        `https://api.gumroad.com/v2/user?access_token=${encodeURIComponent(accessToken)}`
      );
      if (!meRes.ok) {
        return Response.redirect(
          buildDashboardRedirect(
            { tenant_id: tenantId, guild_id: guildId, error: 'failed_to_fetch_user' },
            storedSetupToken
          ),
          302
        );
      }
      const me = (await meRes.json()) as {
        success?: boolean;
        user?: { user_id?: string; name?: string; email?: string };
      };
      const gumroadUserId = me.user?.user_id ?? '';

      const accessEncrypted = await encrypt(accessToken, config.encryptionSecret);
      const refreshEncrypted = refreshToken
        ? await encrypt(refreshToken, config.encryptionSecret)
        : undefined;

      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation(api.providerConnections.upsertGumroadConnection, {
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
      redirectParams.set('tenant_id', tenantId);
      redirectParams.set('gumroad', 'connected');
      return Response.redirect(
        buildDashboardRedirect(Object.fromEntries(redirectParams.entries()), storedSetupToken),
        302
      );
    } catch (err) {
      logger.error('Gumroad callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.redirect(
        buildDashboardRedirect(
          { tenant_id: tenantId, guild_id: guildId, error: 'internal_error' },
          storedSetupToken
        ),
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
      const status = await convex.query(api.providerConnections.getConnectionStatus, {
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
        return Response.json(
          { error: 'Webhook secret must be at least 16 characters' },
          { status: 400 }
        );
      }
      if (webhookSecret.length > 40) {
        return Response.json(
          { error: 'Jinxxy limits the signing secret to 40 characters' },
          { status: 400 }
        );
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
      return Response.json({ error: 'Failed to get webhook config' }, { status: 500 });
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
        const pendingWebhook = JSON.parse(pendingWebhookRaw) as {
          callbackUrl: string;
          signingSecretEncrypted: string;
        };
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
      await convex.mutation(api.providerConnections.upsertJinxxyConnection, {
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
      return Response.json({ error: 'Failed to store Jinxxy connection' }, { status: 500 });
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
        tenantId: session.tenantId,
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
      await convex.mutation(api.providerConnections.disconnectConnection, {
        apiSecret: config.convexApiSecret,
        connectionId,
        tenantId: session.tenantId,
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
      const tenant = (await convex.query(api.tenants.getTenant, {
        apiSecret: config.convexApiSecret,
        tenantId: session.tenantId,
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
   * POST /api/connect/settings?s=TOKEN
   * Body: { key: string, value: unknown }
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

    let body: { key: string; value: unknown };
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
      await convex.mutation(api.providerConnections.updateTenantSetting, {
        apiSecret: config.convexApiSecret,
        tenantId: session.tenantId,
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
    const tenantId = new URL(request.url).searchParams.get('tenantId') ?? undefined;
    const required = await requireOwnerSessionForTenant(request, tenantId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const { response, data } = await auth.callEndpoint<BetterAuthApiKey[]>('/api-key/list', {
        request,
      });

      if (!response.ok) {
        return Response.json(
          { error: getBetterAuthErrorMessage(data, 'Failed to list API keys') },
          { status: response.status || 500 }
        );
      }

      const keys = (Array.isArray(data) ? data : [])
        .filter((key) => {
          const metadata = parsePublicApiKeyMetadata(key.metadata);
          return metadata?.kind === PUBLIC_API_KEY_METADATA_KIND && metadata.tenantId === tenantId;
        })
        .map((key) => ({
          _id: key.id,
          _creationTime: toTimestamp(key.createdAt) ?? Date.now(),
          tenantId,
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
      tenantId?: string;
      name?: string;
      scopes?: string[];
      expiresAt?: number | null;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const tenantId = body.tenantId?.trim();
    const required = await requireOwnerSessionForTenant(request, tenantId);
    if ('response' in required) {
      return required.response;
    }
    if (!tenantId) {
      return Response.json({ error: 'tenantId is required' }, { status: 400 });
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
        tenantId,
        expiresAt,
      });

      if (!response.ok || !data?.id || !data.key) {
        logger.warn('Create API key rejected by Better Auth', {
          tenantId,
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
    let body: { tenantId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const tenantId = body.tenantId?.trim();
    const required = await requireOwnerSessionForTenant(request, tenantId);
    if ('response' in required) {
      return required.response;
    }
    if (!tenantId) {
      return Response.json({ error: 'tenantId is required' }, { status: 400 });
    }

    try {
      const existing = await auth.callEndpoint<BetterAuthApiKey>('/api-key/get', {
        request,
        query: { id: keyId },
      });

      if (!existing.response.ok || !existing.data) {
        return Response.json(
          { error: getBetterAuthErrorMessage(existing.data, 'API key not found') },
          { status: existing.response.status === 200 ? 404 : existing.response.status || 404 }
        );
      }

      const metadata = parsePublicApiKeyMetadata(existing.data.metadata);
      if (metadata?.kind !== PUBLIC_API_KEY_METADATA_KIND || metadata.tenantId !== tenantId) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      const result = await auth.callEndpoint<BetterAuthApiKey>('/api-key/update', {
        request,
        method: 'POST',
        body: {
          keyId,
          enabled: false,
        },
      });

      if (!result.response.ok) {
        return Response.json(
          { error: getBetterAuthErrorMessage(result.data, 'Failed to revoke API key') },
          { status: result.response.status || 500 }
        );
      }

      return Response.json({ success: true });
    } catch (err) {
      logger.error('Revoke API key failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to revoke API key' }, { status: 500 });
    }
  }

  async function listOAuthApps(request: Request): Promise<Response> {
    const tenantId = new URL(request.url).searchParams.get('tenantId') ?? undefined;
    const required = await requireOwnerSessionForTenant(request, tenantId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mappings = (await convex.query(api.oauthApps.listOAuthApps, {
        apiSecret: config.convexApiSecret,
        tenantId,
      })) as OAuthAppMappingRecord[];
      const { response, data } = await auth.callEndpoint<BetterAuthOAuthClient[] | null>(
        '/oauth2/get-clients',
        {
          request,
        }
      );

      if (!response.ok) {
        return Response.json(
          { error: getBetterAuthErrorMessage(data, 'Failed to list OAuth apps') },
          { status: response.status || 500 }
        );
      }

      const clientMap = new Map(
        (Array.isArray(data) ? data : []).map((client) => [client.client_id, client] as const)
      );

      const apps = mappings
        .map((mapping) => {
          const client = clientMap.get(mapping.clientId);
          if (!client) {
            logger.warn('OAuth app mapping missing Better Auth client', {
              appId: mapping._id,
              clientId: mapping.clientId,
              tenantId,
            });
            return null;
          }

          const scopes = client.scope ? client.scope.split(/\s+/).filter(Boolean) : mapping.scopes;

          return {
            _id: mapping._id,
            _creationTime: mapping._creationTime,
            tenantId: mapping.tenantId,
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
      tenantId?: string;
      name?: string;
      redirectUris?: string[];
      scopes?: string[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const tenantId = body.tenantId?.trim();
    const required = await requireOwnerSessionForTenant(request, tenantId);
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
      const createdClient = await auth.callEndpoint<BetterAuthOAuthClient>(
        '/oauth2/create-client',
        {
          request,
          method: 'POST',
          body: {
            client_name: name,
            redirect_uris: redirectUris,
            scope: scopes.join(' '),
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'client_secret_post',
            type: 'web',
          },
        }
      );

      if (
        !createdClient.response.ok ||
        !createdClient.data?.client_id ||
        !createdClient.data.client_secret
      ) {
        return Response.json(
          { error: getBetterAuthErrorMessage(createdClient.data, 'Failed to create OAuth app') },
          { status: createdClient.response.status || 500 }
        );
      }

      const convex = getConvexClientFromUrl(config.convexUrl);
      try {
        const result = await convex.mutation(api.oauthApps.createOAuthAppMapping, {
          apiSecret: config.convexApiSecret,
          tenantId,
          name,
          clientId: createdClient.data.client_id,
          redirectUris,
          scopes,
          createdByAuthUserId: required.session.user.id,
        });

        return Response.json({
          appId: result._id,
          clientId: createdClient.data.client_id,
          clientSecret: createdClient.data.client_secret,
          name: result.name,
          redirectUris: result.redirectUris,
          scopes: result.scopes,
        });
      } catch (mappingError) {
        await auth.callEndpoint('/oauth2/delete-client', {
          request,
          method: 'POST',
          body: {
            client_id: createdClient.data.client_id,
          },
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
    let body: { tenantId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const tenantId = body.tenantId?.trim();
    const required = await requireOwnerSessionForTenant(request, tenantId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mapping = await convex.query(api.oauthApps.getOAuthApp, {
        apiSecret: config.convexApiSecret,
        tenantId,
        appId,
      });

      if (!mapping) {
        return Response.json({ error: 'OAuth app not found' }, { status: 404 });
      }

      const result = await auth.callEndpoint<BetterAuthOAuthClient>(
        '/oauth2/client/rotate-secret',
        {
          request,
          method: 'POST',
          body: {
            client_id: mapping.clientId,
          },
        }
      );

      if (!result.response.ok || !result.data?.client_secret) {
        return Response.json(
          { error: getBetterAuthErrorMessage(result.data, 'Failed to regenerate secret') },
          { status: result.response.status || 500 }
        );
      }

      return Response.json({
        clientSecret: result.data.client_secret,
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
      tenantId?: string;
      name?: string;
      redirectUris?: string[];
      scopes?: string[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const tenantId = body.tenantId?.trim();
    const required = await requireOwnerSessionForTenant(request, tenantId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mapping = await convex.query(api.oauthApps.getOAuthApp, {
        apiSecret: config.convexApiSecret,
        tenantId,
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

      const result = await auth.callEndpoint<BetterAuthOAuthClient>('/oauth2/update-client', {
        request,
        method: 'POST',
        body: {
          client_id: mapping.clientId,
          update: {
            ...(nextName !== undefined ? { client_name: nextName } : {}),
            ...(nextRedirectUris !== undefined ? { redirect_uris: nextRedirectUris } : {}),
            ...(nextScopes !== undefined ? { scope: nextScopes.join(' ') } : {}),
          },
        },
      });

      if (!result.response.ok) {
        return Response.json(
          { error: getBetterAuthErrorMessage(result.data, 'Failed to update OAuth app') },
          { status: result.response.status || 500 }
        );
      }

      await convex.mutation(api.oauthApps.updateOAuthAppMapping, {
        apiSecret: config.convexApiSecret,
        tenantId,
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
    let body: { tenantId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const tenantId = body.tenantId?.trim();
    const required = await requireOwnerSessionForTenant(request, tenantId);
    if ('response' in required) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mapping = await convex.query(api.oauthApps.getOAuthApp, {
        apiSecret: config.convexApiSecret,
        tenantId,
        appId,
      });

      if (!mapping) {
        return Response.json({ error: 'OAuth app not found' }, { status: 404 });
      }

      const result = await auth.callEndpoint('/oauth2/delete-client', {
        request,
        method: 'POST',
        body: {
          client_id: mapping.clientId,
        },
      });

      if (!result.response.ok) {
        return Response.json(
          { error: getBetterAuthErrorMessage(result.data, 'Failed to delete OAuth app') },
          { status: result.response.status || 500 }
        );
      }

      await convex.mutation(api.oauthApps.deleteOAuthAppMapping, {
        apiSecret: config.convexApiSecret,
        tenantId,
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
      tenantId?: string;
      name?: string;
      scopes?: string[];
      expiresAt?: number | null;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const tenantId = body.tenantId?.trim();
    const required = await requireOwnerSessionForTenant(request, tenantId);
    if ('response' in required) {
      return required.response;
    }
    if (!tenantId) {
      return Response.json({ error: 'tenantId is required' }, { status: 400 });
    }

    try {
      const existing = await auth.callEndpoint<BetterAuthApiKey>('/api-key/get', {
        request,
        query: { id: keyId },
      });

      if (!existing.response.ok || !existing.data) {
        return Response.json(
          { error: getBetterAuthErrorMessage(existing.data, 'API key not found') },
          { status: existing.response.status === 200 ? 404 : existing.response.status || 404 }
        );
      }

      const metadata = parsePublicApiKeyMetadata(existing.data.metadata);
      if (metadata?.kind !== PUBLIC_API_KEY_METADATA_KIND || metadata.tenantId !== tenantId) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      const scopes =
        body.scopes === undefined
          ? getPublicApiKeyScopes(existing.data.permissions)
          : normalizePublicApiScopes(body.scopes);
      const nextName = body.name?.trim() || existing.data.name || 'Rotated key';
      const resolvedExpiresAt =
        body.expiresAt === null
          ? null
          : typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
            ? body.expiresAt
            : toTimestamp(existing.data.expiresAt);
      const created = await createManagedPublicApiKey(config, required.session.user.id, {
        name: nextName,
        scopes,
        tenantId,
        expiresAt: resolvedExpiresAt,
      });

      if (!created.response.ok || !created.data?.id || !created.data.key) {
        logger.warn('Rotate API key rejected by Better Auth', {
          tenantId,
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

      const disabled = await auth.callEndpoint<BetterAuthApiKey>('/api-key/update', {
        request,
        method: 'POST',
        body: {
          keyId,
          enabled: false,
        },
      });

      if (!disabled.response.ok) {
        return Response.json(
          { error: getBetterAuthErrorMessage(disabled.data, 'Failed to revoke previous API key') },
          { status: disabled.response.status || 500 }
        );
      }

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
      return Response.json(
        { error: 'tenantId, guildId, and adminDiscordUserId are required' },
        { status: 400 }
      );
    }

    const token = generateToken();
    const session: DiscordRoleSetupSession = {
      tenantId: body.tenantId,
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
        `${config.frontendBaseUrl}/discord-role-setup?error=${encodeURIComponent(error)}`,
        302
      );
    }
    if (!code || !state) {
      return Response.redirect(
        `${config.frontendBaseUrl}/discord-role-setup?error=missing_parameters`,
        302
      );
    }

    const store = getStateStore();
    const setupToken = await store.get(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`);
    if (!setupToken) {
      return Response.redirect(
        `${config.frontendBaseUrl}/discord-role-setup?error=invalid_state`,
        302
      );
    }
    await store.delete(`${DISCORD_ROLE_OAUTH_STATE_PREFIX}${state}`);

    const raw = await store.get(`${DISCORD_ROLE_SETUP_PREFIX}${setupToken}`);
    if (!raw) {
      return Response.redirect(
        `${config.frontendBaseUrl}/discord-role-setup?error=session_expired`,
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
          `${config.frontendBaseUrl}/discord-role-setup?error=token_exchange_failed`,
          302
        );
      }

      const tokens = (await tokenRes.json()) as { access_token?: string };
      if (!tokens.access_token) {
        return Response.redirect(
          `${config.frontendBaseUrl}/discord-role-setup?error=no_token`,
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
          `${config.frontendBaseUrl}/discord-role-setup?error=guilds_fetch_failed`,
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
          `${config.frontendBaseUrl}/discord-role-setup?error=guilds_fetch_failed`,
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
          tenantId: session.tenantId,
        });
        return Response.redirect(
          `${config.frontendBaseUrl}/discord-role-setup?error=account_mismatch`,
          302
        );
      }
      session.guilds = guilds.sort((a, b) => a.name.localeCompare(b.name));
      await store.set(
        `${DISCORD_ROLE_SETUP_PREFIX}${setupToken}`,
        JSON.stringify(session),
        DISCORD_ROLE_SETUP_TTL_MS
      );

      return Response.redirect(`${config.frontendBaseUrl}/discord-role-setup`, 302);
    } catch (err) {
      logger.error('Discord role OAuth callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.redirect(
        `${config.frontendBaseUrl}/discord-role-setup?error=internal_error`,
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

  return {
    serveConnectPage,
    exchangeConnectBootstrap,
    getDashboardSessionStatus,
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
