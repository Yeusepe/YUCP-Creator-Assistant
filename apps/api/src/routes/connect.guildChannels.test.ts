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

const apiMock = {
  certificateBilling: {
    getAccountOverview: 'certificateBilling.getAccountOverview',
    revokeOwnedCertificate: 'certificateBilling.revokeOwnedCertificate',
  },
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
  createPolarCheckout: async () => null,
  createPolarPortal: async () => null,
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
    const body = (await res.json()) as {
      workspaceKey: string;
      billing: { planKey: string };
      devices: Array<{ certNonce: string }>;
    };
    expect(body.workspaceKey).toBe('creator-profile:abc123');
    expect(body.billing.planKey).toBe('pro');
    expect(body.devices[0]?.certNonce).toBe('cert_nonce_1');
  });
});

describe('POST /api/connect/user/certificates/checkout', () => {
  it('passes the workspace key to Polar checkout as referenceId and metadata', async () => {
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
            },
          ],
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
    expect(checkoutPayload).toMatchObject({
      products: ['prod_starter'],
      referenceId: 'creator-profile:checkout-1',
      metadata: {
        workspace_key: 'creator-profile:checkout-1',
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
            },
          ],
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
            },
          ],
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
    expect(body.error).toContain('Unknown certificate plan');
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
            },
          ],
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
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
