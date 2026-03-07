/**
 * Collaborator Invite Routes
 *
 * Flow:
 * 1. Server owner runs /creator-admin collab invite → bot calls POST /api/collab/invite → gets link
 * 2. Owner sends link to the collaborator however they like (DM, email, etc.)
 * 3. Collaborator opens /collab-invite?t=TOKEN in browser
 * 4. Consent page → "Continue with Discord" → GET /api/collab/auth/begin?t=TOKEN
 * 5. Discord OAuth (identify scope) → GET /api/collab/auth/callback
 * 6. Server stores Discord identity in state store, redirects back to consent page
 * 7. Page fetches /api/collab/invite/:token/discord-status (returns identity + prior history)
 * 8. Collaborator completes setup, POST /api/collab/invite/:token/submit
 * 9. Server reads Discord identity from state store — never from client body
 *
 * Endpoints:
 * POST   /api/collab/invite                          – Create invite link (setup session auth)
 * GET    /api/collab/auth/begin?t=TOKEN              – Start Discord OAuth
 * GET    /api/collab/auth/callback?code=&state=      – Discord OAuth callback
 * GET    /api/collab/invite/:token                   – Validate token, return invite metadata
 * GET    /api/collab/invite/:token/discord-status    – Check OAuth state + prior history
 * GET    /api/collab/invite/:token/webhook-config    – Get webhook URL + signing secret
 * GET    /api/collab/invite/:token/test-webhook      – Poll for test webhook
 * POST   /api/collab/invite/:token/submit            – Submit Jinxxy credentials
 * GET    /api/collab/connections                     – List owner's connections (setup session auth)
 * DELETE /api/collab/connections/:id                 – Remove connection (setup session auth)
 */

import { createLogger } from '@yucp/shared';
import { getConvexClientFromUrl } from '../lib/convex';
import { encrypt, decrypt } from '../lib/encrypt';
import { getStateStore } from '../lib/stateStore';
import { resolveSetupSession } from '../lib/setupSession';
import { JinxxyApiClient } from '@yucp/providers';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COLLAB_TEST_PREFIX = 'collab_test:';
const COLLAB_TEST_TTL_MS = 60 * 1000;
const COLLAB_DISCORD_PREFIX = 'collab_discord:'; // keyed by inviteId
const COLLAB_DISCORD_TTL_MS = 30 * 60 * 1000;   // 30 minutes to complete setup after OAuth

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

async function resolveSetupToken(
  request: Request,
  encryptionSecret: string
): Promise<{ tenantId: string; guildId: string; discordUserId: string } | null> {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : new URL(request.url).searchParams.get('s');
  if (!token) return null;
  return resolveSetupSession(token, encryptionSecret);
}

