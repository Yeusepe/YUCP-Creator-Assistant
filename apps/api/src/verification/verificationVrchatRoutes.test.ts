import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { StructuredLogger } from '@yucp/shared';
import type { VrchatSessionAuthClient } from './vrchatSession';

const storeEntries = new Map<string, { value: string; expiresAt?: number }>();

const store = {
  async get(key: string) {
    const entry = storeEntries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      storeEntries.delete(key);
      return null;
    }
    return entry.value;
  },
  async set(key: string, value: string, ttlMs?: number) {
    storeEntries.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
    });
  },
  async delete(key: string) {
    storeEntries.delete(key);
  },
};

const { createVrchatVerificationRouteHandlers } = await import('./verificationVrchatRoutes');

describe('VRChat verification route handlers', () => {
  const config = {
    baseUrl: 'https://api.example.com',
    frontendUrl: 'https://app.example.com',
    convexUrl: 'https://convex.example.com',
    convexApiSecret: 'api-secret',
    gumroadClientId: 'gumroad-client-id',
    gumroadClientSecret: 'gumroad-client-secret',
  };
  const debugMock = mock((_message: string, _meta?: Record<string, unknown>) => {});
  const infoMock = mock((_message: string, _meta?: Record<string, unknown>) => {});
  const warnMock = mock((_message: string, _meta?: Record<string, unknown>) => {});
  const errorMock = mock((_message: string, _meta?: Record<string, unknown>) => {});
  const getVrchatSessionTokensMock = mock(
    async () =>
      ({ response: new Response(JSON.stringify({ needsLink: true }), { status: 404 }) }) as const
  );
  const createAuthStub = (_config: {
    baseUrl: string;
    convexSiteUrl: string;
    convexUrl: string;
  }): VrchatSessionAuthClient => ({
    getVrchatSessionTokens: async (
      _betterAuthCookieHeader: string,
      _requestCookieHeader?: string
    ) => ({
      ...(await getVrchatSessionTokensMock()),
      betterAuthCookieHeader: 'cookie=value',
      browserSetCookies: [],
    }),
    clearVrchatSession: async (_betterAuthCookieHeader: string, _requestCookieHeader?: string) => ({
      response: new Response('{}', { status: 200 }),
      betterAuthCookieHeader: 'cookie=value',
      browserSetCookies: [],
    }),
    persistVrchatSession: async (_vrchatUser, _session, _requestCookieHeader?: string) => ({
      response: new Response('{}', { status: 200 }),
      betterAuthCookieHeader: 'cookie=value',
      browserSetCookies: [],
    }),
  });
  let logger: StructuredLogger;

  logger = {
    debug: debugMock,
    info: infoMock,
    warn: warnMock,
    error: errorMock,
    child: mock((_additionalContext: Record<string, unknown>) => logger),
  };

  beforeEach(() => {
    storeEntries.clear();
    storeEntries.set('vrchat_verify:test-token', {
      value: JSON.stringify({
        authUserId: 'auth-user',
        discordUserId: 'discord-user',
        redirectUri: 'https://app.example.com/return',
      }),
    });
    getVrchatSessionTokensMock.mockReset();
    getVrchatSessionTokensMock.mockResolvedValue({
      response: new Response(JSON.stringify({ needsLink: true }), { status: 404 }),
    });
  });

  afterEach(() => {
    debugMock.mockClear();
    infoMock.mockClear();
    warnMock.mockClear();
    errorMock.mockClear();
  });

  afterAll(() => {
    mock.restore();
  });

  it('rejects partial credentials instead of falling back to stored-session auth', async () => {
    const handlers = createVrchatVerificationRouteHandlers({
      config,
      logger,
      deps: {
        createAuth: createAuthStub,
        getStateStore: () => store,
      },
    });

    const response = await handlers.vrchatVerify(
      new Request('https://api.example.com/api/verification/vrchat-verify', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://api.example.com',
        },
        body: JSON.stringify({
          token: 'test-token',
          username: 'vrchat-user',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(getVrchatSessionTokensMock).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      success: false,
      error: 'Please provide both your VRChat username and password.',
    });
  });

  it('returns 500 for unexpected stored-session failures', async () => {
    getVrchatSessionTokensMock.mockImplementation(async () => {
      throw new Error('state store unavailable');
    });
    const handlers = createVrchatVerificationRouteHandlers({
      config,
      logger,
      deps: {
        createAuth: createAuthStub,
        getStateStore: () => store,
      },
    });

    const response = await handlers.vrchatVerify(
      new Request('https://api.example.com/api/verification/vrchat-verify', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://api.example.com',
        },
        body: JSON.stringify({
          token: 'test-token',
        }),
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Verification failed. Please try again.',
    });
  });
});
