import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ConvexServerClient } from './convex';

export const SUBJECT_AUTH_USER_REQUIRED_ERROR =
  'Verification subject must be linked to a Creator Account before completion';

export async function ensureSubjectAuthUserId(
  convex: ConvexServerClient,
  apiSecret: string,
  subjectId: string
): Promise<string | null> {
  return await convex.mutation(api.subjects.ensureAuthUserIdForSubject, {
    apiSecret,
    subjectId: subjectId as Id<'subjects'>,
  });
}
