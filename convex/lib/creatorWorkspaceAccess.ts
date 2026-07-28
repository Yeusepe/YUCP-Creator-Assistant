import type { ApiActorBinding } from '@yucp/shared/apiActor';
import { ConvexError } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { actorHasScope, requireApiActor } from './apiActor';

type DatabaseCtx = Pick<QueryCtx | MutationCtx, 'db'>;

export type CreatorWorkspaceAccess = {
  accessRole: 'owner' | 'collaborator';
  creatorAuthUserId: string;
  creatorDisplayName?: string;
};

async function getActiveCollaboratorOwnerIds(
  ctx: DatabaseCtx,
  collaboratorAuthUserId: string
): Promise<string[]> {
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
  return [
    ...new Set(
      connections
        .filter(
          (connection) =>
            connection.status === 'active' && connection.ownerAuthUserId !== collaboratorAuthUserId
        )
        .map((connection) => connection.ownerAuthUserId)
    ),
  ];
}

export async function listCreatorWorkspaceAccess(
  ctx: DatabaseCtx,
  authUserId: string
): Promise<CreatorWorkspaceAccess[]> {
  const collaboratorOwnerIds = await getActiveCollaboratorOwnerIds(ctx, authUserId);
  const creatorAuthUserIds = [authUserId, ...collaboratorOwnerIds];
  const profiles = await Promise.all(
    creatorAuthUserIds.map(async (creatorAuthUserId) => {
      return await ctx.db
        .query('creator_profiles')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', creatorAuthUserId))
        .first();
    })
  );

  return creatorAuthUserIds.map((creatorAuthUserId, index) => ({
    accessRole: creatorAuthUserId === authUserId ? 'owner' : 'collaborator',
    creatorAuthUserId,
    ...(profiles[index]?.name ? { creatorDisplayName: profiles[index].name } : {}),
  }));
}

export async function hasCreatorWorkspaceAccess(
  ctx: DatabaseCtx,
  actorAuthUserId: string,
  creatorAuthUserId: string
): Promise<boolean> {
  if (actorAuthUserId === creatorAuthUserId) {
    return true;
  }
  const ownerIds = await getActiveCollaboratorOwnerIds(ctx, actorAuthUserId);
  return ownerIds.includes(creatorAuthUserId);
}

export async function requireCreatorWorkspaceActor(
  ctx: DatabaseCtx,
  actorBinding: ApiActorBinding,
  creatorAuthUserId: string
) {
  const actor = await requireApiActor(actorBinding);
  if (actor.kind === 'service' && actorHasScope(actor, 'creator:delegate')) {
    return actor;
  }
  if (
    actor.kind === 'auth_user' &&
    (await hasCreatorWorkspaceAccess(ctx, actor.authUserId, creatorAuthUserId))
  ) {
    return actor;
  }
  throw new ConvexError('Unauthorized: creator workspace access required');
}
