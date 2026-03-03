/**
 * Envelope encryption implementation for provider tokens.
 *
 * Envelope encryption pattern:
 * 1. Generate a random DEK (Data Encryption Key)
 * 2. Encrypt plaintext with DEK using AES-256-GCM with AAD
 * 3. Wrap DEK with KEK (Key Encryption Key from Infisical KMS)
 * 4. Store: ciphertext + wrapped_dek + key_version + aad_metadata
 *
 * Security properties:
 * - AES-256-GCM provides authenticated encryption
 * - AAD (Additional Authenticated Data) binds ciphertext to context
 * - Each encryption uses a unique DEK (no key reuse)
 * - DEKs are wrapped with KEK for secure storage
 */

import type {
  EncryptedPayload,
  EncryptionAAD,
  KEKReference,
  TokenProvider,
  TokenType,
  WrappedDEK,
} from './keys';
import {
  aadToBytes,
  base64ToBytes,
  bytesToBase64,
  generateDEK,
  generateIV,
  importKEK,
  unwrapDEK,
  wrapDEK,
} from './keys';

/**
 * Options for envelope encryption.
 */
export interface EncryptOptions {
  /** The KEK key ID (for tracking/rotation) */
  keyId: string;
  /** The KEK version */
  keyVersion: number;
  /** The raw KEK bytes retrieved from Infisical KMS */
  kekBytes: Uint8Array;
  /** The AAD context for binding */
  aad: EncryptionAAD;
}

/**
 * Options for envelope decryption.
 */
export interface DecryptOptions {
  /** The raw KEK bytes retrieved from Infisical KMS */
  kekBytes: Uint8Array;
  /** The encrypted payload to decrypt */
  payload: EncryptedPayload;
  /** The AAD context for verification (must match encryption AAD) */
  aad: EncryptionAAD;
}

/**
 * Encrypt data using envelope encryption with AAD binding.
 *
 * @param plaintext - The data to encrypt
 * @param options - Encryption options including KEK and AAD
 * @returns Encrypted payload ready for storage
 *
 * @example
 * ```ts
 * const payload = await encrypt(accessToken, {
 *   keyId: 'kek-v1',
 *   keyVersion: 1,
 *   kekBytes: kekFromInfisical,
 *   aad: { tenantId: 'tenant-123', provider: 'gumroad', tokenType: 'access' }
 * });
 * ```
 */
export async function encrypt(
  plaintext: string | Uint8Array,
  options: EncryptOptions
): Promise<EncryptedPayload> {
  const { keyId, keyVersion, kekBytes, aad } = options;

  // 1. Convert plaintext to bytes if needed
  const plaintextBytes =
    typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;

  // 2. Generate a fresh DEK for this encryption
  const dek = await generateDEK();

  // 3. Generate IV for data encryption
  const dataIv = generateIV();

  // 4. Convert AAD to bytes for binding
  const aadBytes = aadToBytes(aad);

  // 5. Encrypt the plaintext with the DEK using AES-256-GCM
  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: dataIv,
      additionalData: aadBytes,
      tagLength: 128, // 16-byte auth tag
    },
    dek,
    plaintextBytes
  );
  const ciphertext = new Uint8Array(ciphertextBuffer);

  // 6. Import the KEK for wrapping
  const kek = await importKEK(kekBytes);

  // 7. Wrap the DEK with the KEK using AES-KW
  const wrappedDekBytes = await wrapDEK(dek, kek);

  // 8. Build the wrapped DEK structure
  const wrappedDek: WrappedDEK = {
    encryptedDek: bytesToBase64(wrappedDekBytes),
    keyId,
    keyVersion,
    iv: '', // AES-KW doesn't use IV
  };

  // 9. Build and return the encrypted payload
  const payload: EncryptedPayload = {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(dataIv),
    wrappedDek,
    aadMetadata: {
      tenantId: aad.tenantId,
      provider: aad.provider,
      tokenType: aad.tokenType,
    },
    algorithm: 'AES-256-GCM',
    encryptedAt: new Date().toISOString(),
  };

  return payload;
}

/**
 * Decrypt data using envelope encryption with AAD verification.
 *
 * @param options - Decryption options including KEK, payload, and AAD
 * @returns The decrypted plaintext as a string
 * @throws Error if AAD mismatch or decryption fails
 *
 * @example
 * ```ts
 * const plaintext = await decrypt({
 *   kekBytes: kekFromInfisical,
 *   payload: encryptedPayload,
 *   aad: { tenantId: 'tenant-123', provider: 'gumroad', tokenType: 'access' }
 * });
 * ```
 */
