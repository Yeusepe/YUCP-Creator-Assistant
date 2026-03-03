/**
 * Tests for Install routes
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  BOT_PERMISSIONS,
  generateState,
  storeInstallState,
  validateInstallState,
  createInstallRoutes,
  type InstallConfig,
} from './install';

// Mock auth instance
const mockSession = {
  user: {
    id: 'test-user-id',
    email: 'test@example.com',
    name: 'Test User',
  },
  session: {
    id: 'test-session-id',
    expiresAt: new Date(Date.now() + 86400000),
  },
};

const mockAuth = {
  handler: mock(() => new Response()),
  api: {
    getSession: mock(() => mockSession),
    signOut: mock(() => {}),
  },
} as unknown as ReturnType<typeof import('../auth').createAuth>;

const testConfig: InstallConfig = {
  discordClientId: 'test-discord-client-id',
  discordClientSecret: 'test-discord-client-secret',
  discordBotToken: 'test-bot-token',
  baseUrl: 'http://localhost:3001',
  frontendUrl: 'http://localhost:3000',
  convexUrl: 'http://localhost:3210',
  convexApiSecret: 'test-convex-api-secret',
};

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
      const tenantId = 'tenant-123';
      const authUserId = 'user-456';

      await storeInstallState(state, tenantId, authUserId);
      const retrieved = await validateInstallState(state);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.tenantId).toBe(tenantId);
      expect(retrieved!.authUserId).toBe(authUserId);
    });

    it('returns null for invalid state', async () => {
      const retrieved = await validateInstallState('invalid-state');
      expect(retrieved).toBeNull();
    });

    it('consumes state on validation (single use)', async () => {
      const state = generateState();
      const tenantId = 'tenant-123';
      const authUserId = 'user-456';

      await storeInstallState(state, tenantId, authUserId);

      // First validation should succeed
      const first = await validateInstallState(state);
      expect(first).not.toBeNull();

      // Second validation should fail (state consumed)
      const second = await validateInstallState(state);
      expect(second).toBeNull();
    });
  });
});

describe('Install Routes', () => {
  const routes = createInstallRoutes(mockAuth, testConfig);

  describe('initiateBotInstall', () => {
    it('returns 401 when not authenticated', async () => {
      const unauthenticatedAuth = {
        handler: mock(() => new Response()),
        api: {
          getSession: mock(() => null),
          signOut: mock(() => {}),
        },
      } as unknown as ReturnType<typeof import('../auth').createAuth>;

      const unauthRoutes = createInstallRoutes(unauthenticatedAuth, testConfig);
      const request = new Request('http://localhost:3001/api/install/bot?tenantId=tenant-123');
      const response = await unauthRoutes.initiateBotInstall(request);

      expect(response.status).toBe(401);
    });

    it('returns 400 when tenantId is missing', async () => {
      const request = new Request('http://localhost:3001/api/install/bot');
      const response = await routes.initiateBotInstall(request);
      const data = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe('tenantId is required');
    });

    it('redirects to Discord OAuth with bot scope', async () => {
      const request = new Request('http://localhost:3001/api/install/bot?tenantId=tenant-123');
      const response = await routes.initiateBotInstall(request);

      expect(response.status).toBe(302);
      const location = response.headers.get('location');
      expect(location).toContain('discord.com/api/oauth2/authorize');
      expect(location).toContain('client_id=test-discord-client-id');
      expect(location).toContain('scope=bot+applications.commands');
    });

    it('includes permissions parameter', async () => {
      const request = new Request('http://localhost:3001/api/install/bot?tenantId=tenant-123');
      const response = await routes.initiateBotInstall(request);

      const location = response.headers.get('location');
      const url = new URL(location!);
      const permissions = url.searchParams.get('permissions');

      expect(permissions).not.toBeNull();
    });

    it('pre-selects guild when guildId is provided', async () => {
      const request = new Request(
        'http://localhost:3001/api/install/bot?tenantId=tenant-123&guildId=guild-456'
      );
      const response = await routes.initiateBotInstall(request);

      const location = response.headers.get('location');
      const url = new URL(location!);

      expect(url.searchParams.get('guild_id')).toBe('guild-456');
      expect(url.searchParams.get('disable_guild_select')).toBe('true');
    });

    it('includes state parameter for CSRF protection', async () => {
      const request = new Request('http://localhost:3001/api/install/bot?tenantId=tenant-123');
      const response = await routes.initiateBotInstall(request);

      const location = response.headers.get('location');
      const url = new URL(location!);
      const state = url.searchParams.get('state');

      expect(state).not.toBeNull();
      expect(state!.length).toBe(64);
    });
  });

  describe('checkGuildHealth', () => {
    it('returns 400 when guildId is missing', async () => {
      const request = new Request('http://localhost:3001/api/install/health');
      const response = await routes.checkGuildHealth(request);
      const data = await response.json() as { error: string };

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
      const unauthenticatedAuth = {
        handler: mock(() => new Response()),
        api: {
          getSession: mock(() => null),
          signOut: mock(() => {}),
        },
      } as unknown as ReturnType<typeof import('../auth').createAuth>;

      const unauthRoutes = createInstallRoutes(unauthenticatedAuth, testConfig);
      const request = new Request('http://localhost:3001/api/install/uninstall/guild-123', {
        method: 'POST',
      });
      const response = await unauthRoutes.uninstallFromGuild(request);

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
