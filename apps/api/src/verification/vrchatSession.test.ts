import { describe, expect, it } from 'bun:test';
import type { VrchatCurrentUser } from '@yucp/providers';
import type { VrchatSessionTokens } from '@yucp/providers/vrchat';
import type { VrchatInternalResponse } from '../auth';
import {
  buildSessionFromAuthResult,
  clearStoredVrchatSession,
  ensureVrchatSubjectId,
  getOwnershipFromSession,
  getStoredVrchatSession,
  parseTwoFactorType,
  persistVrchatSession,
  type VrchatSessionAuthClient,
  type VrchatSubjectLookupClient,
} from './vrchatSession';

function createAuthResponse(
  response: Response,
  browserSetCookies: string[] = [],
  betterAuthCookieHeader = ''
): VrchatInternalResponse {
  return {
    response,
    browserSetCookies,
    betterAuthCookieHeader,
  };
}

function createAuthClient(
  overrides: Partial<VrchatSessionAuthClient> = {}
): VrchatSessionAuthClient {
  return {
    async persistVrchatSession() {
      return createAuthResponse(new Response(null, { status: 200 }));
    },
    async getVrchatSessionTokens() {
      return createAuthResponse(new Response(null, { status: 200 }));
    },
    async clearVrchatSession() {
      return createAuthResponse(new Response(null, { status: 200 }));
    },
    ...overrides,
  };
}

