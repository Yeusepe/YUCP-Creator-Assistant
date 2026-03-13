/**
 * Tests for envelope encryption module.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  aadToBytes,
  base64ToBytes,
  bytesToBase64,
  createAAD,
  decrypt,
  decryptToBytes,
  type EncryptedPayload,
  type EncryptionAAD,
  encrypt,
  extractKeyMetadata,
  generateDEK,
  generateIV,
  importKEK,
  isKeyVersion,
  reEncrypt,
  unwrapDEK,
  validatePayload,
  wrapDEK,
} from '../index';

describe('Key utilities', () => {
  describe('generateIV', () => {
    it('should generate a 12-byte IV', () => {
      const iv = generateIV();
      expect(iv.length).toBe(12);
    });

    it('should generate unique IVs', () => {
      const iv1 = generateIV();
      const iv2 = generateIV();
      expect(iv1).not.toEqual(iv2);
    });
  });

  describe('generateDEK', () => {
    it('should generate a CryptoKey for AES-GCM', async () => {
      const dek = await generateDEK();
      expect(dek).toBeDefined();
      expect(dek.type).toBe('secret');
      expect(dek.algorithm.name).toBe('AES-GCM');
      expect(dek.usages).toContain('encrypt');
      expect(dek.usages).toContain('decrypt');
    });

    it('round-trips: generate DEK, encrypt, decrypt equals plaintext', async () => {
      const dek = await generateDEK();
      const plaintext = new TextEncoder().encode('secret-data');
      const iv = generateIV();
      // Ensure we pass concrete ArrayBuffers for iv/plaintext to satisfy strict BufferSource typing
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv.slice().buffer as ArrayBuffer },
        dek,
        new Uint8Array(plaintext).slice().buffer as ArrayBuffer
      );
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv.slice().buffer as ArrayBuffer },
        dek,
        ciphertext
      );
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });

    it('should generate unique keys', async () => {
      const dek1 = await generateDEK();
      const dek2 = await generateDEK();
      // Keys should be different (we can't directly compare, but we can export and compare)
      const raw1 = await crypto.subtle.exportKey('raw', dek1);
      const raw2 = await crypto.subtle.exportKey('raw', dek2);
      expect(new Uint8Array(raw1)).not.toEqual(new Uint8Array(raw2));
    });
  });

  describe('bytesToBase64 / base64ToBytes', () => {
    it('should round-trip bytes correctly', () => {
      const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const base64 = bytesToBase64(original);
      const decoded = base64ToBytes(base64);
      expect(decoded).toEqual(original);
    });

    it('should handle empty bytes', () => {
      const original = new Uint8Array([]);
      const base64 = bytesToBase64(original);
      const decoded = base64ToBytes(base64);
      expect(decoded).toEqual(original);
    });

    it('should handle random bytes', () => {
      const original = crypto.getRandomValues(new Uint8Array(32));
      const base64 = bytesToBase64(original);
      const decoded = base64ToBytes(base64);
      expect(decoded).toEqual(original);
    });
  });

  describe('aadToBytes', () => {
    it('should convert AAD to expected format', () => {
      const aad: EncryptionAAD = {
        authUserId: 'user_test123',
        provider: 'gumroad',
        tokenType: 'access',
      };
      const bytes = aadToBytes(aad);
      const decoded = new TextDecoder().decode(bytes);
      expect(decoded).toBe('user_test123:gumroad:access');
    });

    it('should produce different bytes for different AAD', () => {
      const aad1: EncryptionAAD = {
        authUserId: 'user_test123',
        provider: 'gumroad',
        tokenType: 'access',
      };
      const aad2: EncryptionAAD = {
        authUserId: 'user_test456',
        provider: 'gumroad',
        tokenType: 'access',
      };
      expect(aadToBytes(aad1)).not.toEqual(aadToBytes(aad2));
    });
  });
});

describe('Key wrapping', () => {
  let kek: CryptoKey;
  let dek: CryptoKey;

  beforeEach(async () => {
    // Generate a KEK for testing (in production this comes from Infisical)
    const kekBytes = crypto.getRandomValues(new Uint8Array(32));
    kek = await importKEK(kekBytes);
    dek = await generateDEK();
  });

  it('should wrap and unwrap a DEK', async () => {
    const wrapped = await wrapDEK(dek, kek);
    expect(wrapped).toBeDefined();
    expect(wrapped.length).toBeGreaterThan(0);

    const unwrapped = await unwrapDEK(wrapped, kek);
    expect(unwrapped).toBeDefined();
    expect(unwrapped.algorithm.name).toBe('AES-GCM');
  });

  it('should fail to unwrap with wrong KEK', async () => {
    const wrapped = await wrapDEK(dek, kek);

    // Generate a different KEK
    const wrongKekBytes = crypto.getRandomValues(new Uint8Array(32));
    const wrongKek = await importKEK(wrongKekBytes);

    await expect(unwrapDEK(wrapped, wrongKek)).rejects.toThrow();
  });

  it('should produce different wrapped keys for same DEK with different KEKs', async () => {
    const kek2Bytes = crypto.getRandomValues(new Uint8Array(32));
    const kek2 = await importKEK(kek2Bytes);

    const wrapped1 = await wrapDEK(dek, kek);
    const wrapped2 = await wrapDEK(dek, kek2);

    expect(wrapped1).not.toEqual(wrapped2);
  });
});

describe('Envelope encryption', () => {
  let kekBytes: Uint8Array;
  const aad: EncryptionAAD = {
    authUserId: 'user_test123',
    provider: 'gumroad',
    tokenType: 'access',
  };
  const encryptOptions: {
    keyId: string;
    keyVersion: number;
    kekBytes: Uint8Array;
    aad: EncryptionAAD;
  } = {
    keyId: 'kek-v1',
    keyVersion: 1,
    kekBytes: new Uint8Array(32),
    aad,
  };

  beforeEach(() => {
    kekBytes = crypto.getRandomValues(new Uint8Array(32));
    encryptOptions.kekBytes = kekBytes;
  });

  describe('encrypt', () => {
    it('should encrypt a string and return a valid payload', async () => {
      const plaintext = 'my-secret-token';
      const payload = await encrypt(plaintext, encryptOptions);

      expect(payload).toBeDefined();
      expect(payload.ciphertext).toBeDefined();
      expect(payload.iv).toBeDefined();
      expect(payload.wrappedDek).toBeDefined();
      expect(payload.wrappedDek.keyId).toBe('kek-v1');
      expect(payload.wrappedDek.keyVersion).toBe(1);
      expect(payload.algorithm).toBe('AES-256-GCM');
      expect(payload.encryptedAt).toBeDefined();
      expect(payload.aadMetadata.authUserId).toBe('user_test123');
    });

    it('should encrypt Uint8Array and decrypt to original bytes', async () => {
      const plaintext = new TextEncoder().encode('my-secret-token');
      const payload = await encrypt(plaintext, encryptOptions);

      expect(payload).toBeDefined();
      expect(payload.ciphertext).toBeDefined();

      const decrypted = await decryptToBytes({
        kekBytes,
        payload,
        aad,
      });
      expect(decrypted).toEqual(plaintext);
    });

    it('should produce different ciphertexts for same plaintext', async () => {
      const plaintext = 'my-secret-token';
      const payload1 = await encrypt(plaintext, encryptOptions);
      const payload2 = await encrypt(plaintext, encryptOptions);

      // Different IVs and DEKs should produce different ciphertext
      expect(payload1.ciphertext).not.toBe(payload2.ciphertext);
      expect(payload1.iv).not.toBe(payload2.iv);
    });

    it('should produce valid base64 for all encoded fields usable in decrypt', async () => {
      const payload = await encrypt('test', encryptOptions);

      const cipherBytes = base64ToBytes(payload.ciphertext);
      const ivBytes = base64ToBytes(payload.iv);
      const dekBytes = base64ToBytes(payload.wrappedDek.encryptedDek);
      expect(cipherBytes.length).toBeGreaterThan(0);
      expect(ivBytes.length).toBe(12);
      expect(dekBytes.length).toBeGreaterThan(0);

      const decrypted = await decrypt({ kekBytes, payload, aad });
      expect(decrypted).toBe('test');
    });
  });

  describe('decrypt', () => {
    it('should decrypt to the original plaintext', async () => {
      const plaintext = 'my-secret-token';
      const payload = await encrypt(plaintext, encryptOptions);

      const decrypted = await decrypt({
        kekBytes,
        payload,
        aad,
      });

      expect(decrypted).toBe(plaintext);
    });

    it('should decrypt to bytes correctly', async () => {
      const plaintext = 'my-secret-token';
      const payload = await encrypt(plaintext, encryptOptions);

      const decrypted = await decryptToBytes({
        kekBytes,
        payload,
        aad,
      });

      const expected = new TextEncoder().encode(plaintext);
      expect(decrypted).toEqual(expected);
    });

    it('should fail with wrong KEK', async () => {
      const plaintext = 'my-secret-token';
      const payload = await encrypt(plaintext, encryptOptions);

      const wrongKekBytes = crypto.getRandomValues(new Uint8Array(32));

      await expect(
        decrypt({
          kekBytes: wrongKekBytes,
          payload,
          aad,
        })
      ).rejects.toThrow();
    });

    it('should fail with wrong AAD (different tenant)', async () => {
      const plaintext = 'my-secret-token';
      const payload = await encrypt(plaintext, encryptOptions);

      const wrongAad: EncryptionAAD = {
        ...aad,
        authUserId: 'user_different',
      };

      await expect(
        decrypt({
          kekBytes,
          payload,
          aad: wrongAad,
        })
      ).rejects.toThrow('AAD mismatch');
    });

    it('should fail with wrong AAD (different provider)', async () => {
      const plaintext = 'my-secret-token';
      const payload = await encrypt(plaintext, encryptOptions);

      const wrongAad: EncryptionAAD = {
        ...aad,
        provider: 'discord',
      };

      await expect(
        decrypt({
          kekBytes,
          payload,
          aad: wrongAad,
        })
      ).rejects.toThrow('AAD mismatch');
    });

    it('should fail with wrong AAD (different tokenType)', async () => {
      const plaintext = 'my-secret-token';
      const payload = await encrypt(plaintext, encryptOptions);

      const wrongAad: EncryptionAAD = {
        ...aad,
        tokenType: 'refresh',
      };

      await expect(
        decrypt({
          kekBytes,
          payload,
          aad: wrongAad,
        })
      ).rejects.toThrow('AAD mismatch');
    });

    it('should fail with tampered ciphertext', async () => {
      const plaintext = 'my-secret-token';
      const payload = await encrypt(plaintext, encryptOptions);

      // Tamper with ciphertext
      const tamperedPayload: EncryptedPayload = {
        ...payload,
        ciphertext: `${payload.ciphertext.slice(0, -5)}XXXXX`,
      };

      await expect(
        decrypt({
          kekBytes,
          payload: tamperedPayload,
          aad,
        })
      ).rejects.toThrow();
    });

    it('should fail with unsupported algorithm', async () => {
      const payload = await encrypt('test', encryptOptions);

      const invalidPayload: EncryptedPayload = {
        ...payload,
        algorithm: 'AES-128-CBC' as EncryptedPayload['algorithm'],
      };

      await expect(
        decrypt({
          kekBytes,
          payload: invalidPayload,
          aad,
        })
      ).rejects.toThrow('Unsupported algorithm');
    });
  });

  describe('reEncrypt', () => {
    it('should re-encrypt with a new KEK', async () => {
      const plaintext = 'my-secret-token';
      const oldPayload = await encrypt(plaintext, encryptOptions);

      const newKekBytes = crypto.getRandomValues(new Uint8Array(32));
      const newPayload = await reEncrypt(oldPayload, kekBytes, {
        keyId: 'kek-v2',
        keyVersion: 2,
        kekBytes: newKekBytes,
      });

      expect(newPayload.wrappedDek.keyId).toBe('kek-v2');
      expect(newPayload.wrappedDek.keyVersion).toBe(2);

      // Should decrypt with new KEK
      const decrypted = await decrypt({
        kekBytes: newKekBytes,
        payload: newPayload,
        aad,
      });
      expect(decrypted).toBe(plaintext);

      // Should NOT decrypt with old KEK
      await expect(
        decrypt({
          kekBytes,
          payload: newPayload,
          aad,
        })
      ).rejects.toThrow();
    });

    it('should preserve AAD metadata during re-encryption', async () => {
      const plaintext = 'my-secret-token';
      const oldPayload = await encrypt(plaintext, encryptOptions);

      const newKekBytes = crypto.getRandomValues(new Uint8Array(32));
      const newPayload = await reEncrypt(oldPayload, kekBytes, {
        keyId: 'kek-v2',
        keyVersion: 2,
        kekBytes: newKekBytes,
      });

      expect(newPayload.aadMetadata).toEqual(oldPayload.aadMetadata);
    });
  });
});

describe('Payload utilities', () => {
  let validPayload: EncryptedPayload;
  const aad: EncryptionAAD = {
    authUserId: 'user_test123',
    provider: 'gumroad',
    tokenType: 'access',
  };

  beforeEach(async () => {
    const kekBytes = crypto.getRandomValues(new Uint8Array(32));
    validPayload = await encrypt('test', {
      keyId: 'kek-v1',
      keyVersion: 1,
      kekBytes,
      aad,
    });
  });

  describe('validatePayload', () => {
    it('should validate a correct payload', () => {
      expect(validatePayload(validPayload)).toBe(true);
    });

    it('should reject null', () => {
      expect(validatePayload(null)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(validatePayload(undefined)).toBe(false);
    });

    it('should reject object without ciphertext', () => {
      expect(validatePayload({ ...validPayload, ciphertext: undefined })).toBe(false);
    });

    it('should reject object with wrong algorithm', () => {
      expect(validatePayload({ ...validPayload, algorithm: 'wrong' })).toBe(false);
    });

    it('should reject object with missing wrappedDek fields', () => {
      expect(
        validatePayload({
          ...validPayload,
          wrappedDek: { ...validPayload.wrappedDek, keyId: undefined },
        })
      ).toBe(false);
    });
  });

  describe('isKeyVersion', () => {
    it('should return true for matching key version', () => {
      expect(isKeyVersion(validPayload, 'kek-v1', 1)).toBe(true);
    });

    it('should return false for non-matching key ID', () => {
      expect(isKeyVersion(validPayload, 'kek-v2', 1)).toBe(false);
    });

    it('should return false for non-matching version', () => {
      expect(isKeyVersion(validPayload, 'kek-v1', 2)).toBe(false);
    });
  });

  describe('extractKeyMetadata', () => {
    it('should extract correct metadata', () => {
      const metadata = extractKeyMetadata(validPayload);

      expect(metadata.keyId).toBe('kek-v1');
      expect(metadata.keyVersion).toBe(1);
      expect(metadata.algorithm).toBe('AES-256-GCM');
      expect(metadata.authUserId).toBe('user_test123');
      expect(metadata.provider).toBe('gumroad');
      expect(metadata.tokenType).toBe('access');
    });
  });
});

describe('createAAD', () => {
  it('should create AAD with correct values', () => {
    const aad = createAAD('user_test123', 'discord', 'refresh');

    expect(aad.authUserId).toBe('user_test123');
    expect(aad.provider).toBe('discord');
    expect(aad.tokenType).toBe('refresh');
  });

  it('should accept all provider types', () => {
    const providers: Array<'discord' | 'gumroad' | 'jinxxy' | 'manual'> = [
      'discord',
      'gumroad',
      'jinxxy',
      'manual',
    ];

    for (const provider of providers) {
      const aad = createAAD('tenant', provider, 'access');
      expect(aad.provider).toBe(provider);
    }
  });

  it('should accept all token types', () => {
    const types: Array<'access' | 'refresh' | 'api_key'> = ['access', 'refresh', 'api_key'];

    for (const tokenType of types) {
      const aad = createAAD('tenant', 'gumroad', tokenType);
      expect(aad.tokenType).toBe(tokenType);
    }
  });
});

describe('Integration tests', () => {
  it('should handle realistic token encryption flow', async () => {
    // Simulate a Gumroad access token
    const accessToken = 'gumroad_access_token_abc123xyz789';

    // Generate KEK (in production, this comes from Infisical)
    const kekBytes = crypto.getRandomValues(new Uint8Array(32));

    // Create AAD for this token's context
    const aad = createAAD('user_test123', 'gumroad', 'access');

    // Encrypt the token
    const payload = await encrypt(accessToken, {
      keyId: 'prod-kek-v1',
      keyVersion: 1,
      kekBytes,
      aad,
    });

    // Simulate storing the payload (e.g., in database)
    const storedPayload = JSON.stringify(payload);

    // Simulate retrieving and decrypting
    const retrievedPayload = JSON.parse(storedPayload) as EncryptedPayload;
    const decryptedToken = await decrypt({
      kekBytes,
      payload: retrievedPayload,
      aad,
    });

    expect(decryptedToken).toBe(accessToken);
  });

  it('should handle key rotation scenario', async () => {
    const accessToken = 'gumroad_access_token_abc123xyz789';

    // Original KEK (v1)
    const kekV1 = crypto.getRandomValues(new Uint8Array(32));

    // New KEK (v2)
    const kekV2 = crypto.getRandomValues(new Uint8Array(32));

    const aad = createAAD('user_test123', 'gumroad', 'access');

    // Encrypt with v1
    const payloadV1 = await encrypt(accessToken, {
      keyId: 'kek-v1',
      keyVersion: 1,
      kekBytes: kekV1,
      aad,
    });

    // Rotate to v2
    const payloadV2 = await reEncrypt(payloadV1, kekV1, {
      keyId: 'kek-v2',
      keyVersion: 2,
      kekBytes: kekV2,
    });

    // Verify v2 decrypts correctly
    const decrypted = await decrypt({
      kekBytes: kekV2,
      payload: payloadV2,
      aad,
    });

    expect(decrypted).toBe(accessToken);
    expect(payloadV2.wrappedDek.keyVersion).toBe(2);
  });

  it('should enforce tenant isolation', async () => {
    const token = 'secret-token';
    const kekBytes = crypto.getRandomValues(new Uint8Array(32));

    // Encrypt for tenant A
    const aadA = createAAD('user_test_a', 'gumroad', 'access');
    const payloadA = await encrypt(token, {
      keyId: 'kek-v1',
      keyVersion: 1,
      kekBytes,
      aad: aadA,
    });

    // Try to decrypt with tenant B's context (should fail)
    const aadB = createAAD('user_test_b', 'gumroad', 'access');

    await expect(
      decrypt({
        kekBytes,
        payload: payloadA,
        aad: aadB,
      })
    ).rejects.toThrow('AAD mismatch');
  });
});
