/**
 * Tests for auth-token based connect route behavior.
 *
 * These tests cover the setup-session path that replaced the old Better Auth
 * bridge. The routes should accept a bound setup token and resolve their
 * Convex-backed operations without needing a browser session cookie.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { type Auth, BetterAuthEndpointError } from '../auth';
import type { ConnectConfig } from './connect';

let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let actionImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  synced: false,
  productCount: 0,
  benefitCount: 0,
});
let polarCustomerStateImpl: (externalId: string) => Promise<unknown> = async () => null;

const apiMock = {
  betterAuthApiKeys: {
    backfillApiKeyReferenceIds: 'betterAuthApiKeys.backfillApiKeyReferenceIds',
    listApiKeysForAuthUser: 'betterAuthApiKeys.listApiKeysForAuthUser',
  },
  certificateBillingSync: {
    ensureCatalogFresh: 'certificateBillingSync.ensureCatalogFresh',
  },
  certificateBilling: {
    getAccountOverview: 'certificateBilling.getAccountOverview',
    getShellBrandingForAuthUser: 'certificateBilling.getShellBrandingForAuthUser',
    projectCustomerStateForApi: 'certificateBilling.projectCustomerStateForApi',
    revokeOwnedCertificate: 'certificateBilling.revokeOwnedCertificate',
  },
  creatorProfiles: {
    getCreatorProfile: 'creatorProfiles.getCreatorProfile',
  },
  guildLinks: {
    getGuildLinkForUninstall: 'guildLinks.getGuildLinkForUninstall',
    getUserGuilds: 'guildLinks.getUserGuilds',
  },
  providerConnections: {
    getConnectionForDisconnect: 'providerConnections.getConnectionForDisconnect',
    disconnectConnection: 'providerConnections.disconnectConnection',
    getConnectionStatus: 'providerConnections.getConnectionStatus',
    listConnectionsForUser: 'providerConnections.listConnectionsForUser',
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
  internal: apiMock,
  components: {},
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
    action: (...args: unknown[]) => actionImpl(...args),
  }),
  getConvexClientFromUrl: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: (...args: unknown[]) => mutationImpl(...args),
    action: (...args: unknown[]) => actionImpl(...args),
  }),
}));

mock.module('../lib/polar', () => ({
  fetchCertificateBillingCustomerStateByExternalId: (externalId: string) =>
    polarCustomerStateImpl(externalId),
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
  createPolarCheckout: async () => null,
  createPolarPortal: async () => null,
} as unknown as Auth;

const routes = createConnectRoutes(auth, testConfig);

afterEach(() => {
  queryImpl = async () => null;
  mutationImpl = async () => null;
  actionImpl = async () => ({
    synced: false,
    productCount: 0,
    benefitCount: 0,
  });
  polarCustomerStateImpl = async () => null;
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

describe('GET /api/connect/dashboard/shell', () => {
  it('returns the viewer, shared home shell, and selected server policy in one response', async () => {
    const queriedFns: string[] = [];
    queryImpl = async (fn, args) => {
      queriedFns.push(String(fn));

      if (fn === apiMock.guildLinks.getUserGuilds) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          authUserId: 'user-dashboard-001',
        });
        return [
          {
            authUserId: 'user-dashboard-001',
            guildId: 'guild-dashboard-001',
            name: 'Dashboard Guild',
            icon: 'guild-icon',
          },
        ];
      }

      if (fn === apiMock.providerConnections.listConnectionsForUser) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          authUserId: 'user-dashboard-001',
        });
        return [
          {
            id: 'conn-1',
            provider: 'gumroad',
            label: 'Gumroad Connection',
            connectionType: 'setup',
            status: 'active',
            webhookConfigured: true,
            hasApiKey: false,
            hasAccessToken: true,
            authUserId: 'user-dashboard-001',
            createdAt: 1,
            updatedAt: 2,
          },
        ];
      }

      if (fn === apiMock.creatorProfiles.getCreatorProfile) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          authUserId: 'user-dashboard-001',
        });
        return {
          authUserId: 'user-dashboard-001',
          policy: {
            autoVerifyOnJoin: true,
          },
        };
      }

      if (fn === apiMock.certificateBilling.getShellBrandingForAuthUser) {
        expect(args).toEqual({
          apiSecret: 'test-convex-secret',
          authUserId: 'user-dashboard-001',
        });
        return {
          isPlus: true,
          billingStatus: 'active',
        };
      }

      throw new Error(`Unexpected query fn: ${String(fn)}`);
    };

    const fakeAuth = {
      ...auth,
      getSession: async () => ({
        user: {
          id: 'user-dashboard-001',
          email: 'creator@example.com',
          name: 'Creator Name',
          image: 'https://example.com/avatar.png',
        },
        discordUserId: 'discord-user-001',
      }),
    } as unknown as Auth;
    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);

    const req = new Request(
      'http://localhost:3001/api/connect/dashboard/shell?guildId=guild-dashboard-001&includeHomeData=true',
      {
        headers: { 'x-auth-token': 'viewer-token' },
      }
    );
    const res = await isolatedRoutes.getDashboardShell(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Server-Timing')).toContain('session');
    expect(res.headers.get('Server-Timing')).toContain('convex_guilds');
    expect(res.headers.get('Server-Timing')).toContain('convex_shell_branding');
    expect(res.headers.get('Server-Timing')).toContain('convex_home_connections');
    expect(res.headers.get('Server-Timing')).toContain('selected_policy');
    expect(queriedFns).toEqual([
      apiMock.guildLinks.getUserGuilds,
      apiMock.providerConnections.listConnectionsForUser,
      apiMock.certificateBilling.getShellBrandingForAuthUser,
      apiMock.creatorProfiles.getCreatorProfile,
    ]);

    const body = (await res.json()) as {
      viewer: {
        authUserId: string;
        email: string | null;
        name: string | null;
        image: string | null;
        discordUserId: string | null;
      };
      guilds: Array<{ guildId: string; authUserId: string; name: string; icon: string | null }>;
      home: {
        providers: Array<{ key: string; label?: string }>;
        userAccounts: Array<{ provider: string; label: string }>;
        connectionStatusAuthUserId: string;
        connectionStatusByProvider: Record<string, boolean>;
      };
      selectedServer: {
        authUserId: string;
        guildId: string;
        policy: {
          autoVerifyOnJoin?: boolean;
        };
      };
      branding: {
        isPlus: boolean;
        billingStatus: string | null;
      };
    };

    expect(body.viewer).toEqual({
      authUserId: 'user-dashboard-001',
      email: 'creator@example.com',
      name: 'Creator Name',
      image: 'https://example.com/avatar.png',
      discordUserId: 'discord-user-001',
    });
    expect(body.guilds).toEqual([
      {
        authUserId: 'user-dashboard-001',
        guildId: 'guild-dashboard-001',
        name: 'Dashboard Guild',
        icon: 'guild-icon',
      },
    ]);
    expect(body.home.connectionStatusAuthUserId).toBe('user-dashboard-001');
    expect(body.home.connectionStatusByProvider).toEqual({ gumroad: true });
    expect(body.home.userAccounts).toEqual([
      expect.objectContaining({
        provider: 'gumroad',
        label: 'Gumroad Connection',
      }),
    ]);
    expect(body.home.providers.length).toBeGreaterThan(0);
    expect(body.selectedServer).toEqual({
      authUserId: 'user-dashboard-001',
      guildId: 'guild-dashboard-001',
      policy: {
        autoVerifyOnJoin: true,
      },
    });
    expect(body.branding).toEqual({
      isPlus: true,
      billingStatus: 'active',
    });
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

  it('reuses the creator profile read across tenant ownership and settings lookup', async () => {
    const creatorProfileQueries: Array<{ apiSecret?: string; authUserId?: string }> = [];

    queryImpl = async (reference: unknown, args: unknown) => {
      if (reference === apiMock.creatorProfiles.getCreatorProfile) {
        const record = args as { authUserId?: string };
        creatorProfileQueries.push(record);
        return {
          authUserId: 'session-user-123',
          policy: { allowMismatchedEmails: true },
        };
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

    expect(res.status).toBe(200);
    const body = (await res.json()) as { policy: { allowMismatchedEmails: boolean } };
    expect(body.policy.allowMismatchedEmails).toBe(true);
    expect(creatorProfileQueries).toEqual([
      { apiSecret: 'test-convex-secret', authUserId: 'tenant-123' },
    ]);
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

describe('GET /api/connect/user/connections', () => {
  it('returns creator provider connections for the authenticated owner session', async () => {
    queryImpl = async (fn, args) => {
      expect(fn).toBe(apiMock.providerConnections.listConnectionsForUser);
      expect(args).toEqual({
        apiSecret: 'test-convex-secret',
        authUserId: 'user-dashboard-001',
      });
      return [
        {
          id: 'conn-1',
          provider: 'gumroad',
          label: 'Gumroad Connection',
          connectionType: 'setup',
          status: 'active',
          webhookConfigured: true,
          hasApiKey: false,
          hasAccessToken: true,
          authUserId: 'user-dashboard-001',
          createdAt: 1,
          updatedAt: 2,
        },
      ];
    };

    const fakeAuth = {
      ...auth,
      getSession: async () => ({
        user: {
          id: 'user-dashboard-001',
        },
      }),
    } as unknown as Auth;
    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig) as typeof routes & {
      getUserConnections?: (request: Request) => Promise<Response>;
    };

    const getUserConnections = isolatedRoutes.getUserConnections;
    expect(getUserConnections).toBeDefined();
    if (!getUserConnections) {
      throw new Error('getUserConnections route is not defined');
    }

    const res = await getUserConnections(
      new Request('http://localhost:3001/api/connect/user/connections', {
        headers: { 'x-auth-token': 'viewer-token' },
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connections: [
        {
          id: 'conn-1',
          provider: 'gumroad',
          label: 'Gumroad Connection',
          connectionType: 'setup',
          status: 'active',
          webhookConfigured: true,
          hasApiKey: false,
          hasAccessToken: true,
          authUserId: 'user-dashboard-001',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
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

describe('discord role setup routes', () => {
  it('creates and exchanges a Discord role setup session', async () => {
    const createRes = await routes.createDiscordRoleSession(
      new Request('http://localhost:3001/api/setup/discord-role-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authUserId: 'creator-auth-user',
          guildId: 'guild-123',
          adminDiscordUserId: 'discord-admin-123',
          apiSecret: 'test-convex-secret',
        }),
      })
    );

    expect(createRes.status).toBe(200);
    const createBody = (await createRes.json()) as { token: string };
    expect(createBody.token.length).toBeGreaterThan(0);

    const exchangeRes = await routes.exchangeDiscordRoleSetupSession(
      new Request('http://localhost:3001/api/setup/discord-role-session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: createBody.token }),
      })
    );

    expect(exchangeRes.status).toBe(200);
    expect(exchangeRes.headers.get('Set-Cookie')).toContain(
      `yucp_discord_role_setup=${createBody.token}`
    );
  });

  it('saves a Discord role selection and returns it to the bot result poller', async () => {
    const createRes = await routes.createDiscordRoleSession(
      new Request('http://localhost:3001/api/setup/discord-role-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authUserId: 'creator-auth-user',
          guildId: 'guild-123',
          adminDiscordUserId: 'discord-admin-123',
          apiSecret: 'test-convex-secret',
        }),
      })
    );
    const { token } = (await createRes.json()) as { token: string };
    const sessionEntry = testStore.get(`discord_role_setup:${token}`);
    if (!sessionEntry) {
      throw new Error('Discord role setup session was not stored');
    }
    const session = JSON.parse(sessionEntry.value) as {
      guilds?: Array<{ id: string; name: string }>;
    };
    session.guilds = [{ id: 'source-guild-1', name: 'Source Guild' }];
    testStore.set(`discord_role_setup:${token}`, { value: JSON.stringify(session) });

    const saveRes = await routes.saveDiscordRoleSelection(
      new Request('http://localhost:3001/api/setup/discord-role-save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `yucp_discord_role_setup=${token}`,
        },
        body: JSON.stringify({
          sourceGuildId: 'source-guild-1',
          sourceGuildName: 'Source Guild',
          sourceRoleId: '123456789012345678',
        }),
      })
    );

    expect(saveRes.status).toBe(200);

    const resultRes = await routes.getDiscordRoleResult(
      new Request('http://localhost:3001/api/setup/discord-role-result', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
    );

    expect(resultRes.status).toBe(200);
    const resultBody = (await resultRes.json()) as {
      completed: boolean;
      sourceGuildId: string;
      sourceGuildName: string;
      sourceRoleId: string;
      sourceRoleIds: string[];
      requiredRoleMatchMode: 'any' | 'all';
    };
    expect(resultBody).toEqual({
      completed: true,
      sourceGuildId: 'source-guild-1',
      sourceGuildName: 'Source Guild',
      sourceRoleId: '123456789012345678',
      sourceRoleIds: ['123456789012345678'],
      requiredRoleMatchMode: 'any',
    });
  });
});

describe('GET /api/connect/user/certificates', () => {
  it('returns 401 without an authenticated account session', async () => {
    const req = new Request('http://localhost:3001/api/connect/user/certificates');
    const res = await routes.getUserCertificates(req);
    expect(res.status).toBe(401);
  });

  it('returns the certificate workspace overview for the authenticated account', async () => {
    queryImpl = async (reference: unknown) => {
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return {
          workspaceKey: 'creator-profile:abc123',
          creatorProfileId: 'abc123',
          billing: {
            billingEnabled: true,
            status: 'active',
            allowEnrollment: true,
            allowSigning: true,
            planKey: 'pro',
            deviceCap: 5,
            activeDeviceCount: 1,
          },
          devices: [
            {
              certNonce: 'cert_nonce_1',
              devPublicKey: 'dev_public_key_1',
              publisherId: 'publisher_1',
              publisherName: 'Test Publisher',
              issuedAt: 1,
              expiresAt: 2,
              status: 'active',
            },
          ],
          availablePlans: [],
        };
      }
      return null;
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-1',
        },
      }),
      createPolarCheckout: async () => null,
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates');
    const res = await isolatedRoutes.getUserCertificates(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Server-Timing')).toMatch(
      /session;dur=.*convex_certificate_overview;dur=.*serialize;dur=.*total;dur=/
    );
    const body = (await res.json()) as {
      workspaceKey: string;
      billing: { planKey: string };
      devices: Array<{ certNonce: string }>;
    };
    expect(body.workspaceKey).toBe('creator-profile:abc123');
    expect(body.billing.planKey).toBe('pro');
    expect(body.devices[0]?.certNonce).toBe('cert_nonce_1');
  });

  it('recovers an inactive overview by reconciling customer state from Polar once', async () => {
    let projected = false;
    queryImpl = async (reference: unknown) => {
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        if (!projected) {
          return {
            workspaceKey: 'creator-profile:recover-1',
            creatorProfileId: 'recover-1',
            billing: {
              billingEnabled: true,
              status: 'inactive',
              allowEnrollment: false,
              allowSigning: false,
              activeDeviceCount: 0,
            },
            devices: [],
            availablePlans: [
              {
                planKey: 'creator-studio-plus',
                slug: 'creator-studio-plus',
                productId: 'prod_creator_studio_plus',
                displayName: 'Creator Studio+',
                description: 'Everything in one plan',
                highlights: ['Moderation Lookup', 'Protected Exports'],
                priority: 1,
                deviceCap: 5,
                auditRetentionDays: 90,
                supportTier: 'premium',
                billingGraceDays: 0,
                capabilities: ['moderation_lookup', 'protected_exports', 'coupling_traceability'],
                meteredPrices: [],
              },
            ],
            meters: [],
          };
        }

        return {
          workspaceKey: 'creator-profile:recover-1',
          creatorProfileId: 'recover-1',
          billing: {
            billingEnabled: true,
            status: 'active',
            allowEnrollment: true,
            allowSigning: true,
            planKey: 'creator-studio-plus',
            productId: 'prod_creator_studio_plus',
            deviceCap: 5,
            activeDeviceCount: 0,
            signQuotaPerPeriod: 1000,
            auditRetentionDays: 90,
            supportTier: 'premium',
            capabilities: [
              { capabilityKey: 'moderation_lookup', status: 'active' },
              { capabilityKey: 'protected_exports', status: 'active' },
              { capabilityKey: 'coupling_traceability', status: 'active' },
            ],
          },
          devices: [],
          availablePlans: [
            {
              planKey: 'creator-studio-plus',
              slug: 'creator-studio-plus',
              productId: 'prod_creator_studio_plus',
              displayName: 'Creator Studio+',
              description: 'Everything in one plan',
              highlights: ['Moderation Lookup', 'Protected Exports'],
              priority: 1,
              deviceCap: 5,
              auditRetentionDays: 90,
              supportTier: 'premium',
              billingGraceDays: 0,
              capabilities: ['moderation_lookup', 'protected_exports', 'coupling_traceability'],
              meteredPrices: [],
            },
          ],
          meters: [],
        };
      }
      return null;
    };

    polarCustomerStateImpl = async (externalId: string) => {
      expect(externalId).toBe('session-user-recover');
      return {
        id: 'cus_recover_1',
        email: 'creator@example.com',
        externalId: 'session-user-recover',
        activeSubscriptions: [
          {
            id: 'sub_recover_1',
            status: 'active',
            recurringInterval: 'month',
            currentPeriodStart: new Date('2026-03-23T00:00:00.000Z'),
            currentPeriodEnd: new Date('2026-04-23T00:00:00.000Z'),
            cancelAtPeriodEnd: false,
            productId: 'prod_creator_studio_plus',
            metadata: {
              workspace_key: 'creator-profile:recover-1',
            },
          },
        ],
        grantedBenefits: [
          {
            id: 'grant_limits',
            benefitId: 'benefit_limits',
            benefitType: 'feature_flag',
            benefitMetadata: {
              device_cap: '5',
              sign_quota_per_period: '1000',
              audit_retention_days: '90',
              support_tier: 'premium',
              tier_rank: '100',
            },
          },
          {
            id: 'grant_moderation',
            benefitId: 'benefit_moderation',
            benefitType: 'feature_flag',
            benefitMetadata: {
              moderation_lookup: 'true',
            },
          },
        ],
        activeMeters: [],
      };
    };

    mutationImpl = async (reference: unknown, args: unknown) => {
      expect(reference).toBe(apiMock.certificateBilling.projectCustomerStateForApi);
      expect(args).toMatchObject({
        apiSecret: 'test-convex-secret',
        authUserId: 'session-user-recover',
        polarCustomerId: 'cus_recover_1',
        customerEmail: 'creator@example.com',
      });
      projected = true;
      return { updated: true, workspaceCount: 1 };
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-recover',
        },
      }),
      createPolarCheckout: async () => null,
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates');
    const res = await isolatedRoutes.getUserCertificates(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      billing: { status: string; planKey?: string; productId?: string; deviceCap?: number };
    };
    expect(projected).toBe(true);
    expect(body.billing.status).toBe('active');
    expect(body.billing.planKey).toBe('creator-studio-plus');
    expect(body.billing.productId).toBe('prod_creator_studio_plus');
    expect(body.billing.deviceCap).toBe(5);
  });

  it('reconciles certificate billing through the explicit Polar recovery endpoint', async () => {
    let projected = false;
    queryImpl = async (reference: unknown) => {
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        if (!projected) {
          return {
            workspaceKey: 'creator-profile:sync-1',
            creatorProfileId: 'sync-1',
            billing: {
              billingEnabled: true,
              status: 'inactive',
              allowEnrollment: false,
              allowSigning: false,
              activeDeviceCount: 0,
            },
            devices: [],
            availablePlans: [
              {
                planKey: 'starter',
                slug: 'starter',
                productId: 'prod_starter',
                displayName: 'Starter',
                description: 'Entry tier',
                highlights: ['Up to 2 signing devices'],
                priority: 1,
                deviceCap: 2,
                auditRetentionDays: 30,
                supportTier: 'standard',
                billingGraceDays: 3,
                capabilities: ['protected_exports'],
                meteredPrices: [],
              },
            ],
            meters: [],
          };
        }

        return {
          workspaceKey: 'creator-profile:sync-1',
          creatorProfileId: 'sync-1',
          billing: {
            billingEnabled: true,
            status: 'active',
            allowEnrollment: true,
            allowSigning: true,
            planKey: 'starter',
            deviceCap: 2,
            activeDeviceCount: 0,
            auditRetentionDays: 30,
            supportTier: 'standard',
            currentPeriodEnd: 1_742_850_400_000,
            capabilities: [
              {
                capabilityKey: 'protected_exports',
                status: 'granted',
              },
            ],
          },
          devices: [],
          availablePlans: [
            {
              planKey: 'starter',
              slug: 'starter',
              productId: 'prod_starter',
              displayName: 'Starter',
              description: 'Entry tier',
              highlights: ['Up to 2 signing devices'],
              priority: 1,
              deviceCap: 2,
              auditRetentionDays: 30,
              supportTier: 'standard',
              billingGraceDays: 3,
              capabilities: ['protected_exports'],
              meteredPrices: [],
            },
          ],
          meters: [],
        };
      }
      return null;
    };

    polarCustomerStateImpl = async (externalId: string) => {
      expect(externalId).toBe('session-user-sync');
      return {
        id: 'cus_sync_1',
        email: 'creator@example.com',
        externalId: 'session-user-sync',
        activeSubscriptions: [
          {
            id: 'sub_sync_1',
            status: 'active',
            recurringInterval: 'month',
            currentPeriodStart: new Date('2026-03-23T00:00:00.000Z'),
            currentPeriodEnd: new Date('2026-04-23T00:00:00.000Z'),
            cancelAtPeriodEnd: false,
            productId: 'prod_starter',
            metadata: {
              workspace_key: 'creator-profile:sync-1',
            },
          },
        ],
        grantedBenefits: [],
        activeMeters: [],
      };
    };

    mutationImpl = async (reference: unknown, args: unknown) => {
      expect(reference).toBe(apiMock.certificateBilling.projectCustomerStateForApi);
      expect(args).toMatchObject({
        apiSecret: 'test-convex-secret',
        authUserId: 'session-user-sync',
        polarCustomerId: 'cus_sync_1',
        customerEmail: 'creator@example.com',
        activeSubscriptions: [
          {
            subscriptionId: 'sub_sync_1',
            productId: 'prod_starter',
            status: 'active',
            recurringInterval: 'month',
            cancelAtPeriodEnd: false,
            metadata: {
              workspace_key: 'creator-profile:sync-1',
            },
          },
        ],
        grantedBenefits: [],
        activeMeters: [],
      });
      projected = true;
      return { updated: true, workspaceCount: 1 };
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-sync',
        },
      }),
      createPolarCheckout: async () => null,
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates/reconcile', {
      method: 'POST',
    });
    const res = await isolatedRoutes.reconcileUserCertificateBilling(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Server-Timing')).toMatch(
      /session;dur=.*convex_certificate_catalog;dur=.*provider_polar_customer_state;dur=.*convex_certificate_project_customer_state;dur=.*convex_certificate_overview;dur=.*serialize;dur=.*total;dur=/
    );
    const body = (await res.json()) as {
      reconciled: boolean;
      overview: {
        billing: { status: string; planKey?: string; allowSigning: boolean };
      };
    };
    expect(body.reconciled).toBe(true);
    expect(body.overview.billing.status).toBe('active');
    expect(body.overview.billing.planKey).toBe('starter');
    expect(body.overview.billing.allowSigning).toBe(true);
  });

  it('returns 503 when reconcile detects a Polar credential failure', async () => {
    polarCustomerStateImpl = async () => {
      const error = new Error('The configured Polar access token is expired.');
      Object.assign(error, {
        code: 'polar_access_token_invalid',
      });
      throw error;
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-sync',
        },
      }),
      createPolarCheckout: async () => null,
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates/reconcile', {
      method: 'POST',
    });
    const res = await isolatedRoutes.reconcileUserCertificateBilling(req);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('polar_access_token_invalid');
    expect(body.error).toContain('configured Polar organization access token is invalid');
  });
});

describe('GET /api/connect/public-api/keys', () => {
  it('uses the indexed Convex API key path and backfills legacy keys once', async () => {
    let listCalls = 0;
    queryImpl = async (reference: unknown, args: unknown) => {
      if (reference === apiMock.creatorProfiles.getCreatorProfile) {
        expect(args).toMatchObject({
          apiSecret: 'test-convex-secret',
          authUserId: 'tenant-auth-user-1',
        });
        return {
          authUserId: 'session-owner-1',
        };
      }

      if (reference === apiMock.betterAuthApiKeys.listApiKeysForAuthUser) {
        listCalls += 1;
        expect(args).toMatchObject({
          apiSecret: 'test-convex-secret',
          authUserId: 'tenant-auth-user-1',
        });

        if (listCalls === 1) {
          return [];
        }

        return [
          {
            id: 'key_1',
            name: 'Verification Key',
            start: 'ypsk_',
            prefix: 'ypsk_',
            enabled: true,
            permissions: {
              publicApi: ['verification:read'],
            },
            lastRequestAt: 1_742_840_000_000,
            expiresAt: null,
            createdAt: 1_742_830_000_000,
          },
        ];
      }

      return null;
    };

    mutationImpl = async (reference: unknown, args: unknown) => {
      expect(reference).toBe(apiMock.betterAuthApiKeys.backfillApiKeyReferenceIds);
      expect(args).toMatchObject({
        apiSecret: 'test-convex-secret',
        ownerUserId: 'session-owner-1',
        authUserId: 'tenant-auth-user-1',
      });
      return { updatedCount: 1 };
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-owner-1',
        },
      }),
      listApiKeys: async () => {
        throw new Error('slow Better Auth list path should not be used');
      },
      createPolarCheckout: async () => null,
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request(
      'http://localhost:3001/api/connect/public-api/keys?authUserId=tenant-auth-user-1'
    );
    const res = await isolatedRoutes.listPublicApiKeys(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: Array<{
        _id: string;
        authUserId: string | undefined;
        name: string;
        status: string;
        scopes: string[];
      }>;
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      _id: 'key_1',
      authUserId: 'tenant-auth-user-1',
      name: 'Verification Key',
      status: 'active',
      scopes: ['verification:read'],
    });
    expect(listCalls).toBe(2);
  });
});

describe('POST /api/connect/user/certificates/checkout', () => {
  it('passes the workspace key, product, and embed settings to Polar checkout', async () => {
    queryImpl = async (reference: unknown) => {
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return {
          workspaceKey: 'creator-profile:checkout-1',
          creatorProfileId: 'checkout-1',
          billing: {
            billingEnabled: true,
            status: 'inactive',
            allowEnrollment: false,
            allowSigning: false,
            activeDeviceCount: 0,
          },
          devices: [],
          availablePlans: [
            {
              planKey: 'starter',
              slug: 'starter',
              productId: 'prod_starter',
              displayName: 'Starter',
              description: 'Entry tier',
              highlights: ['Up to 2 signing devices'],
              priority: 1,
              deviceCap: 2,
              auditRetentionDays: 30,
              supportTier: 'standard',
              billingGraceDays: 3,
              capabilities: ['protected_exports'],
              meteredPrices: [],
            },
          ],
          meters: [],
        };
      }
      return null;
    };

    let checkoutPayload: Record<string, unknown> | null = null;
    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-2',
        },
      }),
      createPolarCheckout: async (_request: Request, payload: Record<string, unknown>) => {
        checkoutPayload = payload;
        return {
          url: 'https://polar.example.test/checkout',
          redirect: false,
        };
      },
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planKey: 'starter' }),
    });
    const res = await isolatedRoutes.createUserCertificateCheckout(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Server-Timing')).toMatch(
      /session;dur=.*convex_certificate_overview;dur=.*provider_polar_checkout;dur=.*serialize;dur=.*total;dur=/
    );
    expect(checkoutPayload).toMatchObject({
      products: ['prod_starter'],
      referenceId: 'creator-profile:checkout-1',
      externalCustomerId: 'session-user-2',
      embedOrigin: 'http://localhost:3000',
      successUrl: 'http://localhost:3000/dashboard/billing',
      returnUrl: 'http://localhost:3000/dashboard/billing',
      metadata: {
        workspace_key: 'creator-profile:checkout-1',
        product_id: 'prod_starter',
        plan_key: 'starter',
      },
    });
  });

  it('returns 409 when the auth layer cannot initialize certificate checkout', async () => {
    queryImpl = async (reference: unknown) => {
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return {
          workspaceKey: 'creator-profile:checkout-2',
          creatorProfileId: 'checkout-2',
          billing: {
            billingEnabled: true,
            status: 'inactive',
            allowEnrollment: false,
            allowSigning: false,
            activeDeviceCount: 0,
          },
          devices: [],
          availablePlans: [
            {
              planKey: 'starter',
              slug: 'starter',
              productId: 'prod_starter',
              displayName: 'Starter',
              description: 'Entry tier',
              highlights: ['Up to 2 signing devices'],
              priority: 1,
              deviceCap: 2,
              auditRetentionDays: 30,
              supportTier: 'standard',
              billingGraceDays: 3,
              capabilities: ['protected_exports'],
              meteredPrices: [],
            },
          ],
          meters: [],
        };
      }
      return null;
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-2',
        },
      }),
      createPolarCheckout: async () => null,
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planKey: 'starter' }),
    });
    const res = await isolatedRoutes.createUserCertificateCheckout(req);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Could not initialize certificate checkout');
  });

  it('returns 404 when the requested certificate plan does not exist', async () => {
    queryImpl = async (reference: unknown) => {
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return {
          workspaceKey: 'creator-profile:checkout-3',
          creatorProfileId: 'checkout-3',
          billing: {
            billingEnabled: true,
            status: 'inactive',
            allowEnrollment: false,
            allowSigning: false,
            activeDeviceCount: 0,
          },
          devices: [],
          availablePlans: [
            {
              planKey: 'starter',
              slug: 'starter',
              productId: 'prod_starter',
              displayName: 'Starter',
              description: 'Entry tier',
              highlights: ['Up to 2 signing devices'],
              priority: 1,
              deviceCap: 2,
              auditRetentionDays: 30,
              supportTier: 'standard',
              billingGraceDays: 3,
              capabilities: ['protected_exports'],
              meteredPrices: [],
            },
          ],
          meters: [],
        };
      }
      return null;
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-2',
        },
      }),
      createPolarCheckout: async () => ({
        url: 'https://polar.example.test/checkout',
        redirect: false,
      }),
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planKey: 'missing-plan' }),
    });
    const res = await isolatedRoutes.createUserCertificateCheckout(req);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Unknown certificate product');
  });

  it('returns 503 when certificate billing is not configured', async () => {
    queryImpl = async (reference: unknown) => {
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return {
          workspaceKey: 'creator-profile:checkout-4',
          creatorProfileId: 'checkout-4',
          billing: {
            billingEnabled: false,
            status: 'unmanaged',
            allowEnrollment: true,
            allowSigning: true,
            activeDeviceCount: 0,
          },
          devices: [],
          availablePlans: [],
          meters: [],
        };
      }
      return null;
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-2',
        },
      }),
      createPolarCheckout: async () => ({
        url: 'https://polar.example.test/checkout',
        redirect: false,
      }),
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planKey: 'starter' }),
    });
    const res = await isolatedRoutes.createUserCertificateCheckout(req);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Certificate billing is not configured');
  });

  it('returns 503 when Polar rejects the configured access token for checkout', async () => {
    queryImpl = async (reference: unknown) => {
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return {
          workspaceKey: 'creator-profile:checkout-5',
          creatorProfileId: 'checkout-5',
          billing: {
            billingEnabled: true,
            status: 'inactive',
            allowEnrollment: false,
            allowSigning: false,
            activeDeviceCount: 0,
          },
          devices: [],
          availablePlans: [
            {
              planKey: 'starter',
              slug: 'starter',
              productId: 'prod_starter',
              displayName: 'Starter',
              description: 'Entry tier',
              highlights: ['Up to 2 signing devices'],
              priority: 1,
              deviceCap: 2,
              auditRetentionDays: 30,
              supportTier: 'standard',
              billingGraceDays: 3,
              capabilities: ['protected_exports'],
              meteredPrices: [],
            },
          ],
          meters: [],
        };
      }
      return null;
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-2',
        },
      }),
      createPolarCheckout: async () => {
        throw new BetterAuthEndpointError(
          '/checkout',
          500,
          {
            error:
              'Polar checkout creation failed. Error: API error occurred: Status 401\nBody: {"error":"invalid_token","error_description":"The access token provided is expired, revoked, malformed, or invalid for other reasons."}',
          },
          '{"error":"Polar checkout creation failed. Error: API error occurred: Status 401\\nBody: {\\"error\\":\\"invalid_token\\"}"}'
        );
      },
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planKey: 'starter' }),
    });
    const res = await isolatedRoutes.createUserCertificateCheckout(req);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('polar_access_token_invalid');
    expect(body.error).toContain('POLAR_ACCESS_TOKEN');
    expect(body.error).toContain('POLAR_SERVER');
  });
});

describe('GET /api/connect/user/certificates/portal', () => {
  it('returns 503 when Polar rejects the configured access token for portal sessions', async () => {
    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-4',
        },
      }),
      createPolarCheckout: async () => null,
      createPolarPortal: async () => {
        throw new BetterAuthEndpointError(
          '/customer/portal',
          500,
          {
            error:
              'Polar portal creation failed. Error: API error occurred: Status 401\nBody: {"error":"invalid_token","error_description":"The access token provided is expired, revoked, malformed, or invalid for other reasons."}',
          },
          '{"error":"Polar portal creation failed. Error: API error occurred: Status 401\\nBody: {\\"error\\":\\"invalid_token\\"}"}'
        );
      },
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates/portal');
    const res = await isolatedRoutes.getUserCertificatePortal(req);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('polar_access_token_invalid');
    expect(body.error).toContain('POLAR_ACCESS_TOKEN');
  });
});

describe('POST /api/connect/user/certificates/revoke', () => {
  it('revokes an owned signing device from the account session flow', async () => {
    mutationImpl = async (reference: unknown, args: unknown) => {
      expect(reference).toBe(apiMock.certificateBilling.revokeOwnedCertificate);
      expect(args).toMatchObject({
        authUserId: 'session-user-3',
        certNonce: 'cert_nonce_2',
      });
      return { revoked: true };
    };

    const fakeAuth = {
      getSession: async () => ({
        user: {
          id: 'session-user-3',
        },
      }),
      createPolarCheckout: async () => null,
      createPolarPortal: async () => null,
    } as unknown as Auth;

    const isolatedRoutes = createConnectRoutes(fakeAuth, testConfig);
    const req = new Request('http://localhost:3001/api/connect/user/certificates/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certNonce: 'cert_nonce_2' }),
    });
    const res = await isolatedRoutes.revokeUserCertificate(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Server-Timing')).toMatch(
      /session;dur=.*convex_certificate_revoke;dur=.*serialize;dur=.*total;dur=/
    );
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
