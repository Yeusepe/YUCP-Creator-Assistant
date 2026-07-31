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
    listCreatorWorkspaceMemberships: 'collaboratorInvites.listCreatorWorkspaceMemberships',
    migrateLegacyConnectionsForOwner: 'collaboratorInvites.migrateLegacyConnectionsForOwner',
    removeCollaboratorConnection: 'collaboratorInvites.removeCollaboratorConnection',
    removeCollaboratorConnectionAsCollaborator:
      'collaboratorInvites.removeCollaboratorConnectionAsCollaborator',
    removeCreatorWorkspaceMembership: 'collaboratorInvites.removeCreatorWorkspaceMembership',
  },
  creatorWorkspacePermissions: {
    getPolicyForConnection: 'creatorWorkspacePermissions.getPolicyForConnection',
    getPolicyForMembership: 'creatorWorkspacePermissions.getPolicyForMembership',
    replacePolicyForConnection: 'creatorWorkspacePermissions.replacePolicyForConnection',
    replacePolicyForMembership: 'creatorWorkspacePermissions.replacePolicyForMembership',
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

  it('rejects a cross-site browser request before creating an invitation', async () => {
    const token = await createSetupSession(
      'user-test-csrf-invite',
      'guild-test-csrf-invite',
      'discord-user-csrf-invite',
      ENCRYPTION_SECRET
    );
    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/invite', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Origin: 'https://attacker.example',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: JSON.stringify({ guildName: 'Cross-site attempt' }),
      })
    );

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
      permissions: { revision: 2 },
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

describe('/api/collab/memberships', () => {
  it('returns 401 when listing memberships without owner authentication', async () => {
    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/memberships')
    );

    expect(res.status).toBe(401);
  });

  it('returns a bounded, cursor-aware, allowlisted membership page', async () => {
    const queryCalls: unknown[][] = [];
    queryImpl = async (...args: unknown[]) => {
      queryCalls.push(args);
      if (args[0] === apiMock.creatorWorkspacePermissions.getPolicyForMembership) {
        return {
          grants: [],
          legacyPolicyPendingReview: false,
          membershipId: 'membership-1',
          policyVersion: 1,
          revision: 2,
        };
      }
      return {
        continueCursor: 'next-page',
        isDone: false,
        page: [
          {
            id: 'membership-1',
            collaboratorDiscordUserId: '100000000000000010',
            collaboratorDisplayName: 'Collaborator One',
            collaboratorAvatarHash: 'a'.repeat(32),
            connectionId: 'connection-internal',
            provider: 'jinxxy',
            linkType: 'api',
            webhookConfigured: true,
            status: 'active',
            createdAt: 100,
            updatedAt: 200,
            permissions: {
              grants: [],
              legacyPolicyPendingReview: false,
              membershipId: 'membership-1',
              policyVersion: 1,
              revision: 2,
            },
          },
        ],
      };
    };
    const token = await createSetupSession(
      'user-membership-list',
      'guild-membership-list',
      'discord-membership-list',
      ENCRYPTION_SECRET
    );

    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/memberships?cursor=current-page&limit=25', {
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    expect(queryCalls[0]?.[0]).toBe(apiMock.collaboratorInvites.listCreatorWorkspaceMemberships);
    expect(queryCalls[0]?.[1]).toMatchObject({
      actor: expect.objectContaining({
        payload: expect.any(String),
        signature: expect.any(String),
      }),
      cursor: 'current-page',
      limit: 25,
      ownerAuthUserId: 'user-membership-list',
    });
    const payload = (await res.json()) as {
      memberships: Array<Record<string, unknown>>;
      nextCursor: string;
      isDone: boolean;
    };
    expect(payload).toMatchObject({ nextCursor: 'next-page', isDone: false });
    expect(payload.memberships[0]).toMatchObject({
      id: 'membership-1',
      collaboratorDisplayName: 'Collaborator One',
      provider: 'jinxxy',
      permissions: {
        grants: [],
        legacyPolicyPendingReview: false,
        policyVersion: 1,
        revision: 2,
      },
      avatarUrl:
        'https://cdn.discordapp.com/avatars/100000000000000010/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp?size=64',
    });
    expect(payload.memberships[0]).not.toHaveProperty('collaboratorDiscordUserId');
    expect(payload.memberships[0]).not.toHaveProperty('collaboratorAvatarHash');
    expect(payload.memberships[0]).not.toHaveProperty('connectionId');
    expect(payload.memberships[0]?.permissions).not.toHaveProperty('membershipId');
  });
});

