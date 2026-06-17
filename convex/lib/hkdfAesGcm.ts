const MAX_CIPHERTEXT_B64_LENGTH = 100 * 1024;

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hmacSha256(keyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toExactArrayBuffer(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, toExactArrayBuffer(message)));
}

async function deriveHkdfAesGcmKey(secret: string, purpose: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const prk = await hmacSha256(new Uint8Array(32), encoder.encode(secret));
  const info = encoder.encode(purpose);
  const expandInput = new Uint8Array(info.byteLength + 1);
  expandInput.set(info);
  expandInput[info.byteLength] = 0x01;
  const okm = await hmacSha256(prk, expandInput);
  return await crypto.subtle.importKey(
    'raw',
    toExactArrayBuffer(okm),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

export async function decryptHkdfAesGcm(
  ciphertextB64: string,
  secret: string,
  purpose: string
): Promise<string> {
  if (ciphertextB64.length > MAX_CIPHERTEXT_B64_LENGTH) {
    throw new Error('Encrypted value exceeds maximum supported size.');
  }
  const key = await deriveHkdfAesGcmKey(secret, purpose);
  const combined = Uint8Array.from(atob(ciphertextB64), (char) => char.charCodeAt(0));
  if (combined.byteLength <= 12) {
    throw new Error('Encrypted value is malformed.');
  }
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}
