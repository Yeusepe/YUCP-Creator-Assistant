/**
 * Tests for auth module configuration and utilities
 */

import { describe, expect, it } from 'bun:test';
import {
  createDiscordProvider,
  type DiscordProviderConfig,
  validateDiscordConfig,
} from './discord';
import { type AuthConfig, createAuth } from './index';
import {
  createCookieConfig,
  createSessionConfig,
  DEV_COOKIE_ATTRIBUTES,
  SECURE_COOKIE_ATTRIBUTES,
} from './session';

describe('Discord Provider', () => {
  describe('validateDiscordConfig', () => {
    it('returns enabled=false when no credentials provided', () => {
      const config = validateDiscordConfig({});
      expect(config.enabled).toBe(false);
      expect(config.clientId).toBe('');
      expect(config.clientSecret).toBe('');
    });

    it('returns enabled=false when only clientId provided', () => {
      const config = validateDiscordConfig({
        DISCORD_CLIENT_ID: 'test-id',
      });
      expect(config.enabled).toBe(false);
    });

    it('returns enabled=false when only clientSecret provided', () => {
      const config = validateDiscordConfig({
        DISCORD_CLIENT_SECRET: 'test-secret',
      });
      expect(config.enabled).toBe(false);
    });

    it('returns enabled=true when both credentials provided', () => {
      const config = validateDiscordConfig({
        DISCORD_CLIENT_ID: 'test-id',
        DISCORD_CLIENT_SECRET: 'test-secret',
      });
      expect(config.enabled).toBe(true);
      expect(config.clientId).toBe('test-id');
      expect(config.clientSecret).toBe('test-secret');
    });
  });

  describe('createDiscordProvider', () => {
    it('returns empty object when disabled', () => {
      const config: DiscordProviderConfig = {
        clientId: '',
        clientSecret: '',
        enabled: false,
      };
      const provider = createDiscordProvider(config);
      expect(provider).toEqual({});
    });

    it('returns empty object when clientId is missing', () => {
      const config: DiscordProviderConfig = {
        clientId: '',
        clientSecret: 'secret',
        enabled: true,
      };
      const provider = createDiscordProvider(config);
      expect(provider).toEqual({});
    });

    it('returns empty object when clientSecret is missing', () => {
      const config: DiscordProviderConfig = {
        clientId: 'id',
        clientSecret: '',
        enabled: true,
      };
      const provider = createDiscordProvider(config);
      expect(provider).toEqual({});
    });

    it('returns discord provider when fully configured', () => {
      const config: DiscordProviderConfig = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        enabled: true,
      };
      const provider = createDiscordProvider(config);
      expect(provider).toHaveProperty('discord');
      expect(provider.discord.clientId).toBe('test-client-id');
      expect(provider.discord.clientSecret).toBe('test-client-secret');
    });
  });
});

describe('Session Configuration', () => {
  describe('createSessionConfig', () => {
    it('returns correct session config for production', () => {
      const config = createSessionConfig(true);
      expect(config.modelName).toBe('session');
      expect(config.expiresIn).toBe(60 * 60 * 24 * 7); // 7 days
      expect(config.updateAge).toBe(60 * 60 * 24); // 1 day
      expect(config.cookieCache?.enabled).toBe(true);
      expect(config.cookieCache?.maxAge).toBe(5 * 60); // 5 minutes
    });

    it('returns same session config for development', () => {
      const config = createSessionConfig(false);
      expect(config.modelName).toBe('session');
      expect(config.expiresIn).toBe(60 * 60 * 24 * 7); // 7 days
    });
  });

  describe('createCookieConfig', () => {
    it('returns secure cookies for production', () => {
      const config = createCookieConfig(true);
      expect(config.session_token.name).toBe('yucp_session_token');
      expect(config.session_token.attributes.secure).toBe(true);
      expect(config.session_token.attributes.httpOnly).toBe(true);
      expect(config.session_token.attributes.sameSite).toBe('strict');
    });

    it('returns non-secure cookies for development', () => {
      const config = createCookieConfig(false);
      expect(config.session_token.attributes.secure).toBe(false);
      expect(config.session_token.attributes.sameSite).toBe('lax');
    });
  });

  describe('Cookie Attributes', () => {
    it('SECURE_COOKIE_ATTRIBUTES has correct values', () => {
      expect(SECURE_COOKIE_ATTRIBUTES.httpOnly).toBe(true);
      expect(SECURE_COOKIE_ATTRIBUTES.secure).toBe(true);
      expect(SECURE_COOKIE_ATTRIBUTES.sameSite).toBe('strict');
      expect(SECURE_COOKIE_ATTRIBUTES.path).toBe('/');
    });

    it('DEV_COOKIE_ATTRIBUTES has correct values', () => {
      expect(DEV_COOKIE_ATTRIBUTES.httpOnly).toBe(true);
      expect(DEV_COOKIE_ATTRIBUTES.secure).toBe(false);
      expect(DEV_COOKIE_ATTRIBUTES.sameSite).toBe('lax');
      expect(DEV_COOKIE_ATTRIBUTES.path).toBe('/');
    });
  });
});

