import { internal } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexServerClient } from './convex';

export const SUBJECT_AUTH_USER_REQUIRED_ERROR =
  'Verification subject must be linked to a YUCP account before completion';

export async function resolveSubjectAuthUserId(
  convex: ConvexServerClient,
  subjectId: string
): Promise<string | null> {
  const subjectIdentity = await convex.query(internal.subjects.getSubjectIdentityById, {
    subjectId: subjectId as Id<'subjects'>,
  });
  return subjectIdentity?.authUserId ?? null;
}

export async function ensureSubjectAuthUserId(
  convex: ConvexServerClient,
  subjectId: string
): Promise<string | null> {
  return await convex.mutation(internal.subjects.ensureAuthUserIdForSubject, {
    subjectId: subjectId as Id<'subjects'>,
  });
}
