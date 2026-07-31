import type { ApiActorBinding } from '@yucp/shared/apiActor';
import {
  CREATOR_WORKSPACE_CAPABILITIES,
  type CreatorWorkspaceCapabilityKey,
  type CreatorWorkspaceResourceType,
  LEGACY_CREATOR_WORKSPACE_GRANTS,
} from '@yucp/shared/creatorWorkspacePermissions';
import { ConvexError } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { actorHasScope, requireApiActor } from './apiActor';

type DatabaseCtx = Pick<QueryCtx | MutationCtx, 'db'>;

export type CreatorWorkspaceResource = {
  resourceId: string;
  resourceType: CreatorWorkspaceResourceType;
};

export type CreatorWorkspaceCapabilityRequest = {
  capabilityKey: CreatorWorkspaceCapabilityKey;
  resources?: readonly CreatorWorkspaceResource[];
};

export type CreatorWorkspaceAccess = {
  accessRole: 'owner' | 'collaborator';
  creatorAuthUserId: string;
  creatorDisplayName?: string;
  legacyPolicyPendingReview?: boolean;
  resourceScope?: {
    kind: 'all' | 'selected';
    resourceIds: string[];
  };
};

async function getActiveMemberships(
  ctx: DatabaseCtx,
  collaboratorAuthUserId: string
): Promise<Doc<'creator_workspace_memberships'>[]> {
  const profile = await ctx.db
    .query('creator_profiles')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', collaboratorAuthUserId))
    .first();
  if (!profile || profile.status !== 'active') {
    return [];
  }
  const [byAuthUser, byDiscord] = await Promise.all([
    ctx.db
      .query('creator_workspace_memberships')
      .withIndex('by_member_auth_user', (q) => q.eq('memberAuthUserId', collaboratorAuthUserId))
      .collect(),
    ctx.db
      .query('creator_workspace_memberships')
      .withIndex('by_member_discord', (q) =>
        q.eq('memberDiscordUserId', profile.ownerDiscordUserId)
      )
      .collect(),
  ]);
  return [
    ...new Map(
      [...byAuthUser, ...byDiscord]
        .filter(
          (membership) =>
            membership.status === 'active' && membership.ownerAuthUserId !== collaboratorAuthUserId
        )
        .map((membership) => [String(membership._id), membership])
    ).values(),
  ];
}

async function getLegacyConnections(
  ctx: DatabaseCtx,
  collaboratorAuthUserId: string
): Promise<Doc<'collaborator_connections'>[]> {
  const profile = await ctx.db
    .query('creator_profiles')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', collaboratorAuthUserId))
    .first();
  if (!profile || profile.status !== 'active') {
    return [];
  }
  const connections = await ctx.db
    .query('collaborator_connections')
    .withIndex('by_collaborator_discord', (q) =>
      q.eq('collaboratorDiscordUserId', profile.ownerDiscordUserId)
    )
    .collect();
  return connections.filter(
    (connection) =>
      connection.status === 'active' &&
      connection.ownerAuthUserId !== collaboratorAuthUserId &&
      !connection.workspaceMembershipId
  );
}

function legacyCapabilityAllows(capabilityKey: CreatorWorkspaceCapabilityKey): boolean {
  return LEGACY_CREATOR_WORKSPACE_GRANTS.some((grant) => grant.capabilityKey === capabilityKey);
}

async function grantsForMembershipCapability(
  ctx: DatabaseCtx,
  membership: Doc<'creator_workspace_memberships'>,
  capabilityKey: CreatorWorkspaceCapabilityKey
) {
  if (!membership.currentPolicyVersionId) {
    return [];
  }
  return await ctx.db
    .query('creator_workspace_grants')
    .withIndex('by_policy_capability', (q) =>
      q
        .eq('policyVersionId', membership.currentPolicyVersionId as never)
        .eq('capabilityKey', capabilityKey)
    )
    .collect();
}

function grantsAllowResources(
  grants: Doc<'creator_workspace_grants'>[],
  resources: readonly CreatorWorkspaceResource[]
): boolean {
  if (resources.length === 0) {
    return grants.length > 0;
  }
  return resources.every((resource) =>
    grants.some(
      (grant) =>
        grant.resourceType === resource.resourceType &&
        (grant.scope === 'all' ||
          (grant.scope === 'selected' && grant.resourceId === resource.resourceId))
    )
  );
}

