/**
 * VRChat Connect Plugin
 *
 * Handles the creator VRChat login flow (session-based, not OAuth):
 *   GET  /api/connect/vrchat/begin   — validates setup session, creates state token,
 *                                      redirects to /setup/vrchat?token=TOKEN&mode=connect
 *   POST /api/connect/vrchat/session — validates token, calls VrchatApiClient.beginLogin(),
 *                                      handles 2FA, encrypts session, stores in Convex
 *
 * Reuses the TanStack `/setup/vrchat` flow with `mode=connect`.
 * Separate cookie/path from the buyer flow, and never touches vrchatPending.ts.
 */

import { VrchatApiClient } from '@yucp/providers/vrchat';
import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { encrypt } from '../../lib/encrypt';
import { getStateStore } from '../../lib/stateStore';
import type { ConnectContext, ConnectPlugin, ConnectRoute } from '../types';
import {
  appendClearedConnectPendingCookie,
  clearConnectPendingState,
  createConnectPendingState,
  readConnectPendingState,
} from './pending';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

const CONNECT_TOKEN_PREFIX = 'vrchat_connect:';
const CONNECT_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * HKDF purpose for encrypting the VRChat creator session before storing in Convex.
 * Domain-separated from the buyer session ('vrchat-provider-session').
 */
const SESSION_PURPOSE = 'vrchat-creator-session' as const;

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/connect/vrchat/begin
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Entry point for the creator VRChat connect flow.
 * Requires a valid bound setup session (same guard as all other connect flows).
 * Creates a short-lived state token, stores {authUserId} under it, and redirects
 * to the TanStack VRChat setup route with mode=connect.
 */
