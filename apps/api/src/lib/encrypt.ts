/**
 * Credential encryption for storing tokens at rest.
 *
 * Algorithm:  AES-256-GCM  (authenticated encryption, no separate MAC needed)
 * KDF:        HKDF-SHA256  (proper extract-and-expand; domain-separated by `purpose`)
 * Nonce:      96-bit random per encryption, never reused
 *
 * `purpose` is a caller-defined domain-separation label (e.g. 'gumroad-oauth-access-token').
 * It MUST be the same at encrypt and decrypt time for a given ciphertext.
 * Define purpose constants in the module that owns the credential type, not here.
 */

async function deriveKey(secret: string, purpose: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encoder.encode(purpose),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(plaintext: string, secret: string, purpose: string): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(
  ciphertextB64: string,
  secret: string,
  purpose: string
): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}
