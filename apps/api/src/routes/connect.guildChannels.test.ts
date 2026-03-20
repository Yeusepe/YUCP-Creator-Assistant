/**
 * Tests for auth-token based connect route behavior.
 *
 * These tests cover the setup-session path that replaced the old Better Auth
 * bridge. The routes should accept a bound setup token and resolve their
 * Convex-backed operations without needing a browser session cookie.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { Auth } from '../auth';
import type { ConnectConfig } from './connect';

let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;

const apiMock = {
  creatorProfiles: {
    getCreatorProfile: 'creatorProfiles.getCreatorProfile',
  },
  guildLinks: {
    getGuildLinkForUninstall: 'guildLinks.getGuildLinkForUninstall',
  },
  providerConnections: {
    getConnectionForDisconnect: 'providerConnections.getConnectionForDisconnect',
    disconnectConnection: 'providerConnections.disconnectConnection',
    updateTenantSetting: 'providerConnections.updateTenantSetting',
  },
} as const;

/**
 * Shared in-memory state store that both createSetupSession (imported at top-level)
 * and resolveSetupSession (used inside connect.ts) will use. This avoids bun
 * mock.module causing the stateStore singleton to diverge across module instances.
 */
const testStore = new Map<string, { value: string; expiresAt?: number }>();

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
}));

mock.module('../lib/stateStore', () => ({
  getStateStore: () => ({
    get: async (key: string): Promise<string | null> => {
      const entry = testStore.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
        testStore.delete(key);
        return null;
      }
      return entry.value;
    },
    set: async (key: string, value: string, ttlMs?: number): Promise<void> => {
      const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;
      testStore.set(key, { value, expiresAt });
    },
    delete: async (key: string): Promise<void> => {
      testStore.delete(key);
    },
  }),
}));

mock.module('../lib/convex', () => ({
  getConvexApiSecret: () => 'test-convex-secret',
  getConvexClient: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: (...args: unknown[]) => mutationImpl(...args),
  }),
  getConvexClientFromUrl: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: (...args: unknown[]) => mutationImpl(...args),
  }),
}));

const { createSetupSession } = await import('../lib/setupSession');
const { createConnectRoutes } = await import('./connect');

const ENCRYPTION_SECRET = 'test-encryption-secret-32chars!!';

const testConfig: ConnectConfig = {
  apiBaseUrl: 'http://localhost:3001',
  frontendBaseUrl: 'http://localhost:3000',
  convexSiteUrl: 'http://localhost:3210',
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
  discordBotToken: undefined,
  convexApiSecret: 'test-convex-secret',
  convexUrl: 'http://localhost:3210',
  encryptionSecret: ENCRYPTION_SECRET,
};

const auth = {
  getSession: async () => null,
  getDiscordUserId: async () => null,
} as unknown as Auth;

const routes = createConnectRoutes(auth, testConfig);

afterEach(() => {
  queryImpl = async () => null;
  mutationImpl = async () => null;
  testStore.clear();
});

