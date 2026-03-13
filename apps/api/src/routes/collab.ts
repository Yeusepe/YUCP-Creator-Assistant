/**
 * Collaborator Invite Routes
 *
 * Flow:
 * 1. Server owner runs /creator-admin collab invite → bot calls POST /api/collab/invite → gets link
 * 2. Owner sends link to the collaborator however they like (DM, email, etc.)
 * 3. Collaborator opens /collab-invite#t=TOKEN in browser
 * 4. Browser exchanges the one-time token for a short-lived HTTP-only session cookie
 * 5. Consent page → "Continue with Discord" → GET /api/collab/auth/begin
 * 5. Discord OAuth (identify scope) → GET /api/collab/auth/callback
 * 6. Server stores Discord identity in state store, redirects back to consent page
 * 7. Page fetches /api/collab/session/discord-status (returns identity only)
 * 8. Collaborator completes setup, POST /api/collab/session/submit
 * 9. Server reads Discord identity from state store - never from client body
 *
 * Endpoints:
 * POST   /api/collab/invite                          – Create invite link (setup session auth)
 * POST   /api/collab/session/exchange                – Exchange invite token for a setup session
 * GET    /api/collab/auth/begin                      – Start Discord OAuth
 * GET    /api/collab/auth/callback?code=&state=      – Discord OAuth callback
 * GET    /api/collab/session/invite                  – Read invite metadata from collab session
 * GET    /api/collab/session/discord-status          – Check OAuth state
 * GET    /api/collab/session/webhook-config          – Get webhook URL after OAuth
 * POST   /api/collab/session/webhook-config          – Stage collaborator-provided signing secret
 * GET    /api/collab/session/test-webhook            – Poll for test webhook
 * POST   /api/collab/session/submit                  – Submit Jinxxy credentials
 * GET    /api/collab/connections                     – List owner's connections (setup session auth)
 * DELETE /api/collab/connections/:id                 – Remove connection (setup session auth)
 */

import { JinxxyApiClient } from '@yucp/providers';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import { SETUP_SESSION_COOKIE } from '../lib/browserSessions';
import { getConvexClientFromUrl } from '../lib/convex';
import { sendCollabKeyAddedEmail } from '../lib/email';
import { encrypt } from '../lib/encrypt';
import { resolveSetupSession } from '../lib/setupSession';
import { getStateStore } from '../lib/stateStore';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COLLAB_TEST_PREFIX = 'collab_test:';
const COLLAB_TEST_TTL_MS = 60 * 1000;
const COLLAB_DISCORD_PREFIX = 'collab_discord:'; // keyed by inviteId
const COLLAB_DISCORD_TTL_MS = 30 * 60 * 1000; // 30 minutes to complete setup after OAuth
const COLLAB_SESSION_PREFIX = 'collab_session:'; // keyed by collab session id
const COLLAB_WEBHOOK_PREFIX = 'collab_webhook:'; // keyed by inviteId
const COLLAB_OAUTH_PREFIX = 'collab_oauth:'; // keyed by oauth state nonce
const COLLAB_OAUTH_TTL_MS = 10 * 60 * 1000;
const COLLAB_SESSION_COOKIE = 'yucp_collab_session';

export interface CollabConfig {
  apiBaseUrl: string;
  frontendBaseUrl: string;
  convexUrl: string;
  convexApiSecret: string;
  encryptionSecret: string;
  discordClientId: string;
  discordClientSecret: string;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) return rest.join('=');
  }
  return null;
}

function buildCookie(
  name: string,
  value: string,
  request: Request,
  maxAgeSeconds?: number
): string {
  const isSecure = new URL(request.url).protocol === 'https:';
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isSecure) parts.push('Secure');
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

function clearCookie(name: string, request: Request): string {
  return buildCookie(name, '', request, 0);
}

