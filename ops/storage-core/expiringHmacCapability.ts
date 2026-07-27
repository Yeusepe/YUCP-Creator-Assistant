export type ExpiringHmacSignature = {
  exp: string;
  sig: string;
};

const textEncoder = new TextEncoder();
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const EXPIRY_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const MIN_UNAMBIGUOUS_EPOCH_MILLISECONDS = 1_000_000_000_000;

function unixSeconds(value: Date | number): number {
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) {
    throw new Error('Capability expiry must be a finite timestamp');
  }
  if (
    typeof value === 'number' &&
    (!Number.isSafeInteger(value) || value < MIN_UNAMBIGUOUS_EPOCH_MILLISECONDS)
  ) {
    throw new Error('Numeric capability expiry must use Unix epoch milliseconds');
  }
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error('Capability expiry must be a non-negative Unix timestamp');
  }
  return seconds;
}

function signatureBytes(signature: string): Uint8Array<ArrayBuffer> | undefined {
  if (!SIGNATURE_PATTERN.test(signature)) {
    return undefined;
  }
  const bytes = new Uint8Array(signature.length / 2);
  for (let offset = 0; offset < signature.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(signature.slice(offset, offset + 2), 16);
  }
  return bytes;
}

function encodeUtf8(value: string): ArrayBuffer {
  const encoded = textEncoder.encode(value);
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function importHmacKey(key: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const encodedKey = encodeUtf8(key);
  if (encodedKey.byteLength < 32) {
    throw new Error('Capability HMAC key must be at least 32 UTF-8 bytes');
  }
  return crypto.subtle.importKey('raw', encodedKey, { hash: 'SHA-256', name: 'HMAC' }, false, [
    usage,
  ]);
}

function payload(purpose: string, binding: string, expiry: string): ArrayBuffer {
  if (!purpose || !binding) {
    throw new Error('Capability purpose and binding must not be empty');
  }
  return encodeUtf8(JSON.stringify([purpose, binding, expiry]));
}

export async function signExpiringHmacCapability(input: {
  binding: string;
  expiresAt: Date | number;
  key: string;
  purpose: string;
}): Promise<ExpiringHmacSignature> {
  const exp = unixSeconds(input.expiresAt).toString();
  const key = await importHmacKey(input.key, 'sign');
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    payload(input.purpose, input.binding, exp)
  );
  return { exp, sig: toHex(signature) };
}

export async function verifyExpiringHmacCapability(input: {
  binding: string;
  exp: string;
  key: string;
  now?: Date | number;
  purpose: string;
  sig: string;
}): Promise<boolean> {
  try {
    if (!EXPIRY_PATTERN.test(input.exp)) {
      return false;
    }
    const expiresAt = Number(input.exp);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= unixSeconds(input.now ?? Date.now())) {
      return false;
    }
    const signature = signatureBytes(input.sig);
    if (!signature) {
      return false;
    }
    const key = await importHmacKey(input.key, 'verify');
    return crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      payload(input.purpose, input.binding, input.exp)
    );
  } catch {
    return false;
  }
}