async function handleVrchatConnectBegin(request: Request, ctx: ConnectContext): Promise<Response> {
  const binding = await ctx.requireBoundSetupSession(request);

  let authUserId: string;
  if (binding.ok) {
    authUserId = binding.setupSession.authUserId;
  } else {
    // If a setup session token was present but failed validation, reject it.
    // If no token was present at all (dashboard flow), fall back to the auth session.
    if (ctx.getSetupSessionTokenFromRequest(request)) {
      return binding.response;
    }
    const authSession = await ctx.auth.getSession(request);
    if (!authSession) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    authUserId = authSession.user.id;
  }
  const url = new URL(request.url);
  const guildId = url.searchParams.get('guildId') ?? url.searchParams.get('guild_id') ?? '';
  const tenantId = url.searchParams.get('tenantId') ?? url.searchParams.get('tenant_id') ?? '';

  const token = crypto.randomUUID();
  const store = getStateStore();
  await store.set(
    `${CONNECT_TOKEN_PREFIX}${token}`,
    JSON.stringify({ authUserId }),
    CONNECT_TOKEN_TTL_MS
  );

  // The setup page handles the mode=connect variant and returns to the correct dashboard context.
  const redirectUrl = new URL('/setup/vrchat', `${ctx.config.frontendBaseUrl.replace(/\/$/, '')}/`);
  redirectUrl.searchParams.set('token', token);
  redirectUrl.searchParams.set('mode', 'connect');
  if (guildId) redirectUrl.searchParams.set('guild_id', guildId);
  if (tenantId) redirectUrl.searchParams.set('tenant_id', tenantId);
  return Response.redirect(redirectUrl.toString(), 302);
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/connect/vrchat/session
// ──────────────────────────────────────────────────────────────────────────────

interface SessionBody {
  token?: string;
  username?: string;
  password?: string;
  twoFactorCode?: string;
}

/**
 * Called by the TanStack `/setup/vrchat` route (mode=connect) after the creator enters credentials.
 *
 * Flow:
 * 1. Validate connect token from body → get authUserId
 * 2a. First call (username+password): beginLogin() → if 2FA needed return needsTwoFactor
 * 2b. 2FA call (twoFactorCode): completePendingLogin() using cookie-stored pending state
 * 3. Encrypt session, call upsertVrchatConnection, clear state, return success
 */
async function handleVrchatConnectSession(
  request: Request,
  ctx: ConnectContext
): Promise<Response> {
  const store = getStateStore();
  const responseHeaders = new Headers();

  let body: SessionBody;
  try {
    body = (await request.json()) as SessionBody;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { token, username, password, twoFactorCode } = body;

  // Resolve authUserId from the connect token (or from the pending 2FA state on retry)
  let authUserId: string | null = null;
  if (token) {
    const tokenRaw = await store.get(`${CONNECT_TOKEN_PREFIX}${token}`);
    if (tokenRaw) {
      const parsed = JSON.parse(tokenRaw) as { authUserId?: string };
      authUserId = parsed.authUserId ?? null;
    }
  }

  if (!authUserId) {
    // May be a 2FA completion where the connect token has already been consumed
    const pending = await readConnectPendingState(store, request);
    if (pending) {
      authUserId = pending.state.authUserId;
    }
  }

  if (!authUserId) {
    const authSession = await ctx.auth.getSession(request);
    authUserId = authSession?.user?.id ?? null;
  }

  if (!authUserId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const client = new VrchatApiClient();

  try {
    // ── 2FA completion ──────────────────────────────────────────────────────
    if (twoFactorCode) {
      const pending = await readConnectPendingState(store, request);
      if (!pending) {
        return Response.json(
          {
            success: false,
            error: 'Two-factor session expired',
            needsCredentials: true,
            sessionExpired: true,
          },
          { status: 200 }
        );
      }
      const { user, session } = await client.completePendingLogin(
        pending.state.pendingState,
        twoFactorCode
      );
      logger.info('[vrchat-connect] 2FA complete', {
        authUserId,
        vrchatUserId: user.id,
      });
      await finishConnect(authUserId, session.authToken, session.twoFactorAuthToken, ctx);
      await clearConnectPendingState(store, request, responseHeaders);
      if (token) {
        await store.delete(`${CONNECT_TOKEN_PREFIX}${token}`);
      }
      return Response.json({ success: true }, { headers: responseHeaders });
    }

    // ── Initial login ───────────────────────────────────────────────────────
    if (!username || !password) {
      return Response.json({ error: 'username and password are required' }, { status: 400 });
    }

    const result = await client.beginLogin(username, password);

    if (!result.success) {
      // 2FA required: persist pending state in a short-lived cookie
      const pendingCookie = await createConnectPendingState(store, request, {
        authUserId,
        pendingState: result.pendingState,
        types: result.requiresTwoFactorAuth,
      });
      responseHeaders.append('Set-Cookie', pendingCookie);
      return Response.json(
        { twoFactorRequired: true, types: result.requiresTwoFactorAuth },
        { status: 200, headers: responseHeaders }
      );
    }

    // Login succeeded without 2FA
    logger.info('[vrchat-connect] login complete (no 2FA)', {
      authUserId,
      vrchatUserId: result.user.id,
    });
    await finishConnect(
      authUserId,
      result.session.authToken,
      result.session.twoFactorAuthToken,
      ctx
    );
    if (token) {
      await store.delete(`${CONNECT_TOKEN_PREFIX}${token}`);
    }
    return Response.json({ success: true }, { headers: responseHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[vrchat-connect] login failed', { authUserId, error: message });

    if (message.includes('missing auth cookie') || message.includes('Verification failed')) {
      appendClearedConnectPendingCookie(responseHeaders, request);
      return Response.json(
        {
          success: false,
          error: 'Invalid VRChat credentials',
          needsCredentials: true,
        },
        { status: 200, headers: responseHeaders }
      );
    }

    return Response.json({ error: 'VRChat login failed' }, { status: 500 });
  }
}

/**
 * Encrypt the VRChat session and store it in Convex.
 * Token values are NEVER logged per security policy.
 */
async function finishConnect(
  authUserId: string,
  authToken: string,
  twoFactorAuthToken: string | undefined,
  ctx: ConnectContext
): Promise<void> {
  const sessionJson = JSON.stringify({ authToken, twoFactorAuthToken });
  const encrypted = await encrypt(sessionJson, ctx.config.encryptionSecret, SESSION_PURPOSE);

  const convex = getConvexClientFromUrl(ctx.config.convexUrl);
  await convex.mutation(api.providerConnections.upsertProviderConnection, {
    apiSecret: ctx.config.convexApiSecret,
    authUserId,
    providerKey: 'vrchat',
    authMode: 'session',
    credentials: [
      { credentialKey: 'vrchat_session', kind: 'api_token', encryptedValue: encrypted },
    ],
    capabilities: [
      {
        capabilityKey: 'catalog_sync',
        status: 'configured',
        requiredCredentialKeys: ['vrchat_session'],
      },
    ],
  });

  logger.info('[vrchat-connect] session stored (token values redacted)', { authUserId });
}

// ──────────────────────────────────────────────────────────────────────────────
// Plugin declaration
// ──────────────────────────────────────────────────────────────────────────────

const routes: ReadonlyArray<ConnectRoute> = [
  { method: 'GET', path: '/api/connect/vrchat/begin', handler: handleVrchatConnectBegin },
  { method: 'POST', path: '/api/connect/vrchat/session', handler: handleVrchatConnectSession },
];

export const vrchatConnect: ConnectPlugin = {
  providerId: 'vrchat',
  routes,
};
