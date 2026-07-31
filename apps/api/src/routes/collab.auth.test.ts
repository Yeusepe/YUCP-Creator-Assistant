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
    acceptCreatorWorkspaceInvite: 'collaboratorInvites.acceptCreatorWorkspaceInvite',
    createCollaboratorInvite: 'collaboratorInvites.createCollaboratorInvite',
    listCollaboratorConnections: 'collaboratorInvites.listCollaboratorConnections',
    removeCollaboratorConnection: 'collaboratorInvites.removeCollaboratorConnection',
    removeCollaboratorConnectionAsCollaborator:
      'collaboratorInvites.removeCollaboratorConnectionAsCollaborator',
  },
  creatorWorkspacePermissions: {
    getPolicyForConnection: 'creatorWorkspacePermissions.getPolicyForConnection',
    replacePolicyForConnection: 'creatorWorkspacePermissions.replacePolicyForConnection',
  },
} as const;

let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  internal: apiMock,
  components: {},
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
    const mutationCalls: unknown[][] = [];
    mutationImpl = async (...args: unknown[]) => {
      mutationCalls.push(args);
      return 'invite-setup-token';
    };
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
    expect(res.status).toBe(200);
    expect(mutationCalls[0]?.[1]).toMatchObject({
      ownerAuthUserId: 'user-test-001',
      permissionGrants: [],
    });
    expect(mutationCalls[0]?.[1]).not.toHaveProperty('providerKey');
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

  it('creates new invites with explicit deny-by-default workspace permissions', async () => {
    const mutationCalls: unknown[][] = [];
    mutationImpl = async (...args: unknown[]) => {
      mutationCalls.push(args);
      return 'invite-1';
    };
    const token = await createSetupSession(
      'user-test-default-deny',
      'guild-test-default-deny',
      'discord-user-default-deny',
      ENCRYPTION_SECRET
    );
    const req = new Request('http://localhost:3001/api/collab/invite', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        guildName: 'Test Workspace',
        permissionGrants: [
          {
            capabilityKey: 'products.view',
            resourceType: 'product',
            scope: 'all',
          },
        ],
      }),
    });

    const res = await routes.handleCollabRequest(req);

    expect(res.status).toBe(200);
    expect(mutationCalls[0]?.[0]).toBe(apiMock.collaboratorInvites.createCollaboratorInvite);
    expect(mutationCalls[0]?.[1]).toMatchObject({
      ownerAuthUserId: 'user-test-default-deny',
      permissionGrants: [],
    });
    expect(mutationCalls[0]?.[1]).not.toHaveProperty('providerKey');
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

describe('/api/collab/connections/:id/permissions', () => {
  it('returns an owner-authorized permission policy with capability definitions', async () => {
    const queryCalls: unknown[][] = [];
    queryImpl = async (...args: unknown[]) => {
      queryCalls.push(args);
      return {
        connectionId: 'connection-1',
        grants: [],
        legacyPolicyPendingReview: false,
        membershipId: 'membership-1',
        policyVersion: 1,
        revision: 2,
      };
    };
    const token = await createSetupSession(
      'user-test-permission-read',
      'guild-test-permission-read',
      'discord-user-permission-read',
      ENCRYPTION_SECRET
    );

    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/connections/connection-1/permissions', {
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    expect(queryCalls[0]?.[0]).toBe(apiMock.creatorWorkspacePermissions.getPolicyForConnection);
    await expect(res.json()).resolves.toMatchObject({
      permissions: { connectionId: 'connection-1', revision: 2 },
      capabilityDefinitions: {
        'packages.releases.upload': expect.objectContaining({ label: 'Upload releases' }),
      },
    });
  });

  it('replaces the policy with the reviewed revision and selected resource grants', async () => {
    const mutationCalls: unknown[][] = [];
    mutationImpl = async (...args: unknown[]) => {
      mutationCalls.push(args);
      return { membershipId: 'membership-1', policyVersionId: 'policy-3', revision: 3 };
    };
    const token = await createSetupSession(
      'user-test-permission-write',
      'guild-test-permission-write',
      'discord-user-permission-write',
      ENCRYPTION_SECRET
    );

    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/connections/connection-1/permissions', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedRevision: 2,
          grants: [
            {
              capabilityKey: 'packages.releases.upload',
              resourceType: 'package',
              scope: 'selected',
              resourceId: 'com.yucp.one-package',
            },
          ],
        }),
      })
    );

    expect(res.status).toBe(200);
    expect(mutationCalls[0]?.[0]).toBe(
      apiMock.creatorWorkspacePermissions.replacePolicyForConnection
    );
    expect(mutationCalls[0]?.[1]).toMatchObject({
      connectionId: 'connection-1',
      expectedRevision: 2,
      grants: [
        {
          capabilityKey: 'packages.releases.upload',
          resourceId: 'com.yucp.one-package',
          resourceType: 'package',
          scope: 'selected',
        },
      ],
      ownerAuthUserId: 'user-test-permission-write',
    });
  });
});

describe('DELETE /api/collab/connections/as-collaborator/:id (auth guard)', () => {
  it('returns 401 when no auth is present', async () => {
    const req = new Request(
      'http://localhost:3001/api/collab/connections/as-collaborator/some-id?authUserId=user-1',
      { method: 'DELETE' }
    );
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(401);
  });

  it('accepts a setup session token for collaborator self-removal', async () => {
    const mutationCalls: unknown[][] = [];
    mutationImpl = async (...args: unknown[]) => {
      mutationCalls.push(args);
      return null;
    };

    const token = await createSetupSession(
      'user-test-004',
      'guild-test-004',
      'discord-user-004',
      ENCRYPTION_SECRET
    );
    const req = new Request(
      'http://localhost:3001/api/collab/connections/as-collaborator/some-id?authUserId=user-test-004',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const res = await routes.handleCollabRequest(req);
    expect(res.status).toBe(200);
    expect(mutationCalls).toHaveLength(1);
    expect(mutationCalls[0][0]).toBe(
      apiMock.collaboratorInvites.removeCollaboratorConnectionAsCollaborator
    );
    expect(mutationCalls[0][1]).toMatchObject({
      apiSecret: 'test-convex-secret',
      authUserId: 'user-test-004',
      connectionId: 'some-id',
    });
    await expect(res.json()).resolves.toMatchObject({ success: true });
  });
});

describe('GET /api/collab/providers', () => {
  it('lists generic collaborator-shareable providers, including itchio and payhip', async () => {
    const req = new Request('http://localhost:3001/api/collab/providers');
    const res = await routes.handleCollabRequest(req);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ key: 'itchio', label: 'itch.io' }),
        expect.objectContaining({ key: 'payhip', label: 'Payhip' }),
      ]),
    });
  });
});
