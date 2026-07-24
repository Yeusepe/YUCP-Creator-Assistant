import { describe, expect, it } from 'vitest';
import { requireTotpBackupCodes } from '@/lib/twoFactorEnrollment';

describe('requireTotpBackupCodes', () => {
  it('returns backup codes from a TOTP enrollment response', () => {
    expect(
      requireTotpBackupCodes({
        method: 'totp',
        totpURI: 'otpauth://totp/YUCP:test',
        backupCodes: ['code-one', 'code-two'],
      })
    ).toEqual(['code-one', 'code-two']);
  });

  it('rejects an OTP enrollment response without backup codes', () => {
    expect(() => requireTotpBackupCodes({ method: 'otp' })).toThrow(
      'TOTP enrollment did not return backup codes'
    );
  });

  it('rejects an empty enrollment response', () => {
    expect(() => requireTotpBackupCodes(undefined)).toThrow(
      'TOTP enrollment did not return backup codes'
    );
  });
});