describe('Auth Configuration', () => {
  describe('createAuth', () => {
    it('creates auth with viewer-token and VRChat helpers', () => {
      const config: AuthConfig = {
        baseUrl: 'http://localhost:3001',
        convexSiteUrl: 'https://test-123.convex.site',
        convexUrl: 'https://test-123.convex.site',
      };
      const auth = createAuth(config);
      expect(auth).toHaveProperty('getSession');
      expect(auth).toHaveProperty('getDiscordUserId');
      expect(auth).toHaveProperty('persistVrchatSession');
      expect(auth).toHaveProperty('getVrchatSessionTokens');
      expect(auth).toHaveProperty('clearVrchatSession');
      expect(auth).toHaveProperty('clearVrchatSessionForUser');
      expect(typeof auth.getSession).toBe('function');
      expect(typeof auth.getDiscordUserId).toBe('function');
      expect(typeof auth.persistVrchatSession).toBe('function');
    });

    it('getSession returns null when no cookies', async () => {
      const config: AuthConfig = {
        baseUrl: 'http://localhost:3001',
        convexSiteUrl: 'https://test-123.convex.site',
        convexUrl: 'https://test-123.convex.site',
      };
      const auth = createAuth(config);
      const req = new Request('http://localhost:3001/connect');
      // This will fail to reach Convex in tests, but should not throw
      const session = await auth.getSession(req);
      expect(session).toBeNull();
    });

    it('getSession resolves Better Auth sessions from forwarded cookies when no viewer token exists', async () => {
      const originalInternalSecret = process.env.INTERNAL_SERVICE_AUTH_SECRET;
      process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-secret';
      const originalFetch = globalThis.fetch;
      let forwardedCookieHeader = '';

      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwardedCookieHeader = new Headers(init?.headers).get('cookie') ?? '';
        return new Response(
          JSON.stringify({
            session: { id: 'session_123' },
            user: {
              id: 'auth_user_123',
              email: 'creator@example.com',
              name: 'Creator',
              image: null,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }) as typeof fetch;

      try {
        const config: AuthConfig = {
          baseUrl: 'http://localhost:3001',
          convexSiteUrl: 'https://test-123.convex.site',
          convexUrl: 'https://test-123.convex.site',
        };
        const auth = createAuth(config);
        const req = new Request('http://localhost:3001/connect', {
          headers: {
            cookie: 'yucp.session_token=session-cookie',
          },
        });

        const session = await auth.getSession(req);

        expect(forwardedCookieHeader).toContain('yucp.session_token=session-cookie');
        expect(session).toEqual({
          user: {
            id: 'auth_user_123',
            email: 'creator@example.com',
            name: 'Creator',
            image: null,
          },
          discordUserId: null,
        });
      } finally {
        globalThis.fetch = originalFetch;
        if (originalInternalSecret === undefined) {
          delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
        } else {
          process.env.INTERNAL_SERVICE_AUTH_SECRET = originalInternalSecret;
        }
      }
    });

    it('getDiscordUserId returns null when no viewer token is present', async () => {
      const config: AuthConfig = {
        baseUrl: 'http://localhost:3001',
        convexSiteUrl: 'https://test-123.convex.site',
        convexUrl: 'https://test-123.convex.site',
      };
      const auth = createAuth(config);
      const req = new Request('http://localhost:3001/connect');
      const discordUserId = await auth.getDiscordUserId(req);
      expect(discordUserId).toBeNull();
    });

    it('lists OAuth clients through the Better Auth session cookie fallback', async () => {
      const originalInternalSecret = process.env.INTERNAL_SERVICE_AUTH_SECRET;
      process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-secret';
      const originalFetch = globalThis.fetch;
      let requestUrl = '';
      let forwardedCookieHeader = '';

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = String(input);
        forwardedCookieHeader = new Headers(init?.headers).get('cookie') ?? '';
        return new Response(
          JSON.stringify([
            {
              client_id: 'client_123',
              client_name: 'My App',
              redirect_uris: ['https://example.com/callback'],
              scope: 'verification:read subjects:read',
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }) as typeof fetch;

      try {
        const config: AuthConfig = {
          baseUrl: 'http://localhost:3001',
          convexSiteUrl: 'https://test-123.convex.site',
          convexUrl: 'https://test-123.convex.site',
        };
        const auth = createAuth(config);
        const req = new Request('http://localhost:3001/connect', {
          headers: {
            cookie: 'yucp.session_token=session-cookie',
          },
        });

        const clients = await auth.listOAuthClients(req);

        expect(requestUrl).toContain('/api/auth/oauth2/get-clients');
        expect(forwardedCookieHeader).toContain('yucp.session_token=session-cookie');
        expect(clients).toEqual([
          {
            client_id: 'client_123',
            client_name: 'My App',
            redirect_uris: ['https://example.com/callback'],
            scope: 'verification:read subjects:read',
          },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalInternalSecret === undefined) {
          delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
        } else {
          process.env.INTERNAL_SERVICE_AUTH_SECRET = originalInternalSecret;
        }
      }
    });

    it('lists API keys through the Better Auth session cookie fallback', async () => {
      const originalInternalSecret = process.env.INTERNAL_SERVICE_AUTH_SECRET;
      process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-secret';
      const originalFetch = globalThis.fetch;
      let requestUrl = '';
      let forwardedCookieHeader = '';

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = String(input);
        forwardedCookieHeader = new Headers(init?.headers).get('cookie') ?? '';
        return new Response(
          JSON.stringify({
            apiKeys: [
              {
                id: 'key_123',
                userId: 'auth_user_123',
                name: 'Prod key',
                start: 'ypsk_live_abc',
                prefix: 'ypsk_',
                enabled: true,
                permissions: { publicApi: ['verification:read'] },
                metadata: { kind: 'public-api', authUserId: 'auth_user_123' },
                createdAt: 123,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }) as typeof fetch;

      try {
        const config: AuthConfig = {
          baseUrl: 'http://localhost:3001',
          convexSiteUrl: 'https://test-123.convex.site',
          convexUrl: 'https://test-123.convex.site',
        };
        const auth = createAuth(config);
        const req = new Request('http://localhost:3001/connect', {
          headers: {
            cookie: 'yucp.session_token=session-cookie',
          },
        });

        const result = await auth.listApiKeys(req);

        expect(requestUrl).toContain('/api/auth/api-key/list');
        expect(forwardedCookieHeader).toContain('yucp.session_token=session-cookie');
        expect(result.apiKeys).toEqual([
          {
            id: 'key_123',
            userId: 'auth_user_123',
            name: 'Prod key',
            start: 'ypsk_live_abc',
            prefix: 'ypsk_',
            enabled: true,
            permissions: { publicApi: ['verification:read'] },
            metadata: { kind: 'public-api', authUserId: 'auth_user_123' },
            createdAt: 123,
          },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalInternalSecret === undefined) {
          delete process.env.INTERNAL_SERVICE_AUTH_SECRET;
        } else {
          process.env.INTERNAL_SERVICE_AUTH_SECRET = originalInternalSecret;
        }
      }
    });

    it('persistVrchatSession signs internal requests and preserves response cookies', async () => {
      const originalInternalSecret = process.env.INTERNAL_SERVICE_AUTH_SECRET;
      process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-secret';
      const originalFetch = globalThis.fetch;
      let originHeader = '';
      let hasCookieHeader = false;

      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const capturedHeaders = new Headers(init?.headers);
        originHeader = capturedHeaders.get('origin') ?? '';
        hasCookieHeader = capturedHeaders.has('cookie');
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: {
            'set-better-auth-cookie':
              '__Secure-yucp.session_token=; Path=/; Expires=Wed, 12 Mar 2026 10:00:00 GMT; HttpOnly',
            'set-cookie': 'yucp.session_data=; Path=/; Max-Age=0; HttpOnly',
          },
        });
      }) as typeof fetch;

      try {
        const config: AuthConfig = {
          baseUrl: 'http://localhost:3001',
          convexSiteUrl: 'https://test-123.convex.site',
          convexUrl: 'https://test-123.convex.site',
        };
        const auth = createAuth(config);
        const result = await auth.persistVrchatSession(
          { id: 'usr_123', username: 'user', displayName: 'User' },
          { authToken: 'auth-cookie', twoFactorAuthToken: '2fa-cookie' },
          'foo=bar'
        );

        expect(result.response.status).toBe(200);
        expect(result.browserSetCookies).toHaveLength(2);
        expect(result.browserSetCookies).toContain(
          '__Secure-yucp.session_token=; Path=/; Expires=Wed, 12 Mar 2026 10:00:00 GMT; HttpOnly'
        );
        expect(originHeader).toBe('http://localhost:3001');
        expect(hasCookieHeader).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
        process.env.INTERNAL_SERVICE_AUTH_SECRET = originalInternalSecret;
      }
    });

    it('production config uses secure cookie attributes', () => {
      const prodConfig = createCookieConfig(true);
      const devConfig = createCookieConfig(false);
      expect(prodConfig.session_token.attributes.secure).toBe(true);
      expect(prodConfig.session_token.attributes.sameSite).toBe('strict');
      expect(devConfig.session_token.attributes.secure).toBe(false);
      expect(devConfig.session_token.attributes.sameSite).toBe('lax');
    });
  });
});
