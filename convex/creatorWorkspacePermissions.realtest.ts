import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import { hasCreatorWorkspaceCapability } from './lib/creatorWorkspaceAccess';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';

describe('creator workspace permission enforcement', () => {
  it('accepts a workspace invitation without creating or sharing a provider connection', async () => {
    const t = makeTestConvex();
    const inviteId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('collaborator_invites', {
        ownerAuthUserId: 'workspace-invite-owner',
        tokenHash: 'workspace-invite-token-hash',
        status: 'pending',
        ownerDisplayName: 'Workspace Owner',
        expiresAt: now + 60_000,
        createdAt: now,
        permissionPolicyVersion: 1,
        permissionGrants: [],
        legacyPolicyPendingReview: false,
      });
    });

    const membershipId = await t.mutation(api.collaboratorInvites.acceptCreatorWorkspaceInvite, {
      apiSecret: 'test-secret',
      inviteId,
      collaboratorDiscordUserId: 'workspace-invite-discord',
      collaboratorDisplayName: 'Workspace Collaborator',
      collaboratorAvatarHash: 'a'.repeat(32),
    });

    const accepted = await t.run(async (ctx) => {
      const invite = await ctx.db.get(inviteId);
      const membership = await ctx.db.get(membershipId);
      const policy = membership?.currentPolicyVersionId
        ? await ctx.db.get(membership.currentPolicyVersionId)
        : null;
      const grants = policy
        ? await ctx.db
            .query('creator_workspace_grants')
            .withIndex('by_policy', (q) => q.eq('policyVersionId', policy._id))
            .collect()
        : [];
      const connections = await ctx.db
        .query('collaborator_connections')
        .withIndex('by_owner', (q) => q.eq('ownerAuthUserId', 'workspace-invite-owner'))
        .collect();
      return { connections, grants, invite, membership, policy };
    });

    expect(accepted.invite).toMatchObject({
      status: 'accepted',
      targetDiscordUserId: 'workspace-invite-discord',
    });
    expect(accepted.membership).toMatchObject({
      legacyPolicyPendingReview: false,
      memberDisplayName: 'Workspace Collaborator',
      ownerAuthUserId: 'workspace-invite-owner',
      status: 'active',
    });
    expect(accepted.policy).toMatchObject({ revision: 1, source: 'invite' });
    expect(accepted.grants).toEqual([]);
    expect(accepted.connections).toEqual([]);
  });

  it('allows only the selected product for a granular product-view grant', async () => {
    const t = makeTestConvex();
    const ownerAuthUserId = 'permission-owner';
    const collaboratorAuthUserId = 'permission-collaborator';
    const resources = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('creator_profiles', {
        authUserId: collaboratorAuthUserId,
        name: 'Scoped Collaborator',
        ownerDiscordUserId: 'discord-scoped-collaborator',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert('creator_workspace_memberships', {
        ownerAuthUserId,
        memberAuthUserId: collaboratorAuthUserId,
        memberDiscordUserId: 'discord-scoped-collaborator',
        status: 'active',
        legacyPolicyPendingReview: false,
        createdAt: now,
        updatedAt: now,
      });
      const policyVersionId = await ctx.db.insert('creator_workspace_policy_versions', {
        membershipId,
        revision: 1,
        policyVersion: 1,
        source: 'owner_edit',
        changedByAuthUserId: ownerAuthUserId,
        createdAt: now,
      });
      await ctx.db.patch(membershipId, { currentPolicyVersionId: policyVersionId });
      await ctx.db.insert('creator_workspace_grants', {
        policyVersionId,
        capabilityKey: 'products.view',
        resourceType: 'product',
        scope: 'selected',
        resourceId: 'product-allowed',
        createdAt: now,
      });
      return { policyVersionId };
    });

    expect(resources.policyVersionId).toBeTruthy();
    await expect(
      t.run((ctx) =>
        hasCreatorWorkspaceCapability(ctx, collaboratorAuthUserId, ownerAuthUserId, {
          capabilityKey: 'products.view',
          resources: [{ resourceId: 'product-allowed', resourceType: 'product' }],
        })
      )
    ).resolves.toBe(true);
    await expect(
      t.run((ctx) =>
        hasCreatorWorkspaceCapability(ctx, collaboratorAuthUserId, ownerAuthUserId, {
          capabilityKey: 'products.view',
          resources: [{ resourceId: 'product-hidden', resourceType: 'product' }],
        })
      )
    ).resolves.toBe(false);
  });

  it('does not let an upload grant reveal products', async () => {
    const t = makeTestConvex();
    const ownerAuthUserId = 'upload-only-owner';
    const collaboratorAuthUserId = 'upload-only-collaborator';
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('creator_profiles', {
        authUserId: collaboratorAuthUserId,
        name: 'Upload Only',
        ownerDiscordUserId: 'discord-upload-only',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert('creator_workspace_memberships', {
        ownerAuthUserId,
        memberAuthUserId: collaboratorAuthUserId,
        memberDiscordUserId: 'discord-upload-only',
        status: 'active',
        legacyPolicyPendingReview: false,
        createdAt: now,
        updatedAt: now,
      });
      const policyVersionId = await ctx.db.insert('creator_workspace_policy_versions', {
        membershipId,
        revision: 1,
        policyVersion: 1,
        source: 'owner_edit',
        changedByAuthUserId: ownerAuthUserId,
        createdAt: now,
      });
      await ctx.db.patch(membershipId, { currentPolicyVersionId: policyVersionId });
      await ctx.db.insert('creator_workspace_grants', {
        policyVersionId,
        capabilityKey: 'packages.releases.upload',
        resourceType: 'package',
        scope: 'selected',
        resourceId: 'com.yucp.upload-only',
        createdAt: now,
      });
    });

    await expect(
      t.run((ctx) =>
        hasCreatorWorkspaceCapability(ctx, collaboratorAuthUserId, ownerAuthUserId, {
          capabilityKey: 'packages.releases.upload',
          resources: [{ resourceId: 'com.yucp.upload-only', resourceType: 'package' }],
        })
      )
    ).resolves.toBe(true);
    await expect(
      t.run((ctx) =>
        hasCreatorWorkspaceCapability(ctx, collaboratorAuthUserId, ownerAuthUserId, {
          capabilityKey: 'products.view',
          resources: [{ resourceId: 'product-private', resourceType: 'product' }],
        })
      )
    ).resolves.toBe(false);
  });

  it('materializes legacy collaborators with review-required legacy grants', async () => {
    const t = makeTestConvex();
    const connectionId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('collaborator_connections', {
        ownerAuthUserId: 'legacy-owner',
        provider: 'jinxxy',
        webhookConfigured: false,
        linkType: 'api',
        status: 'active',
        collaboratorDiscordUserId: 'legacy-discord-user',
        collaboratorDisplayName: 'Legacy Collaborator',
        source: 'invite',
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(internal.creatorWorkspacePermissions.migrateLegacyConnections, {
      limit: 25,
    });
    const migrated = await t.run(async (ctx) => {
      const connection = await ctx.db.get(connectionId);
      const membership = connection?.workspaceMembershipId
        ? await ctx.db.get(connection.workspaceMembershipId)
        : null;
      const policy = membership?.currentPolicyVersionId
        ? await ctx.db.get(membership.currentPolicyVersionId)
        : null;
      const grants = policy
        ? await ctx.db
            .query('creator_workspace_grants')
            .withIndex('by_policy', (q) => q.eq('policyVersionId', policy._id))
            .collect()
        : [];
      return { connection, grants, membership, policy };
    });

    expect(result.migrated).toBe(1);
    expect(migrated.connection?.workspaceMembershipId).toBeTruthy();
    expect(migrated.membership).toMatchObject({
      legacyPolicyPendingReview: true,
      ownerAuthUserId: 'legacy-owner',
      status: 'active',
    });
    expect(migrated.policy).toMatchObject({
      revision: 1,
      source: 'legacy_migration',
    });
    expect(migrated.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityKey: 'products.view', scope: 'all' }),
        expect.objectContaining({
          capabilityKey: 'packages.releases.upload',
          scope: 'all',
        }),
      ])
    );
  });

  it('creates manually added collaborators with an explicit zero-access policy', async () => {
    const t = makeTestConvex();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('creator_profiles', {
        authUserId: 'manual-owner',
        name: 'Manual Owner',
        ownerDiscordUserId: 'manual-owner-discord',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    const connectionId = await t.mutation(api.collaboratorInvites.addCollaboratorConnectionManual, {
      apiSecret: 'test-secret',
      ownerAuthUserId: 'manual-owner',
      credentialEncrypted: 'encrypted-provider-key',
      provider: 'jinxxy',
      collaboratorDisplayName: 'Manual Collaborator',
      collaboratorIdentity: 'manual-collaborator-discord',
      addedByDiscordUserId: 'manual-owner-discord',
    });

    const materialized = await t.run(async (ctx) => {
      const connection = await ctx.db.get(connectionId);
      const membership = connection?.workspaceMembershipId
        ? await ctx.db.get(connection.workspaceMembershipId)
        : null;
      const policy = membership?.currentPolicyVersionId
        ? await ctx.db.get(membership.currentPolicyVersionId)
        : null;
      const grants = policy
        ? await ctx.db
            .query('creator_workspace_grants')
            .withIndex('by_policy', (q) => q.eq('policyVersionId', policy._id))
            .collect()
        : [];
      return { connection, grants, membership, policy };
    });

    expect(materialized.connection?.workspaceMembershipId).toBeTruthy();
    expect(materialized.membership).toMatchObject({
      legacyPolicyPendingReview: false,
      status: 'active',
    });
    expect(materialized.policy).toMatchObject({
      revision: 1,
      source: 'owner_edit',
    });
    expect(materialized.grants).toEqual([]);
  });
});
