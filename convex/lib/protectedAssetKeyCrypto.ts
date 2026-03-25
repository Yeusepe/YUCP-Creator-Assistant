import { decryptForPurpose, encryptForPurpose } from './vrchat/crypto';

const PROTECTED_ASSET_KEY_PURPOSES = {
  blobContentKey: 'yucp-protected-blob-content-key',
} as const;

function getEncryptionSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('ENCRYPTION_SECRET is required for protected asset key encryption');
  }
  return secret;
}

export async function encryptProtectedBlobContentKey(contentKeyBase64: string): Promise<string> {
  return encryptForPurpose(
    contentKeyBase64,
    getEncryptionSecret(),
    PROTECTED_ASSET_KEY_PURPOSES.blobContentKey
  );
}

export async function decryptProtectedBlobContentKey(ciphertext: string): Promise<string> {
  return decryptForPurpose(ciphertext, getEncryptionSecret(), PROTECTED_ASSET_KEY_PURPOSES.blobContentKey);
}
