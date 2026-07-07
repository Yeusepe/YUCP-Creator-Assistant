import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ConvexServerClient } from '../../lib/convex';

const apiMock = {
  identitySync: {
    storeDiscordToken: 'identitySync.storeDiscordToken',
  },
  creatorProfiles: {
    getCreatorProfile: 'creatorProfiles.getCreatorProfile',
  },
  role_rules: {
    getDiscordRoleRulesByTenant: 'role_rules.getDiscordRoleRulesByTenant',
  },
  entitlements: {
    grantEntitlement: 'entitlements.grantEntitlement',
  },
} as const;

const encryptMock = mock(
  async (value: string, _secret: string, purpose: string) => `enc:${purpose}:${value}`
);

mock.module('../../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: {},
}));

mock.module('../../lib/encrypt', () => ({
  encrypt: encryptMock,
}));

const { createDiscordBuyerLinkPlugin } = await import('./buyerLink');

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

let queryImpl: (ref: unknown, args?: unknown) => Promise<unknown>;
let mutationImpl: (ref: unknown, args?: unknown) => Promise<unknown>;
const queryMock = mock((ref: unknown, args?: unknown) => queryImpl(ref, args));
const mutationMock = mock((ref: unknown, args?: unknown) => mutationImpl(ref, args));

function makeCtx() {
  return {
    convex: {
      query: queryMock,
      mutation: mutationMock,
      action: mock(async () => null),
    } satisfies ConvexServerClient,
    apiSecret: 'api-secret',
    encryptionSecret: 'encrypt-secret',
  };
}

