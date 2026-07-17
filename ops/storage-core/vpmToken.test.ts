import { describe, expect, test } from 'bun:test';
import { signVpmRepoToken, verifyVpmRepoToken } from './vpmToken';

describe('VPM repository token signing', () => {
  const key = 'trusted-vpm-repository-test-key-32';
  const now = new Date('2026-07-17T12:00:00.000Z');
  const expiresAt = new Date('2026-08-16T12:00:00.000Z');

  test('binds the buyer identity and expiry to a path-safe HMAC token', async () => {
    const signed = await signVpmRepoToken({
      authUserId: 'buyer/auth-user',
      expiresAt,
      key,
    });

    expect(signed.token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    await expect(verifyVpmRepoToken({ key, now, token: signed.token })).resolves.toEqual({
      authUserId: 'buyer/auth-user',
      expiresAt: expiresAt.getTime(),
    });
  });

  test('rejects tampered, wrong-key, malformed, and expired tokens', async () => {
    const signed = await signVpmRepoToken({
      authUserId: 'buyer-auth-user',
      expiresAt,
      key,
    });
    const [payload, signature] = signed.token.split('.');

    await expect(
      verifyVpmRepoToken({ key, now, token: `${payload}x.${signature}` })
    ).resolves.toBeNull();
    await expect(
      verifyVpmRepoToken({ key: 'attacker-key', now, token: signed.token })
    ).resolves.toBeNull();
    await expect(verifyVpmRepoToken({ key, now, token: 'not-a-token' })).resolves.toBeNull();
    await expect(
      verifyVpmRepoToken({ key, now: expiresAt, token: signed.token })
    ).resolves.toBeNull();
  });

  test('rejects HMAC keys shorter than 32 UTF-8 bytes', async () => {
    await expect(
      signVpmRepoToken({ authUserId: 'buyer-auth-user', expiresAt, key: 'short-key' })
    ).rejects.toThrow('at least 32 UTF-8 bytes');
  });
});