export function createCollabRoutes(config: CollabConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);
  const apiSecret = config.convexApiSecret;

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function lookupInviteByToken(rawToken: string) {
    const tokenHash = await sha256Hex(rawToken);
    return convex.query('collaboratorInvites:getCollaboratorInviteByTokenHash' as any, {
      apiSecret,
      tokenHash,
    }) as Promise<{
      _id: string;
      ownerTenantId: string;
      status: string;
      ownerDisplayName: string;
      ownerGuildId?: string;
      expiresAt: number;
      createdAt: number;
    } | null>;
  }

  function inviteErrorResponse(invite: { status: string; expiresAt: number } | null): Response | null {
    if (!invite) return Response.json({ error: 'not_found' }, { status: 404 });
    if (invite.status === 'revoked') return Response.json({ error: 'revoked' }, { status: 410 });
    if (invite.status === 'accepted') return Response.json({ error: 'already_used' }, { status: 410 });
    if (Date.now() > invite.expiresAt) return Response.json({ error: 'expired' }, { status: 410 });
    return null;
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────

  /**
   * POST /api/collab/invite
   * Called by the bot. Creates an invite and returns the URL to share.
   * Body: { guildName?, guildId? }
   * Auth: setup session token
   */
  async function createInvite(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

    const session = await resolveSetupToken(request, config.encryptionSecret);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    let body: { guildName?: string; guildId?: string } = {};
    try { body = (await request.json()) as typeof body; } catch { /* use defaults */ }

    const rawToken = generateToken();
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = Date.now() + INVITE_TOKEN_TTL_MS;

    try {
      await convex.mutation('collaboratorInvites:createCollaboratorInvite' as any, {
        apiSecret,
        ownerTenantId: session.tenantId,
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
    return Response.json({ inviteUrl: `${frontendUrl}/collab-invite?t=${rawToken}`, expiresAt });
  }

  /**
   * GET /api/collab/auth/begin?t=TOKEN
   * Redirects the collaborator to Discord OAuth (identify scope).
   * The OAuth state encodes the raw token so the callback can link back to the invite.
   */
  async function authBegin(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rawToken = url.searchParams.get('t');
    if (!rawToken) return new Response('Missing token', { status: 400 });

    // Validate invite before starting OAuth
    const invite = await lookupInviteByToken(rawToken);
    const err = inviteErrorResponse(invite);
    if (err) return err;

    const redirectUri = `${config.apiBaseUrl}/api/collab/auth/callback`;
    const params = new URLSearchParams({
      client_id: config.discordClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify',
      state: rawToken, // echoed back by Discord in the callback
    });

    return Response.redirect(`https://discord.com/api/oauth2/authorize?${params}`, 302);
  }

  /**
   * GET /api/collab/auth/callback?code=&state=TOKEN
   * Discord sends the user here after OAuth.
   * Exchanges the code, stores the Discord identity, redirects to consent page.
   */
  async function authCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const rawToken = url.searchParams.get('state');

    if (!code || !rawToken) return new Response('Missing code or state', { status: 400 });

    // Validate invite is still usable
    const invite = await lookupInviteByToken(rawToken);
    const err = inviteErrorResponse(invite);
    if (err) {
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return Response.redirect(`${frontendUrl}/collab-invite?t=${rawToken}&auth=error`, 302);
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
        return Response.redirect(`${frontendUrl}/collab-invite?t=${rawToken}&auth=error`, 302);
      }

      const tokenData = await tokenRes.json() as { access_token: string };

      // Fetch Discord user identity
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userRes.ok) throw new Error('Failed to fetch Discord user');
      const user = await userRes.json() as { id: string; username: string; global_name?: string };
      discordUserId = user.id;
      discordUsername = user.global_name ?? user.username;
    } catch (oauthErr) {
      logger.error('Discord OAuth failed', { err: oauthErr });
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return Response.redirect(`${frontendUrl}/collab-invite?t=${rawToken}&auth=error`, 302);
    }

    // Store Discord identity in state store, keyed by inviteId
    const store = getStateStore();
    await store.set(
      `${COLLAB_DISCORD_PREFIX}${invite!._id}`,
      JSON.stringify({ discordUserId, discordUsername }),
      COLLAB_DISCORD_TTL_MS,
    );

    logger.info('Collab OAuth completed', {
      inviteId: invite!._id,
      discordUserId,
    });

    const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
    return Response.redirect(`${frontendUrl}/collab-invite?t=${rawToken}&auth=done`, 302);
  }

  /**
   * GET /api/collab/invite/:token
   * Returns invite metadata (server name, expiry). No identity info — that comes after OAuth.
   */
  async function getInvite(_request: Request, rawToken: string): Promise<Response> {
    const invite = await lookupInviteByToken(rawToken);
    const err = inviteErrorResponse(invite);
    if (err) return err;

    return Response.json({
      inviteId: invite!._id,
      ownerDisplayName: invite!.ownerDisplayName,
      ownerGuildId: invite!.ownerGuildId,
      expiresAt: invite!.expiresAt,
    });
  }

  /**
   * GET /api/collab/invite/:token/discord-status
   * Returns whether the collaborator has completed Discord OAuth for this invite,
   * and if so, their prior connection history (for "returning user" UX).
   */
  async function discordStatus(_request: Request, rawToken: string): Promise<Response> {
    const invite = await lookupInviteByToken(rawToken);
    const err = inviteErrorResponse(invite);
    if (err) return err;

    const store = getStateStore();
    const raw = await store.get(`${COLLAB_DISCORD_PREFIX}${invite!._id}`);

    if (!raw) {
      return Response.json({ authenticated: false });
    }

    const { discordUserId, discordUsername } = JSON.parse(raw) as {
      discordUserId: string;
      discordUsername: string;
    };

    const history = await convex.query('collaboratorInvites:getPriorCollabHistory' as any, {
      apiSecret,
      discordUserId,
    }) as { hasApiOnly: boolean; hasFullAccount: boolean };

    return Response.json({
      authenticated: true,
      discordUserId,
      discordUsername,
      hasApiOnly: history.hasApiOnly,
      hasFullAccount: history.hasFullAccount,
    });
  }

  /**
   * GET /api/collab/invite/:token/webhook-config
   */
  async function getWebhookConfig(_request: Request, rawToken: string): Promise<Response> {
    const invite = await lookupInviteByToken(rawToken);
    if (!invite || invite.status !== 'pending' || Date.now() > invite.expiresAt) {
      return Response.json({ error: 'invalid_invite' }, { status: 410 });
    }

    const result = await convex.mutation('collaboratorInvites:getOrCreateCollabWebhookConfig' as any, {
      apiSecret,
      ownerTenantId: invite.ownerTenantId,
      inviteId: invite._id,
      baseUrl: config.apiBaseUrl,
    }) as { callbackUrl: string; signingSecret: string };

    return Response.json(result);
  }

  /**
   * GET /api/collab/invite/:token/test-webhook
   */
  async function testWebhook(_request: Request, rawToken: string): Promise<Response> {
    const invite = await lookupInviteByToken(rawToken);
    if (!invite || invite.status !== 'pending' || Date.now() > invite.expiresAt) {
      return Response.json({ error: 'invalid_invite' }, { status: 410 });
    }

    const store = getStateStore();
    const value = await store.get(`${COLLAB_TEST_PREFIX}${invite._id}`);
    return Response.json({ received: !!value });
  }

  /**
   * POST /api/collab/invite/:token/submit
   * Body: { linkType, reuseKey?, jinxxyApiKey?, webhookSecret?, webhookEndpoint? }
   * Discord identity comes from the state store (OAuth result), NEVER from the client body.
   */
  async function submitInvite(request: Request, rawToken: string): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

    const invite = await lookupInviteByToken(rawToken);
    const err = inviteErrorResponse(invite);
    if (err) return err;

    // Require OAuth to have been completed
    const store = getStateStore();
    const rawDiscord = await store.get(`${COLLAB_DISCORD_PREFIX}${invite!._id}`);
    if (!rawDiscord) {
      return Response.json({ error: 'Discord authentication required. Please complete OAuth first.' }, { status: 401 });
    }
    const { discordUserId, discordUsername } = JSON.parse(rawDiscord) as {
      discordUserId: string;
      discordUsername: string;
    };

    let body: {
      jinxxyApiKey?: string;
      linkType?: 'account' | 'api';
      reuseKey?: boolean;
      webhookSecret?: string;
      webhookEndpoint?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { linkType, reuseKey } = body;
    if (!linkType || !['account', 'api'].includes(linkType)) {
      return Response.json({ error: 'linkType must be account or api' }, { status: 400 });
    }

    let jinxxyApiKeyEncrypted: string;

    if (reuseKey) {
      const history = await convex.query('collaboratorInvites:getPriorCollabHistory' as any, {
        apiSecret,
        discordUserId,
      }) as { hasApiOnly: boolean; hasFullAccount: boolean; encryptedApiKey?: string };

      if (!history.encryptedApiKey) {
        return Response.json({ error: 'No prior API key found to reuse' }, { status: 400 });
      }
      jinxxyApiKeyEncrypted = history.encryptedApiKey;
    } else {
      const { jinxxyApiKey } = body;
      if (!jinxxyApiKey?.trim()) {
        return Response.json({ error: 'jinxxyApiKey is required' }, { status: 400 });
      }

      try {
        const client = new JinxxyApiClient({
          apiKey: jinxxyApiKey.trim(),
          apiBaseUrl: process.env.JINXXY_API_BASE_URL,
        });
        // Validate key by fetching products (same call used in jinxxyProducts route)
        await client.getProducts({ per_page: 1 });
      } catch (validationErr) {
        logger.warn('Collab submit: Jinxxy API key validation failed', {
          error: validationErr instanceof Error ? validationErr.message : String(validationErr),
        });
        return Response.json({ error: 'Invalid Jinxxy API key — could not authenticate' }, { status: 422 });
      }

      jinxxyApiKeyEncrypted = await encrypt(jinxxyApiKey.trim(), config.encryptionSecret);
    }

    const webhookSecretRef = linkType === 'account' ? (body.webhookSecret ?? undefined) : undefined;
    const webhookEndpoint = linkType === 'account' ? (body.webhookEndpoint ?? undefined) : undefined;

    try {
      await convex.mutation('collaboratorInvites:acceptCollaboratorInvite' as any, {
        apiSecret,
        inviteId: invite!._id,
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

    // Clean up OAuth state — invite is single-use
    await store.delete(`${COLLAB_DISCORD_PREFIX}${invite!._id}`);

    return Response.json({ success: true });
  }

  /**
   * GET /api/collab/connections — list owner's connections
   */
  async function listConnections(request: Request): Promise<Response> {
    const session = await resolveSetupToken(request, config.encryptionSecret);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const connections = await convex.query('collaboratorInvites:listCollaboratorConnections' as any, {
      apiSecret,
      ownerTenantId: session.tenantId,
    });
    return Response.json({ connections });
  }

  /**
   * DELETE /api/collab/connections/:id — remove a connection
   */
  async function removeConnection(request: Request, connectionId: string): Promise<Response> {
    if (request.method !== 'DELETE') return Response.json({ error: 'Method not allowed' }, { status: 405 });

    const session = await resolveSetupToken(request, config.encryptionSecret);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    try {
      await convex.mutation('collaboratorInvites:removeCollaboratorConnection' as any, {
        apiSecret,
        connectionId,
        ownerTenantId: session.tenantId,
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

    if (pathname === '/api/collab/invite' && request.method === 'POST') return createInvite(request);
    if (pathname === '/api/collab/auth/begin') return authBegin(request);
    if (pathname === '/api/collab/auth/callback') return authCallback(request);
    if (pathname === '/api/collab/connections' && request.method === 'GET') return listConnections(request);

    const connDeleteMatch = pathname.match(/^\/api\/collab\/connections\/([^/]+)$/);
    if (connDeleteMatch && request.method === 'DELETE') return removeConnection(request, connDeleteMatch[1]);

    const tokenMatch = pathname.match(/^\/api\/collab\/invite\/([^/]+)(\/.*)?$/);
    if (!tokenMatch) return Response.json({ error: 'Not found' }, { status: 404 });

    const rawToken = tokenMatch[1];
    const subPath = tokenMatch[2] ?? '';

    if (subPath === '' && request.method === 'GET') return getInvite(request, rawToken);
    if (subPath === '/discord-status' && request.method === 'GET') return discordStatus(request, rawToken);
    if (subPath === '/webhook-config' && request.method === 'GET') return getWebhookConfig(request, rawToken);
    if (subPath === '/test-webhook' && request.method === 'GET') return testWebhook(request, rawToken);
    if (subPath === '/submit' && request.method === 'POST') return submitInvite(request, rawToken);

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  return { handleCollabRequest };
}