export async function hasCreatorWorkspaceCapability(
  ctx: DatabaseCtx,
  actorAuthUserId: string,
  creatorAuthUserId: string,
  request: CreatorWorkspaceCapabilityRequest
): Promise<boolean> {
  if (actorAuthUserId === creatorAuthUserId) {
    return true;
  }
  const definition = CREATOR_WORKSPACE_CAPABILITIES[request.capabilityKey];
  for (const resource of request.resources ?? []) {
    if (!(definition.resourceTypes as readonly string[]).includes(resource.resourceType)) {
      return false;
    }
  }

  const memberships = await getActiveMemberships(ctx, actorAuthUserId);
  const membership = memberships.find(
    (candidate) => candidate.ownerAuthUserId === creatorAuthUserId
  );
  if (membership) {
    const grants = await grantsForMembershipCapability(ctx, membership, request.capabilityKey);
    return grantsAllowResources(grants, request.resources ?? []);
  }

  const legacyConnections = await getLegacyConnections(ctx, actorAuthUserId);
  return (
    legacyConnections.some((connection) => connection.ownerAuthUserId === creatorAuthUserId) &&
    legacyCapabilityAllows(request.capabilityKey)
  );
}

export async function listCreatorWorkspaceAccess(
  ctx: DatabaseCtx,
  authUserId: string,
  request: {
    capabilityKey: CreatorWorkspaceCapabilityKey;
    resourceType: CreatorWorkspaceResourceType;
  } = {
    capabilityKey: 'products.view',
    resourceType: 'product',
  }
): Promise<CreatorWorkspaceAccess[]> {
  const [memberships, legacyConnections] = await Promise.all([
    getActiveMemberships(ctx, authUserId),
    getLegacyConnections(ctx, authUserId),
  ]);
  const collaboratorAccess = new Map<string, CreatorWorkspaceAccess>();

  for (const membership of memberships) {
    const grants = await grantsForMembershipCapability(ctx, membership, request.capabilityKey);
    const applicable = grants.filter((grant) => grant.resourceType === request.resourceType);
    const hasAll = applicable.some((grant) => grant.scope === 'all');
    const resourceIds = [
      ...new Set(
        applicable
          .filter((grant) => grant.scope === 'selected' && grant.resourceId)
          .map((grant) => grant.resourceId as string)
      ),
    ];
    if (!hasAll && resourceIds.length === 0) {
      continue;
    }
    collaboratorAccess.set(membership.ownerAuthUserId, {
      accessRole: 'collaborator',
      creatorAuthUserId: membership.ownerAuthUserId,
      legacyPolicyPendingReview: membership.legacyPolicyPendingReview,
      resourceScope: {
        kind: hasAll ? 'all' : 'selected',
        resourceIds: hasAll ? [] : resourceIds,
      },
    });
  }

  if (legacyCapabilityAllows(request.capabilityKey)) {
    for (const connection of legacyConnections) {
      if (!collaboratorAccess.has(connection.ownerAuthUserId)) {
        collaboratorAccess.set(connection.ownerAuthUserId, {
          accessRole: 'collaborator',
          creatorAuthUserId: connection.ownerAuthUserId,
          legacyPolicyPendingReview: true,
          resourceScope: { kind: 'all', resourceIds: [] },
        });
      }
    }
  }

  const access = [
    {
      accessRole: 'owner' as const,
      creatorAuthUserId: authUserId,
      resourceScope: { kind: 'all' as const, resourceIds: [] },
    },
    ...collaboratorAccess.values(),
  ];
  const profiles = await Promise.all(
    access.map(async ({ creatorAuthUserId }) => {
      return await ctx.db
        .query('creator_profiles')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', creatorAuthUserId))
        .first();
    })
  );
  return access.map((entry, index) => ({
    ...entry,
    ...(profiles[index]?.name ? { creatorDisplayName: profiles[index].name } : {}),
  }));
}

/**
 * Backward-compatible package visibility check. New mutation paths must use
 * requireCreatorWorkspaceCapability with their exact capability and resource.
 */
export async function hasCreatorWorkspaceAccess(
  ctx: DatabaseCtx,
  actorAuthUserId: string,
  creatorAuthUserId: string
): Promise<boolean> {
  return await hasCreatorWorkspaceCapability(ctx, actorAuthUserId, creatorAuthUserId, {
    capabilityKey: 'packages.view',
  });
}

export async function requireCreatorWorkspaceCapability(
  ctx: DatabaseCtx,
  actorBinding: ApiActorBinding,
  creatorAuthUserId: string,
  request: CreatorWorkspaceCapabilityRequest
) {
  const actor = await requireApiActor(actorBinding);
  if (actor.kind === 'service' && actorHasScope(actor, 'creator:delegate')) {
    return actor;
  }
  if (
    actor.kind === 'auth_user' &&
    (await hasCreatorWorkspaceCapability(ctx, actor.authUserId, creatorAuthUserId, request))
  ) {
    return actor;
  }
  throw new ConvexError(`Unauthorized: ${request.capabilityKey} permission required`);
}

export async function requireCreatorWorkspaceActor(
  ctx: DatabaseCtx,
  actorBinding: ApiActorBinding,
  creatorAuthUserId: string
) {
  return await requireCreatorWorkspaceCapability(ctx, actorBinding, creatorAuthUserId, {
    capabilityKey: 'packages.view',
  });
}
