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

import { getProviderDescriptor, PROVIDER_REGISTRY } from '@yucp/providers/providerMetadata';
import { base64UrlEncode, sha256Hex } from '@yucp/shared/crypto';
import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import {
  buildCookie,
  clearCookie,
  getCookieValue,
  SETUP_SESSION_COOKIE,
} from '../lib/browserSessions';
import { getConvexClientFromUrl } from '../lib/convex';
import { encrypt } from '../lib/encrypt';
import { logger } from '../lib/logger';
import { loadRequestScoped, requestScopeKey } from '../lib/requestScope';
import { buildTimedResponse, RouteTimingCollector } from '../lib/requestTiming';
import { resolveSetupSession } from '../lib/setupSession';
import { getStateStore } from '../lib/stateStore';
import { getProviderRuntime } from '../providers/index';

// Collab webhook secrets are scoped to collab connections, not shared with per-provider webhooks
const COLLAB_WEBHOOK_SECRET_PURPOSE = 'collab-webhook-signing-secret' as const;

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COLLAB_TEST_PREFIX = 'collab_test:';
const _COLLAB_TEST_TTL_MS = 60 * 1000;
const COLLAB_DISCORD_PREFIX = 'collab_discord:'; // keyed by inviteId
const COLLAB_DISCORD_TTL_MS = 30 * 60 * 1000; // 30 minutes to complete setup after OAuth
const COLLAB_SESSION_PREFIX = 'collab_session:'; // keyed by collab session id
const COLLAB_WEBHOOK_PREFIX = 'collab_webhook:'; // keyed by inviteId
const COLLAB_OAUTH_PREFIX = 'collab_oauth:'; // keyed by oauth state nonce
const COLLAB_OAUTH_TTL_MS = 10 * 60 * 1000;
const COLLAB_SESSION_COOKIE = 'yucp_collab_session';
type CreatorProfileRecord = { authUserId?: string } | null;

function isCollaboratorShareableProvider(
  provider: ReturnType<typeof getProviderDescriptor>
): provider is NonNullable<ReturnType<typeof getProviderDescriptor>> & {
  collabCredential: NonNullable<
    NonNullable<ReturnType<typeof getProviderDescriptor>>['collabCredential']
  >;
} {
  return Boolean(provider?.collabCredential);
}

export interface CollabConfig {
  auth: Auth;
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
  return base64UrlEncode(bytes);
}

async function resolveSetupToken(
  request: Request,
  encryptionSecret: string
): Promise<{ authUserId: string; guildId: string; discordUserId: string } | null> {
  return loadRequestScoped(request, 'collab:setup-session', async () => {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : getCookieValue(request, SETUP_SESSION_COOKIE);
    if (!token) return null;
    return resolveSetupSession(token, encryptionSecret);
  });
}

