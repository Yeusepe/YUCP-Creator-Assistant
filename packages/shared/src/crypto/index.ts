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

export type {
  DecryptOptions,
  EncryptOptions,
} from './envelope';
// Re-export envelope encryption functions
export {
  createAAD,
  decrypt,
  decryptToBytes,
  encrypt,
  extractKeyMetadata,
  isKeyVersion,
  reEncrypt,
  validatePayload,
} from './envelope';
// Re-export all types
export type {
  DEK,
  EncryptedPayload,
  EncryptionAAD,
  KEKReference,
  TokenProvider,
  TokenType,
  WrappedDEK,
} from './keys';
// Re-export key management functions
export {
  aadToBytes,
  base64ToBytes,
  bytesToBase64,
  exportDEK,
  generateDEK,
  generateIV,
  importDEK,
  importKEK,
  importKEKForGCM,
  unwrapDEK,
  unwrapDEKWithGCM,
  wrapDEK,
  wrapDEKWithGCM,
} from './keys';
// Re-export timing-safe comparison
export { timingSafeStringEqual } from './timingSafeEqual';
