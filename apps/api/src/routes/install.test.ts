/**
 * Tests for Install routes.
 *
 * No mocks: uses real createAuth(). Requests without a valid session cookie
 * get null from getSession and receive 401. Assume smoke until proven otherwise.
 */

import { describe, expect, it } from 'bun:test';
import type { Auth } from '../auth';
import { createAuth } from '../auth';
import {
  BOT_PERMISSIONS,
  createInstallRoutes,
  generateState,
  type InstallConfig,
  storeInstallState,
  validateInstallState,
} from './install';

const testConfig: InstallConfig = {
  discordClientId: 'test-discord-client-id',
  discordClientSecret: 'test-discord-client-secret',
  discordBotToken: 'test-bot-token',
  baseUrl: 'http://localhost:3001',
  frontendUrl: 'http://localhost:3000',
  convexUrl: 'http://localhost:3210',
  convexApiSecret: 'test-convex-api-secret',
};

// Real auth: no cookies => getSession returns null => protected routes return 401
const auth = createAuth({
  baseUrl: testConfig.baseUrl,
  convexSiteUrl: testConfig.convexUrl,
  convexUrl: testConfig.convexUrl,
});

const routes = createInstallRoutes(auth, testConfig);

describe('Install State Management', () => {
  describe('generateState', () => {
    it('generates a 64-character hex string', () => {
      const state = generateState();
      expect(state.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(state)).toBe(true);
    });

    it('generates unique states', () => {
      const state1 = generateState();
      const state2 = generateState();
      expect(state1).not.toBe(state2);
    });
  });

  describe('storeInstallState and validateInstallState', () => {
    it('stores and retrieves state', async () => {
      const state = generateState();
      const authUserId = 'user-456';

      await storeInstallState(state, authUserId);
      const retrieved = await validateInstallState(state);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.authUserId).toBe(authUserId);
    });

    it('returns null for invalid state', async () => {
      const retrieved = await validateInstallState('invalid-state');
      expect(retrieved).toBeNull();
    });

    it('consumes state on validation (single use)', async () => {
      const state = generateState();
      const authUserId = 'user-456';

      await storeInstallState(state, authUserId);

      const first = await validateInstallState(state);
      expect(first).not.toBeNull();

      const second = await validateInstallState(state);
      expect(second).toBeNull();
    });
  });
});

describe('Install Routes', () => {
  describe('initiateBotInstall', () => {
    it('returns 401 when not authenticated', async () => {
      const request = new Request('http://localhost:3001/api/install/bot?authUserId=user-456');
      const response = await routes.initiateBotInstall(request);

      expect(response.status).toBe(401);
    });

    it('defaults the install target to the authenticated user when authUserId is omitted', async () => {
      const authWithSession: Auth = {
        ...auth,
        async getSession() {
          return {
            user: {
              id: 'user-456',
              email: 'user@example.com',
              image: null,
              name: 'User',
            },
          };
        },
      };

      const sessionRoutes = createInstallRoutes(authWithSession, testConfig);
      const response = await sessionRoutes.initiateBotInstall(
        new Request('http://localhost:3001/api/install/bot')
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('location');
      expect(location).toContain('https://discord.com/api/oauth2/authorize');
      expect(location).not.toContain('authUserId=');
      const state = new URL(location as string).searchParams.get('state');
      expect(state).toBeTruthy();
      const installState = await validateInstallState(state as string);
      expect(installState?.authUserId).toBe('user-456');
    });
  });

  describe('checkGuildHealth', () => {
    it('returns 400 when guildId is missing', async () => {
      const request = new Request('http://localhost:3001/api/install/health');
      const response = await routes.checkGuildHealth(request);
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe('guildId is required');
    });
  });

  describe('handleBotInstallCallback', () => {
    it('redirects to error when state is invalid', async () => {
      const request = new Request(
        'http://localhost:3001/api/install/bot/callback?code=abc&state=invalid-state&guild_id=guild-123'
      );
      const response = await routes.handleBotInstallCallback(request);

      expect(response.status).toBe(302);
      const location = response.headers.get('location');
      expect(location).toContain('/install/error');
      expect(location).toContain('error=invalid_state');
    });

    it('redirects to error when code, state, or guild_id is missing', async () => {
      const request = new Request('http://localhost:3001/api/install/bot/callback');
      const response = await routes.handleBotInstallCallback(request);

      expect(response.status).toBe(302);
      const location = response.headers.get('location');
      expect(location).toContain('/install/error');
      expect(location).toContain('error=missing_parameters');
    });

    it('redirects to error when Discord returns error param', async () => {
      const request = new Request(
        'http://localhost:3001/api/install/bot/callback?error=access_denied'
      );
      const response = await routes.handleBotInstallCallback(request);

      expect(response.status).toBe(302);
      const location = response.headers.get('location');
      expect(location).toContain('/install/error');
      expect(location).toContain('error=access_denied');
    });
  });

  describe('uninstallFromGuild', () => {
    it('returns 401 when not authenticated', async () => {
      const request = new Request('http://localhost:3001/api/install/uninstall/guild-123', {
        method: 'POST',
      });
      const response = await routes.uninstallFromGuild(request);

      expect(response.status).toBe(401);
    });
  });
});

describe('Bot Permissions', () => {
  it('has correct permissions value for Manage Roles', () => {
    expect(BOT_PERMISSIONS).toBe(268435456n);
    expect(BOT_PERMISSIONS.toString()).toBe('268435456');
  });
});
