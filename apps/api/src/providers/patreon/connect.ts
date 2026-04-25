/**
 * Patreon Connect Plugin
 *
 * Handles the Patreon OAuth 2.0 authorization code flow:
 *   GET /api/connect/patreon/begin
 *   GET /api/connect/patreon/callback
 */

import { PATREON_PURPOSES } from '@yucp/providers/patreon/module';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { encrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import { getStateStore } from '../../lib/stateStore';
import { createVerificationRoutes } from '../../verification/sessionManager';
import type { ConnectContext, ConnectPlugin, ConnectRoute } from '../types';
import { generateSecureRandom } from '../types';
import {
  isPatreonConnectState,
  PATREON_CONNECT_STATE_PREFIX,
  PATREON_SHARED_CALLBACK_PATH,
  toPatreonVerificationConfig,
} from './oauth';

const PATREON_STATE_EXPIRY_MS = 10 * 60 * 1000;
const PATREON_SCOPES = ['campaigns'].join(' ');
const DEFAULT_PATREON_FETCH_TIMEOUT_MS = 10_000;

function getPatreonFetchTimeoutMs(): number {
  const rawValue = process.env.PATREON_CONNECT_FETCH_TIMEOUT_MS;
  if (!rawValue) {
    return DEFAULT_PATREON_FETCH_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PATREON_FETCH_TIMEOUT_MS;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = getPatreonFetchTimeoutMs()
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Patreon request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildDashboardRedirect(
  config: ConnectContext['config'],
  params: Record<string, string | undefined>,
  setupToken?: string
): string {
  const redirectUrl = new URL(`${config.frontendBaseUrl.replace(/\/$/, '')}/dashboard`);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      redirectUrl.searchParams.set(key, value);
    }
  }
  if (setupToken) {
    redirectUrl.hash = `s=${encodeURIComponent(setupToken)}`;
  }
  return redirectUrl.toString();
}

async function patreonBegin(request: Request, ctx: ConnectContext): Promise<Response> {
  const { config } = ctx;
  const url = new URL(request.url);
  let authUserId = url.searchParams.get('authUserId');
  let guildId = url.searchParams.get('guildId');

  const setupBinding = await ctx.requireBoundSetupSession(request);
  if (!setupBinding.ok && ctx.getSetupSessionTokenFromRequest(request)) {
    return setupBinding.response;
  }
  const setupSession = setupBinding.ok ? setupBinding.setupSession : null;
  const session = setupSession ? null : await ctx.auth.getSession(request);
  const authenticatedViaSetupToken = Boolean(setupSession);

  if (setupSession) {
    authUserId = authUserId || setupSession.authUserId;
    guildId = guildId || setupSession.guildId;
  }

  if (!session && !authenticatedViaSetupToken) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  if (!config.patreonClientId || !config.patreonClientSecret) {
    return Response.json({ error: 'Patreon OAuth not configured' }, { status: 400 });
  }
  if (authUserId && !authenticatedViaSetupToken && session) {
    const tenantOwned = await ctx.isTenantOwnedBySessionUser(session.user.id, authUserId);
    if (!tenantOwned) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  authUserId = authUserId ?? session?.user?.id ?? null;

  const state = `${PATREON_CONNECT_STATE_PREFIX}${authUserId ?? 'personal'}:${generateSecureRandom(48)}`;
  await getStateStore().set(
    `${PATREON_CONNECT_STATE_PREFIX}${state}`,
    JSON.stringify({
      authUserId: authUserId ?? null,
      guildId: guildId ?? null,
      setupToken: ctx.getSetupSessionTokenFromRequest(request) ?? '',
    }),
    PATREON_STATE_EXPIRY_MS
  );

  // Patreon OAuth authorize endpoint:
  // https://docs.patreon.com/#step-2-making-the-log-in-button
  const authUrl = new URL('https://www.patreon.com/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.patreonClientId);
  authUrl.searchParams.set(
    'redirect_uri',
    `${config.apiBaseUrl.replace(/\/$/, '')}${PATREON_SHARED_CALLBACK_PATH}`
  );
  authUrl.searchParams.set('scope', PATREON_SCOPES);
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

async function patreonCallback(request: Request, ctx: ConnectContext): Promise<Response> {
  const { config } = ctx;
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (state && !isPatreonConnectState(state)) {
    const delegatedUrl = new URL(request.url);
    delegatedUrl.pathname = '/api/verification/callback/patreon';
    return createVerificationRoutes(toPatreonVerificationConfig(config)).handleVerificationCallback(
      new Request(delegatedUrl.toString(), request)
    );
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    logger.error('Patreon OAuth error', { error });
    return Response.redirect(buildDashboardRedirect(config, { error }), 302);
  }
  if (!code || !state) {
    return Response.redirect(buildDashboardRedirect(config, { error: 'missing_parameters' }), 302);
  }
  if (!config.patreonClientId || !config.patreonClientSecret) {
    return Response.redirect(
      buildDashboardRedirect(config, { error: 'patreon_not_configured' }),
      302
    );
  }

  const store = getStateStore();
  const raw = await store.get(`${PATREON_CONNECT_STATE_PREFIX}${state}`);
  if (!raw) {
    return Response.redirect(buildDashboardRedirect(config, { error: 'invalid_state' }), 302);
  }
  await store.delete(`${PATREON_CONNECT_STATE_PREFIX}${state}`);

  const {
    authUserId,
    guildId,
    setupToken: storedSetupToken,
  } = JSON.parse(raw) as {
    authUserId: string | null;
    guildId: string | null;
    setupToken?: string;
  };

  try {
    // Patreon OAuth token exchange:
    // https://docs.patreon.com/#step-4-validating-receipt-of-the-oauth-token
    const tokenRes = await fetchWithTimeout('https://www.patreon.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: config.patreonClientId,
        client_secret: config.patreonClientSecret,
        redirect_uri: `${config.apiBaseUrl.replace(/\/$/, '')}${PATREON_SHARED_CALLBACK_PATH}`,
      }).toString(),
    });

    if (!tokenRes.ok) {
      logger.error('Patreon token exchange failed', {
        status: tokenRes.status,
        body: await tokenRes.text(),
      });
      return Response.redirect(
        buildDashboardRedirect(
          config,
          {
            ...(authUserId ? { tenant_id: authUserId } : {}),
            ...(guildId ? { guild_id: guildId } : {}),
            error: 'token_exchange_failed',
          },
          storedSetupToken
        ),
        302
      );
    }

    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    // Patreon documents the OAuth token response fields used here, including
    // `access_token`, `refresh_token`, `expires_in`, `scope`, and `token_type`:
    // https://docs.patreon.com/#step-4-validating-receipt-of-the-oauth-token
    const accessToken = tokens.access_token;
    if (!accessToken || !authUserId) {
      return Response.redirect(
        buildDashboardRedirect(
          config,
          {
            ...(authUserId ? { tenant_id: authUserId } : {}),
            ...(guildId ? { guild_id: guildId } : {}),
            error: !authUserId ? 'missing_auth_user' : 'no_access_token',
          },
          storedSetupToken
        ),
        302
      );
    }

    // Patreon creator campaign listing:
    // https://docs.patreon.com/#get-api-oauth2-v2-campaigns
    const campaignsUrl = new URL('https://www.patreon.com/api/oauth2/v2/campaigns');
    campaignsUrl.searchParams.set('fields[campaign]', 'creation_name,url');
    const campaignsRes = await fetchWithTimeout(campaignsUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!campaignsRes.ok) {
      logger.error('Patreon campaign fetch failed', {
        status: campaignsRes.status,
        body: await campaignsRes.text(),
      });
      return Response.redirect(
        buildDashboardRedirect(
          config,
          {
            tenant_id: authUserId,
            ...(guildId ? { guild_id: guildId } : {}),
            error: 'failed_to_fetch_campaigns',
          },
          storedSetupToken
        ),
        302
      );
    }

    // Patreon campaign collection responses return `data[]` campaign resources with the
    // requested `creation_name` and `url` attributes read below:
    // https://docs.patreon.com/#get-api-oauth2-v2-campaigns
    const campaignsPayload = (await campaignsRes.json()) as {
      data?: Array<{
        id: string;
        attributes?: {
          creation_name?: string | null;
          url?: string | null;
        };
      }>;
    };
    const primaryCampaign = campaignsPayload.data?.[0];
    if (!primaryCampaign) {
      return Response.redirect(
        buildDashboardRedirect(
          config,
          {
            tenant_id: authUserId,
            ...(guildId ? { guild_id: guildId } : {}),
            error: 'no_campaigns_found',
          },
          storedSetupToken
        ),
        302
      );
    }

    const encryptedAccessToken = await encrypt(
      accessToken,
      config.encryptionSecret,
      PATREON_PURPOSES.credential
    );
    const encryptedRefreshToken = tokens.refresh_token
      ? await encrypt(tokens.refresh_token, config.encryptionSecret, PATREON_PURPOSES.refreshToken)
      : null;

    const convex = getConvexClientFromUrl(config.convexUrl);
    await convex.mutation(api.providerConnections.upsertProviderConnection, {
      apiSecret: config.convexApiSecret,
      authUserId,
      providerKey: 'patreon',
      authMode: 'oauth',
      externalShopId: primaryCampaign.id,
      externalShopName: primaryCampaign.attributes?.creation_name?.trim() || 'Patreon Campaign',
      credentials: [
        {
          credentialKey: 'oauth_access_token',
          kind: 'oauth_access_token',
          encryptedValue: encryptedAccessToken,
        },
        ...(encryptedRefreshToken
          ? [
              {
                credentialKey: 'oauth_refresh_token',
                kind: 'oauth_refresh_token' as const,
                encryptedValue: encryptedRefreshToken,
              },
            ]
          : []),
      ],
      capabilities: [
        {
          capabilityKey: 'catalog_sync',
          status: 'active',
          requiredCredentialKeys: ['oauth_access_token'],
        },
        {
          capabilityKey: 'tier_catalog',
          status: 'active',
          requiredCredentialKeys: ['oauth_access_token'],
        },
      ],
    });

    return Response.redirect(
      buildDashboardRedirect(
        config,
        {
          tenant_id: authUserId,
          ...(guildId ? { guild_id: guildId } : {}),
          provider: 'patreon',
          connected: '1',
        },
        storedSetupToken
      ),
      302
    );
  } catch (err) {
    logger.error('Patreon callback failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.redirect(
      buildDashboardRedirect(
        config,
        {
          ...(authUserId ? { tenant_id: authUserId } : {}),
          ...(guildId ? { guild_id: guildId } : {}),
          error: 'patreon_connect_failed',
        },
        storedSetupToken
      ),
      302
    );
  }
}

const routes: ReadonlyArray<ConnectRoute> = [
  { method: 'GET', path: '/api/connect/patreon/begin', handler: patreonBegin },
  { method: 'GET', path: '/api/connect/patreon/callback', handler: patreonCallback },
];

export const connect: ConnectPlugin = {
  providerId: 'patreon',
  routes,
};
