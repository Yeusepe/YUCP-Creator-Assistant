import { describe, expect, test } from 'bun:test';
import { signUploadCapability, verifyUploadCapability } from './uploadSigning';

describe('upload capability signing', () => {
  const key = 'trusted-upload-test-key';
  const now = new Date('2026-07-16T12:00:00.000Z');
  const expiresAt = new Date('2026-07-16T12:05:00.000Z');

  test('binds the intended catalog target, version ID, and expiry to the server key', async () => {
    const capability = await signUploadCapability({
      catalogProductId: 'catalog-product-123',
      expiresAt,
      key,
      packageId: 'com.yucp.avatar-tools',
      version: '1.2.3',
      versionId: 'd7eb9f28-b970-4a3c-b55e-c100fb9f81ed',
    });

    await expect(verifyUploadCapability({ ...capability, now }, key)).resolves.toBe(true);
    await expect(
      verifyUploadCapability(
        { ...capability, now, versionId: 'd3038fd9-152b-46eb-98a1-12956d9eeed9' },
        key
      )
    ).resolves.toBe(false);
    await expect(
      verifyUploadCapability({ ...capability, now, packageId: 'com.attacker.package' }, key)
    ).resolves.toBe(false);
    await expect(
      verifyUploadCapability({ ...capability, now, version: '9.9.9' }, key)
    ).resolves.toBe(false);
    await expect(
      verifyUploadCapability({ ...capability, now, catalogProductId: 'other-product' }, key)
    ).resolves.toBe(false);
    await expect(verifyUploadCapability({ ...capability, now }, 'attacker-key')).resolves.toBe(
      false
    );
    await expect(verifyUploadCapability({ ...capability, now: expiresAt }, key)).resolves.toBe(
      false
    );
  });
});
