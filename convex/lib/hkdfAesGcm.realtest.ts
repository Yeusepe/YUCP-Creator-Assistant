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
});