describe('GET /api/connect/guild/channels', () => {
  it('returns 401 when no setup session token is present', async () => {
    const req = new Request('http://localhost:3001/api/connect/guild/channels');
    const res = await routes.getGuildChannels(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/authentication required/i);
  });

  it('returns channels for a valid setup session token without a browser session', async () => {
    const token = await createSetupSession(
      'user-test-001',
      'guild-test-001',
      'discord-user-001',
      ENCRYPTION_SECRET
    );
    const req = new Request('http://localhost:3001/api/connect/guild/channels', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await routes.getGuildChannels(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: Array<{ id: string; name: string; type: number }>;
    };
    expect(body.channels).toEqual([]);
  });

  it('returns 401 when no setup token exists and the web-session path is missing auth', async () => {
    const req = new Request(
      'http://localhost:3001/api/connect/guild/channels?authUserId=some-user'
    );
    const res = await routes.getGuildChannels(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/authentication required/i);
  });
});

describe('GET /api/connect/settings (setup-session path)', () => {
  it('returns 401 when no session is present', async () => {
    const req = new Request('http://localhost:3001/api/connect/settings?authUserId=some-user');
    const res = await routes.getSettingsHandler(req);
    expect(res.status).toBe(401);
  });

  it('returns settings for a valid setup session token without a browser session', async () => {
    queryImpl = async () => ({ policy: { allowMismatchedEmails: true } });

    const token = await createSetupSession(
      'user-test-002',
      'guild-test-002',
      'discord-user-002',
      ENCRYPTION_SECRET
    );
    const req = new Request('http://localhost:3001/api/connect/settings', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await routes.getSettingsHandler(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { policy: { allowMismatchedEmails: boolean } };
    expect(body.policy.allowMismatchedEmails).toBe(true);
  });

  it('returns a controlled error when tenant ownership resolution fails in the web-session path', async () => {
    queryImpl = async (_reference: unknown, args: unknown) => {
      const record = args as { authUserId?: string };
      if (record.authUserId === 'tenant-123') {
        throw new Error('convex offline');
      }
      return null;
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-123',
        },
      }),
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/settings?authUserId=tenant-123');

    const res = await isolatedRoutes.getSettingsHandler(req);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/tenant ownership/i);
  });

  it('returns a controlled error when session resolution fails in the web-session path', async () => {
    const fakeAuth = {
      getSession: async () => {
        throw new Error('session store offline');
      },
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/settings?authUserId=tenant-456');

    const res = await isolatedRoutes.getSettingsHandler(req);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/session/i);
  });
});

describe('DELETE /api/connections (disconnect) - setup-session path', () => {
  it('returns 401 when no auth is present', async () => {
    const req = new Request('http://localhost:3001/api/connections?id=conn-1&authUserId=user-1', {
      method: 'DELETE',
    });
    const res = await routes.disconnectConnectionHandler(req);
    expect(res.status).toBe(401);
  });

  it('disconnects a connection with a valid setup session token', async () => {
    queryImpl = async () => null;
    mutationImpl = async () => null;

    const token = await createSetupSession(
      'user-test-004',
      'guild-test-004',
      'discord-user-004',
      ENCRYPTION_SECRET
    );
    const req = new Request('http://localhost:3001/api/connections?id=conn-2', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await routes.disconnectConnectionHandler(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});

describe('GET /api/connect/guild/channels (web-session path)', () => {
  it('allows a tenant-owned guild when authUserId differs from the session user id', async () => {
    queryImpl = async (_reference: unknown, args: unknown) => {
      const record = args as { authUserId?: string; discordGuildId?: string };
      if (record.authUserId === 'tenant-123') {
        return { authUserId: 'session-user-123' };
      }
      if (record.discordGuildId === 'guild-123') {
        return { authUserId: 'tenant-123' };
      }
      return null;
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-123',
        },
      }),
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request(
      'http://localhost:3001/api/connect/guild/channels?guildId=guild-123&authUserId=tenant-123'
    );

    const res = await isolatedRoutes.getGuildChannels(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: unknown[] };
    expect(body.channels).toEqual([]);
  });
});

describe('POST /api/connect/settings (setup-session path)', () => {
  it('returns 401 when no session is present', async () => {
    const req = new Request('http://localhost:3001/api/connect/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'allowMismatchedEmails', value: true, authUserId: 'some-user' }),
    });
    const res = await routes.updateSettingHandler(req);
    expect(res.status).toBe(401);
  });

  it('updates a setting for a valid setup session token without a browser session', async () => {
    mutationImpl = async () => null;

    const token = await createSetupSession(
      'user-test-003',
      'guild-test-003',
      'discord-user-003',
      ENCRYPTION_SECRET
    );
    const req = new Request('http://localhost:3001/api/connect/settings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'allowMismatchedEmails', value: true }),
    });
    const res = await routes.updateSettingHandler(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