describe('/api/collab/memberships/:id/permissions', () => {
  it('returns 401 when no owner authentication is present', async () => {
    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/memberships/membership-1/permissions')
    );

    expect(res.status).toBe(401);
  });

  it('rejects malformed and unknown grants without calling Convex', async () => {
    const token = await createSetupSession(
      'user-membership-invalid',
      'guild-membership-invalid',
      'discord-membership-invalid',
      ENCRYPTION_SECRET
    );
    const missingRevision = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/memberships/membership-1/permissions', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ grants: 'not-an-array' }),
      })
    );
    const unknownCapability = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/memberships/membership-1/permissions', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedRevision: 1,
          grants: [
            {
              capabilityKey: 'packages.unknown',
              resourceType: 'package',
              scope: 'all',
            },
          ],
        }),
      })
    );

    expect(missingRevision.status).toBe(400);
    expect(unknownCapability.status).toBe(400);
  });

  it('rejects oversized policy bodies before parsing or persistence', async () => {
    const token = await createSetupSession(
      'user-membership-oversized',
      'guild-membership-oversized',
      'discord-membership-oversized',
      ENCRYPTION_SECRET
    );
    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/memberships/membership-1/permissions', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedRevision: 1,
          grants: [],
          padding: 'x'.repeat(70_000),
        }),
      })
    );

    expect(res.status).toBe(413);
  });

  it('returns a fixed conflict message without leaking the Convex request id', async () => {
    mutationImpl = async () => {
      throw new Error(
        '[CONVEX M(creatorWorkspacePermissions:replacePolicyForMembership)] [Request ID: secret-request-id] Permission policy changed while it was being edited'
      );
    };
    const token = await createSetupSession(
      'user-membership-conflict',
      'guild-membership-conflict',
      'discord-membership-conflict',
      ENCRYPTION_SECRET
    );
    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/memberships/membership-1/permissions', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expectedRevision: 2, grants: [] }),
      })
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'Permission policy changed while it was being edited',
    });
  });

  it('rejects cross-site permission changes', async () => {
    const token = await createSetupSession(
      'user-membership-csrf',
      'guild-membership-csrf',
      'discord-membership-csrf',
      ENCRYPTION_SECRET
    );
    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/memberships/membership-1/permissions', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Origin: 'https://attacker.example',
        },
        body: JSON.stringify({ expectedRevision: 1, grants: [] }),
      })
    );

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/collab/memberships/:id', () => {
  it('passes the signed owner actor and returns a fixed failure message', async () => {
    const mutationCalls: unknown[][] = [];
    mutationImpl = async (...args: unknown[]) => {
      mutationCalls.push(args);
      throw new Error(
        '[CONVEX M(collaboratorInvites:removeCreatorWorkspaceMembership)] [Request ID: secret-request-id] Server Error'
      );
    };
    const token = await createSetupSession(
      'user-membership-remove',
      'guild-membership-remove',
      'discord-membership-remove',
      ENCRYPTION_SECRET
    );
    const res = await routes.handleCollabRequest(
      new Request('http://localhost:3001/api/collab/memberships/membership-1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(mutationCalls[0]?.[1]).toMatchObject({
      actor: expect.objectContaining({
        payload: expect.any(String),
        signature: expect.any(String),
      }),
      membershipId: 'membership-1',
      ownerAuthUserId: 'user-membership-remove',
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to remove collaborator' });
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
