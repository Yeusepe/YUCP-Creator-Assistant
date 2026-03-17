/**
 * Tests for GET /api/connect/guild/channels
 *
 * Covers auth-guard behaviour without standing up a full Convex backend.
 * Session resolution uses the in-memory StateStore (no Redis needed in CI).
 */

import { describe, expect, it } from 'bun:test';
import { createAuth } from '../auth';
import { createSetupSession } from '../lib/setupSession';
import { type ConnectConfig, createConnectRoutes } from './connect';

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
});

const routes = createConnectRoutes(auth, testConfig);

describe('GET /api/connect/guild/channels', () => {
  it('returns 401 when no setup session token is present', async () => {
    const req = new Request('http://localhost:3001/api/connect/guild/channels');
    const res = await routes.getGuildChannels(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/authentication required/i);
  });

  it('returns 401 when setup session token is present but no auth session', async () => {
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
    // Auth session (Better Auth cookie) is absent → 401
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/authentication required/i);
  });

  it('returns 400 when no guildId provided in web-session path', async () => {
    // No setup session, no guildId → 400
    const req = new Request(
      'http://localhost:3001/api/connect/guild/channels?authUserId=some-user'
    );
    const res = await routes.getGuildChannels(req);
    // No Better Auth session cookie → 401 (auth check comes first)
    expect(res.status).toBe(401);
  });
});

describe('GET /api/connect/settings (web-session path)', () => {
  it('returns 401 when no session is present (no setup session, no auth session)', async () => {
    const req = new Request('http://localhost:3001/api/connect/settings?authUserId=some-user');
    const res = await routes.getSettingsHandler(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when setup session present but no auth session', async () => {
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
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/connections (disconnect) — auth guard', () => {
  it('returns 401 when no auth is present', async () => {
    const req = new Request('http://localhost:3001/api/connections?id=conn-1&authUserId=user-1', {
      method: 'DELETE',
    });
    const res = await routes.disconnectConnectionHandler(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when setup session present but no Better Auth session', async () => {
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
    expect(res.status).toBe(401);
  });
});

describe('POST /api/connect/settings (web-session path)', () => {
  it('returns 401 when no session is present', async () => {
    const req = new Request('http://localhost:3001/api/connect/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'allowMismatchedEmails', value: true, authUserId: 'some-user' }),
    });
    const res = await routes.updateSettingHandler(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when setup session present but no auth session', async () => {
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
    expect(res.status).toBe(401);
  });
});
