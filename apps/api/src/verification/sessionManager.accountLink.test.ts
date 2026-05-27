import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { VerificationConfig } from './verificationConfig';

const convexQueryMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => undefined
);
const convexMutationMock = mock(
  async (_reference?: unknown, _args?: unknown): Promise<unknown> => undefined
);
const stateStoreGetMock = mock(async (_key: string) => 'pkce-code-verifier');
const stateStoreDeleteMock = mock(async (_key: string) => undefined);
const fetchIdentityMock = mock(
  async (_accessToken: string, _context?: unknown): Promise<Record<string, unknown>> => ({
    providerUserId: 'itchio-user-42',
    username: 'itch-buyer',
    email: 'buyer@example.com',
    avatarUrl: 'https://cdn.example.com/avatar.png',
    profileUrl: 'https://itch.io/profile/itch-buyer',
  })
);
const fetchDiscordIdentityMock = mock(
  async (_accessToken: string, _context?: unknown): Promise<Record<string, unknown>> => ({
    providerUserId: 'discord-user-123',
    username: 'discord-buyer',
    avatarUrl: 'https://cdn.discordapp.com/avatars/discord-user-123/avatar.png',
    profileUrl: 'https://discord.com/users/discord-user-123',
  })
);
const discordAfterLinkMock = mock(async (_input: unknown, _context?: unknown) => undefined);

const apiMock = {
  verificationSessions: {
    getVerificationSessionByState: 'verificationSessions.getVerificationSessionByState',
    completeVerificationSession: 'verificationSessions.completeVerificationSession',
  },
  identitySync: {
    syncUserFromProvider: 'identitySync.syncUserFromProvider',
  },
  bindings: {
    activateBinding: 'bindings.activateBinding',
  },
  subjects: {
    ensureCanonicalAuthContextForDiscordUser: 'subjects.ensureCanonicalAuthContextForDiscordUser',
    upsertBuyerProviderLink: 'subjects.upsertBuyerProviderLink',
  },
  creatorProfiles: {
    getCreatorProfile: 'creatorProfiles.getCreatorProfile',
  },
} as const;

type BuyerLinkPluginMock = {
  oauth: {
    providerId: string;
    mode?: string;
    aliases?: readonly string[];
    authUrl: string;
    tokenUrl: string;
    callbackPath: string;
    responseType: 'code' | 'token';
    scopes: string[];
    usesPkce: boolean;
  };
  fetchIdentity: typeof fetchIdentityMock;
  afterLink?: typeof discordAfterLinkMock;
};

const itchioBuyerLinkPlugin: BuyerLinkPluginMock = {
  oauth: {
    providerId: 'itchio',
    mode: 'itchio',
    authUrl: 'https://oauth.itchio.example/authorize',
    tokenUrl: 'https://oauth.itchio.example/token',
    callbackPath: '/oauth/callback/itchio',
    responseType: 'code',
    scopes: ['profile:me', 'profile:owned'],
    usesPkce: true,
  },
  fetchIdentity: fetchIdentityMock,
} as const;

const discordBuyerLinkPlugin: BuyerLinkPluginMock = {
  oauth: {
    providerId: 'discord',
    mode: 'discord',
    aliases: ['discord_role'],
    authUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    callbackPath: '/api/verification/callback/discord',
    responseType: 'code',
    scopes: ['identify', 'guilds', 'guilds.members.read'],
    usesPkce: true,
  },
  fetchIdentity: fetchDiscordIdentityMock as typeof fetchIdentityMock,
  afterLink: discordAfterLinkMock,
} as const;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: convexQueryMock,
    mutation: convexMutationMock,
  }),
}));

