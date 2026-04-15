import { ConvexError } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

type DbCtx = Pick<QueryCtx, 'db'> | Pick<MutationCtx, 'db'>;

export function filterOwnedDocument<T extends { authUserId: string }>(
  document: T | null | undefined,
  authUserId: string
): T | null {
  if (!document || document.authUserId !== authUserId) {
    return null;
  }
  return document;
}

export function requireOwnedDocument<T extends { authUserId: string }>(
  document: T | null | undefined,
  authUserId: string,
  message = 'Unauthorized: not the owner'
): T {
  if (!document || document.authUserId !== authUserId) {
    throw new ConvexError(message);
  }
  return document;
}

export async function hasActiveBindingForSubject(
  ctx: DbCtx,
  authUserId: string,
  subjectId: Id<'subjects'>
): Promise<boolean> {
  const binding = await ctx.db
    .query('bindings')
    .withIndex('by_auth_user_subject', (q) =>
      q.eq('authUserId', authUserId).eq('subjectId', subjectId)
    )
    .filter((q) => q.eq(q.field('status'), 'active'))
    .first();

  return binding !== null;
}
