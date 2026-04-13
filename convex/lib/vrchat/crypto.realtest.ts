/**
 * Tests for VRChat crypto utilities.
 *
 * NOTE: These run in vitest's edge-runtime, which supports HKDF, unlike
 * Convex's actual V8 runtime (which throws "Not implemented: importKey for
 * HKDF"). The implementation therefore uses a manual HMAC-based HKDF so it
 * works in both environments. These roundtrip tests confirm correct behavior
 * but cannot simulate the Convex HKDF restriction directly.
 *
 * Run with: npx vitest run --config convex/vitest.config.ts
 */
import { describe, expect, it } from 'vitest';
import { decryptForPurpose, encryptForPurpose } from './crypto';

describe('encryptForPurpose / decryptForPurpose', () => {
  it('encrypts and decrypts a round-trip in the edge runtime', async () => {
    const secret = 'test-secret-key';
    const purpose = 'vrchat-provider-session';
    const plaintext = 'auth-token-value';

    const ciphertext = await encryptForPurpose(plaintext, secret, purpose);
    const decrypted = await decryptForPurpose(ciphertext, secret, purpose);

    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for different secrets', async () => {
    const purpose = 'vrchat-provider-session';
    const plaintext = 'same-plaintext';

    const ct1 = await encryptForPurpose(plaintext, 'secret-a', purpose);
    const ct2 = await encryptForPurpose(plaintext, 'secret-b', purpose);

    expect(ct1).not.toBe(ct2);
    await expect(decryptForPurpose(ct2, 'secret-a', purpose)).rejects.toThrow();
  });

  it('produces different ciphertexts for different purposes (domain separation)', async () => {
    const secret = 'same-secret';
    const plaintext = 'token';

    const ct1 = await encryptForPurpose(plaintext, secret, 'purpose-a');
    const ct2 = await encryptForPurpose(plaintext, secret, 'purpose-b');

    expect(ct1).not.toBe(ct2);
    await expect(decryptForPurpose(ct2, secret, 'purpose-a')).rejects.toThrow();
  });

  it('produces unique ciphertexts for the same plaintext (random IV)', async () => {
    const secret = 'secret';
    const purpose = 'purpose';
    const plaintext = 'token';

    const ct1 = await encryptForPurpose(plaintext, secret, purpose);
    const ct2 = await encryptForPurpose(plaintext, secret, purpose);

    expect(ct1).not.toBe(ct2);
  });
});
