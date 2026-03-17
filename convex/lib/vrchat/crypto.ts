export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function hmacSha256(keyBytes: ArrayBuffer, data: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, data);
}

/**
 * Derives a 256-bit AES-GCM key using RFC 5869 HKDF, implemented manually
 * via HMAC-SHA256 because Convex's V8 runtime does not support
 * `crypto.subtle.importKey` for the 'HKDF' algorithm.
 */
async function deriveKey(secret: string, purpose: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  const purposeBytes = encoder.encode(purpose);

  // HKDF-Extract: PRK = HMAC-SHA256(salt=HashLen zeros, IKM=secret)
  const salt = new Uint8Array(32);
  const prk = await hmacSha256(salt.buffer as ArrayBuffer, secretBytes.buffer as ArrayBuffer);

  // HKDF-Expand T(1) = HMAC-SHA256(PRK, info || 0x01) — 32 bytes = AES-256 key
  const expandInput = new Uint8Array(purposeBytes.byteLength + 1);
  expandInput.set(purposeBytes);
  expandInput[purposeBytes.byteLength] = 0x01;
  const okm = await hmacSha256(prk, expandInput.buffer as ArrayBuffer);

  return crypto.subtle.importKey('raw', okm, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptForPurpose(
  plaintext: string,
  secret: string,
  purpose: string
): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

export async function decryptForPurpose(
  ciphertextB64: string,
  secret: string,
  purpose: string
): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const combined = base64ToBytes(ciphertextB64);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

export async function sha256Base64(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToBase64(new Uint8Array(digest));
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalizeValue(entryValue)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function canonicalizeJson(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(canonicalizeValue(value));
}

export async function signValue(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(signature));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const maxLen = Math.max(leftBytes.length, rightBytes.length);

  // Always iterate the full length so comparisons take constant time
  // regardless of where the strings diverge or differ in length.
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maxLen; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}