export async function decrypt(options: DecryptOptions): Promise<string> {
  const { kekBytes, payload, aad } = options;

  // 1. Verify algorithm matches
  if (payload.algorithm !== 'AES-256-GCM') {
    throw new Error(`Unsupported algorithm: ${payload.algorithm}. Expected AES-256-GCM.`);
  }

  // 2. Verify AAD matches (defense in depth - crypto will also verify)
  if (
    payload.aadMetadata.tenantId !== aad.tenantId ||
    payload.aadMetadata.provider !== aad.provider ||
    payload.aadMetadata.tokenType !== aad.tokenType
  ) {
    throw new Error(
      'AAD mismatch: payload metadata does not match provided AAD context. ' +
        'This may indicate data was encrypted for a different tenant/provider/token.'
    );
  }

  // 3. Import the KEK for unwrapping
  const kek = await importKEK(kekBytes);

  // 4. Unwrap the DEK
  const wrappedDekBytes = base64ToBytes(payload.wrappedDek.encryptedDek);
  const dek = await unwrapDEK(wrappedDekBytes, kek);

  // 5. Decode the IV and ciphertext
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const aadBytes = aadToBytes(aad);

  // 6. Decrypt the ciphertext with the DEK
  try {
    const plaintextBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: aadBytes,
        tagLength: 128,
      },
      dek,
      ciphertext
    );

    // 7. Convert to string and return
    return new TextDecoder().decode(plaintextBuffer);
  } catch (error) {
    throw new Error(
      'Decryption failed. This may indicate: ' +
        '1) Wrong KEK, 2) AAD mismatch, 3) Corrupted ciphertext, or 4) Tampered data. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Decrypt data and return raw bytes (for binary data).
 */
export async function decryptToBytes(options: DecryptOptions): Promise<Uint8Array> {
  const plaintext = await decrypt(options);
  return new TextEncoder().encode(plaintext);
}

/**
 * Re-encrypt a payload with a new KEK (for key rotation).
 * This decrypts with the old KEK and encrypts with the new KEK.
 *
 * @param oldPayload - The existing encrypted payload
 * @param oldKekBytes - The current KEK bytes
 * @param newOptions - Options for re-encryption with new KEK
 * @returns New encrypted payload with the new KEK
 */
export async function reEncrypt(
  oldPayload: EncryptedPayload,
  oldKekBytes: Uint8Array,
  newOptions: Omit<EncryptOptions, 'aad'>
): Promise<EncryptedPayload> {
  // Decrypt with old KEK
  const plaintext = await decrypt({
    kekBytes: oldKekBytes,
    payload: oldPayload,
    aad: {
      tenantId: oldPayload.aadMetadata.tenantId,
      provider: oldPayload.aadMetadata.provider,
      tokenType: oldPayload.aadMetadata.tokenType,
    },
  });

  // Encrypt with new KEK
  return encrypt(plaintext, {
    ...newOptions,
    aad: {
      tenantId: oldPayload.aadMetadata.tenantId,
      provider: oldPayload.aadMetadata.provider,
      tokenType: oldPayload.aadMetadata.tokenType,
    },
  });
}

/**
 * Validate that an encrypted payload has the expected structure.
 */
export function validatePayload(payload: unknown): payload is EncryptedPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const p = payload as Record<string, unknown>;

  return (
    typeof p.ciphertext === 'string' &&
    typeof p.iv === 'string' &&
    typeof p.wrappedDek === 'object' &&
    typeof (p.wrappedDek as Record<string, unknown>)?.encryptedDek === 'string' &&
    typeof (p.wrappedDek as Record<string, unknown>)?.keyId === 'string' &&
    typeof (p.wrappedDek as Record<string, unknown>)?.keyVersion === 'number' &&
    typeof p.aadMetadata === 'object' &&
    typeof (p.aadMetadata as Record<string, unknown>)?.tenantId === 'string' &&
    typeof (p.aadMetadata as Record<string, unknown>)?.provider === 'string' &&
    typeof (p.aadMetadata as Record<string, unknown>)?.tokenType === 'string' &&
    p.algorithm === 'AES-256-GCM' &&
    typeof p.encryptedAt === 'string'
  );
}

/**
 * Create a type-safe AAD object.
 */
export function createAAD(
  tenantId: string,
  provider: TokenProvider,
  tokenType: TokenType
): EncryptionAAD {
  return {
    tenantId,
    provider,
    tokenType,
  };
}

/**
 * Check if a payload was encrypted with a specific key version.
 */
export function isKeyVersion(payload: EncryptedPayload, keyId: string, version: number): boolean {
  return payload.wrappedDek.keyId === keyId && payload.wrappedDek.keyVersion === version;
}

/**
 * Extract key metadata from an encrypted payload for audit/logging.
 * Does NOT include any sensitive data.
 */
export function extractKeyMetadata(payload: EncryptedPayload): {
  keyId: string;
  keyVersion: number;
  algorithm: string;
  encryptedAt: string;
  tenantId: string;
  provider: string;
  tokenType: string;
} {
  return {
    keyId: payload.wrappedDek.keyId,
    keyVersion: payload.wrappedDek.keyVersion,
    algorithm: payload.algorithm,
    encryptedAt: payload.encryptedAt,
    tenantId: payload.aadMetadata.tenantId,
    provider: payload.aadMetadata.provider,
    tokenType: payload.aadMetadata.tokenType,
  };
}
