/**
 * Tests for owner-facing collaborator auth behavior.
 *
 * Dashboard requests may arrive with a Better Auth web session, while bot/internal
 * RPC requests mint a short-lived setup-session token and call the same routes
 * with `Authorization: Bearer <token>`. Both auth paths must work.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createAuth } from '../auth';
import { createSetupSession } from '../lib/setupSession';
import type { CollabConfig } from './collab';

const apiMock = {
  collaboratorInvites: {
    listCollaboratorConnections: 'collaboratorInvites.listCollaboratorConnections',
    removeCollaboratorConnection: 'collaboratorInvites.removeCollaboratorConnection',
  },
} as const;

let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
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

const { createCollabRoutes } = await import('./collab');

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

afterEach(() => {
  queryImpl = async () => null;
  mutationImpl = async () => null;
});

describe('POST /api/collab/invite (auth guard)', () => {
  it('returns 401 when no auth is present', async () => {
    const req = new Request('http://localhost:3001/api/collab/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildName: 'test', guildId: 'g1', authUserId: 'user-1' }),
    });
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(401);
    expect(res.headers.get('Server-Timing')).toMatch(
      /session_setup;dur=.*session_web;dur=.*serialize;dur=.*total;dur=/
    );
  });

  it('accepts a setup session token for owner invite creation', async () => {
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
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'providerKey is required' });
  });

  it('rejects a setup session token when the explicit authUserId targets another owner', async () => {
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
      body: JSON.stringify({
        authUserId: 'different-owner',
        guildName: 'test',
        guildId: 'g1',
        providerKey: 'jinxxy',
      }),
    });
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/collab/connections (auth guard)', () => {
  it('returns 401 when no auth is present', async () => {
    const req = new Request('http://localhost:3001/api/collab/connections?authUserId=user-1');
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(401);
  });

  it('accepts a setup session token for owner connection listing', async () => {
    queryImpl = async () => [];

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
    expect(res.status).toBe(200);
    expect(res.headers.get('Server-Timing')).toMatch(
      /session_setup;dur=.*session_web;dur=.*convex_collab_connections;dur=.*serialize;dur=.*total;dur=/
    );
    await expect(res.json()).resolves.toMatchObject({ connections: [] });
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

  it('accepts a setup session token for owner connection removal', async () => {
    mutationImpl = async () => null;

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
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true });
  });
});
