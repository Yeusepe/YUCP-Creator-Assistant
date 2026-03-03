/**
 * Crypto module for envelope encryption of provider tokens.
 *
 * This module provides secure envelope encryption for sensitive data like
 * OAuth tokens and API keys. It uses AES-256-GCM for data encryption with
 * Additional Authenticated Data (AAD) binding to tenant/provider/token context.
 *
 * Key concepts:
 * - KEK (Key Encryption Key): Master key stored in Infisical KMS
 * - DEK (Data Encryption Key): Per-encryption key, wrapped by KEK
 * - AAD (Additional Authenticated Data): Context binding for ciphertext
 *
 * @example
 * ```ts
 * import { encrypt, decrypt, createAAD } from '@yucp/shared/crypto';
 *
 * // Encrypt a token
 * const payload = await encrypt(accessToken, {
 *   keyId: 'kek-v1',
 *   keyVersion: 1,
 *   kekBytes: kekFromInfisical,
 *   aad: createAAD('tenant-123', 'gumroad', 'access')
 * });
 *
 * // Decrypt a token
 * const plaintext = await decrypt({
 *   kekBytes: kekFromInfisical,
 *   payload,
 *   aad: createAAD('tenant-123', 'gumroad', 'access')
 * });
 * ```
 */

// Re-export all types
export type {
  EncryptionAAD,
  EncryptedPayload,
  KEKReference,
  TokenProvider,
  TokenType,
  WrappedDEK,
  DEK,
} from './keys';

export type {
  EncryptOptions,
  DecryptOptions,
} from './envelope';

// Re-export key management functions
export {
  generateDEK,
  importDEK,
  exportDEK,
  importKEK,
  importKEKForGCM,
  wrapDEK,
  unwrapDEK,
  wrapDEKWithGCM,
  unwrapDEKWithGCM,
  generateIV,
  aadToBytes,
  bytesToBase64,
  base64ToBytes,
} from './keys';

// Re-export envelope encryption functions
export {
  encrypt,
  decrypt,
  decryptToBytes,
  reEncrypt,
  validatePayload,
  createAAD,
  isKeyVersion,
  extractKeyMetadata,
} from './envelope';
