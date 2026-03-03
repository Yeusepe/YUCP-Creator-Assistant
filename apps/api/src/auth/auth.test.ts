/**
 * Tests for auth module configuration and utilities
 */

import { describe, expect, it } from 'bun:test';
import {
  type DiscordProviderConfig,
  createDiscordProvider,
  validateDiscordConfig,
} from './discord';
import { type AuthConfig, createAuth } from './index';
import {
  DEV_COOKIE_ATTRIBUTES,
  SECURE_COOKIE_ATTRIBUTES,
  createCookieConfig,
  createSessionConfig,
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
    it('creates auth with session and OTT helpers', () => {
      const config: AuthConfig = {
        baseUrl: 'http://localhost:3001',
        convexSiteUrl: 'https://test-123.convex.site',
      };
      const auth = createAuth(config);
      expect(auth).toHaveProperty('getSession');
      expect(auth).toHaveProperty('exchangeOTT');
      expect(auth).toHaveProperty('signOut');
      expect(typeof auth.getSession).toBe('function');
      expect(typeof auth.exchangeOTT).toBe('function');
      expect(typeof auth.signOut).toBe('function');
    });

    it('getSession returns null when no cookies', async () => {
      const config: AuthConfig = {
        baseUrl: 'http://localhost:3001',
        convexSiteUrl: 'https://test-123.convex.site',
      };
      const auth = createAuth(config);
      const req = new Request('http://localhost:3001/connect');
      // This will fail to reach Convex in tests, but should not throw
      const session = await auth.getSession(req);
      expect(session).toBeNull();
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
