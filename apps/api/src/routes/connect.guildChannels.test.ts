/**
 * Tests for auth-token based connect route behavior.
 *
 * These tests cover the setup-session path that replaced the old Better Auth
 * bridge. The routes should accept a bound setup token and resolve their
 * Convex-backed operations without needing a browser session cookie.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createAuth } from '../auth';
import { createSetupSession } from '../lib/setupSession';
import type { ConnectConfig } from './connect';

let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: (...args: unknown[]) => mutationImpl(...args),
  }),
}));

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

const auth = createAuth({
  baseUrl: testConfig.apiBaseUrl,
  convexSiteUrl: testConfig.convexSiteUrl,
  convexUrl: testConfig.convexUrl,
});

const routes = createConnectRoutes(auth, testConfig);

afterEach(() => {
  queryImpl = async () => null;
  mutationImpl = async () => null;
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