export function createCollabRoutes(config: CollabConfig) {
  const convex = getConvexClientFromUrl(config.convexUrl);
  const apiSecret = config.convexApiSecret;
  const store = getStateStore();

  async function getCreatorProfile(
    request: Request,
    authUserId: string,
    timing?: RouteTimingCollector
  ): Promise<CreatorProfileRecord> {
    return loadRequestScoped(
      request,
      requestScopeKey('collab:creator-profile', { authUserId }),
      async () =>
        timing
          ? ((await timing.measure(
              'convex_tenant_ownership',
              () =>
                convex.query(api.creatorProfiles.getCreatorProfile, {
                  apiSecret,
                  authUserId,
                }),
              'check tenant ownership'
            )) as CreatorProfileRecord)
          : ((await convex.query(api.creatorProfiles.getCreatorProfile, {
              apiSecret,
              authUserId,
            })) as CreatorProfileRecord)
    );
  }

  async function isTenantOwnedBySessionUser(
    request: Request,
    sessionUserId: string,
    profileAuthUserId: string,
    timing?: RouteTimingCollector
  ): Promise<boolean> {
    const profile = await getCreatorProfile(request, profileAuthUserId, timing);
    return !!profile && profile.authUserId === sessionUserId;
  }

  /**
   * Owner-facing collaborator APIs accept either a forwarded Better Auth dashboard
   * session or a short-lived setup-session token minted by internal RPC.
   * When both are present they must resolve to the same owner.
   */
  async function requireOwnerAuth(
    request: Request,
    authUserIdHint?: string,
    timing?: RouteTimingCollector
  ): Promise<
    { ok: true; authUserId: string; displayName: string } | { ok: false; response: Response }
  > {
    const buildErrorResponse = (body: object, status: number): Response =>
      timing
        ? buildTimedResponse(
            timing,
            () => Response.json(body, { status }),
            'serialize collaborator auth response'
          )
        : Response.json(body, { status });
    const setupSession = timing
      ? await timing.measure(
          'session_setup',
          () => resolveSetupToken(request, config.encryptionSecret),
          'resolve setup session'
        )
      : await resolveSetupToken(request, config.encryptionSecret);
    const webSession = timing
      ? await timing.measure(
          'session_web',
          () => config.auth.getSession(request),
          'resolve Better Auth session'
        )
      : await config.auth.getSession(request);

    if (setupSession) {
      if (authUserIdHint && authUserIdHint !== setupSession.authUserId) {
        return { ok: false, response: buildErrorResponse({ error: 'Forbidden' }, 403) };
      }

      if (webSession) {
        const sessionOwnsSetupTenant =
          webSession.user.id === setupSession.authUserId ||
          (await isTenantOwnedBySessionUser(
            request,
            webSession.user.id,
            setupSession.authUserId,
            timing
          ));
        if (!sessionOwnsSetupTenant) {
          return { ok: false, response: buildErrorResponse({ error: 'Forbidden' }, 403) };
        }

        return {
          ok: true,
          authUserId: setupSession.authUserId,
          displayName: webSession.user.name ?? '',
        };
      }

      return {
        ok: true,
        authUserId: setupSession.authUserId,
        displayName: '',
      };
    }

    if (!webSession) {
      return {
        ok: false,
        response: buildErrorResponse({ error: 'Authentication required' }, 401),
      };
    }

    // If no authUserId hint is supplied, fall back to the session user's own ID.
    // The user IS their own authUserId in the Better Auth system, so no ownership
    // check is needed in this case.
    if (!authUserIdHint) {
      return { ok: true, authUserId: webSession.user.id, displayName: webSession.user.name ?? '' };
    }

    const tenantOwned = await isTenantOwnedBySessionUser(
      request,
      webSession.user.id,
      authUserIdHint,
      timing
    );
    if (!tenantOwned) {
      return { ok: false, response: buildErrorResponse({ error: 'Forbidden' }, 403) };
    }
    return { ok: true, authUserId: authUserIdHint, displayName: webSession.user.name ?? '' };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function lookupInviteByToken(request: Request, rawToken: string) {
    return loadRequestScoped(
      request,
      requestScopeKey('collab:invite-token', { rawToken }),
      async () => {
        const tokenHash = await sha256Hex(rawToken);
        const invite = await (convex.query(
          api.collaboratorInvites.getCollaboratorInviteByTokenHash,
          {
            apiSecret,
            tokenHash,
          }
        ) as Promise<{
          _id: string;
          ownerAuthUserId: string;
          status: string;
          ownerDisplayName: string;
          ownerGuildId?: string;
          providerKey?: string;
          expiresAt: number;
          createdAt: number;
        } | null>);
        if (invite && invite.expiresAt < Date.now()) {
          return null;
        }
        return invite;
      }
    );
  }

  async function lookupInviteById(request: Request, inviteId: string) {
    return loadRequestScoped(
      request,
      requestScopeKey('collab:invite-id', { inviteId }),
      async () =>
        convex.query(api.collaboratorInvites.getCollaboratorInviteById, {
          apiSecret,
          inviteId,
        }) as Promise<{
          _id: string;
          ownerAuthUserId: string;
          status: string;
          ownerDisplayName: string;
          ownerGuildId?: string;
          providerKey?: string;
          expiresAt: number;
          createdAt: number;
        } | null>
    );
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

  async function resolveSessionInvite(request: Request, timing?: RouteTimingCollector) {
    return loadRequestScoped(request, 'collab:session-invite', async () => {
      const sessionId = getCookieValue(request, COLLAB_SESSION_COOKIE);
      if (!sessionId) return null;
      const raw = timing
        ? await timing.measure(
            'session_collab',
            () => store.get(`${COLLAB_SESSION_PREFIX}${sessionId}`),
            'resolve collaborator session'
          )
        : await store.get(`${COLLAB_SESSION_PREFIX}${sessionId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { inviteId: string };
      const invite = timing
        ? await timing.measure(
            'convex_invite_lookup',
            () => lookupInviteById(request, parsed.inviteId),
            'load collaborator invite'
          )
        : await lookupInviteById(request, parsed.inviteId);
      if (!invite) return null;
      return { sessionId, invite };
    });
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────

  /**
   * POST /api/collab/invite
   * Creates a collaborator invite and returns the URL to share.
   * Body: { guildName?, guildId?, authUserId?, providerKey? }
   * Auth: setup session token OR Better Auth web session with authUserId in body
   */
  async function createInvite(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    const respond = (
      buildResponse: () => Response,
      description = 'serialize collaborator response'
    ) => buildTimedResponse(timing, buildResponse, description);
    if (request.method !== 'POST')
      return respond(() => Response.json({ error: 'Method not allowed' }, { status: 405 }));

    let body: { guildName?: string; guildId?: string; authUserId?: string; providerKey?: string } =
      {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      /* use defaults */
    }

    // Auth first, never expose body validation details to unauthenticated callers
    const ownerAuth = await requireOwnerAuth(request, body.authUserId, timing);
    if (!ownerAuth.ok) return ownerAuth.response;

    const providerKey = body.providerKey?.trim();
    if (!providerKey) {
      return respond(() => Response.json({ error: 'providerKey is required' }, { status: 400 }));
    }
    const providerDescriptor = getProviderDescriptor(providerKey);
    if (!isCollaboratorShareableProvider(providerDescriptor)) {
      return respond(() =>
        Response.json(
          { error: `Provider '${providerKey}' does not support collaborator invites` },
          { status: 400 }
        )
      );
    }

    const rawToken = generateToken();
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = Date.now() + INVITE_TOKEN_TTL_MS;

    try {
      await timing.measure(
        'convex_collab_invite_create',
        () =>
          convex.mutation(api.collaboratorInvites.createCollaboratorInvite, {
            apiSecret,
            ownerAuthUserId: ownerAuth.authUserId,
            ownerDisplayName: body.guildName?.trim() || ownerAuth.displayName,
            ownerGuildId: body.guildId,
            tokenHash,
            expiresAt,
            providerKey,
          }),
        'create collaborator invite'
      );
    } catch (err) {
      logger.error('Failed to create collab invite', { err });
      return respond(() => Response.json({ error: 'Failed to create invite' }, { status: 500 }));
    }

    const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
    return respond(() =>
      Response.json({ inviteUrl: `${frontendUrl}/collab-invite#t=${rawToken}`, expiresAt })
    );
  }

  /**
   * POST /api/collab/session/exchange
   * Exchanges a one-time invite token for a short-lived HTTP-only cookie session.
   */
  async function exchangeSession(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    const respond = (
      buildResponse: () => Response,
      description = 'serialize collaborator response'
    ) => buildTimedResponse(timing, buildResponse, description);
    if (request.method !== 'POST') {
      return respond(() => Response.json({ error: 'Method not allowed' }, { status: 405 }));
    }

    let body: { token?: string };
    try {
      body = (await request.json()) as { token?: string };
    } catch {
      return respond(() => Response.json({ error: 'Invalid JSON' }, { status: 400 }));
    }

    const rawToken = body.token?.trim();
    if (!rawToken) return respond(() => Response.json({ error: 'Missing token' }, { status: 400 }));

    const invite = await timing.measure(
      'convex_invite_lookup',
      () => lookupInviteByToken(request, rawToken),
      'load invite by token'
    );
    const err = inviteErrorResponse(invite);
    if (err) return respond(() => err);
    if (!invite) return respond(() => Response.json({ error: 'not_found' }, { status: 404 }));

    const sessionId = generateToken();
    const ttlMs = Math.max(1, invite.expiresAt - Date.now());
    await timing.measure(
      'session_collab_store',
      () =>
        store.set(
          `${COLLAB_SESSION_PREFIX}${sessionId}`,
          JSON.stringify({ inviteId: invite._id }),
          ttlMs
        ),
      'store collaborator session'
    );

    return respond(() =>
      Response.json(
        {
          inviteId: invite._id,
          ownerDisplayName: invite.ownerDisplayName,
          ownerGuildId: invite.ownerGuildId,
          expiresAt: invite.expiresAt,
          providerKey: invite.providerKey,
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
      )
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
    const timing = new RouteTimingCollector();
    const respond = (
      buildResponse: () => Response,
      description = 'serialize collaborator response'
    ) => buildTimedResponse(timing, buildResponse, description);
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const oauthState = url.searchParams.get('state');

    if (!code || !oauthState) {
      return respond(
        () => new Response('Missing code or state', { status: 400 }),
        'prepare collaborator callback response'
      );
    }

    const rawOAuth = await timing.measure(
      'session_oauth_state',
      () => store.get(`${COLLAB_OAUTH_PREFIX}${oauthState}`),
      'load OAuth state'
    );
    if (!rawOAuth) {
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return respond(
        () => Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302),
        'prepare collaborator redirect'
      );
    }

    const { inviteId, sessionId } = JSON.parse(rawOAuth) as { inviteId: string; sessionId: string };
    await timing.measure(
      'session_oauth_state_delete',
      () => store.delete(`${COLLAB_OAUTH_PREFIX}${oauthState}`),
      'clear OAuth state'
    );

    const invite = await timing.measure(
      'convex_invite_lookup',
      () => lookupInviteById(request, inviteId),
      'load invite for callback'
    );
    const err = inviteErrorResponse(invite);
    if (err) {
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return respond(
        () => Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302),
        'prepare collaborator redirect'
      );
    }
    if (!invite) {
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return respond(
        () => Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302),
        'prepare collaborator redirect'
      );
    }

    // Exchange code for access token
    const redirectUri = `${config.apiBaseUrl}/api/collab/auth/callback`;
    let discordUserId: string;
    let discordUsername: string;
    let discordAvatarHash: string | null = null;

    try {
      const tokenRes = await timing.measure(
        'provider_discord_token',
        () =>
          fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: config.discordClientId,
              client_secret: config.discordClientSecret,
              grant_type: 'authorization_code',
              code,
              redirect_uri: redirectUri,
            }),
          }),
        'exchange Discord OAuth code'
      );

      if (!tokenRes.ok) {
        logger.warn('Discord OAuth token exchange failed', { status: tokenRes.status });
        const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
        return respond(
          () => Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302),
          'prepare collaborator redirect'
        );
      }

      const tokenData = (await tokenRes.json()) as { access_token: string };

      // Fetch Discord user identity
      const userRes = await timing.measure(
        'provider_discord_user',
        () =>
          fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          }),
        'fetch Discord user profile'
      );

      if (!userRes.ok) throw new Error('Failed to fetch Discord user');
      const user = (await userRes.json()) as {
        id: string;
        username: string;
        global_name?: string;
        avatar?: string | null;
      };
      discordUserId = user.id;
      discordUsername = user.global_name ?? user.username;

      // Validate avatar hash: Discord uses hex strings, optionally prefixed with
      // "a_" for animated GIFs. Never store arbitrary strings from external sources.
      const AVATAR_HASH_RE = /^(a_)?[0-9a-f]{32}$/;
      const rawAvatarHash = user.avatar ?? null;
      discordAvatarHash =
        rawAvatarHash && AVATAR_HASH_RE.test(rawAvatarHash) ? rawAvatarHash : null;
    } catch (oauthErr) {
      logger.error('Discord OAuth failed', { err: oauthErr });
      const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
      return respond(
        () => Response.redirect(`${frontendUrl}/collab-invite?auth=error`, 302),
        'prepare collaborator redirect'
      );
    }

    // Store Discord identity in state store, keyed by inviteId
    await timing.measure(
      'session_discord_store',
      () =>
        store.set(
          `${COLLAB_DISCORD_PREFIX}${invite._id}`,
          JSON.stringify({ discordUserId, discordUsername, avatarHash: discordAvatarHash }),
          COLLAB_DISCORD_TTL_MS
        ),
      'store Discord identity'
    );

    logger.info('Collab OAuth completed', {
      inviteId: invite._id,
      discordUserId,
    });

    const frontendUrl = config.frontendBaseUrl.replace(/\/$/, '');
    return respond(
      () =>
        new Response(null, {
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
        }),
      'prepare collaborator callback response'
    );
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
    const providerDescriptor = session.invite.providerKey
      ? getProviderDescriptor(session.invite.providerKey)
      : undefined;

    return Response.json({
      inviteId: session.invite._id,
      ownerDisplayName: session.invite.ownerDisplayName,
      ownerGuildId: session.invite.ownerGuildId,
      expiresAt: session.invite.expiresAt,
      providerKey: session.invite.providerKey,
      providerLabel: providerDescriptor?.label ?? session.invite.providerKey,
      collabCredentialLabel: providerDescriptor?.collabCredential?.label ?? 'Credential',
      collabCredentialPlaceholder:
        providerDescriptor?.collabCredential?.placeholder ??
        'Paste the credential you want to share',
      collabLinkModes: providerDescriptor?.collabLinkModes ?? ['api'],
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
        signingSecretEncrypted: await encrypt(
          webhookSecret,
          config.encryptionSecret,
          COLLAB_WEBHOOK_SECRET_PURPOSE
        ),
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
   * Body: { linkType, apiKey? (or legacy jinxxyApiKey?) }
   * Discord identity comes from the state store (OAuth result), NEVER from the client body.
   */
  async function submitInvite(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    const respond = (
      buildResponse: () => Response,
      description = 'serialize collaborator response'
    ) => buildTimedResponse(timing, buildResponse, description);
    if (request.method !== 'POST')
      return respond(() => Response.json({ error: 'Method not allowed' }, { status: 405 }));

    const session = await resolveSessionInvite(request, timing);
    if (!session) return respond(() => Response.json({ error: 'not_found' }, { status: 404 }));
    if (session.invite.expiresAt < Date.now()) {
      return respond(() => Response.json({ error: 'expired' }, { status: 410 }));
    }
    const err = inviteErrorResponse(session.invite);
    if (err) return respond(() => err);

    // Require OAuth to have been completed
    const rawDiscord = await timing.measure(
      'session_discord_state',
      () => store.get(`${COLLAB_DISCORD_PREFIX}${session.invite._id}`),
      'load Discord identity'
    );
    if (!rawDiscord) {
      return respond(() =>
        Response.json(
          { error: 'Discord authentication required. Please complete OAuth first.' },
          { status: 401 }
        )
      );
    }
    const { discordUserId, discordUsername, avatarHash } = JSON.parse(rawDiscord) as {
      discordUserId: string;
      discordUsername: string;
      avatarHash: string | null;
    };

    let body: {
      apiKey?: string;
      /** @deprecated use apiKey */
      jinxxyApiKey?: string;
      linkType?: 'account' | 'api';
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return respond(() => Response.json({ error: 'Invalid JSON' }, { status: 400 }));
    }

    const { linkType } = body;
    if (!linkType || !['account', 'api'].includes(linkType)) {
      return respond(() =>
        Response.json({ error: 'linkType must be account or api' }, { status: 400 })
      );
    }

    const rawApiKey = (body.apiKey ?? body.jinxxyApiKey)?.trim();
    if (!rawApiKey) {
      return respond(() => Response.json({ error: 'apiKey is required' }, { status: 400 }));
    }

    const inviteProviderKey = session.invite.providerKey;
    if (!inviteProviderKey) {
      return respond(() => Response.json({ error: 'missing_provider' }, { status: 400 }));
    }

    // Validate the API key against the correct provider
    let credentialEncrypted: string;
    const providerRuntime = getProviderRuntime(inviteProviderKey);
    if (!providerRuntime) {
      return respond(() => Response.json({ error: 'unsupported_provider' }, { status: 400 }));
    }
    const validateCollaboratorCredential = providerRuntime.collabValidate;
    if (validateCollaboratorCredential) {
      try {
        await timing.measure(
          'provider_collab_validate',
          () => validateCollaboratorCredential(rawApiKey),
          `validate ${inviteProviderKey} collaborator credential`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid API key';
        logger.warn('Collab credential validation failed', { inviteProviderKey, error: msg });
        return respond(() =>
          Response.json({ error: 'invalid_api_key', details: msg }, { status: 422 })
        );
      }
    }
    if (!providerRuntime.collabCredentialPurpose) {
      return respond(() => Response.json({ error: 'provider_not_configurable' }, { status: 400 }));
    }
    credentialEncrypted = await encrypt(
      rawApiKey,
      config.encryptionSecret,
      providerRuntime.collabCredentialPurpose
    );

    let webhookSecretRef: string | undefined;
    let webhookEndpoint: string | undefined;
    if (linkType === 'account') {
      const pendingWebhook = await timing.measure(
        'session_webhook_state',
        () => store.get(`${COLLAB_WEBHOOK_PREFIX}${session.invite._id}`),
        'load webhook configuration'
      );
      if (!pendingWebhook) {
        return respond(() =>
          Response.json(
            { error: 'Webhook setup is required before completing account linking.' },
            { status: 400 }
          )
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
      await timing.measure(
        'convex_collab_invite_accept',
        () =>
          convex.mutation(api.collaboratorInvites.acceptCollaboratorInvite, {
            apiSecret,
            inviteId: session.invite._id,
            credentialEncrypted,
            webhookSecretRef,
            webhookEndpoint,
            linkType,
            provider: inviteProviderKey,
            collaboratorDiscordUserId: discordUserId,
            collaboratorDisplayName: discordUsername,
            collaboratorAvatarHash: avatarHash ?? undefined,
          }),
        'accept collaborator invite'
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('Failed to accept collab invite', { err: msg });
      if (msg.includes('no longer pending') || msg.includes('expired')) {
        return respond(() => Response.json({ error: msg }, { status: 410 }));
      }
      return respond(() =>
        Response.json({ error: 'Failed to submit credentials' }, { status: 500 })
      );
    }

    await timing.measure(
      'session_collab_cleanup',
      async () => {
        await store.delete(`${COLLAB_DISCORD_PREFIX}${session.invite._id}`);
        await store.delete(`${COLLAB_WEBHOOK_PREFIX}${session.invite._id}`);
        await store.delete(`${COLLAB_TEST_PREFIX}${session.invite._id}`);
        await store.delete(`${COLLAB_SESSION_PREFIX}${session.sessionId}`);
      },
      'clear collaborator session state'
    );

    return respond(() =>
      Response.json(
        { success: true },
        { headers: { 'Set-Cookie': clearCookie(COLLAB_SESSION_COOKIE, request) } }
      )
    );
  }

  /**
   * GET /api/collab/connections - list owner's connections
   */
  async function listConnections(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    const respond = (
      buildResponse: () => Response,
      description = 'serialize collaborator response'
    ) => buildTimedResponse(timing, buildResponse, description);
    const url = new URL(request.url);
    const ownerAuth = await requireOwnerAuth(
      request,
      url.searchParams.get('authUserId') ?? undefined,
      timing
    );
    if (!ownerAuth.ok) return ownerAuth.response;

    const connections = await timing.measure(
      'convex_collab_connections',
      () =>
        convex.query(api.collaboratorInvites.listCollaboratorConnections, {
          apiSecret,
          ownerAuthUserId: ownerAuth.authUserId,
        }),
      'list collaborator connections'
    );

    // Construct Discord CDN avatar URLs server-side from the validated hash.
    // The client receives only the pre-built URL, never the raw hash.
    const AVATAR_HASH_RE = /^(a_)?[0-9a-f]{32}$/;
    const withAvatars = connections.map(
      (c: {
        collaboratorAvatarHash?: string | null;
        collaboratorDiscordUserId?: string;
        [key: string]: unknown;
      }) => {
        const hash = c.collaboratorAvatarHash;
        const avatarUrl =
          hash && AVATAR_HASH_RE.test(hash)
            ? `https://cdn.discordapp.com/avatars/${c.collaboratorDiscordUserId}/${hash}.webp?size=64`
            : null;
        const { collaboratorAvatarHash: _drop, ...rest } = c;
        return { ...rest, avatarUrl };
      }
    );

    return respond(() => Response.json({ connections: withAvatars }));
  }

  /**
   * POST /api/collab/connections/manual
   * Manually add a collaborator by API key (no invite). Identity from provider API.
   * Body: { providerKey: string, credential: string, serverName?: string }
   */
  async function addConnectionManual(request: Request): Promise<Response> {
    if (request.method !== 'POST')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });

    const session = await resolveSetupToken(request, config.encryptionSecret);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    let body: { providerKey?: string; credential?: string; serverName?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const providerKey = body.providerKey?.trim();
    if (!providerKey) {
      return Response.json({ error: 'providerKey is required' }, { status: 400 });
    }

    const providerDescriptor = getProviderDescriptor(providerKey);
    if (!isCollaboratorShareableProvider(providerDescriptor)) {
      return Response.json(
        { error: `Provider '${providerKey}' does not support manual collaborator connections` },
        { status: 400 }
      );
    }

    const rawCredential = body.credential?.trim();
    if (!rawCredential) {
      return Response.json({ error: 'credential is required' }, { status: 400 });
    }

    let collaboratorDisplayName: string;
    let collaboratorIdentity: string;
    let credentialEncrypted: string;

    const providerRuntime = getProviderRuntime(providerKey);
    if (!providerRuntime) {
      return Response.json({ error: 'unsupported_provider' }, { status: 400 });
    }
    if (providerRuntime.collabValidate) {
      try {
        await providerRuntime.collabValidate(rawCredential);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid credential';
        logger.warn('Manual collab credential validation failed', { providerKey, error: msg });
        return Response.json({ error: 'invalid_credential', details: msg }, { status: 422 });
      }
    }
    if (!providerRuntime.collabCredentialPurpose) {
      return Response.json({ error: 'provider_not_configurable' }, { status: 400 });
    }
    credentialEncrypted = await encrypt(
      rawCredential,
      config.encryptionSecret,
      providerRuntime.collabCredentialPurpose
    );
    collaboratorDisplayName = providerKey;
    collaboratorIdentity = `manual:${providerKey}:${Date.now()}`;

    let connectionId: string;
    try {
      connectionId = await convex.mutation(
        api.collaboratorInvites.addCollaboratorConnectionManual,
        {
          apiSecret,
          ownerAuthUserId: session.authUserId,
          credentialEncrypted,
          provider: providerKey,
          collaboratorDisplayName,
          collaboratorIdentity,
          addedByDiscordUserId: session.discordUserId,
        }
      );
    } catch (e) {
      logger.error('Failed to add collab connection manually', { err: e });
      return Response.json({ error: 'Failed to add connection' }, { status: 500 });
    }

    return Response.json({
      success: true,
      connectionId,
      displayName: collaboratorDisplayName,
    });
  }

  /**
   * DELETE /api/collab/connections/:id - remove a connection
   */
  async function removeConnection(request: Request, connectionId: string): Promise<Response> {
    const timing = new RouteTimingCollector();
    const respond = (
      buildResponse: () => Response,
      description = 'serialize collaborator response'
    ) => buildTimedResponse(timing, buildResponse, description);
    if (request.method !== 'DELETE')
      return respond(() => Response.json({ error: 'Method not allowed' }, { status: 405 }));

    const url = new URL(request.url);
    const ownerAuth = await requireOwnerAuth(
      request,
      url.searchParams.get('authUserId') ?? undefined,
      timing
    );
    if (!ownerAuth.ok) return ownerAuth.response;

    try {
      await timing.measure(
        'convex_collab_connection_remove',
        () =>
          convex.mutation(api.collaboratorInvites.removeCollaboratorConnection, {
            apiSecret,
            connectionId,
            ownerAuthUserId: ownerAuth.authUserId,
          }),
        'remove collaborator connection'
      );
    } catch (e) {
      return respond(() =>
        Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
      );
    }
    return respond(() => Response.json({ success: true }));
  }

  // ── Dispatcher ─────────────────────────────────────────────────────────────

  /**
   * GET /api/collab/providers, public list of providers that support collab invites.
   * No auth required, this is metadata only.
   */
  function listCollabProviders(): Response {
    const providers = (PROVIDER_REGISTRY as ReadonlyArray<(typeof PROVIDER_REGISTRY)[number]>)
      .filter((provider) => isCollaboratorShareableProvider(provider))
      .map((provider) => ({
        key: provider.providerKey,
        label: provider.label,
        collabCredentialLabel: provider.collabCredential.label,
        collabCredentialPlaceholder: provider.collabCredential.placeholder,
        collabLinkModes: provider.collabLinkModes ?? ['api'],
      }));
    return Response.json({ providers });
  }

  /**
   * GET /api/collab/invites, list pending invites created by this owner.
   */
  async function listInvites(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ownerAuth = await requireOwnerAuth(
      request,
      url.searchParams.get('authUserId') ?? undefined
    );
    if (!ownerAuth.ok) return ownerAuth.response;

    const invites = await convex.query(api.collaboratorInvites.listPendingInvitesByOwner, {
      apiSecret,
      ownerAuthUserId: ownerAuth.authUserId,
    });
    return Response.json({ invites });
  }

  /**
   * GET /api/collab/connections/as-collaborator, list stores this user is a collaborator for.
   */
  async function listConnectionsAsCollaborator(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ownerAuth = await requireOwnerAuth(
      request,
      url.searchParams.get('authUserId') ?? undefined
    );
    if (!ownerAuth.ok) return ownerAuth.response;

    const connections = await convex.query(api.collaboratorInvites.listConnectionsAsCollaborator, {
      apiSecret,
      authUserId: ownerAuth.authUserId,
    });
    return Response.json({ connections });
  }

  /**
   * DELETE /api/collab/invites/:id, revoke a pending invite.
   */
  async function revokeInvite(request: Request, inviteId: string): Promise<Response> {
    if (request.method !== 'DELETE')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });

    const url = new URL(request.url);
    const ownerAuth = await requireOwnerAuth(
      request,
      url.searchParams.get('authUserId') ?? undefined
    );
    if (!ownerAuth.ok) return ownerAuth.response;

    try {
      await convex.mutation(api.collaboratorInvites.revokeCollaboratorInvite, {
        apiSecret,
        // biome-ignore lint/suspicious/noExplicitAny: Convex ID coercion from URL param string
        inviteId: inviteId as any,
        ownerAuthUserId: ownerAuth.authUserId,
      });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    return Response.json({ success: true });
  }

  async function handleCollabRequest(request: Request): Promise<Response> {
    try {
      return await dispatchCollabRequest(request);
    } catch (err) {
      logger.error('Unhandled collab route error', {
        error: err instanceof Error ? err.message : String(err),
        url: request.url,
      });
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  }

  async function dispatchCollabRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/api/collab/providers' && request.method === 'GET')
      return listCollabProviders();
    if (pathname === '/api/collab/invites' && request.method === 'GET') return listInvites(request);
    if (pathname === '/api/collab/invite') return createInvite(request);
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
    if (pathname === '/api/collab/connections/as-collaborator' && request.method === 'GET')
      return listConnectionsAsCollaborator(request);
    if (pathname === '/api/collab/connections/manual' && request.method === 'POST')
      return addConnectionManual(request);

    const connDeleteMatch = pathname.match(/^\/api\/collab\/connections\/([^/]+)$/);
    if (connDeleteMatch && request.method === 'DELETE')
      return removeConnection(request, connDeleteMatch[1]);

    const inviteDeleteMatch = pathname.match(/^\/api\/collab\/invites\/([^/]+)$/);
    if (inviteDeleteMatch && request.method === 'DELETE')
      return revokeInvite(request, inviteDeleteMatch[1]);

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  return { handleCollabRequest };
}
