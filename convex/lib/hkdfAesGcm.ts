async function hmacSha256(keyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message.buffer as ArrayBuffer));
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
    okm.buffer as ArrayBuffer,
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
  const key = await deriveHkdfAesGcmKey(secret, purpose);
  const combined = Uint8Array.from(atob(ciphertextB64), (char) => char.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}
