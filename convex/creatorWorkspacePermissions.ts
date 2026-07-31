import {
  CREATOR_WORKSPACE_POLICY_VERSION,
  LEGACY_CREATOR_WORKSPACE_GRANTS,
  normalizeCreatorWorkspaceGrants,
} from '@yucp/shared/creatorWorkspacePermissions';
import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { internalMutation, mutation, query } from './_generated/server';
import { ApiActorBindingV, requireDelegatedAuthUserActor } from './lib/apiActor';
import { requireApiSecret } from './lib/apiAuth';
import {
  materializeCreatorWorkspaceMembership,
  writeCreatorWorkspacePolicy,
} from './lib/creatorWorkspacePolicy';

const GrantV = v.object({
  capabilityKey: v.string(),
  resourceType: v.union(
    v.literal('workspace'),
    v.literal('product'),
    v.literal('package'),
    v.literal('guild'),
    v.literal('provider_connection'),
    v.literal('developer_integration')
  ),
  scope: v.union(v.literal('all'), v.literal('selected')),
  resourceId: v.optional(v.string()),
});

async function readPolicyForMembership(
  ctx: QueryCtx,
  membership: Doc<'creator_workspace_memberships'>
) {
  if (!membership.currentPolicyVersionId) {
    return {
      grants: [],
      legacyPolicyPendingReview: membership.legacyPolicyPendingReview,
      membershipId: membership._id,
      policyVersion: CREATOR_WORKSPACE_POLICY_VERSION,
      revision: 0,
    };
  }
  const [policy, grants] = await Promise.all([
    ctx.db.get(membership.currentPolicyVersionId),
    ctx.db
      .query('creator_workspace_grants')
      .withIndex('by_policy', (q) =>
        q.eq('policyVersionId', membership.currentPolicyVersionId as never)
      )
      .collect(),
  ]);
  if (!policy) throw new ConvexError('Collaborator permission policy is unavailable');
  return {
    grants: grants.map(({ capabilityKey, resourceId, resourceType, scope }) => ({
      capabilityKey,
      resourceId,
      resourceType,
      scope,
    })),
    legacyPolicyPendingReview: membership.legacyPolicyPendingReview,
    membershipId: membership._id,
    policyVersion: policy.policyVersion,
    revision: policy.revision,
  };
}

export const getPolicyForMembership = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    ownerAuthUserId: v.string(),
    membershipId: v.id('creator_workspace_memberships'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.ownerAuthUserId);
    const membership = await ctx.db.get(args.membershipId);
    if (!membership || membership.ownerAuthUserId !== args.ownerAuthUserId) return null;
    return await readPolicyForMembership(ctx, membership);
  },
});

export const replacePolicyForMembership = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    ownerAuthUserId: v.string(),
    membershipId: v.id('creator_workspace_memberships'),
    expectedRevision: v.number(),
    grants: v.array(GrantV),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.ownerAuthUserId);
    const membership = await ctx.db.get(args.membershipId);
    if (!membership || membership.ownerAuthUserId !== args.ownerAuthUserId) {
      throw new ConvexError('Collaborator membership not found');
    }
    return await writeCreatorWorkspacePolicy(ctx, {
      membership,
      changedByAuthUserId: args.ownerAuthUserId,
      expectedRevision: args.expectedRevision,
      grants: normalizeCreatorWorkspaceGrants(args.grants),
      legacyPolicyPendingReview: false,
      source: 'owner_edit',
    });
  },
});

export const getPolicyForConnection = query({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    ownerAuthUserId: v.string(),
    connectionId: v.id('collaborator_connections'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.ownerAuthUserId);
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.ownerAuthUserId !== args.ownerAuthUserId) {
      return null;
    }
    const membership = connection.workspaceMembershipId
      ? await ctx.db.get(connection.workspaceMembershipId)
      : await ctx.db
          .query('creator_workspace_memberships')
          .withIndex('by_owner_member_discord', (q) =>
            q
              .eq('ownerAuthUserId', args.ownerAuthUserId)
              .eq('memberDiscordUserId', connection.collaboratorDiscordUserId)
          )
          .first();
    if (!membership?.currentPolicyVersionId) {
      return {
        connectionId: connection._id,
        grants: LEGACY_CREATOR_WORKSPACE_GRANTS,
        legacyPolicyPendingReview: true,
        membershipId: membership?._id ?? null,
        policyVersion: CREATOR_WORKSPACE_POLICY_VERSION,
        revision: 0,
      };
    }
    const policy = await readPolicyForMembership(ctx, membership);
    return {
      connectionId: connection._id,
      ...policy,
    };
  },
});

export const replacePolicyForConnection = mutation({
  args: {
    apiSecret: v.string(),
    actor: ApiActorBindingV,
    ownerAuthUserId: v.string(),
    connectionId: v.id('collaborator_connections'),
    expectedRevision: v.number(),
    grants: v.array(GrantV),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    await requireDelegatedAuthUserActor(args.actor, args.ownerAuthUserId);
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.ownerAuthUserId !== args.ownerAuthUserId) {
      throw new ConvexError('Collaborator connection not found');
    }
    const normalized = normalizeCreatorWorkspaceGrants(args.grants);
    let membership = connection.workspaceMembershipId
      ? await ctx.db.get(connection.workspaceMembershipId)
      : null;
    if (!membership) {
      await materializeCreatorWorkspaceMembership(ctx, {
        changedByAuthUserId: args.ownerAuthUserId,
        collaboratorConnectionId: connection._id,
        grants: LEGACY_CREATOR_WORKSPACE_GRANTS,
        legacyPolicyPendingReview: true,
        memberDiscordUserId: connection.collaboratorDiscordUserId,
        ownerAuthUserId: args.ownerAuthUserId,
        source: 'legacy_migration',
      });
      const refreshedConnection = await ctx.db.get(connection._id);
      membership = refreshedConnection?.workspaceMembershipId
        ? await ctx.db.get(refreshedConnection.workspaceMembershipId)
        : null;
    }
    if (!membership) {
      throw new ConvexError('Collaborator workspace membership is unavailable');
    }
    return await writeCreatorWorkspacePolicy(ctx, {
      membership,
      changedByAuthUserId: args.ownerAuthUserId,
      expectedRevision: args.expectedRevision === 0 ? 1 : args.expectedRevision,
      grants: normalized,
      legacyPolicyPendingReview: false,
      source: 'owner_edit',
    });
  },
});

export const migrateLegacyConnections = internalMutation({
  args: { cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query('collaborator_connections').paginate({
      cursor: args.cursor ?? null,
      numItems: Math.min(Math.max(args.limit ?? 100, 1), 250),
    });
    let migrated = 0;
    for (const connection of page.page) {
      if (connection.status !== 'active' || connection.workspaceMembershipId) {
        continue;
      }
      await materializeCreatorWorkspaceMembership(ctx, {
        changedByAuthUserId: connection.ownerAuthUserId,
        collaboratorConnectionId: connection._id,
        grants: LEGACY_CREATOR_WORKSPACE_GRANTS,
        legacyPolicyPendingReview: true,
        memberDiscordUserId: connection.collaboratorDiscordUserId,
        ownerAuthUserId: connection.ownerAuthUserId,
        source: 'legacy_migration',
      });
      migrated += 1;
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      migrated,
    };
  },
});
