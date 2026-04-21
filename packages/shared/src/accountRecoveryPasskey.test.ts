import { describe, expect, it } from 'bun:test';
import {
  issueRecoveryPasskeyContext,
  verifyRecoveryPasskeyContext,
} from './accountRecoveryPasskey';

const SECRET = 'test-recovery-secret';

describe('account recovery passkey context', () => {
  it('round-trips a valid token', async () => {
    const token = await issueRecoveryPasskeyContext(
      {
        authUserId: 'user_123',
        method: 'backup-code',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_300_000,
        nonce: 'nonce_123',
      },
      SECRET
    );

    await expect(verifyRecoveryPasskeyContext(token, SECRET, 1_700_000_100_000)).resolves.toEqual({
      authUserId: 'user_123',
      method: 'backup-code',
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_300_000,
      nonce: 'nonce_123',
    });
  });

  it('rejects expired tokens', async () => {
    const token = await issueRecoveryPasskeyContext(
      {
        authUserId: 'user_123',
        method: 'recovery-email-otp',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_100_000,
        nonce: 'nonce_123',
      },
      SECRET
    );

    await expect(
      verifyRecoveryPasskeyContext(token, SECRET, 1_700_000_100_001)
    ).resolves.toBeNull();
  });

  it('rejects tokens with extra dot segments', async () => {
    const token = await issueRecoveryPasskeyContext(
      {
        authUserId: 'user_123',
        method: 'backup-code',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_300_000,
        nonce: 'nonce_123',
      },
      SECRET
    );

    await expect(
      verifyRecoveryPasskeyContext(`${token}.unexpected`, SECRET, 1_700_000_100_000)
    ).resolves.toBeNull();
  });

  it('rejects tokens with unsupported methods', async () => {
    const token = await issueRecoveryPasskeyContext(
      {
        authUserId: 'user_123',
        method: 'backup-code',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_300_000,
        nonce: 'nonce_123',
      },
      SECRET
    );
    const [encodedPayload, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      authUserId: string;
      method: string;
      expiresAt: number;
      issuedAt: number;
      nonce: string;
      purpose: string;
      version: string;
    };
    payload.method = 'totally-made-up-method';
    const malformedToken = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;

    await expect(
      verifyRecoveryPasskeyContext(malformedToken, SECRET, 1_700_000_100_000)
    ).resolves.toBeNull();
  });
});
