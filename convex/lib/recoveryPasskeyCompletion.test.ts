import { describe, expect, it, mock } from 'bun:test';
import {
  completeRecoveryPasskeyEnrollmentOrThrow,
  type RecoveryPasskeyCompletionArgs,
} from './recoveryPasskeyCompletion';

const args: RecoveryPasskeyCompletionArgs = {
  authUserId: 'auth-user-123',
  contextNonce: 'nonce-123',
  method: 'backup-code',
  completedAt: 1_700_000_000_000,
};

describe('completeRecoveryPasskeyEnrollmentOrThrow', () => {
  it('throws when recovery enrollment completion is rejected', async () => {
    const completeEnrollment = mock(async () => ({ completed: false }));

    await expect(
      completeRecoveryPasskeyEnrollmentOrThrow(completeEnrollment, args)
    ).rejects.toThrow('Recovery passkey context is invalid, expired, or already used');
  });

  it('passes through the completion args when recovery enrollment succeeds', async () => {
    const completeEnrollment = mock(async () => ({ completed: true }));

    await expect(
      completeRecoveryPasskeyEnrollmentOrThrow(completeEnrollment, args)
    ).resolves.toBeUndefined();
    expect(completeEnrollment).toHaveBeenCalledWith(args);
  });
});
