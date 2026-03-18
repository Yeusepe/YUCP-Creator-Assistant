/**
 * Tests for collab endpoint auth guards.
 *
 * Verifies that owner-facing endpoints (createInvite, listConnections,
 * removeConnection) return 401 when neither a valid setup session nor a
 * Better Auth web session is provided.
 */

import { describe, expect, it } from 'bun:test';
import { createAuth } from '../auth';
import { createSetupSession } from '../lib/setupSession';
import { type CollabConfig, createCollabRoutes } from './collab';

const ENCRYPTION_SECRET = 'test-encryption-secret-32chars!!';

const auth = createAuth({
  baseUrl: 'http://localhost:3001',
  convexSiteUrl: 'http://localhost:3210',
  convexUrl: 'http://localhost:3210',
});

const testConfig: CollabConfig = {
  auth,
  apiBaseUrl: 'http://localhost:3001',
  frontendBaseUrl: 'http://localhost:3001',
  convexUrl: 'http://localhost:3210',
  convexApiSecret: 'test-convex-secret',
  encryptionSecret: ENCRYPTION_SECRET,
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
};

const routes = createCollabRoutes(testConfig);

describe('POST /api/collab/invite (auth guard)', () => {
  it('returns 401 when no auth is present', async () => {
    const req = new Request('http://localhost:3001/api/collab/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildName: 'test', guildId: 'g1', authUserId: 'user-1' }),
    });
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when setup session is present but no Better Auth session', async () => {
    const token = await createSetupSession(
      'user-test-001',
      'guild-test-001',
      'discord-user-001',
      ENCRYPTION_SECRET
    );
    const req = new Request('http://localhost:3001/api/collab/invite', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ guildName: 'test', guildId: 'g1' }),
    });
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/collab/connections (auth guard)', () => {
  it('returns 401 when no auth is present', async () => {
    const req = new Request('http://localhost:3001/api/collab/connections?authUserId=user-1');
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when setup session is present but no Better Auth session', async () => {
    const token = await createSetupSession(
      'user-test-002',
      'guild-test-002',
      'discord-user-002',
      ENCRYPTION_SECRET
    );
    const req = new Request('http://localhost:3001/api/collab/connections', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/collab/connections/:id (auth guard)', () => {
  it('returns 401 when no auth is present', async () => {
    const req = new Request(
      'http://localhost:3001/api/collab/connections/some-id?authUserId=user-1',
      { method: 'DELETE' }
    );
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when setup session present but no Better Auth session', async () => {
    const token = await createSetupSession(
      'user-test-003',
      'guild-test-003',
      'discord-user-003',
      ENCRYPTION_SECRET
    );
    const req = new Request('http://localhost:3001/api/collab/connections/some-id', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(401);
  });
});
