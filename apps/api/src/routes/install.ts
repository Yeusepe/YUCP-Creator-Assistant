/**
 * Bot Installation Routes
 *
 * This module handles Discord bot installation to guilds.
 * This is SEPARATE from creator login - it's for installing the bot.
 *
 * Bot install uses Discord OAuth with:
 * - `bot` scope: To add the bot to a guild
 * - `applications.commands` scope: To register slash commands
 *
 * Flow:
 * 1. Creator clicks "Install Bot" in dashboard
 * 2. GET /api/install/bot?authUserId=xxx -> redirects to Discord OAuth
 * 3. Creator selects guild and authorizes
 * 4. Discord redirects to /api/install/bot/callback
 * 5. Store guild_link in Convex
 * 6. Redirect to dashboard with success
 */

import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { getConvexApiSecret, getConvexClient } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { getStateStore } from '../lib/stateStore';

const INSTALL_STATE_PREFIX = 'install:';

/**
 * Bot permissions required for YUCP functionality
 * - Manage Roles: To assign/remove verified roles
 * - Send Messages: For notifications
 * - Use Slash Commands: For command interactions
 */
/** MANAGE_ROLES = 0x10000000 = 268435456. Exported for tests. */
export const BOT_PERMISSIONS = 268435456n;

/**
 * Install state for tracking bot installation flows
 */
