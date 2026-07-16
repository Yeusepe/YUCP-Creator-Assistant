import { describe, expect, test } from 'bun:test';
import { signDeliveryUrl, verifyDeliveryUrl } from './deliverySigning';

describe('delivery URL signing', () => {
  const key = 'throwaway-test-key';
  const now = new Date('2026-07-16T12:00:00.000Z');
  const expiresAt = new Date('2026-07-16T12:05:00.000Z');

  test('signs and verifies versionId|exp with Web Crypto HMAC-SHA256', async () => {
    const signed = await signDeliveryUrl({ expiresAt, key, versionId: 'version_123' });

    expect(signed.exp).toBe('1784203500');
    expect(signed.sig).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      verifyDeliveryUrl({ ...signed, key, now, versionId: 'version_123' })
    ).resolves.toBe(true);
  });

  test('rejects expiry and every signed-field mutation', async () => {
    const signed = await signDeliveryUrl({ expiresAt, key, versionId: 'version_123' });

    await expect(
      verifyDeliveryUrl({ ...signed, key, now: expiresAt, versionId: 'version_123' })
    ).resolves.toBe(false);
    await expect(
      verifyDeliveryUrl({ ...signed, key, now, versionId: 'version_456' })
    ).resolves.toBe(false);
    await expect(
      verifyDeliveryUrl({ ...signed, exp: '1784203501', key, now, versionId: 'version_123' })
    ).resolves.toBe(false);
    await expect(
      verifyDeliveryUrl({ ...signed, key: 'different-test-key', now, versionId: 'version_123' })
    ).resolves.toBe(false);
    await expect(
      verifyDeliveryUrl({ ...signed, key, now, sig: 'not-hex', versionId: 'version_123' })
    ).resolves.toBe(false);
  });
});
