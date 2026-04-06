/**
 * itch.io Connect Plugin
 *
 * Handles the itch.io OAuth implicit flow:
 *   GET  /api/connect/itchio/begin   — builds the authorisation URL
 *   POST /api/connect/itchio/finish  — validates the fragment token, stores credentials
 *
 * Sources:
 * - https://itch.io/docs/api/oauth
 * - https://itch.io/docs/api/serverside
 */

import {
  fetchItchioCredentialsInfo,
  fetchItchioCurrentUser,
  ITCHIO_PURPOSES,
  itchioScopeSatisfied,
} from '@yucp/providers/itchio/module';
import { api } from '../../../../../convex/_generated/api';
import { getConvexClientFromUrl } from '../../lib/convex';
import { encrypt } from '../../lib/encrypt';
import { logger } from '../../lib/logger';
import { getStateStore } from '../../lib/stateStore';
import type { ConnectContext, ConnectPlugin, ConnectRoute } from '../types';
import { generateSecureRandom } from '../types';

const CREDENTIAL_PURPOSE = ITCHIO_PURPOSES.credential;
const ITCHIO_STATE_PREFIX = 'connect_itchio:';
const ITCHIO_STATE_EXPIRY_MS = 10 * 60 * 1000;
const REQUIRED_ITCHIO_SCOPES = ['profile:me', 'profile:games', 'game:view:purchases'] as const;

function buildDashboardRedirect(
  frontendBaseUrl: string,
  params: Record<string, string | undefined>,
  setupToken?: string
): string {
  const redirectUrl = new URL(`${frontendBaseUrl.replace(/\/$/, '')}/dashboard`);
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

async function itchioBegin(request: Request, ctx: ConnectContext): Promise<Response> {
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

  if (!config.itchioClientId) {
    return Response.json({ error: 'itch.io OAuth not configured' }, { status: 400 });
  }

  if (authUserId && !authenticatedViaSetupToken && session) {
    const tenantOwned = await ctx.isTenantOwnedBySessionUser(session.user.id, authUserId);
    if (!tenantOwned) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  authUserId = authUserId ?? session?.user?.id ?? null;

  const state = `connect_itchio:${authUserId ?? 'personal'}:${generateSecureRandom(48)}`;
  await getStateStore().set(
    `${ITCHIO_STATE_PREFIX}${state}`,
    JSON.stringify({
      authUserId,
      guildId,
      setupToken: ctx.getSetupSessionTokenFromRequest(request) ?? '',
    }),
    ITCHIO_STATE_EXPIRY_MS
  );

  const authUrl = new URL('https://itch.io/user/oauth');
  authUrl.searchParams.set('client_id', config.itchioClientId);
  authUrl.searchParams.set(
    'redirect_uri',
    `${config.frontendBaseUrl.replace(/\/$/, '')}/oauth/callback/itchio`
  );
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', REQUIRED_ITCHIO_SCOPES.join(' '));
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

async function itchioFinish(request: Request, ctx: ConnectContext): Promise<Response> {
  const { config } = ctx;
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const setupBinding = await ctx.requireBoundSetupSession(request);
  if (!setupBinding.ok && ctx.getSetupSessionTokenFromRequest(request)) {
    return setupBinding.response;
  }
  const setupSession = setupBinding.ok ? setupBinding.setupSession : null;
  const authSession = setupSession ? null : await ctx.auth.getSession(request);
  if (!authSession && !setupSession) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  let body: { accessToken?: string; state?: string };
  try {
    body = (await request.json()) as { accessToken?: string; state?: string };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const accessToken = body.accessToken?.trim();
  const state = body.state?.trim();
  if (!accessToken || !state) {
    return Response.json({ error: 'accessToken and state are required' }, { status: 400 });
  }

  const stateStore = getStateStore();
  const raw = await stateStore.get(`${ITCHIO_STATE_PREFIX}${state}`);
  if (!raw) {
    return Response.json({ error: 'invalid_state' }, { status: 400 });
  }
  await stateStore.delete(`${ITCHIO_STATE_PREFIX}${state}`);

  const stored = JSON.parse(raw) as {
    authUserId: string | null;
    guildId: string | null;
    setupToken?: string;
  };

  if (!stored.authUserId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (authSession && !setupSession) {
    const tenantOwned = await ctx.isTenantOwnedBySessionUser(
      authSession.user.id,
      stored.authUserId
    );
    if (!tenantOwned) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  try {
    const credentialsInfo = await fetchItchioCredentialsInfo(accessToken);
    const grantedScopes = credentialsInfo.scopes ?? [];
    const missingScopes = REQUIRED_ITCHIO_SCOPES.filter(
      (requiredScope) => !itchioScopeSatisfied(grantedScopes, requiredScope)
    );
    if (missingScopes.length > 0) {
      return Response.json(
        {
          error: `Missing required itch.io scopes: ${missingScopes.join(', ')}`,
        },
        { status: 403 }
      );
    }

    const currentUser = await fetchItchioCurrentUser(accessToken);
    const encryptedAccessToken = await encrypt(
      accessToken,
      config.encryptionSecret,
      CREDENTIAL_PURPOSE
    );

    const convex = getConvexClientFromUrl(config.convexUrl);
    await convex.mutation(api.providerConnections.upsertProviderConnection, {
      apiSecret: config.convexApiSecret,
      authUserId: stored.authUserId,
      providerKey: 'itchio',
      authMode: 'oauth',
      label: 'itch.io Store',
      externalShopId: currentUser.id,
      externalShopName: currentUser.displayName ?? currentUser.username,
      credentials: [
        {
          credentialKey: 'oauth_access_token',
          kind: 'oauth_access_token',
          encryptedValue: encryptedAccessToken,
        },
      ],
      capabilities: [
        {
          capabilityKey: 'catalog_sync',
          status: 'active',
          requiredCredentialKeys: ['oauth_access_token'],
        },
        {
          capabilityKey: 'license_verification',
          status: 'active',
          requiredCredentialKeys: ['oauth_access_token'],
        },
        {
          capabilityKey: 'orders',
          status: 'active',
          requiredCredentialKeys: ['oauth_access_token'],
        },
        {
          capabilityKey: 'reconciliation',
          status: 'active',
          requiredCredentialKeys: ['oauth_access_token'],
        },
      ],
    });

    return Response.json({
      success: true,
      redirectUrl: buildDashboardRedirect(
        config.frontendBaseUrl,
        {
          itchio: 'connected',
          tenant_id: stored.authUserId,
          guild_id: stored.guildId ?? undefined,
        },
        stored.setupToken
      ),
    });
  } catch (error) {
    logger.error('itch.io finish failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Could not complete itch.io setup',
      },
      { status: 500 }
    );
  }
}

const routes: ReadonlyArray<ConnectRoute> = [
  { method: 'GET', path: '/api/connect/itchio/begin', handler: itchioBegin },
  { method: 'POST', path: '/api/connect/itchio/finish', handler: itchioFinish },
];

export const connect: ConnectPlugin = {
  providerId: 'itchio',
  routes,
};
