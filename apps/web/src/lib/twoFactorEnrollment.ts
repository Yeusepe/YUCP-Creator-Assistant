export type TwoFactorEnrollmentResult =
  | { method: 'otp' }
  | { method: 'totp'; totpURI: string; backupCodes: string[] };

/**
 * Better Auth 1.7 returns backup codes only for TOTP enrollment.
 * Reference: https://better-auth.com/docs/guides/1-7-upgrade-guide
 */
export function requireTotpBackupCodes(
  enrollment: TwoFactorEnrollmentResult | null | undefined
): string[] {
  if (enrollment?.method !== 'totp') {
    throw new Error('TOTP enrollment did not return backup codes');
  }

  return enrollment.backupCodes;
}
