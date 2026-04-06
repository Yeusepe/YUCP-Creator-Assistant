import type { StructuredLogger } from '@yucp/shared';
import { buildCookie, DISCORD_ROLE_SETUP_COOKIE, getCookieValue } from '../lib/browserSessions';
import { getStateStore } from '../lib/stateStore';
import type { ConnectConfig } from '../providers/types';

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

interface ConnectDiscordRoleRoutesOptions {
  readonly config: ConnectConfig;
  readonly logger: StructuredLogger;
  readonly hasValidApiSecret: (apiSecret: string | null | undefined) => boolean;
  readonly generateToken: () => string;
  readonly generateSecureRandom: (length: number) => string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getOptionalTrimmedString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getOptionalStringArray(
  record: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const trimmed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return undefined;
    }
    const next = entry.trim();
    if (next) {
      trimmed.push(next);
    }
  }
  return trimmed;
}

export function createConnectDiscordRoleRoutes(options: ConnectDiscordRoleRoutesOptions) {
  const { config, logger, hasValidApiSecret, generateToken, generateSecureRandom } = options;

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

  async function createDiscordRoleSession(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let bodyRecord: Record<string, unknown> | null;
    try {
      bodyRecord = asRecord(await request.json());
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!bodyRecord) {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = getOptionalTrimmedString(bodyRecord, 'authUserId');
    const guildId = getOptionalTrimmedString(bodyRecord, 'guildId');
    const adminDiscordUserId = getOptionalTrimmedString(bodyRecord, 'adminDiscordUserId');
    const apiSecret = getOptionalTrimmedString(bodyRecord, 'apiSecret');

    if (!hasValidApiSecret(apiSecret)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!authUserId || !guildId || !adminDiscordUserId) {
      return Response.json(
        { error: 'authUserId, guildId, and adminDiscordUserId are required' },
        { status: 400 }
      );
    }

    const token = generateToken();
    const session: DiscordRoleSetupSession = {
      authUserId,
      guildId,
      adminDiscordUserId,
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

  async function discordRoleOAuthBegin(request: Request): Promise<Response> {
    const binding = await requireBoundDiscordRoleSetupSession(request);
    if (!binding.ok) return binding.response;

    const { sessionToken: token } = binding;
    const store = getStateStore();

    const state = generateSecureRandom(16);
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
        signal: AbortSignal.timeout(10_000),
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
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!userRes.ok) {
        logger.error('Discord role OAuth user fetch failed', { status: userRes.status });
        return Response.redirect(
          `${config.frontendBaseUrl}/setup/discord-role?error=user_fetch_failed`,
          302
        );
      }
      const discordUser = (await userRes.json()) as { id?: string };
      const oauthDiscordUserId = discordUser.id;

      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
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

  async function saveDiscordRoleSelection(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let bodyRecord: Record<string, unknown> | null;
    try {
      bodyRecord = asRecord(await request.json());
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!bodyRecord) {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const sourceGuildId = getOptionalTrimmedString(bodyRecord, 'sourceGuildId');
    const sourceRoleId = getOptionalTrimmedString(bodyRecord, 'sourceRoleId');
    const sourceRoleIds = getOptionalStringArray(bodyRecord, 'sourceRoleIds');
    const requiredRoleMatchMode = getOptionalTrimmedString(bodyRecord, 'requiredRoleMatchMode');
    if (!sourceGuildId) {
      return Response.json({ error: 'sourceGuildId is required' }, { status: 400 });
    }
    if (bodyRecord.sourceRoleIds !== undefined && !sourceRoleIds) {
      return Response.json({ error: 'sourceRoleIds must be an array of strings' }, { status: 400 });
    }
    if (
      requiredRoleMatchMode !== undefined &&
      requiredRoleMatchMode !== 'any' &&
      requiredRoleMatchMode !== 'all'
    ) {
      return Response.json(
        { error: 'requiredRoleMatchMode must be "any" or "all"' },
        { status: 400 }
      );
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
    const verifiedGuild = session.guilds?.find((guild) => guild.id === sourceGuildId);
    if (!verifiedGuild) {
      return Response.json(
        { error: 'Select a guild from the verified Discord OAuth session before continuing.' },
        { status: 400 }
      );
    }
    session.sourceGuildId = sourceGuildId;
    session.sourceGuildName = verifiedGuild.name;
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

    await store.delete(`${DISCORD_ROLE_SETUP_PREFIX}${token}`);
    return Response.json({
      completed: true,
      sourceGuildId: session.sourceGuildId,
      sourceGuildName: session.sourceGuildName,
      sourceRoleId: session.sourceRoleId,
      sourceRoleIds: roleIds,
      requiredRoleMatchMode: session.requiredRoleMatchMode ?? 'any',
    });
  }

  async function exchangeDiscordRoleSetupSession(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    let bodyRecord: Record<string, unknown> | null;
    try {
      bodyRecord = asRecord(await request.json());
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!bodyRecord) {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const token = getOptionalTrimmedString(bodyRecord, 'token');
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
    createDiscordRoleSession,
    discordRoleOAuthBegin,
    discordRoleOAuthCallback,
    getDiscordRoleGuilds,
    saveDiscordRoleSelection,
    getDiscordRoleResult,
    exchangeDiscordRoleSetupSession,
  };
}
