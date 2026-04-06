import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { InMemoryStateStore } from '../../lib/stateStore';
import type { ConnectContext } from '../types';

let activeStore = new InMemoryStateStore();
const mutationCalls: Array<[string, unknown]> = [];
const credentialsInfoMock = mock(async () => ({
  scopes: ['profile:me', 'profile:games', 'game:view:purchases'],
}));
const currentUserMock = mock(async () => ({
  id: 'creator-123',
  username: 'creator',
  displayName: 'Creator',
  profileUrl: 'https://creator.itch.io',
}));

const apiMock = {
  providerConnections: {
    upsertProviderConnection: 'providerConnections.upsertProviderConnection',
  },
} as const;

mock.module('../../../../../convex/_generated/api', () => ({
  api: apiMock,
  internal: apiMock,
  components: {},
}));

mock.module('../../lib/stateStore', () => ({
  getStateStore: () => activeStore,
  InMemoryStateStore,
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    mutation: mock(async (path: string, args: unknown) => {
      mutationCalls.push([path, args]);
      return null;
    }),
  }),
}));

mock.module('@yucp/providers/itchio/module', () => ({
  ITCHIO_PURPOSES: { credential: 'itchio-oauth-access-token' },
  fetchItchioCredentialsInfo: credentialsInfoMock,
  fetchItchioCurrentUser: currentUserMock,
  itchioScopeSatisfied: (grantedScopes: string[], requiredScope: string) =>
    grantedScopes.some(
      (grantedScope) =>
        grantedScope === requiredScope || requiredScope.startsWith(`${grantedScope}:`)
    ),
}));

const { connect } = await import('./connect');

const MOCK_CONFIG = {
  apiBaseUrl: 'https://api.example.com',
  frontendBaseUrl: 'https://app.example.com',
  convexSiteUrl: 'https://convex.example.com',
  convexUrl: 'https://convex.example.com',
  convexApiSecret: 'test-api-secret-min-32-characters!!',
  discordClientId: 'discord-client-id',
  discordClientSecret: 'discord-client-secret',
  encryptionSecret: 'test-encryption-secret-min-32-ch!',
  itchioClientId: 'itchio-client-id',
};

function makeContext(
  boundResult:
    | {
        ok: true;
        setupSession: { authUserId: string; guildId: string; discordUserId: string };
      }
    | { ok: false; response: Response } = {
    ok: true,
    setupSession: {
      authUserId: 'auth_user_123',
      guildId: 'guild_456',
      discordUserId: 'discord_789',
    },
  }
) {
  return {
    config: MOCK_CONFIG,
    auth: { getSession: mock(async () => null) },
    requireBoundSetupSession: mock(async () => boundResult),
    getSetupSessionTokenFromRequest: mock((_request: Request) => null as string | null),
    isTenantOwnedBySessionUser: mock(async () => true),
  };
}

beforeEach(() => {
  activeStore = new InMemoryStateStore();
  mutationCalls.length = 0;
  credentialsInfoMock.mockClear();
  currentUserMock.mockClear();
});

afterEach(() => {
  credentialsInfoMock.mockReset();
  currentUserMock.mockReset();
  credentialsInfoMock.mockResolvedValue({
    scopes: ['profile:me', 'profile:games', 'game:view:purchases'],
  });
  currentUserMock.mockResolvedValue({
    id: 'creator-123',
    username: 'creator',
    displayName: 'Creator',
    profileUrl: 'https://creator.itch.io',
  });
});

describe('itch.io connect - GET /begin', () => {
  it('redirects to itch.io OAuth with implicit response_type=token', async () => {
    const ctx = makeContext();
    const beginRoute = connect.routes.find((route) => route.path.endsWith('/begin'));
    if (!beginRoute) {
      throw new Error('GET /begin route not registered in itchio connect plugin');
    }

    const response = await beginRoute.handler(
      new Request('https://api.example.com/api/connect/itchio/begin'),
      ctx as unknown as ConnectContext
    );

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toContain('https://itch.io/user/oauth?');
    expect(location).toContain('response_type=token');
    expect(location).toContain('client_id=itchio-client-id');
    expect(location).toContain(
      'redirect_uri=https%3A%2F%2Fapp.example.com%2Foauth%2Fcallback%2Fitchio'
    );
  });
});

describe('itch.io connect - POST /finish', () => {
  it('stores the encrypted access token after validating scopes and the current user', async () => {
    const ctx = makeContext();
    await activeStore.set(
      'connect_itchio:connect_itchio:auth_user_123:state-token',
      JSON.stringify({
        authUserId: 'auth_user_123',
        guildId: 'guild_456',
        setupToken: 'setup-token',
      }),
      60_000
    );

    const finishRoute = connect.routes.find((route) => route.path.endsWith('/finish'));
    if (!finishRoute) {
      throw new Error('POST /finish route not registered in itchio connect plugin');
    }

    const response = await finishRoute.handler(
      new Request('https://api.example.com/api/connect/itchio/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: 'buyer-fragment-token',
          state: 'connect_itchio:auth_user_123:state-token',
        }),
      }),
      ctx as unknown as ConnectContext
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectUrl:
        'https://app.example.com/dashboard?itchio=connected&tenant_id=auth_user_123&guild_id=guild_456#s=setup-token',
    });

    expect(credentialsInfoMock).toHaveBeenCalledWith('buyer-fragment-token');
    expect(currentUserMock).toHaveBeenCalledWith('buyer-fragment-token');
    expect(mutationCalls).toHaveLength(1);
    expect(mutationCalls[0]?.[0]).toBe(apiMock.providerConnections.upsertProviderConnection);
    expect(mutationCalls[0]?.[1]).toMatchObject({
      providerKey: 'itchio',
      authMode: 'oauth',
      authUserId: 'auth_user_123',
      externalShopId: 'creator-123',
      externalShopName: 'Creator',
      credentials: [
        {
          credentialKey: 'oauth_access_token',
          kind: 'oauth_access_token',
          encryptedValue: expect.any(String),
        },
      ],
    });
  });
});
