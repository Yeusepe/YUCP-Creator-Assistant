import { describe, expect, it } from 'vitest';
import { encrypt } from '../../apps/api/src/lib/encrypt';
import { decryptHkdfAesGcm } from './hkdfAesGcm';

describe('decryptHkdfAesGcm', () => {
  it('decrypts ciphertext from the API native HKDF encryptor', async () => {
    const secret = 'test-encryption-secret-32-bytes!!';
    const purpose = 'gumroad-oauth-access-token';
    const ciphertext = await encrypt('provider-token', secret, purpose);

    await expect(decryptHkdfAesGcm(ciphertext, secret, purpose)).resolves.toBe('provider-token');
  });

  it('rejects ciphertext encrypted with a different secret', async () => {
    const purpose = 'gumroad-oauth-access-token';
    const ciphertext = await encrypt('provider-token', 'test-encryption-secret-32-bytes!!', purpose);

    await expect(decryptHkdfAesGcm(ciphertext, 'different-secret-32-bytes-here', purpose)).rejects.toThrow();
  });

  it('rejects ciphertext encrypted for a different purpose', async () => {
    const secret = 'test-encryption-secret-32-bytes!!';
    const ciphertext = await encrypt('provider-token', secret, 'gumroad-oauth-access-token');

    await expect(decryptHkdfAesGcm(ciphertext, secret, 'vrchat-creator-session')).rejects.toThrow();
  });

  it('rejects truncated encrypted values before decrypting', async () => {
    await expect(
      decryptHkdfAesGcm('YWJj', 'test-encryption-secret-32-bytes!!', 'gumroad-oauth-access-token')
    ).rejects.toThrow('Encrypted value is malformed.');
  });

  it('rejects oversized encrypted values before decoding', async () => {
    const oversizedCiphertext = 'A'.repeat(100 * 1024 + 1);

    await expect(
      decryptHkdfAesGcm(
        oversizedCiphertext,
        'test-encryption-secret-32-bytes!!',
        'gumroad-oauth-access-token'
      )
    ).rejects.toThrow('Encrypted value exceeds maximum supported size.');
  });
});