interface InstallState {
  state: string;
  authUserId: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Discord Guild response from API
 */
interface DiscordGuildResponse {
  id: string;
  name: string;
  icon: string | null;
  approximate_member_count?: number;
}

interface DiscordTokenExchangeResponse {
  guild?: {
    id?: string;
  };
  guild_id?: string;
}

type AuthSession = Awaited<ReturnType<Auth['getSession']>>;

// State expiration: 10 minutes
const STATE_EXPIRY_MS = 10 * 60 * 1000;

/**
 * Generates a cryptographically secure random state string
 */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stores install state for CSRF validation
 */
export async function storeInstallState(state: string, authUserId: string): Promise<void> {
  const now = Date.now();
  const data: InstallState = {
    state,
    authUserId,
    createdAt: now,
    expiresAt: now + STATE_EXPIRY_MS,
  };
  const store = getStateStore();
  await store.set(`${INSTALL_STATE_PREFIX}${state}`, JSON.stringify(data), STATE_EXPIRY_MS);
}

/**
 * Validates and consumes install state
 */
export async function validateInstallState(state: string): Promise<InstallState | null> {
  const store = getStateStore();
  const raw = await store.get(`${INSTALL_STATE_PREFIX}${state}`);

  if (!raw) {
    logger.warn('Install state not found', { statePrefix: `${state.slice(0, 8)}...` });
    return null;
  }

  await store.delete(`${INSTALL_STATE_PREFIX}${state}`);

  let stored: InstallState;
  try {
    stored = JSON.parse(raw) as InstallState;
  } catch {
    logger.warn('Install state invalid JSON', { statePrefix: `${state.slice(0, 8)}...` });
    return null;
  }

  if (Date.now() > stored.expiresAt) {
    logger.warn('Install state expired', { statePrefix: `${state.slice(0, 8)}...` });
    return null;
  }

  return stored;
}

/**
 * Install configuration interface
 */
export interface InstallConfig {
  /** Discord application client ID */
  discordClientId: string;
  /** Discord client secret (required for OAuth token exchange) */
  discordClientSecret: string;
  /** Discord bot token (for health checks) */
  discordBotToken: string;
  /** Base URL for the API */
  baseUrl: string;
  /** Frontend URL for redirects */
  frontendUrl: string;
  /** Convex deployment URL */
  convexUrl: string;
  /** Convex API secret for server-to-Convex calls */
  convexApiSecret: string;
}

/**
 * Guild link status type
 */
export type GuildLinkStatus = 'active' | 'uninstalled' | 'suspended';

/**
 * Guild link data for Convex storage
 */
export interface GuildLinkData {
  authUserId: string;
  discordGuildId: string;
  discordGuildName?: string;
  discordGuildIcon?: string;
  installedByAuthUserId: string;
  botPresent: boolean;
  commandScopeState?: {
    registered: boolean;
    registeredAt?: number;
  };
  status: GuildLinkStatus;
}

/**
 * Creates install route handlers
 */
export function createInstallRoutes(auth: Auth, config: InstallConfig) {
  /**
   * GET /api/install/bot
   * Initiates Discord bot installation flow
   *
   * Query params:
   * - authUserId (optional): The creator profile to link the guild to. Defaults to the authenticated user.
   * - guildId (optional): Pre-select a specific guild
   */
  async function initiateBotInstall(request: Request): Promise<Response> {
    // Verify user is authenticated
    let session: AuthSession = null;
    try {
      session = await auth.getSession(request);
    } catch {
      session = null;
    }

    if (!session) {
      logger.warn('Unauthenticated bot install attempt');
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const url = new URL(request.url);
    const requestedAuthUserId = url.searchParams.get('authUserId')?.trim() || null;
    const guildId = url.searchParams.get('guildId');
    const authUserId = requestedAuthUserId ?? session.user.id;

    // Verify the authUserId matches the authenticated session user to prevent
    // one authenticated user from installing the bot on behalf of another user.
    if (requestedAuthUserId && session.user.id !== authUserId) {
      logger.warn('authUserId mismatch in bot install', {
        sessionUserId: session.user.id,
        requestedAuthUserId,
      });
      return Response.json(
        { error: 'Forbidden: authUserId does not match session' },
        { status: 403 }
      );
    }

    // Generate state for CSRF protection
    const state = generateState();
    await storeInstallState(state, authUserId);

    // Build Discord bot install OAuth URL
    const discordAuthUrl = new URL('https://discord.com/api/oauth2/authorize');
    discordAuthUrl.searchParams.set('client_id', config.discordClientId);
    discordAuthUrl.searchParams.set('permissions', BOT_PERMISSIONS.toString());
    discordAuthUrl.searchParams.set('scope', 'bot applications.commands');
    discordAuthUrl.searchParams.set('redirect_uri', `${config.baseUrl}/api/install/bot/callback`);
    discordAuthUrl.searchParams.set('state', state);

    // Pre-select guild if provided
    if (guildId) {
      discordAuthUrl.searchParams.set('guild_id', guildId);
      discordAuthUrl.searchParams.set('disable_guild_select', 'true');
    }

    logger.info('Initiating bot install', {
      authUserId,
      guildId: guildId ?? 'not specified',
    });

    return Response.redirect(discordAuthUrl.toString(), 302);
  }

  /**
   * GET /api/install/bot/callback
   * Handles Discord bot installation callback
   */
  async function handleBotInstallCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const guildId = url.searchParams.get('guild_id');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    // Handle OAuth errors
    if (error) {
      logger.error('Bot install OAuth error', { error, errorDescription });
      const errorUrl = new URL('/install/error', config.frontendUrl);
      errorUrl.searchParams.set('error', error);
      if (errorDescription) {
        errorUrl.searchParams.set('description', errorDescription);
      }
      return Response.redirect(errorUrl.toString(), 302);
    }

    // Validate required parameters
    if (!code || !state || !guildId) {
      logger.error('Missing bot install parameters', {
        code: !!code,
        state: !!state,
        guildId: !!guildId,
      });
      const errorUrl = new URL('/install/error', config.frontendUrl);
      errorUrl.searchParams.set('error', 'missing_parameters');
      return Response.redirect(errorUrl.toString(), 302);
    }

    // Validate state for CSRF protection
    const installState = await validateInstallState(state);
    if (!installState) {
      logger.error('Invalid bot install state', { state });
      const errorUrl = new URL('/install/error', config.frontendUrl);
      errorUrl.searchParams.set('error', 'invalid_state');
      return Response.redirect(errorUrl.toString(), 302);
    }

    try {
      // Exchange code for bot token (this adds the bot to the guild)
      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: config.discordClientId,
          client_secret: config.discordClientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${config.baseUrl}/api/install/bot/callback`,
        }).toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        logger.error('Bot install token exchange failed', {
          status: tokenResponse.status,
          body: errorText,
        });
        const errorUrl = new URL('/install/error', config.frontendUrl);
        errorUrl.searchParams.set('error', 'token_exchange_failed');
        return Response.redirect(errorUrl.toString(), 302);
      }

      // Validate guild consistency between callback and token response when available.
      let tokenPayload: DiscordTokenExchangeResponse | null = null;
      try {
        tokenPayload = (await tokenResponse.json()) as DiscordTokenExchangeResponse;
      } catch {
        tokenPayload = null;
      }
      const tokenGuildId = tokenPayload?.guild?.id ?? tokenPayload?.guild_id;
      if (tokenGuildId && tokenGuildId !== guildId) {
        logger.error('Bot install guild mismatch', {
          callbackGuildId: guildId,
          tokenGuildId,
          authUserId: installState.authUserId,
        });
        const errorUrl = new URL('/install/error', config.frontendUrl);
        errorUrl.searchParams.set('error', 'guild_mismatch');
        return Response.redirect(errorUrl.toString(), 302);
      }

      logger.info('Bot installed to guild', {
        guildId,
        authUserId: installState.authUserId,
      });

      // Store guild link in Convex
      // Fetch guild info from Discord so we can store the server name/icon immediately
      let guildName: string | undefined;
      let guildIcon: string | undefined;
      try {
        const guildRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
          headers: { Authorization: `Bot ${config.discordBotToken}` },
        });
        if (guildRes.ok) {
          const guild = (await guildRes.json()) as DiscordGuildResponse;
          guildName = guild.name;
          guildIcon = guild.icon ?? undefined;
        }
      } catch (e) {
        logger.warn('Failed to fetch guild info after install', {
          guildId,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      await storeGuildLink(config.convexApiSecret, {
        authUserId: installState.authUserId,
        discordGuildId: guildId,
        discordGuildName: guildName,
        discordGuildIcon: guildIcon,
        installedByAuthUserId: installState.authUserId,
        botPresent: true,
        status: 'active',
      });

      // Redirect to success page
      const successUrl = new URL('/install/success', config.frontendUrl);
      successUrl.searchParams.set('guild_id', guildId);
      successUrl.searchParams.set('auth_user_id', installState.authUserId);

      return Response.redirect(successUrl.toString(), 302);
    } catch (err) {
      logger.error('Bot install callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      const errorUrl = new URL('/install/error', config.frontendUrl);
      errorUrl.searchParams.set('error', 'installation_failed');
      return Response.redirect(errorUrl.toString(), 302);
    }
  }

  /**
   * GET /api/install/health/:guildId
   * Checks if the bot is still present in the guild
   */
  async function checkGuildHealth(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Expected path: /api/install/health/:guildId
    // pathParts should be ['api', 'install', 'health', guildId]
    const healthIndex = pathParts.indexOf('health');
    const guildId =
      healthIndex >= 0 && healthIndex + 1 < pathParts.length ? pathParts[healthIndex + 1] : null;

    if (!guildId) {
      return Response.json({ error: 'guildId is required' }, { status: 400 });
    }

    // This GET endpoint performs state mutations (updateGuildLinkStatus).
    // Reject cross-site requests to prevent CSRF exploitation.
    const allowedOrigins = new Set([
      new URL(config.baseUrl).origin,
      new URL(config.frontendUrl).origin,
    ]);
    const csrfBlock = rejectCrossSiteRequest(request, allowedOrigins);
    if (csrfBlock) return csrfBlock;

    let session: AuthSession = null;
    try {
      session = await auth.getSession(request);
    } catch {
      session = null;
    }
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    // Verify the authenticated user owns this guild before performing mutations.
    // Same ownership check as uninstallFromGuild.
    try {
      const convex = getConvexClient();
      const apiSecret = getConvexApiSecret();
      const guildLink = await convex.query(api.guildLinks.getGuildLinkForUninstall, {
        apiSecret,
        discordGuildId: guildId,
      });
      if (!guildLink || guildLink.authUserId !== session.user.id) {
        return Response.json({ error: 'Forbidden: you do not own this guild' }, { status: 403 });
      }
    } catch (err) {
      logger.error('Guild health check ownership verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to verify guild ownership' }, { status: 500 });
    }

    try {
      // Query Discord API to check if bot is in guild
      const guildResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
        headers: {
          Authorization: `Bot ${config.discordBotToken}`,
        },
      });

      if (guildResponse.ok) {
        const guild = (await guildResponse.json()) as DiscordGuildResponse;

        logger.debug('Guild health check passed', { guildId, guildName: guild.name });

        // Update guild link status and sync name/icon in Convex
        await updateGuildLinkStatus(
          config.convexApiSecret,
          guildId,
          'active',
          true,
          guild.name,
          guild.icon ?? undefined
        );

        return Response.json({
          healthy: true,
          botPresent: true,
          guild: {
            id: guild.id,
            name: guild.name,
            icon: guild.icon,
            memberCount: guild.approximate_member_count,
          },
        });
      }

      if (guildResponse.status === 403 || guildResponse.status === 404) {
        // Bot is not in guild
        logger.warn('Guild health check failed - bot not in guild', { guildId });

        // Update guild link status in Convex
        await updateGuildLinkStatus(config.convexApiSecret, guildId, 'uninstalled', false);

        return Response.json({
          healthy: false,
          botPresent: false,
          reason: 'Bot not present in guild',
        });
      }

      // Other error
      logger.error('Guild health check failed', {
        guildId,
        status: guildResponse.status,
      });

      return Response.json({
        healthy: false,
        botPresent: false,
        reason: 'Failed to check guild status',
      });
    } catch (err) {
      logger.error('Guild health check error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        {
          healthy: false,
          botPresent: false,
          reason: 'Health check failed',
          error: 'Temporary server issue',
        },
        { status: 500 }
      );
    }
  }

  /**
   * POST /api/install/uninstall/:guildId
   * Marks a guild as uninstalled
   */
  async function uninstallFromGuild(request: Request): Promise<Response> {
    // Verify user is authenticated
    let session: AuthSession = null;
    try {
      session = await auth.getSession(request);
    } catch {
      session = null;
    }

    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const guildId = pathParts[pathParts.length - 1];

    if (!guildId) {
      return Response.json({ error: 'guildId is required' }, { status: 400 });
    }

    try {
      // Verify tenant ownership before uninstalling
      const convex = getConvexClient();
      const apiSecret = getConvexApiSecret();
      const guildLink = await convex.query(api.guildLinks.getGuildLinkForUninstall, {
        apiSecret,
        discordGuildId: guildId,
      });

      if (!guildLink || guildLink.authUserId !== session.user.id) {
        return Response.json({ error: 'Forbidden: you do not own this guild' }, { status: 403 });
      }

      await updateGuildLinkStatus(config.convexApiSecret, guildId, 'uninstalled', false);

      logger.info('Guild uninstalled', {
        guildId,
        authUserId: session.user.id,
      });

      return Response.json({
        success: true,
        message: 'Guild uninstalled successfully',
      });
    } catch (err) {
      logger.error('Failed to uninstall guild', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        {
          success: false,
          error: 'Failed to uninstall',
        },
        { status: 500 }
      );
    }
  }

  return {
    initiateBotInstall,
    handleBotInstallCallback,
    checkGuildHealth,
    uninstallFromGuild,
  };
}

/**
 * Stores guild link data in Convex
 */
async function storeGuildLink(apiSecret: string, data: GuildLinkData): Promise<void> {
  const convex = getConvexClient();
  await convex.mutation(api.guildLinks.upsertGuildLink, {
    apiSecret,
    authUserId: data.authUserId,
    discordGuildId: data.discordGuildId,
    ...(data.discordGuildName !== undefined && { discordGuildName: data.discordGuildName }),
    ...(data.discordGuildIcon !== undefined && { discordGuildIcon: data.discordGuildIcon }),
    installedByAuthUserId: data.installedByAuthUserId,
    botPresent: data.botPresent,
    status: data.status,
  });
  logger.info('Stored guild link in Convex', {
    discordGuildId: data.discordGuildId,
    status: data.status,
  });
}

/**
 * Updates guild link status in Convex.
 * Optionally syncs discordGuildName and discordGuildIcon when available.
 */
async function updateGuildLinkStatus(
  apiSecret: string,
  discordGuildId: string,
  status: GuildLinkStatus,
  botPresent: boolean,
  discordGuildName?: string,
  discordGuildIcon?: string
): Promise<void> {
  const convex = getConvexClient();
  await convex.mutation(api.guildLinks.updateGuildLinkStatus, {
    apiSecret,
    discordGuildId,
    status,
    botPresent,
    ...(discordGuildName !== undefined && { discordGuildName }),
    ...(discordGuildIcon !== undefined && { discordGuildIcon }),
  });
  logger.debug('Updated guild link status in Convex', { discordGuildId, status });
}

/**
 * Route handler type
 */
export type InstallRouteHandlers = ReturnType<typeof createInstallRoutes>;

/**
 * Mounts install routes on the given path pattern
 */
export function mountInstallRoutes(
  auth: Auth,
  config: InstallConfig
): Map<string, (request: Request) => Promise<Response>> {
  const routes = createInstallRoutes(auth, config);
  const routeMap = new Map<string, (request: Request) => Promise<Response>>();

  routeMap.set('/api/install/bot', routes.initiateBotInstall);
  routeMap.set('/api/install/bot/callback', routes.handleBotInstallCallback);
  routeMap.set('/api/install/uninstall', routes.uninstallFromGuild);

  // Health check uses pattern matching
  routeMap.set('/api/install/health', routes.checkGuildHealth);

  return routeMap;
}
