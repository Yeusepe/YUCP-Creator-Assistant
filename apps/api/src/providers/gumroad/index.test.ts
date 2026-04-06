import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const decryptMock = mock(async () => 'access-token');
const debugMock = mock((_message: string, _meta?: Record<string, unknown>) => {});
const infoMock = mock((_message: string, _meta?: Record<string, unknown>) => {});
const warnMock = mock((_message: string, _meta?: Record<string, unknown>) => {});
const errorMock = mock((_message: string, _meta?: Record<string, unknown>) => {});

mock.module('@yucp/providers/gumroad/module', () => ({
  GUMROAD_PURPOSES: { credential: 'credential' },
  createGumroadProviderModule: () => ({
    descriptor: { key: 'gumroad' },
  }),
}));

mock.module('./buyerVerification', () => ({
  buyerVerification: {},
}));

mock.module('./connect', () => ({
  connect: { providerId: 'gumroad', routes: [] },
}));

mock.module('./webhook', () => ({
  webhook: { handle: async () => new Response(null, { status: 200 }) },
}));

const { createGumroadApiProvider } = await import('./index');

describe('gumroad provider disconnect hook', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    decryptMock.mockReset();
    decryptMock.mockResolvedValue('access-token');
    debugMock.mockClear();
    infoMock.mockClear();
    warnMock.mockClear();
    errorMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not log delete success when Gumroad returns a failed delete response', async () => {
    const gumroadProvider = createGumroadApiProvider({
      decryptCredential: decryptMock as typeof decryptMock,
      logger: {
        debug: debugMock,
        info: infoMock,
        warn: warnMock,
        error: errorMock,
        child: () => {
          throw new Error('child logger should not be called in this test');
        },
      },
    });

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/resource_subscriptions')) {
        return new Response(
          JSON.stringify({
            success: true,
            resource_subscriptions: [
              {
                id: 'sub_123',
                resource_name: 'sale',
                post_url: 'https://api.example.com/webhooks/gumroad/sale',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }

      return new Response('failed delete', { status: 500 });
    }) as unknown as typeof fetch;

    await gumroadProvider.hooks.onDisconnect?.({
      credentials: {
        oauth_access_token: 'encrypted-token',
      },
      encryptionSecret: 'encryption-secret',
      apiBaseUrl: 'https://api.example.com',
    });

    expect(
      infoMock.mock.calls.some(
        (call) => call[0] === 'Gumroad onDisconnect: deleted resource_subscription'
      )
    ).toBe(false);
    expect(
      warnMock.mock.calls.some(
        (call) =>
          call[0] === 'Gumroad onDisconnect: failed to delete resource_subscription' &&
          (call[1] as Record<string, unknown>)?.status === 500
      )
    ).toBe(true);
  });
});
