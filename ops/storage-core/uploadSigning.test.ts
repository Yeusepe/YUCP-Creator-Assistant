import { describe, expect, test } from 'bun:test';
import { signUploadCapability, verifyUploadCapability } from './uploadSigning';

describe('upload capability signing', () => {
  const key = 'trusted-upload-test-key';
  const now = new Date('2026-07-16T12:00:00.000Z');
  const expiresAt = new Date('2026-07-16T12:05:00.000Z');

  test('binds the intended version and expiry to the server key', async () => {
    const capability = await signUploadCapability({
      expiresAt,
      key,
      versionId: 'd7eb9f28-b970-4a3c-b55e-c100fb9f81ed',
    });

    await expect(verifyUploadCapability({ ...capability, now }, key)).resolves.toBe(true);
    await expect(
      verifyUploadCapability(
        { ...capability, now, versionId: 'd3038fd9-152b-46eb-98a1-12956d9eeed9' },
        key
      )
    ).resolves.toBe(false);
    await expect(verifyUploadCapability({ ...capability, now }, 'attacker-key')).resolves.toBe(
      false
    );
    await expect(verifyUploadCapability({ ...capability, now: expiresAt }, key)).resolves.toBe(
      false
    );
  });
});
