import { describe, expect, it } from 'bun:test';
import { encryptForPurpose } from './lib/vrchat/crypto';
import { loadAndDecryptSession } from './vrchatAvatarActions';

const PURPOSE = 'vrchat-provider-session';
const PREFIX = 'enc:v1:';

describe('loadAndDecryptSession', () => {
  it('decrypts enc:v1: prefixed auth token correctly', async () => {
    const secret = 'test-secret-key-abc';
    const authToken = 'vrc-auth-token-abc123';

    const encrypted = await encryptForPurpose(authToken, secret, PURPOSE);
    const result = await loadAndDecryptSession(`${PREFIX}${encrypted}`, undefined, secret);

    expect(result.authToken).toBe(authToken);
    expect(result.twoFactorAuthToken).toBeUndefined();
  });

  it('decrypts enc:v1: prefixed 2FA token correctly', async () => {
    const secret = 'test-secret-key-abc';
    const authToken = 'vrc-auth-token-abc123';
    const twoFaToken = 'vrc-2fa-token-xyz789';

    const encryptedAuth = await encryptForPurpose(authToken, secret, PURPOSE);
    const encrypted2fa = await encryptForPurpose(twoFaToken, secret, PURPOSE);
    const result = await loadAndDecryptSession(
      `${PREFIX}${encryptedAuth}`,
      `${PREFIX}${encrypted2fa}`,
      secret
    );

    expect(result.authToken).toBe(authToken);
    expect(result.twoFactorAuthToken).toBe(twoFaToken);
  });

  it('passes through a plain (unencrypted/legacy) auth token without modification', async () => {
    const plainToken = 'plain-auth-token-no-prefix';
    const result = await loadAndDecryptSession(plainToken, undefined, 'any-secret');

    expect(result.authToken).toBe(plainToken);
    expect(result.twoFactorAuthToken).toBeUndefined();
  });

  it('treats an empty 2FA token as absent', async () => {
    const secret = 'test-secret-key-abc';
    const authToken = 'vrc-auth-token-abc123';
    const encryptedAuth = await encryptForPurpose(authToken, secret, PURPOSE);

    const result = await loadAndDecryptSession(`${PREFIX}${encryptedAuth}`, '', secret);
    expect(result.twoFactorAuthToken).toBeUndefined();
  });
});
