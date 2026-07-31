import {
  CREATOR_WORKSPACE_POLICY_VERSION,
  type CreatorWorkspaceGrant,
  normalizeCreatorWorkspaceGrants,
} from '@yucp/shared/creatorWorkspacePermissions';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

type PolicySource = 'invite' | 'owner_edit' | 'legacy_migration';

export async function writeCreatorWorkspacePolicy(
  ctx: MutationCtx,
  args: {
    changedByAuthUserId: string;
    grants: readonly CreatorWorkspaceGrant[];
    legacyPolicyPendingReview: boolean;
    membership: Doc<'creator_workspace_memberships'>;
    note?: string;
    source: PolicySource;
    expectedRevision?: number;
  }
): Promise<{
  membershipId: Id<'creator_workspace_memberships'>;
  policyVersionId: Id<'creator_workspace_policy_versions'>;
  revision: number;
}> {
  const currentPolicy = args.membership.currentPolicyVersionId
    ? await ctx.db.get(args.membership.currentPolicyVersionId)
    : null;
  const currentRevision = currentPolicy?.revision ?? 0;
  if (args.expectedRevision !== undefined && args.expectedRevision !== currentRevision) {
    throw new ConvexError('Permission policy changed while it was being edited');
  }
  const grants = normalizeCreatorWorkspaceGrants(args.grants);
  const revision = currentRevision + 1;
  const now = Date.now();
  const policyVersionId = await ctx.db.insert('creator_workspace_policy_versions', {
    membershipId: args.membership._id,
    revision,
    policyVersion: CREATOR_WORKSPACE_POLICY_VERSION,
    source: args.source,
    changedByAuthUserId: args.changedByAuthUserId,
    note: args.note,
    createdAt: now,
  });
  for (const grant of grants) {
    await ctx.db.insert('creator_workspace_grants', {
      policyVersionId,
      capabilityKey: grant.capabilityKey,
      resourceType: grant.resourceType,
      scope: grant.scope,
      resourceId: grant.resourceId,
      createdAt: now,
    });
  }
  await ctx.db.patch(args.membership._id, {
    currentPolicyVersionId: policyVersionId,
    legacyPolicyPendingReview: args.legacyPolicyPendingReview,
    updatedAt: now,
  });
  await ctx.db.insert('audit_events', {
    authUserId: args.membership.ownerAuthUserId,
    eventType: 'collaborator.permissions.changed',
    actorType: 'admin',
    actorId: args.changedByAuthUserId,
    metadata: {
      membershipId: args.membership._id,
      policyVersionId,
      previousRevision: currentRevision,
      revision,
      source: args.source,
      grantCount: grants.length,
    },
    createdAt: now,
  });
  return { membershipId: args.membership._id, policyVersionId, revision };
}

export async function materializeCreatorWorkspaceMembership(
  ctx: MutationCtx,
  args: {
    changedByAuthUserId: string;
    collaboratorConnectionId?: Id<'collaborator_connections'>;
    grants: readonly CreatorWorkspaceGrant[];
    legacyPolicyPendingReview: boolean;
    memberAuthUserId?: string;
    memberAvatarHash?: string;
    memberDiscordUserId: string;
    memberDisplayName?: string;
    ownerAuthUserId: string;
    source: PolicySource;
  }
) {
  const now = Date.now();
  let membership = await ctx.db
    .query('creator_workspace_memberships')
    .withIndex('by_owner_member_discord', (q) =>
      q
        .eq('ownerAuthUserId', args.ownerAuthUserId)
        .eq('memberDiscordUserId', args.memberDiscordUserId)
    )
    .first();
  if (!membership) {
    const membershipId = await ctx.db.insert('creator_workspace_memberships', {
      ownerAuthUserId: args.ownerAuthUserId,
      memberAuthUserId: args.memberAuthUserId,
      memberDiscordUserId: args.memberDiscordUserId,
      memberDisplayName: args.memberDisplayName,
      memberAvatarHash: args.memberAvatarHash,
      collaboratorConnectionId: args.collaboratorConnectionId,
      status: 'active',
      legacyPolicyPendingReview: args.legacyPolicyPendingReview,
      createdAt: now,
      updatedAt: now,
    });
    membership = (await ctx.db.get(membershipId)) as Doc<'creator_workspace_memberships'>;
  } else {
    await ctx.db.patch(membership._id, {
      collaboratorConnectionId: args.collaboratorConnectionId,
      memberAuthUserId: args.memberAuthUserId ?? membership.memberAuthUserId,
      memberDisplayName: args.memberDisplayName ?? membership.memberDisplayName,
      memberAvatarHash: args.memberAvatarHash ?? membership.memberAvatarHash,
      status: 'active',
      removedAt: undefined,
      updatedAt: now,
    });
    membership = (await ctx.db.get(membership._id)) as Doc<'creator_workspace_memberships'>;
  }
  const policy = await writeCreatorWorkspacePolicy(ctx, {
    membership,
    changedByAuthUserId: args.changedByAuthUserId,
    grants: args.grants,
    legacyPolicyPendingReview: args.legacyPolicyPendingReview,
    source: args.source,
  });
  if (args.collaboratorConnectionId) {
    await ctx.db.patch(args.collaboratorConnectionId, {
      workspaceMembershipId: membership._id,
      updatedAt: now,
    });
  }
  return policy;
}
