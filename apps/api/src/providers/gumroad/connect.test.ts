import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { InMemoryStateStore } from '../../lib/stateStore';
import type { ConnectContext } from '../types';

let activeStore = new InMemoryStateStore();
const verificationCallbackMock = mock(async (_request: Request) =>
  Response.redirect('https://app.example.com/verify/success?provider=gumroad', 302)
);

mock.module('../../../../../convex/_generated/api', () => ({
  api: {
    providerConnections: {
      upsertProviderConnection: 'providerConnections.upsertProviderConnection',
    },
  },
  internal: {
    providerConnections: {
      upsertProviderConnection: 'providerConnections.upsertProviderConnection',
    },
  },
  components: {},
}));

mock.module('../../lib/stateStore', () => ({
  getStateStore: () => activeStore,
  InMemoryStateStore,
}));

mock.module('../../verification/sessionManager', () => ({
  createVerificationRoutes: () => ({
    handleVerificationCallback: verificationCallbackMock,
  }),
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
  gumroadClientId: 'gumroad-client-id',
  gumroadClientSecret: 'gumroad-client-secret',
};

function makeContext() {
  return {
    config: MOCK_CONFIG,
    auth: { getSession: mock(async () => null) },
    requireBoundSetupSession: mock(async () => ({
      ok: true,
      setupSession: {
        authUserId: 'auth_user_123',
        guildId: 'guild_456',
        discordUserId: 'discord_789',
      },
    })),
    getSetupSessionTokenFromRequest: mock((_request: Request) => null as string | null),
    isTenantOwnedBySessionUser: mock(async () => true),
  };
}

describe('gumroad connect - shared callback', () => {
  beforeEach(() => {
    activeStore = new InMemoryStateStore();
    verificationCallbackMock.mockClear();
  });

  it('delegates verification states to the verification callback flow', async () => {
    const callbackRoute = connect.routes.find((route) => route.path.endsWith('/callback'));
    if (!callbackRoute) {
      throw new Error('GET /callback route not registered in gumroad connect plugin');
    }

    const response = await callbackRoute.handler(
      new Request(
        'https://api.example.com/api/connect/gumroad/callback?code=test-code&state=verify:gumroad:user_test123:test-state'
      ),
      makeContext() as unknown as ConnectContext
    );

    expect(verificationCallbackMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/verify/success?provider=gumroad'
    );
  });
});