async function resolveSetupToken(
  request: Request,
  encryptionSecret: string
): Promise<{ authUserId: string; guildId: string; discordUserId: string } | null> {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : getCookieValue(request, SETUP_SESSION_COOKIE);
  if (!token) return null;
  return resolveSetupSession(token, encryptionSecret);
}

export function createCollabRoutes(config: CollabConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);
  const apiSecret = config.convexApiSecret;
  const store = getStateStore();

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function lookupInviteByToken(rawToken: string) {
    const tokenHash = await sha256Hex(rawToken);
    return convex.query(api.collaboratorInvites.getCollaboratorInviteByTokenHash, {
      apiSecret,
      tokenHash,
    }) as Promise<{
      _id: string;
      ownerAuthUserId: string;
      status: string;
      ownerDisplayName: string;
      ownerGuildId?: string;
      expiresAt: number;
      createdAt: number;
    } | null>;
  }

  async function lookupInviteById(inviteId: string) {
    return convex.query(api.collaboratorInvites.getCollaboratorInviteById, {
      apiSecret,
      inviteId,
    }) as Promise<{
      _id: string;
      ownerAuthUserId: string;
      status: string;
      ownerDisplayName: string;
      ownerGuildId?: string;
      expiresAt: number;
      createdAt: number;
    } | null>;
  }

  function inviteErrorResponse(
    invite: { status: string; expiresAt: number } | null
  ): Response | null {
    if (!invite) return Response.json({ error: 'not_found' }, { status: 404 });
    if (invite.status === 'revoked') return Response.json({ error: 'revoked' }, { status: 410 });
    if (invite.status === 'accepted')
      return Response.json({ error: 'already_used' }, { status: 410 });
    if (Date.now() > invite.expiresAt) return Response.json({ error: 'expired' }, { status: 410 });
    return null;
  }

  async function resolveSessionInvite(request: Request) {
    const sessionId = getCookieValue(request, COLLAB_SESSION_COOKIE);
    if (!sessionId) return null;
    const raw = await store.get(`${COLLAB_SESSION_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { inviteId: string };
    const invite = await lookupInviteById(parsed.inviteId);
    if (!invite) return null;
    return { sessionId, invite };
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────

  /**
   * POST /api/collab/invite
   * Called by the bot. Creates an invite and returns the URL to share.
   * Body: { guildName?, guildId? }
   * Auth: setup session token
   */
  async function createInvite(request: Request): Promise<Response> {
    if (request.method !== 'POST')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });

    const session = await resolveSetupToken(request, config.encryptionSecret);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    let body: { guildName?: string; guildId?: string } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      /* use defaults */
    }

    const rawToken = generateToken();
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = Date.now() + INVITE_TOKEN_TTL_MS;

    try {
      await convex.mutation(api.collaboratorInvites.createCollaboratorInvite, {
        apiSecret,
        ownerAuthUserId: session.authUserId,
        ownerDisplayName: body.guildName ?? 'Unknown Server',
        ownerGuildId: body.guildId,
        tokenHash,
        expiresAt,
      });
    } catch (err) {
      logger.error('Failed to create collab invite', { err });
      return Response.json({ error: 'Failed to create invite' }, { status: 500 });
    }

    const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
    return Response.json({ inviteUrl: `${frontendUrl}/collab-invite#t=${rawToken}`, expiresAt });
  }

  /**
   * POST /api/collab/session/exchange
   * Exchanges a one-time invite token for a short-lived HTTP-only cookie session.
   */
  async function exchangeSession(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    let body: { token?: string };
    try {
      body = (await request.json()) as { token?: string };
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const rawToken = body.token?.trim();
    if (!rawToken) return Response.json({ error: 'Missing token' }, { status: 400 });

    const invite = await lookupInviteByToken(rawToken);
    const err = inviteErrorResponse(invite);
    if (err) return err;
    if (!invite) return Response.json({ error: 'not_found' }, { status: 404 });

    const sessionId = generateToken();
    const ttlMs = Math.max(1, invite.expiresAt - Date.now());
    await store.set(
      `${COLLAB_SESSION_PREFIX}${sessionId}`,
      JSON.stringify({ inviteId: invite._id }),
      ttlMs
    );

    return Response.json(
      {
        inviteId: invite._id,
        ownerDisplayName: invite.ownerDisplayName,
        ownerGuildId: invite.ownerGuildId,
        expiresAt: invite.expiresAt,
      },
      {
        headers: {
          'Set-Cookie': buildCookie(
            COLLAB_SESSION_COOKIE,
            sessionId,
            request,
            Math.max(1, Math.floor(ttlMs / 1000))
          ),
        },
      }
    );
  }

  /**
   * GET /api/collab/auth/begin
   * Redirects the collaborator to Discord OAuth (identify scope).
   * The OAuth state is a random nonce, not the invite token.
   */
  async function authBegin(request: Request): Promise<Response> {
    const session = await resolveSessionInvite(request);
    if (!session) return new Response('Missing or expired collab session', { status: 401 });

    const err = inviteErrorResponse(session.invite);
    if (err) return err;

    const oauthState = generateToken();
    await store.set(
      `${COLLAB_OAUTH_PREFIX}${oauthState}`,
      JSON.stringify({ inviteId: session.invite._id, sessionId: session.sessionId }),
      COLLAB_OAUTH_TTL_MS
    );

    const redirectUri = `${config.apiBaseUrl}/api/collab/auth/callback`;
    const params = new URLSearchParams({
      client_id: config.discordClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify',
      state: oauthState,
    });

    return Response.redirect(`https://discord.com/api/oauth2/authorize?${params}`, 302);
  }

  /**
   * GET /api/collab/auth/callback?code=&state=NONCE
   * Discord sends the user here after OAuth.
   * Exchanges the code, stores the Discord identity, redirects to consent page.
   */
  async function authCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const oauthState = url.searchParams.get('state');

    if (!code || !oauthState) return new Response('Missing code or state', { status: 400 });

    const rawOAuth = await store.get(`${COLLAB_OAUTH_PREFIX}${oauthState}`);
    if (!rawOAuth) {
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302);
    }

    const { inviteId, sessionId } = JSON.parse(rawOAuth) as { inviteId: string; sessionId: string };
    await store.delete(`${COLLAB_OAUTH_PREFIX}${oauthState}`);

    const invite = await lookupInviteById(inviteId);
    const err = inviteErrorResponse(invite);
    if (err) {
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302);
    }
    if (!invite) {
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302);
    }

    // Exchange code for access token
    const redirectUri = `${config.apiBaseUrl}/api/collab/auth/callback`;
    let discordUserId: string;
    let discordUsername: string;

    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.discordClientId,
          client_secret: config.discordClientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        logger.warn('Discord OAuth token exchange failed', { status: tokenRes.status });
        const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
        return Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302);
      }

      const tokenData = (await tokenRes.json()) as { access_token: string };

      // Fetch Discord user identity
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userRes.ok) throw new Error('Failed to fetch Discord user');
      const user = (await userRes.json()) as { id: string; username: string; global_name?: string };
      discordUserId = user.id;
      discordUsername = user.global_name ?? user.username;
    } catch (oauthErr) {
      logger.error('Discord OAuth failed', { err: oauthErr });
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302);
    }

    // Store Discord identity in state store, keyed by inviteId
    await store.set(
      `${COLLAB_DISCORD_PREFIX}${invite._id}`,
      JSON.stringify({ discordUserId, discordUsername }),
      COLLAB_DISCORD_TTL_MS
    );

    logger.info('Collab OAuth completed', {
      inviteId: invite._id,
      discordUserId,
    });

    const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${frontendUrl}/collab-invite?auth=done`,
        'Set-Cookie': buildCookie(
          COLLAB_SESSION_COOKIE,
          sessionId,
          request,
          Math.max(1, Math.floor((invite.expiresAt - Date.now()) / 1000))
        ),
      },
    });
  }

  /**
   * GET /api/collab/session/invite
   * Returns invite metadata for the current collab session.
   */
  async function getInvite(request: Request): Promise<Response> {
    const session = await resolveSessionInvite(request);
    if (!session) return Response.json({ error: 'not_found' }, { status: 404 });
    const err = inviteErrorResponse(session.invite);
    if (err) return err;

    return Response.json({
      inviteId: session.invite._id,
      ownerDisplayName: session.invite.ownerDisplayName,
      ownerGuildId: session.invite.ownerGuildId,
      expiresAt: session.invite.expiresAt,
    });
  }

  /**
   * GET /api/collab/session/discord-status
   * Returns whether the collaborator has completed Discord OAuth for this invite.
   */
  async function discordStatus(request: Request): Promise<Response> {
    const session = await resolveSessionInvite(request);
    if (!session) return Response.json({ error: 'not_found' }, { status: 404 });
    const err = inviteErrorResponse(session.invite);
    if (err) return err;

    const raw = await store.get(`${COLLAB_DISCORD_PREFIX}${session.invite._id}`);

    if (!raw) {
      return Response.json({ authenticated: false });
    }

    const { discordUserId, discordUsername } = JSON.parse(raw) as {
      discordUserId: string;
      discordUsername: string;
    };

    return Response.json({
      authenticated: true,
      discordUserId,
      discordUsername,
    });
  }

  /**
   * GET /api/collab/session/webhook-config
   * POST /api/collab/session/webhook-config
   */
  async function getWebhookConfig(request: Request): Promise<Response> {
    const session = await resolveSessionInvite(request);
    if (!session) return Response.json({ error: 'not_found' }, { status: 404 });
    if (session.invite.status !== 'pending' || Date.now() > session.invite.expiresAt) {
      return Response.json({ error: 'invalid_invite' }, { status: 410 });
    }

    const rawDiscord = await store.get(`${COLLAB_DISCORD_PREFIX}${session.invite._id}`);
    if (!rawDiscord) {
      return Response.json({ error: 'Discord authentication required' }, { status: 401 });
    }

    const callbackUrl = `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/jinxxy-collab/${session.invite.ownerAuthUserId}/${session.invite._id}`;

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

    await store.set(
      `${COLLAB_WEBHOOK_PREFIX}${session.invite._id}`,
      JSON.stringify({
        callbackUrl,
        signingSecretEncrypted: await encrypt(webhookSecret, config.encryptionSecret),
      }),
      Math.min(COLLAB_DISCORD_TTL_MS, Math.max(1, session.invite.expiresAt - Date.now()))
    );

    return Response.json({ success: true });
  }

  /**
   * GET /api/collab/session/test-webhook
   */
  async function testWebhook(request: Request): Promise<Response> {
    const session = await resolveSessionInvite(request);
    if (!session) return Response.json({ error: 'not_found' }, { status: 404 });
    if (session.invite.status !== 'pending' || Date.now() > session.invite.expiresAt) {
      return Response.json({ error: 'invalid_invite' }, { status: 410 });
    }

    const value = await store.get(`${COLLAB_TEST_PREFIX}${session.invite._id}`);
    return Response.json({ received: !!value });
  }

  /**
   * POST /api/collab/session/submit
   * Body: { linkType, jinxxyApiKey? }
   * Discord identity comes from the state store (OAuth result), NEVER from the client body.
   */
  async function submitInvite(request: Request): Promise<Response> {
    if (request.method !== 'POST')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });

    const session = await resolveSessionInvite(request);
    if (!session) return Response.json({ error: 'not_found' }, { status: 404 });
    const err = inviteErrorResponse(session.invite);
    if (err) return err;

    // Require OAuth to have been completed
    const rawDiscord = await store.get(`${COLLAB_DISCORD_PREFIX}${session.invite._id}`);
    if (!rawDiscord) {
      return Response.json(
        { error: 'Discord authentication required. Please complete OAuth first.' },
        { status: 401 }
      );
    }
    const { discordUserId, discordUsername } = JSON.parse(rawDiscord) as {
      discordUserId: string;
      discordUsername: string;
    };

    let body: {
      jinxxyApiKey?: string;
      linkType?: 'account' | 'api';
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { linkType } = body;
    if (!linkType || !['account', 'api'].includes(linkType)) {
      return Response.json({ error: 'linkType must be account or api' }, { status: 400 });
    }

    const { jinxxyApiKey } = body;
    if (!jinxxyApiKey?.trim()) {
      return Response.json({ error: 'jinxxyApiKey is required' }, { status: 400 });
    }

    try {
      const client = new JinxxyApiClient({
        apiKey: jinxxyApiKey.trim(),
        apiBaseUrl: process.env.JINXXY_API_BASE_URL,
      });
      await client.getProducts({ per_page: 1 });
    } catch (validationErr) {
      logger.warn('Collab submit: Jinxxy API key validation failed', {
        error: validationErr instanceof Error ? validationErr.message : String(validationErr),
      });
      return Response.json(
        { error: 'Invalid Jinxxy API key - could not authenticate' },
        { status: 422 }
      );
    }

    const jinxxyApiKeyEncrypted = await encrypt(jinxxyApiKey.trim(), config.encryptionSecret);

    let webhookSecretRef: string | undefined;
    let webhookEndpoint: string | undefined;
    if (linkType === 'account') {
      const pendingWebhook = await store.get(`${COLLAB_WEBHOOK_PREFIX}${session.invite._id}`);
      if (!pendingWebhook) {
        return Response.json(
          { error: 'Webhook setup is required before completing account linking.' },
          { status: 400 }
        );
      }
      const parsedWebhook = JSON.parse(pendingWebhook) as {
        callbackUrl: string;
        signingSecretEncrypted: string;
      };
      webhookSecretRef = parsedWebhook.signingSecretEncrypted;
      webhookEndpoint = parsedWebhook.callbackUrl;
    }

    try {
      await convex.mutation(api.collaboratorInvites.acceptCollaboratorInvite, {
        apiSecret,
        inviteId: session.invite._id,
        jinxxyApiKeyEncrypted,
        webhookSecretRef,
        webhookEndpoint,
        linkType,
        collaboratorDiscordUserId: discordUserId,
        collaboratorDisplayName: discordUsername,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('Failed to accept collab invite', { err: msg });
      if (msg.includes('no longer pending') || msg.includes('expired')) {
        return Response.json({ error: msg }, { status: 410 });
      }
      return Response.json({ error: 'Failed to submit credentials' }, { status: 500 });
    }

    await store.delete(`${COLLAB_DISCORD_PREFIX}${session.invite._id}`);
    await store.delete(`${COLLAB_WEBHOOK_PREFIX}${session.invite._id}`);
    await store.delete(`${COLLAB_TEST_PREFIX}${session.invite._id}`);
    await store.delete(`${COLLAB_SESSION_PREFIX}${session.sessionId}`);

    return Response.json(
      { success: true },
      { headers: { 'Set-Cookie': clearCookie(COLLAB_SESSION_COOKIE, request) } }
    );
  }

  /**
   * GET /api/collab/connections - list owner's connections
   */
  async function listConnections(request: Request): Promise<Response> {
    const session = await resolveSetupToken(request, config.encryptionSecret);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const connections = await convex.query(api.collaboratorInvites.listCollaboratorConnections, {
      apiSecret,
      ownerAuthUserId: session.authUserId,
    });
    return Response.json({ connections });
  }

  /**
   * POST /api/collab/connections/manual
   * Manually add a collaborator by API key (no invite). Identity from Jinxxy API.
   * Body: { jinxxyApiKey: string, serverName?: string }
   */
  async function addConnectionManual(request: Request): Promise<Response> {
    if (request.method !== 'POST')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });

    const session = await resolveSetupToken(request, config.encryptionSecret);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    let body: { jinxxyApiKey?: string; serverName?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const jinxxyApiKey = body.jinxxyApiKey?.trim();
    if (!jinxxyApiKey) {
      return Response.json({ error: 'jinxxyApiKey is required' }, { status: 400 });
    }

    let user: { username: string; id: string; email?: string };
    try {
      const client = new JinxxyApiClient({
        apiKey: jinxxyApiKey,
        apiBaseUrl: process.env.JINXXY_API_BASE_URL,
      });
      user = await client.getCurrentUser();
    } catch (validationErr) {
      logger.warn('Collab manual add: Jinxxy API key validation failed', {
        error: validationErr instanceof Error ? validationErr.message : String(validationErr),
      });
      return Response.json(
        { error: 'Invalid Jinxxy API key - could not authenticate' },
        { status: 422 }
      );
    }

    const jinxxyApiKeyEncrypted = await encrypt(jinxxyApiKey, config.encryptionSecret);
    const collaboratorIdentity = `manual:${user.id}`;

    let connectionId: string;
    try {
      connectionId = await convex.mutation(
        api.collaboratorInvites.addCollaboratorConnectionManual,
        {
          apiSecret,
          ownerAuthUserId: session.authUserId,
          jinxxyApiKeyEncrypted,
          collaboratorDisplayName: user.username,
          collaboratorIdentity,
          addedByDiscordUserId: session.discordUserId,
        }
      );
    } catch (e) {
      logger.error('Failed to add collab connection manually', { err: e });
      return Response.json({ error: 'Failed to add connection' }, { status: 500 });
    }

    if (user.email) {
      sendCollabKeyAddedEmail({
        to: user.email,
        collaboratorDisplayName: user.username,
        serverName: body.serverName ?? 'a Discord server',
        addedAt: new Date().toISOString(),
        connectionId,
      }).catch((err) => {
        logger.warn('Failed to send collab key added email', { err, connectionId });
      });
    }

    return Response.json({
      success: true,
      connectionId,
      displayName: user.username,
    });
  }

  /**
   * DELETE /api/collab/connections/:id - remove a connection
   */
  async function removeConnection(request: Request, connectionId: string): Promise<Response> {
    if (request.method !== 'DELETE')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });

    const session = await resolveSetupToken(request, config.encryptionSecret);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    try {
      await convex.mutation(api.collaboratorInvites.removeCollaboratorConnection, {
        apiSecret,
        connectionId,
        ownerAuthUserId: session.authUserId,
      });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    return Response.json({ success: true });
  }

  // ── Dispatcher ─────────────────────────────────────────────────────────────

  async function handleCollabRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/api/collab/invite' && request.method === 'POST')
      return createInvite(request);
    if (pathname === '/api/collab/session/exchange' && request.method === 'POST')
      return exchangeSession(request);
    if (pathname === '/api/collab/auth/begin') return authBegin(request);
    if (pathname === '/api/collab/auth/callback') return authCallback(request);
    if (pathname === '/api/collab/session/invite' && request.method === 'GET')
      return getInvite(request);
    if (pathname === '/api/collab/session/discord-status' && request.method === 'GET')
      return discordStatus(request);
    if (
      pathname === '/api/collab/session/webhook-config' &&
      (request.method === 'GET' || request.method === 'POST')
    )
      return getWebhookConfig(request);
    if (pathname === '/api/collab/session/test-webhook' && request.method === 'GET')
      return testWebhook(request);
    if (pathname === '/api/collab/session/submit' && request.method === 'POST')
      return submitInvite(request);
    if (pathname === '/api/collab/connections' && request.method === 'GET')
      return listConnections(request);
    if (pathname === '/api/collab/connections/manual' && request.method === 'POST')
      return addConnectionManual(request);

    const connDeleteMatch = pathname.match(/^\/api\/collab\/connections\/([^/]+)$/);
    if (connDeleteMatch && request.method === 'DELETE')
      return removeConnection(request, connDeleteMatch[1]);

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  return { handleCollabRequest };
}