mock.module('../lib/logger', () => ({
  logger: {
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

mock.module('../lib/stateStore', () => ({
  getStateStore: () => ({
    get: stateStoreGetMock,
    delete: stateStoreDeleteMock,
  }),
}));

mock.module('../providers', () => ({
  getBuyerLinkPluginByMode: (mode: string) => {
    if (mode === 'itchio') {
      return itchioBuyerLinkPlugin;
    }
    if (mode === 'discord' || mode === 'discord_role') {
      return discordBuyerLinkPlugin;
    }
    return null;
  },
  listBuyerLinkPlugins: () => [itchioBuyerLinkPlugin, discordBuyerLinkPlugin],
}));

mock.module('./verificationConfig', () => ({
  getVerificationConfig: (mode: string) => {
    if (mode === 'itchio') {
      return itchioBuyerLinkPlugin.oauth;
    }
    if (mode === 'discord' || mode === 'discord_role') {
      return discordBuyerLinkPlugin.oauth;
    }
    return null;
  },
}));

mock.module('./verificationPanelRoutes', () => ({
  createVerificationPanelRouteHandlers: () => ({}),
}));

mock.module('./verificationVrchatRoutes', () => ({
  createVrchatVerificationRouteHandlers: () => ({}),
}));

mock.module('../auth', () => ({
  createAuth: () => ({}),
}));

const { createVerificationSessionManager } = await import('./sessionManager');

const originalFetch = globalThis.fetch;

const testConfig: VerificationConfig = {
  baseUrl: 'https://api.example.com',
  frontendUrl: 'https://app.example.com',
  convexUrl: 'https://convex.example.com',
  convexApiSecret: 'convex-api-secret',
  encryptionSecret: 'test-encryption-secret-32chars!!',
  providerClientIds: {
    itchio: 'itchio-client-id',
  },
  providerClientSecrets: {
    itchio: 'itchio-client-secret',
  },
};

describe('VerificationSessionManager account-link callback', () => {
  beforeEach(() => {
    convexQueryMock.mockReset();
    convexMutationMock.mockReset();
    stateStoreGetMock.mockReset();
    stateStoreDeleteMock.mockReset();
    fetchIdentityMock.mockReset();
    fetchDiscordIdentityMock.mockReset();
    discordAfterLinkMock.mockReset();

    stateStoreGetMock.mockResolvedValue('pkce-code-verifier');
    stateStoreDeleteMock.mockResolvedValue(undefined);
    fetchIdentityMock.mockResolvedValue({
      providerUserId: 'itchio-user-42',
      username: 'itch-buyer',
      email: 'buyer@example.com',
      avatarUrl: 'https://cdn.example.com/avatar.png',
      profileUrl: 'https://itch.io/profile/itch-buyer',
    });
    fetchDiscordIdentityMock.mockResolvedValue({
      providerUserId: 'discord-user-123',
      username: 'discord-buyer',
      avatarUrl: 'https://cdn.discordapp.com/avatars/discord-user-123/avatar.png',
      profileUrl: 'https://discord.com/users/discord-user-123',
    });
    discordAfterLinkMock.mockResolvedValue(undefined);

    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference !== apiMock.verificationSessions.getVerificationSessionByState) {
        throw new Error(`Unexpected query reference: ${String(reference)}`);
      }

      return {
        found: true,
        session: {
          _id: 'verification-session-1',
          mode: 'itchio',
          verificationMethod: 'account_link',
          discordUserId: 'discord-user-123',
        },
      };
    });

    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.subjects.ensureCanonicalAuthContextForDiscordUser) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          discordUserId: 'discord-user-123',
          displayName: 'itch-buyer',
          avatarUrl: 'https://cdn.example.com/avatar.png',
        });
        return {
          authUserId: 'buyer_auth_user_B',
          resolution: 'better_auth',
          subjectId: 'discord-subject-1',
        };
      }

      if (reference === apiMock.identitySync.syncUserFromProvider) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          authUserId: 'buyer_auth_user_B',
          provider: 'itchio',
          providerUserId: 'itchio-user-42',
          discordUserId: 'discord-user-123',
        });
        return {
          subjectId: 'subject-1',
          externalAccountId: 'external-account-1',
        };
      }

      if (reference === apiMock.bindings.activateBinding) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          authUserId: 'buyer_auth_user_B',
          subjectId: 'subject-1',
          externalAccountId: 'external-account-1',
          bindingType: 'verification',
        });
        return undefined;
      }

      if (reference === apiMock.subjects.upsertBuyerProviderLink) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          subjectId: 'subject-1',
          provider: 'itchio',
          externalAccountId: 'external-account-1',
          verificationMethod: 'account_link',
          verificationSessionId: 'verification-session-1',
        });
        return undefined;
      }

      if (reference === apiMock.verificationSessions.completeVerificationSession) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          sessionId: 'verification-session-1',
          subjectId: 'subject-1',
        });
        return {
          redirectUri: 'https://app.example.com/account/connections',
        };
      }

      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://oauth.itchio.example/token');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      const params = new URLSearchParams(String(init?.body ?? ''));
      expect(params.get('grant_type')).toBe('authorization_code');
      expect(params.get('code')).toBe('authorization-code-1');
      expect(params.get('redirect_uri')).toBe('https://api.example.com/oauth/callback/itchio');
      expect(params.get('code_verifier')).toBe('pkce-code-verifier');
      expect(params.get('client_id')).toBe('itchio-client-id');
      expect(params.get('client_secret')).toBe('itchio-client-secret');

      return new Response(
        JSON.stringify({
          access_token: 'access-token-123',
          refresh_token: 'refresh-token-123',
          expires_in: 3600,
          scope: 'profile:me profile:owned',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('persists the linked buyer account against the callback session and signed-in auth user', async () => {
    const manager = createVerificationSessionManager(testConfig);

    const result = await manager.handleCallback(
      'itchio',
      'authorization-code-1',
      'verify:itchio:creator_auth_user_A:state-suffix'
    );

    expect(result).toEqual({
      success: true,
      redirectUri: 'https://app.example.com/account/connections',
    });
    expect(stateStoreGetMock).toHaveBeenCalledWith(
      'pkce_verifier:verify:itchio:creator_auth_user_A:state-suffix'
    );
    expect(stateStoreDeleteMock).toHaveBeenCalledWith(
      'pkce_verifier:verify:itchio:creator_auth_user_A:state-suffix'
    );
    expect(fetchIdentityMock).toHaveBeenCalledWith(
      'access-token-123',
      expect.objectContaining({
        apiSecret: 'convex-api-secret',
      })
    );
  });

  it('persists the linked buyer account through the implicit callback path used by itch.io', async () => {
    itchioBuyerLinkPlugin.oauth.responseType = 'token';
    const manager = createVerificationSessionManager(testConfig);

    const result = await manager.handleImplicitCallback(
      'itchio',
      'fragment-access-token-123',
      'verify:itchio:creator_auth_user_A:state-suffix'
    );

    expect(result).toEqual({
      success: true,
      redirectUri: 'https://app.example.com/account/connections',
    });
    expect(fetchIdentityMock).toHaveBeenCalledWith(
      'fragment-access-token-123',
      expect.objectContaining({
        apiSecret: 'convex-api-secret',
      })
    );
    expect(stateStoreGetMock).not.toHaveBeenCalled();
    expect(stateStoreDeleteMock).not.toHaveBeenCalled();
  });

  it('surfaces a conflict when the linked provider account already belongs to a different YUCP user', async () => {
    itchioBuyerLinkPlugin.oauth.responseType = 'token';
    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.subjects.ensureCanonicalAuthContextForDiscordUser) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          discordUserId: 'discord-user-123',
        });
        return {
          authUserId: 'buyer_auth_user_B',
          resolution: 'better_auth',
          subjectId: 'discord-subject-1',
        };
      }

      if (reference === apiMock.identitySync.syncUserFromProvider) {
        throw new Error('This provider account is already linked to a different YUCP account.');
      }

      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });

    const manager = createVerificationSessionManager(testConfig);
    const result = await manager.handleImplicitCallback(
      'itchio',
      'fragment-access-token-123',
      'verify:itchio:creator_auth_user_A:state-suffix'
    );

    expect(result).toEqual({
      success: false,
      error: 'This provider account is already linked to a different YUCP account.',
    });
    expect(
      convexMutationMock.mock.calls.filter(
        ([reference]) =>
          reference === apiMock.bindings.activateBinding ||
          reference === apiMock.subjects.upsertBuyerProviderLink ||
          reference === apiMock.verificationSessions.completeVerificationSession
      )
    ).toHaveLength(0);
  });

  it('keeps the creator tenant context when a Discord role account link resolves to a different buyer auth user', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.verificationSessions.getVerificationSessionByState) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          authUserId: 'creator_auth_user_A',
          state: 'verify:discord_role:creator_auth_user_A:state-suffix',
        });
        return {
          found: true,
          session: {
            _id: 'verification-session-1',
            mode: 'discord_role',
            verificationMethod: 'account_link',
            discordUserId: 'discord-user-123',
          },
        };
      }

      if (reference === apiMock.creatorProfiles.getCreatorProfile) {
        const authUserId = (args as { authUserId?: string }).authUserId;
        if (authUserId === 'creator_auth_user_A') {
          return {
            _id: 'creator-profile-1',
            authUserId: 'creator_auth_user_A',
            policy: {
              enableDiscordRoleFromOtherServers: true,
              allowedSourceGuildIds: ['source-guild-1'],
            },
          };
        }
        return null;
      }

      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    convexMutationMock.mockImplementation(async (reference: unknown, args: unknown) => {
      if (reference === apiMock.subjects.ensureCanonicalAuthContextForDiscordUser) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          discordUserId: 'discord-user-123',
          displayName: 'discord-buyer',
        });
        return {
          authUserId: 'buyer_auth_user_B',
          resolution: 'better_auth',
          subjectId: 'discord-subject-1',
        };
      }

      if (reference === apiMock.identitySync.syncUserFromProvider) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          authUserId: 'buyer_auth_user_B',
          provider: 'discord',
          providerUserId: 'discord-user-123',
          discordUserId: 'discord-user-123',
        });
        return {
          subjectId: 'subject-1',
          externalAccountId: 'external-account-1',
        };
      }

      if (reference === apiMock.bindings.activateBinding) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          authUserId: 'buyer_auth_user_B',
          subjectId: 'subject-1',
          externalAccountId: 'external-account-1',
        });
        return undefined;
      }

      if (reference === apiMock.subjects.upsertBuyerProviderLink) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          subjectId: 'subject-1',
          provider: 'discord',
          externalAccountId: 'external-account-1',
          verificationMethod: 'account_link',
          verificationSessionId: 'verification-session-1',
        });
        return undefined;
      }

      if (reference === apiMock.verificationSessions.completeVerificationSession) {
        expect(args).toMatchObject({
          apiSecret: 'convex-api-secret',
          sessionId: 'verification-session-1',
          subjectId: 'subject-1',
        });
        return {
          redirectUri: 'https://app.example.com/account/connections',
        };
      }

      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });

    discordAfterLinkMock.mockImplementation(async (input, ctx) => {
      const { apiSecret, convex } = ctx as {
        apiSecret: string;
        convex: { query: (reference: unknown, args: unknown) => Promise<unknown> };
      };
      const { authUserId, creatorAuthUserId } = input as {
        authUserId: string;
        creatorAuthUserId?: string;
      };
      expect(authUserId).toBe('buyer_auth_user_B');
      expect(creatorAuthUserId).toBe('creator_auth_user_A');
      const tenant = await convex.query(apiMock.creatorProfiles.getCreatorProfile, {
        apiSecret,
        authUserId: creatorAuthUserId ?? authUserId,
      });
      if (!tenant) {
        throw new Error('Tenant not found');
      }
    });

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://discord.com/api/oauth2/token');
      expect(init?.method).toBe('POST');

      const params = new URLSearchParams(String(init?.body ?? ''));
      expect(params.get('grant_type')).toBe('authorization_code');
      expect(params.get('code')).toBe('authorization-code-1');
      expect(params.get('redirect_uri')).toBe(
        'https://api.example.com/api/verification/callback/discord'
      );
      expect(params.get('code_verifier')).toBe('pkce-code-verifier');

      return new Response(
        JSON.stringify({
          access_token: 'discord-access-token-123',
          refresh_token: 'discord-refresh-token-123',
          expires_in: 604800,
          scope: 'identify guilds guilds.members.read',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }) as unknown as typeof fetch;

    const manager = createVerificationSessionManager(testConfig);
    const result = await manager.handleCallback(
      'discord',
      'authorization-code-1',
      'verify:discord_role:creator_auth_user_A:state-suffix'
    );

    expect(result).toEqual({
      success: true,
      redirectUri: 'https://app.example.com/account/connections',
    });
  });
});
