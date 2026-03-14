/**
 * Gumroad Connect Plugin
 *
 * Handles the OAuth 2.0 authorisation code flow:
 *   GET  /api/connect/gumroad/begin     — builds the Gumroad authorisation URL
 *   GET  /api/connect/gumroad/callback  — exchanges the code, stores tokens + registers webhooks
 */

import { createLogger } from '@yucp/shared';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { encrypt } from '../../lib/encrypt';
import { getStateStore } from '../../lib/stateStore';
import type { ConnectContext, ConnectPlugin, ConnectRoute } from '../types';
import { generateSecureRandom } from '../types';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info');

// HKDF purpose strings — inlined to avoid circular imports with index.ts
const CREDENTIAL_PURPOSE = 'gumroad-oauth-access-token' as const;
const REFRESH_TOKEN_PURPOSE = 'gumroad-oauth-refresh-token' as const;

const GUMROAD_STATE_PREFIX = 'connect_gumroad:';
const GUMROAD_STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// ──────────────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/connect/gumroad/begin?authUserId=XXX&guildId=XXX
 * Redirects to the Gumroad OAuth authorisation page.
 */
async function gumroadBegin(request: Request, ctx: ConnectContext): Promise<Response> {
  const { config } = ctx;
  const url = new URL(request.url);
  let authUserId = url.searchParams.get('authUserId');
  let guildId = url.searchParams.get('guildId');

  const setupBinding = await ctx.requireBoundSetupSession(request);
  const setupSession = setupBinding.ok ? setupBinding.setupSession : null;
  const session = setupBinding.ok ? setupBinding.authSession : await ctx.auth.getSession(request);
  const authenticatedViaSetupToken = Boolean(setupSession);
  if (setupSession) {
    authUserId = authUserId || setupSession.authUserId;
    guildId = guildId || setupSession.guildId;
  }

  if (!session && !authenticatedViaSetupToken) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  if (!setupBinding.ok && setupSession === null) {
    // A setup token header was present but failed validation — reject.
    const hasToken = ctx.getSetupSessionTokenFromRequest(request);
    if (hasToken) return setupBinding.response;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = config as any;
  if (!cfg.gumroadClientId || !cfg.gumroadClientSecret) {
    return Response.json({ error: 'Gumroad OAuth not configured' }, { status: 400 });
  }

  // If a authUserId is provided, verify ownership.
  if (authUserId && !authenticatedViaSetupToken && session) {
    const tenantOwned = await ctx.isTenantOwnedBySessionUser(session.user.id, authUserId);
    if (!tenantOwned) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  authUserId = session?.user?.id ?? null;

  const state = `connect_gumroad:${authUserId ?? 'personal'}:${generateSecureRandom(48)}`;
  const store = getStateStore();
  await store.set(
    `${GUMROAD_STATE_PREFIX}${state}`,
    JSON.stringify({
      authUserId: authUserId ?? null,
      guildId: guildId ?? null,
      setupToken: ctx.getSetupSessionTokenFromRequest(request) ?? '',
    }),
    GUMROAD_STATE_EXPIRY_MS,
  );

  const authUrl = new URL('https://gumroad.com/oauth/authorize');
  authUrl.searchParams.set('client_id', cfg.gumroadClientId);
  authUrl.searchParams.set('redirect_uri', `${config.apiBaseUrl}/api/connect/gumroad/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'view_profile view_sales');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

/**
 * GET /api/connect/gumroad/callback?code=XXX&state=XXX
 * Exchanges the authorisation code for tokens, stores them in Convex, and
 * registers `sale` + `refund` resource_subscriptions for webhook delivery.
 */
async function gumroadCallback(request: Request, ctx: ConnectContext): Promise<Response> {
  const { config } = ctx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = config as any;

  const buildDashboardRedirect = (
    params: Record<string, string | undefined>,
    setupToken?: string,
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
    authUserId,
    guildId,
    setupToken: storedSetupToken,
  } = JSON.parse(raw) as {
    authUserId: string | null;
    guildId: string | null;
    setupToken?: string;
  };
  const gumroadClientId = cfg.gumroadClientId;
  const gumroadClientSecret = cfg.gumroadClientSecret;

  try {
    if (!gumroadClientId || !gumroadClientSecret) {
      return Response.redirect(
        buildDashboardRedirect(
          {
            ...(authUserId ? { tenant_id: authUserId } : {}),
            ...(guildId ? { guild_id: guildId } : {}),
            error: 'gumroad_not_configured',
          },
          storedSetupToken,
        ),
        302,
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
          {
            ...(authUserId ? { tenant_id: authUserId } : {}),
            ...(guildId ? { guild_id: guildId } : {}),
            error: 'token_exchange_failed',
          },
          storedSetupToken,
        ),
        302,
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
          {
            ...(authUserId ? { tenant_id: authUserId } : {}),
            ...(guildId ? { guild_id: guildId } : {}),
            error: 'no_access_token',
          },
          storedSetupToken,
        ),
        302,
      );
    }

    const meRes = await fetch(
      `https://api.gumroad.com/v2/user?access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!meRes.ok) {
      return Response.redirect(
        buildDashboardRedirect(
          {
            ...(authUserId ? { tenant_id: authUserId } : {}),
            ...(guildId ? { guild_id: guildId } : {}),
            error: 'failed_to_fetch_user',
          },
          storedSetupToken,
        ),
        302,
      );
    }
    const me = (await meRes.json()) as {
      success?: boolean;
      user?: { user_id?: string; name?: string; email?: string };
    };
    const gumroadUserId = me.user?.user_id ?? '';

    const accessEncrypted = await encrypt(accessToken, config.encryptionSecret, CREDENTIAL_PURPOSE);
    const refreshEncrypted = refreshToken
      ? await encrypt(refreshToken, config.encryptionSecret, REFRESH_TOKEN_PURPOSE)
      : undefined;

    const convex = getConvexClientFromUrl(config.convexUrl);

    // Clean up any stale resource_subscriptions pointing at our webhook base URL.
    const webhookBase = `${config.apiBaseUrl.replace(/\/$/, '')}/webhooks/gumroad/`;
    try {
      const listRes = await fetch(
        `https://api.gumroad.com/v2/resource_subscriptions?access_token=${encodeURIComponent(accessToken)}`,
      );
      if (listRes.ok) {
        const listData = (await listRes.json()) as {
          success: boolean;
          resource_subscriptions?: Array<{ id: string; resource_name: string; post_url: string }>;
        };
        for (const sub of listData.resource_subscriptions ?? []) {
          if (sub.post_url.startsWith(webhookBase)) {
            await fetch(
              `https://api.gumroad.com/v2/resource_subscriptions/${sub.id}?access_token=${encodeURIComponent(accessToken)}`,
              { method: 'DELETE' },
            );
            logger.info('Gumroad: deleted stale resource_subscription', {
              id: sub.id,
              post_url: sub.post_url,
            });
          }
        }
      }
    } catch (cleanupErr) {
      logger.warn('Gumroad: failed to clean up old resource_subscriptions', {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }

    const webhookTarget = authUserId;
    const postUrl = `${webhookBase}${webhookTarget}`;
    const resourceSubscriptionIds: string[] = [];
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
        if (subRes.ok) {
          const subData = (await subRes.json()) as {
            success: boolean;
            resource_subscription?: { id: string };
          };
          if (subData.success && subData.resource_subscription?.id) {
            resourceSubscriptionIds.push(subData.resource_subscription.id);
            logger.info('Gumroad: registered resource_subscription', {
              resourceName,
              id: subData.resource_subscription.id,
              webhookTarget,
            });
          }
        } else {
          const errText = await subRes.text();
          logger.warn('Gumroad resource_subscription failed', {
            resourceName,
            status: subRes.status,
            body: errText,
            webhookTarget,
          });
        }
      } catch (subErr) {
        logger.warn('Gumroad resource_subscription error', {
          resourceName,
          error: subErr instanceof Error ? subErr.message : String(subErr),
          webhookTarget,
        });
      }
    }

    await convex.mutation(api.providerConnections.upsertGumroadConnection, {
      apiSecret: config.convexApiSecret,
      authUserId: authUserId ?? undefined,
      gumroadAccessTokenEncrypted: accessEncrypted,
      gumroadRefreshTokenEncrypted: refreshEncrypted,
      gumroadUserId,
      resourceSubscriptionIds,
    });

    const redirectParams: Record<string, string> = { gumroad: 'connected' };
    if (guildId) redirectParams.guild_id = guildId;
    if (authUserId) redirectParams.tenant_id = authUserId;
    return Response.redirect(buildDashboardRedirect(redirectParams, storedSetupToken), 302);
  } catch (err) {
    logger.error('Gumroad callback failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.redirect(
      buildDashboardRedirect(
        {
          ...(authUserId ? { tenant_id: authUserId } : {}),
          ...(guildId ? { guild_id: guildId } : {}),
          error: 'internal_error',
        },
        storedSetupToken,
      ),
      302,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Plugin declaration
// ──────────────────────────────────────────────────────────────────────────────

const routes: ReadonlyArray<ConnectRoute> = [
  { method: 'GET', path: '/api/connect/gumroad/begin', handler: gumroadBegin },
  { method: 'GET', path: '/api/connect/gumroad/callback', handler: gumroadCallback },
];

export const connect: ConnectPlugin = {
  providerId: 'gumroad',
  routes,
};