describe('vrchatSession', () => {
  describe('parseTwoFactorType', () => {
    it('accepts supported two-factor types', () => {
      expect(parseTwoFactorType('totp')).toBe('totp');
      expect(parseTwoFactorType('emailOtp')).toBe('emailOtp');
      expect(parseTwoFactorType('otp')).toBe('otp');
    });

    it('rejects unsupported two-factor types', () => {
      expect(parseTwoFactorType('sms')).toBeUndefined();
      expect(parseTwoFactorType(undefined)).toBeUndefined();
    });
  });

  describe('buildSessionFromAuthResult', () => {
    it('requires a Better Auth cookie header for a successful session result', () => {
      expect(
        buildSessionFromAuthResult({
          browserSetCookies: ['session=abc; Path=/'],
          betterAuthCookieHeader: '',
        })
      ).toEqual({
        success: false,
        status: 500,
        error: 'Verification succeeded, but the account session could not be established.',
        browserSetCookies: ['session=abc; Path=/'],
        betterAuthCookieHeader: '',
      });
    });
  });

  describe('persistVrchatSession', () => {
    it('persists the VRChat session payload through Better Auth', async () => {
      const user: VrchatCurrentUser = {
        id: 'usr_123',
        displayName: 'Display Name',
        username: 'display-name',
      };
      const session: VrchatSessionTokens = {
        authToken: 'auth-token',
        twoFactorAuthToken: 'two-factor-token',
      };

      const authClient = createAuthClient({
        async persistVrchatSession(vrchatUser, tokens, requestCookieHeader) {
          expect(vrchatUser).toEqual({
            id: 'usr_123',
            displayName: 'Display Name',
            username: 'display-name',
          });
          expect(tokens).toEqual(session);
          expect(requestCookieHeader).toBe('request-cookie');
          return createAuthResponse(
            new Response(null, { status: 200 }),
            ['better-auth=abc; Path=/'],
            'better-auth=abc'
          );
        },
      });

      await expect(
        persistVrchatSession(authClient, 'request-cookie', user, session)
      ).resolves.toEqual({
        success: true,
        browserSetCookies: ['better-auth=abc; Path=/'],
        betterAuthCookieHeader: 'better-auth=abc',
      });
    });

    it('returns the existing account-session error when Better Auth persistence fails', async () => {
      const authClient = createAuthClient({
        async persistVrchatSession() {
          return createAuthResponse(
            new Response('persist failed', { status: 502 }),
            ['better-auth=abc; Path=/'],
            'better-auth=abc'
          );
        },
      });

      await expect(
        persistVrchatSession(
          authClient,
          'request-cookie',
          {
            id: 'usr_123',
            displayName: 'Display Name',
            username: 'display-name',
          },
          { authToken: 'auth-token' }
        )
      ).resolves.toEqual({
        success: false,
        status: 502,
        error: 'Verification succeeded, but the account session could not be established.',
        browserSetCookies: ['better-auth=abc; Path=/'],
        betterAuthCookieHeader: 'better-auth=abc',
      });
    });
  });

  describe('getStoredVrchatSession', () => {
    it('returns the stored session tokens when Better Auth responds with a valid payload', async () => {
      const authClient = createAuthClient({
        async getVrchatSessionTokens() {
          return createAuthResponse(
            new Response(
              JSON.stringify({
                authToken: 'auth-token',
                twoFactorAuthToken: 'two-factor-token',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          );
        },
      });

      await expect(
        getStoredVrchatSession(authClient, 'request-cookie', 'better-auth=abc')
      ).resolves.toEqual({
        success: true,
        session: {
          authToken: 'auth-token',
          twoFactorAuthToken: 'two-factor-token',
        },
      });
    });

    it('maps missing-link responses to the existing credentials prompt', async () => {
      const authClient = createAuthClient({
        async getVrchatSessionTokens() {
          return createAuthResponse(
            new Response(JSON.stringify({ needsLink: true }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            })
          );
        },
      });

      await expect(
        getStoredVrchatSession(authClient, 'request-cookie', 'better-auth=abc')
      ).resolves.toEqual({
        success: false,
        status: 404,
        needsCredentials: true,
        error: 'Please enter your VRChat username and password to verify.',
      });
    });

    it('marks unauthorized stored sessions as requiring fresh credentials', async () => {
      const authClient = createAuthClient({
        async getVrchatSessionTokens() {
          return createAuthResponse(
            new Response(JSON.stringify({ error: 'unauthorized' }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            })
          );
        },
      });

      await expect(
        getStoredVrchatSession(authClient, 'request-cookie', 'better-auth=abc')
      ).resolves.toEqual({
        success: false,
        status: 401,
        needsCredentials: true,
        error: 'Please enter your VRChat username and password to verify.',
      });
    });
  });

  describe('clearStoredVrchatSession', () => {
    it('swallows cleanup failures', async () => {
      const authClient = createAuthClient({
        async clearVrchatSession() {
          throw new Error('cleanup failed');
        },
      });

      await expect(
        clearStoredVrchatSession(authClient, 'request-cookie', 'better-auth=abc')
      ).resolves.toBeUndefined();
    });
  });

  describe('getOwnershipFromSession', () => {
    it('normalizes ownership results from the VRChat client', async () => {
      await expect(
        getOwnershipFromSession(
          {
            async getOwnershipFromSession() {
              return {
                vrchatUserId: 'usr_123',
                displayName: 'Display Name',
                ownedAvatarIds: ['avtr_1', 'avtr_2'],
              };
            },
          },
          { authToken: 'auth-token' }
        )
      ).resolves.toEqual({
        vrchatUserId: 'usr_123',
        displayName: 'Display Name',
        ownedAvatarIds: ['avtr_1', 'avtr_2'],
      });
    });

    it('returns null when ownership lookup throws', async () => {
      await expect(
        getOwnershipFromSession(
          {
            async getOwnershipFromSession() {
              throw new Error('lookup failed');
            },
          },
          { authToken: 'auth-token' }
        )
      ).resolves.toBeNull();
    });
  });

  describe('ensureVrchatSubjectId', () => {
    it('delegates subject lookup to Convex with the existing payload shape', async () => {
      const calls: Array<{ url: string; args: Record<string, unknown> }> = [];
      const getConvexClient = (url: string): VrchatSubjectLookupClient => ({
        async mutation(_reference, args) {
          calls.push({ url, args });
          return { subjectId: 'subject_123' };
        },
      });

      await expect(
        ensureVrchatSubjectId(
          'discord_123',
          {
            convexUrl: 'https://convex.example.com',
            convexApiSecret: 'convex-secret',
          },
          getConvexClient
        )
      ).resolves.toBe('subject_123');

      expect(calls).toEqual([
        {
          url: 'https://convex.example.com',
          args: {
            apiSecret: 'convex-secret',
            discordUserId: 'discord_123',
            displayName: undefined,
            avatarUrl: undefined,
          },
        },
      ]);
    });
  });
});
