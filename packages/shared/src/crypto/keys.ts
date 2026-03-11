/**
 * Key management for envelope encryption.
 *
 * KEK (Key Encryption Key) references are stored in Infisical KMS.
 * DEKs (Data Encryption Keys) are generated per-encryption and wrapped by KEKs.
 */

/**
 * Supported token providers for encryption AAD binding
 */
export type TokenProvider = 'discord' | 'gumroad' | 'jinxxy' | 'manual';

/**
 * Supported token types for encryption AAD binding
 */
export type TokenType = 'access' | 'refresh' | 'api_key';

/**
 * Additional Authenticated Data for encryption binding.
 * This ensures ciphertext cannot be used in a different context.
 */
export interface EncryptionAAD {
  tenantId: string;
  provider: TokenProvider;
  tokenType: TokenType;
}

/**
 * Reference to a Key Encryption Key (KEK) stored in Infisical KMS.
 * The actual key material is never stored in code - only the reference.
 */
export interface KEKReference {
  /** Unique identifier for the key version */
  keyId: string;
  /** Version number for key rotation support */
  version: number;
  /** Infisical secret path to retrieve the KEK */
  infisicalPath: string;
  /** When this key was created */
  createdAt: Date;
  /** Whether this is the current active key */
  isActive: boolean;
}

/**
 * Encrypted DEK along with metadata needed for decryption.
 */
export interface WrappedDEK {
  /** The encrypted DEK bytes (base64 encoded for storage) */
  encryptedDek: string;
  /** The KEK key ID used to wrap this DEK */
  keyId: string;
  /** The KEK version used */
  keyVersion: number;
  /** IV used for DEK wrapping (if AES-GCM used for wrapping) */
  iv: string;
}

/**
 * Result of envelope encryption containing all data needed for storage and decryption.
 */
export interface EncryptedPayload {
  /** The encrypted ciphertext (base64 encoded) */
  ciphertext: string;
  /** The IV/nonce used for encryption (base64 encoded) */
  iv: string;
  /** The wrapped DEK */
  wrappedDek: WrappedDEK;
  /** The AAD metadata (for audit/debugging, NOT used in decryption - must be provided separately) */
  aadMetadata: {
    tenantId: string;
    provider: TokenProvider;
    tokenType: TokenType;
  };
  /** Algorithm identifier */
  algorithm: 'AES-256-GCM';
  /** When this was encrypted */
  encryptedAt: string;
}

/**
 * Internal representation of a DEK with its CryptoKey handle.
 */
export interface DEK {
  /** The CryptoKey for AES-256-GCM operations */
  key: CryptoKey;
  /** Raw key bytes (only available briefly during wrap/unwrap) */
  raw?: Uint8Array;
}

/**
 * Generate a new random Data Encryption Key (DEK) for AES-256-GCM.
 * Returns a CryptoKey ready for encryption operations.
 */
export async function generateDEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true, // extractable so we can wrap it
    ['encrypt', 'decrypt']
  );
}

/**
 * Import a DEK from raw bytes (used after unwrapping).
 */
export async function importDEK(rawKey: Uint8Array): Promise<CryptoKey> {
  // Ensure the data is a concrete ArrayBuffer-backed copy to satisfy Web Crypto types
  const buffer = new Uint8Array(rawKey as any).slice().buffer as ArrayBuffer;
  return crypto.subtle.importKey(
    'raw',
    buffer,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false, // not extractable after import for security
    ['encrypt', 'decrypt']
  );
}

/**
 * Export a DEK to raw bytes (used before wrapping).
 */
export async function exportDEK(key: CryptoKey): Promise<Uint8Array> {
  const exported = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(exported);
}

/**
 * Import a KEK from raw bytes retrieved from Infisical KMS.
 * The KEK is used to wrap/unwrap DEKs.
 */
export async function importKEK(rawKey: Uint8Array): Promise<CryptoKey> {
  const buffer = new Uint8Array(rawKey as any).slice().buffer as ArrayBuffer;
  return crypto.subtle.importKey(
    'raw',
    buffer,
    {
      name: 'AES-KW', // AES Key Wrap for wrapping DEKs
      length: 256,
    },
    false, // not extractable
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Alternative: Import KEK for AES-GCM wrapping (if AES-KW not desired).
 * Some environments prefer AES-GCM for wrapping with AAD.
 */
export async function importKEKForGCM(rawKey: Uint8Array): Promise<CryptoKey> {
  const buffer = new Uint8Array(rawKey as any).slice().buffer as ArrayBuffer;
  return crypto.subtle.importKey(
    'raw',
    buffer,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false, // not extractable
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );
}

/**
 * Wrap a DEK using a KEK with AES-KW algorithm.
 */
export async function wrapDEK(dek: CryptoKey, kek: CryptoKey): Promise<Uint8Array> {
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, 'AES-KW');
  return new Uint8Array(wrapped);
}

/**
 * Unwrap a DEK using a KEK with AES-KW algorithm.
 */
export async function unwrapDEK(wrappedDek: Uint8Array, kek: CryptoKey): Promise<CryptoKey> {
  const buffer = new Uint8Array(wrappedDek as any).slice().buffer as ArrayBuffer;
  return crypto.subtle.unwrapKey(
    'raw',
    buffer,
    kek,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Wrap a DEK using AES-GCM with additional IV (for environments preferring AES-GCM over AES-KW).
 */
export async function wrapDEKWithGCM(
  dek: CryptoKey,
  kek: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const ivBuf = new Uint8Array(iv as any).slice().buffer as ArrayBuffer;
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, {
    name: 'AES-GCM',
    iv: ivBuf,
  });
  return new Uint8Array(wrapped);
}

/**
 * Unwrap a DEK using AES-GCM with additional IV.
 */
export async function unwrapDEKWithGCM(
  wrappedDek: Uint8Array,
  kek: CryptoKey,
  iv: Uint8Array
): Promise<CryptoKey> {
  const wrappedBuf = new Uint8Array(wrappedDek as any).slice().buffer as ArrayBuffer;
  const ivBuf = new Uint8Array(iv as any).slice().buffer as ArrayBuffer;
  return crypto.subtle.unwrapKey(
    'raw',
    wrappedBuf,
    kek,
    { name: 'AES-GCM', iv: ivBuf },
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Generate a random IV/nonce for AES-GCM.
 * AES-GCM requires a 12-byte (96-bit) IV for best performance and security.
 */
export function generateIV(): Uint8Array {
  // Return a concrete Uint8Array backed by a plain ArrayBuffer
  return crypto.getRandomValues(new Uint8Array(12)).slice();
}

/**
 * Convert AAD object to bytes for encryption binding.
 */
export function aadToBytes(aad: EncryptionAAD): Uint8Array {
  const aadString = `${aad.tenantId}:${aad.provider}:${aad.tokenType}`;
  return new TextEncoder().encode(aadString).slice();
}

/**
 * Utility: Convert Uint8Array to base64 string for storage.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Use Buffer in Bun/Node or btoa in browser
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Utility: Convert base64 string to Uint8Array.
 */
export function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}
