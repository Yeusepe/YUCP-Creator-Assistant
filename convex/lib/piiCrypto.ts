/**
 * PII encryption helpers for Convex mutations.
 *
 * Uses the same HKDF-AES-256-GCM envelope as the VRChat provider session crypto
 * (convex/lib/vrchat/crypto.ts) with domain-separated purpose strings so each
 * PII field type has its own encryption context.
 *
 * Encryption secret: ENCRYPTION_SECRET (Convex dashboard env var).
 * Falls back to BETTER_AUTH_SECRET in non-production environments only.
 */

import { encryptForPurpose } from './vrchat/crypto';
import { PII_PURPOSES } from './credentialKeys';

export type PiiPurpose = (typeof PII_PURPOSES)[keyof typeof PII_PURPOSES];

function getEncryptionSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error('ENCRYPTION_SECRET is required for PII field encryption');
  }
  return secret;
}

/** Encrypt a PII string value with HKDF-AES-256-GCM. Returns undefined if value is undefined. */
export async function encryptPii(
  value: string | undefined,
  purpose: PiiPurpose
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  return encryptForPurpose(value, getEncryptionSecret(), purpose);
}

/**
 * Derive the hash + encrypted form of a normalized email address.
 * The hash is used for indexed lookups; the encrypted form preserves the
 * plaintext for audit/display without storing it in cleartext.
 */
export async function normalizeAndEncryptEmail(
  email: string | undefined,
  hashFn: (v: string) => Promise<string>
): Promise<{ emailHash: string | undefined; normalizedEmailEncrypted: string | undefined }> {
  if (!email) return { emailHash: undefined, normalizedEmailEncrypted: undefined };
  const normalized = email.trim().toLowerCase();
  const [emailHash, normalizedEmailEncrypted] = await Promise.all([
    hashFn(normalized),
    encryptPii(normalized, PII_PURPOSES.externalAccountEmail),
  ]);
  return { emailHash, normalizedEmailEncrypted };
}
