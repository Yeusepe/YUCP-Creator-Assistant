import type { RecoveryContextMethod } from '@yucp/shared';

export interface RecoveryPasskeyCompletionArgs {
  authUserId: string;
  contextNonce: string;
  method: RecoveryContextMethod;
  completedAt: number;
}

export async function completeRecoveryPasskeyEnrollmentOrThrow(
  completeEnrollment: (args: RecoveryPasskeyCompletionArgs) => Promise<{ completed: boolean }>,
  args: RecoveryPasskeyCompletionArgs
) {
  const result = await completeEnrollment(args);
  if (!result.completed) {
    throw new Error('Recovery passkey context is invalid, expired, or already used');
  }
}
