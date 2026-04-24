import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ConnectContext } from '../types';

const stateStoreGetMock = mock(async () =>
  JSON.stringify({
    authUserId: 'creator_1',
    guildId: 'guild_1',
    setupToken: 'setup-token',
  })
);
const stateStoreDeleteMock = mock(async () => undefined);
const loggerErrorMock = mock(() => undefined);
let delegatedVerificationRequest: Request | null = null;
const verificationCallbackMock = mock(async (request: Request) => {
  delegatedVerificationRequest = request;
  return new Response('delegated verification callback');
});
const originalFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function createFetchStub(
  calls: Array<[FetchInput, FetchInit | undefined]>,
  responses: Response[]
): typeof fetch {
  return Object.assign(
    async (input: FetchInput, init?: FetchInit) => {
      calls.push([input, init]);
      const next = responses.shift();
      if (!next) {
        throw new Error('Unexpected fetch call');
      }
      return next;
    },
    {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    }
  );
}

mock.module('../../lib/stateStore', () => ({
  getStateStore: () => ({
    get: stateStoreGetMock,
    delete: stateStoreDeleteMock,
    set: mock(async () => undefined),
  }),
}));

mock.module('../../lib/logger', () => ({
  logger: {
    error: loggerErrorMock,
    warn: mock(() => undefined),
  },
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    mutation: mock(async () => undefined),
  }),
}));

mock.module('../../lib/encrypt', () => ({
  encrypt: mock(async () => 'encrypted-token'),
}));

mock.module('../../verification/sessionManager', () => ({
  createVerificationRoutes: () => ({
    handleVerificationCallback: verificationCallbackMock,
  }),
}));

const { connect } = await import('./connect');

function createContext(): ConnectContext {
  return {
    config: {
      apiBaseUrl: 'https://api.example.com',
      frontendBaseUrl: 'https://app.example.com',
      convexSiteUrl: 'https://convex.example.com',
      convexApiSecret: 'convex-secret',
      convexUrl: 'https://convex.example.com',
      discordClientId: 'discord-client',
      discordClientSecret: 'discord-secret',
      encryptionSecret: 'encryption-secret',
      patreonClientId: 'patreon-client',
      patreonClientSecret: 'patreon-secret',
    },
    auth: {
      getSession: mock(async () => null),
    } as never,
    requireBoundSetupSession: mock(async () => ({
      ok: false as const,
      response: new Response('missing setup', { status: 401 }),
    })),
    getSetupSessionTokenFromRequest: mock(() => null),
    isTenantOwnedBySessionUser: mock(async () => true),
  };
}

describe('patreon connect callback', () => {
  const callbackRoute = connect.routes.find(
    (route) => route.path === '/api/connect/patreon/callback'
  );

  beforeEach(() => {
    stateStoreGetMock.mockClear();
    stateStoreDeleteMock.mockClear();
    loggerErrorMock.mockClear();
    verificationCallbackMock.mockClear();
    delegatedVerificationRequest = null;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it('passes an AbortSignal to the Patreon token exchange fetch', async () => {
    if (!callbackRoute) {
      throw new Error('Expected Patreon callback route');
    }

    const calls: Array<[FetchInput, FetchInit | undefined]> = [];
    const responses = [
      new Response(JSON.stringify({ access_token: 'access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(
        JSON.stringify({ data: [{ id: 'campaign_1', attributes: { creation_name: 'Campaign' } }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      ),
    ];
    globalThis.fetch = createFetchStub(calls, responses);

    await callbackRoute.handler(
      new Request(
        'https://api.example.com/api/connect/patreon/callback?code=code-1&state=patreon_connect:creator_1:state-1'
      ),
      createContext()
    );

    expect(calls[0]?.[1]).toEqual(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('passes an AbortSignal to the Patreon campaigns fetch', async () => {
    if (!callbackRoute) {
      throw new Error('Expected Patreon callback route');
    }

    const calls: Array<[FetchInput, FetchInit | undefined]> = [];
    const responses = [
      new Response(JSON.stringify({ access_token: 'access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(
        JSON.stringify({ data: [{ id: 'campaign_1', attributes: { creation_name: 'Campaign' } }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      ),
    ];
    globalThis.fetch = createFetchStub(calls, responses);

    await callbackRoute.handler(
      new Request(
        'https://api.example.com/api/connect/patreon/callback?code=code-2&state=patreon_connect:creator_1:state-2'
      ),
      createContext()
    );

    expect(calls[1]?.[1]).toEqual(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('delegates non-connect states to the verification callback handler', async () => {
    if (!callbackRoute) {
      throw new Error('Expected Patreon callback route');
    }

    const response = await callbackRoute.handler(
      new Request(
        'https://api.example.com/api/connect/patreon/callback?code=code-3&state=verify:patreon:buyer_1:state-3'
      ),
      createContext()
    );

    expect(verificationCallbackMock).toHaveBeenCalledTimes(1);
    const delegatedRequest = delegatedVerificationRequest;
    expect(delegatedRequest).toBeDefined();
    if (!delegatedRequest) {
      throw new Error('Expected delegated verification callback request');
    }
    expect(delegatedRequest).toBeInstanceOf(Request);
    expect(new URL(delegatedRequest.url).pathname).toBe('/api/verification/callback/patreon');
    expect(await response.text()).toBe('delegated verification callback');
    expect(stateStoreGetMock).not.toHaveBeenCalled();
  });
});