beforeEach(() => {
  queryMock.mockClear();
  mutationMock.mockClear();
  encryptMock.mockClear();

  queryImpl = async () => null;
  mutationImpl = async () => null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

describe('discord buyer link plugin', () => {
  it('bounds the Discord identity fetch with an abort signal', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://discord.com/api/v10/users/@me');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({
        id: 'discord-user-123',
        username: 'discord-buyer',
        avatar: 'avatar-hash',
      });
    }) as unknown as typeof fetch;

    const plugin = createDiscordBuyerLinkPlugin();
    const identity = await plugin.fetchIdentity('discord-access-token', makeCtx());

    expect(identity).toMatchObject({
      providerUserId: 'discord-user-123',
      username: 'discord-buyer',
    });
  });

  it('uses the creator auth user for Discord role tenant lookups after buyer canonicalization', async () => {
    queryMock.mockImplementation(async (ref, args) => {
      switch (ref) {
        case apiMock.creatorProfiles.getCreatorProfile:
          expect(args).toMatchObject({
            apiSecret: 'api-secret',
            authUserId: 'creator_auth_user_A',
          });
          return {
            _id: 'creator-profile-1',
            authUserId: 'creator_auth_user_A',
            policy: {
              enableDiscordRoleFromOtherServers: false,
              allowedSourceGuildIds: ['source-guild-1'],
            },
          };
        default:
          throw new Error(`Unhandled query ref ${String(ref)}`);
      }
    });
    mutationMock.mockImplementation(async (ref, args) => {
      switch (ref) {
        case apiMock.identitySync.storeDiscordToken:
          expect(args).toMatchObject({
            apiSecret: 'api-secret',
            externalAccountId: 'external-account-1',
          });
          return null;
        default:
          throw new Error(`Unhandled mutation ref ${String(ref)}`);
      }
    });

    const plugin = createDiscordBuyerLinkPlugin();
    if (!plugin.afterLink) {
      throw new Error('Expected afterLink to be defined for Discord');
    }

    await plugin.afterLink(
      {
        authUserId: 'buyer_auth_user_B',
        creatorAuthUserId: 'creator_auth_user_A',
        sessionId: 'verification-session-1' as never,
        sessionMode: 'discord_role',
        verificationMethod: 'account_link',
        discordUserId: 'discord-user-123',
        accessToken: 'discord-access-token',
        expiresAt: 123,
        grantedScopes: ['identify', 'guilds', 'guilds.members.read'],
        identity: {
          providerUserId: 'discord-user-123',
          username: 'discord-buyer',
        },
        subjectId: 'subject-1' as never,
        externalAccountId: 'external-account-1' as never,
      },
      makeCtx()
    );

    expect(encryptMock).toHaveBeenCalledWith(
      'discord-access-token',
      'encrypt-secret',
      'discord-oauth-access-token'
    );
    expect(queryMock).toHaveBeenCalledWith(
      apiMock.creatorProfiles.getCreatorProfile,
      expect.objectContaining({
        authUserId: 'creator_auth_user_A',
      })
    );
    expect(queryMock).not.toHaveBeenCalledWith(
      apiMock.creatorProfiles.getCreatorProfile,
      expect.objectContaining({
        authUserId: 'buyer_auth_user_B',
      })
    );
  });

  it('honors Discord Retry-After before retrying guild member fetches', async () => {
    const retryDelays: number[] = [];
    globalThis.setTimeout = mock(
      (callback: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
        retryDelays.push(Number(timeout));
        if (typeof callback === 'function') {
          callback(...args);
        }
        return 0 as never;
      }
    ) as unknown as typeof setTimeout;

    let guildMemberFetchCount = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        'https://discord.com/api/v10/users/@me/guilds/source-guild-1/member'
      );
      expect(init?.signal).toBeInstanceOf(AbortSignal);

      guildMemberFetchCount += 1;
      if (guildMemberFetchCount === 1) {
        return Response.json(
          { message: 'You are being rate limited.', retry_after: 7 },
          { status: 429, headers: { 'Retry-After': '7' } }
        );
      }

      return Response.json({ roles: ['required-role-1'] });
    }) as unknown as typeof fetch;

    queryMock.mockImplementation(async (ref, args) => {
      switch (ref) {
        case apiMock.creatorProfiles.getCreatorProfile:
          expect(args).toMatchObject({
            apiSecret: 'api-secret',
            authUserId: 'creator_auth_user_A',
          });
          return {
            _id: 'creator-profile-1',
            authUserId: 'creator_auth_user_A',
            policy: {
              enableDiscordRoleFromOtherServers: true,
              allowedSourceGuildIds: ['source-guild-1'],
            },
          };
        case apiMock.role_rules.getDiscordRoleRulesByTenant:
          expect(args).toMatchObject({
            apiSecret: 'api-secret',
            authUserId: 'creator_auth_user_A',
            sourceGuildIds: ['source-guild-1'],
          });
          return [
            {
              sourceGuildId: 'source-guild-1',
              requiredRoleId: 'required-role-1',
              productId: 'discord-product-1',
            },
          ];
        default:
          throw new Error(`Unhandled query ref ${String(ref)}`);
      }
    });
    mutationMock.mockImplementation(async (ref, args) => {
      switch (ref) {
        case apiMock.identitySync.storeDiscordToken:
          expect(args).toMatchObject({
            apiSecret: 'api-secret',
            externalAccountId: 'external-account-1',
          });
          return null;
        case apiMock.entitlements.grantEntitlement:
          expect(args).toMatchObject({
            apiSecret: 'api-secret',
            authUserId: 'creator_auth_user_A',
            subjectId: 'subject-1',
            productId: 'discord-product-1',
            evidence: {
              provider: 'discord',
              sourceReference: 'discord-product-1',
            },
          });
          return null;
        default:
          throw new Error(`Unhandled mutation ref ${String(ref)}`);
      }
    });

    const plugin = createDiscordBuyerLinkPlugin();
    if (!plugin.afterLink) {
      throw new Error('Expected afterLink to be defined for Discord');
    }

    await plugin.afterLink(
      {
        authUserId: 'buyer_auth_user_B',
        creatorAuthUserId: 'creator_auth_user_A',
        sessionId: 'verification-session-1' as never,
        sessionMode: 'discord_role',
        verificationMethod: 'account_link',
        discordUserId: 'discord-user-123',
        accessToken: 'discord-access-token',
        expiresAt: 123,
        grantedScopes: ['identify', 'guilds', 'guilds.members.read'],
        identity: {
          providerUserId: 'discord-user-123',
          username: 'discord-buyer',
        },
        subjectId: 'subject-1' as never,
        externalAccountId: 'external-account-1' as never,
      },
      makeCtx()
    );

    expect(retryDelays).toEqual([7000]);
    expect(guildMemberFetchCount).toBe(2);
    expect(mutationMock).toHaveBeenCalledWith(
      apiMock.entitlements.grantEntitlement,
      expect.objectContaining({
        productId: 'discord-product-1',
      })
    );
  });
});
