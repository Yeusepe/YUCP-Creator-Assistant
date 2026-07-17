import { deliveryManifestObjectId } from './deliveryManifest';

export type SignDeliveryUrlInput = {
  binding?: string;
  /** Expiration as a Date or Unix epoch milliseconds. Numeric epoch seconds are rejected. */
  expiresAt: Date | number;
  key: string;
  versionId: string;
};

export type VerifyDeliveryUrlInput = {
  binding?: string;
  exp: string;
  key: string;
  /** Verification time as a Date or Unix epoch milliseconds. */
  now?: Date | number;
  sig: string;
  versionId: string;
};

export type DeliveryUrlSignature = {
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
    throw new Error('Delivery URL expiry must be a finite timestamp');
  }
  if (
    typeof value === 'number' &&
    (!Number.isSafeInteger(value) || value < MIN_UNAMBIGUOUS_EPOCH_MILLISECONDS)
  ) {
    throw new Error('Numeric delivery URL expiry must use Unix epoch milliseconds');
  }
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error('Delivery URL expiry must be a non-negative Unix timestamp');
  }
  return seconds;
}

function assertSigningInput(versionId: string, key: string): void {
  deliveryManifestObjectId(versionId);
  if (!key) {
    throw new Error('Delivery HMAC key must not be empty');
  }
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
  return crypto.subtle.importKey('raw', encodeUtf8(key), { hash: 'SHA-256', name: 'HMAC' }, false, [
    usage,
  ]);
}

function signedPayload(versionId: string, exp: string, binding?: string): ArrayBuffer {
  return encodeUtf8(
    binding === undefined ? `${versionId}|${exp}` : JSON.stringify([versionId, binding, exp])
  );
}

export async function signDeliveryUrl(input: SignDeliveryUrlInput): Promise<DeliveryUrlSignature> {
  assertSigningInput(input.versionId, input.key);
  const exp = unixSeconds(input.expiresAt).toString();
  const key = await importHmacKey(input.key, 'sign');
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    signedPayload(input.versionId, exp, input.binding)
  );
  return { exp, sig: toHex(signature) };
}

export async function verifyDeliveryUrl(input: VerifyDeliveryUrlInput): Promise<boolean> {
  try {
    assertSigningInput(input.versionId, input.key);
  } catch {
    return false;
  }
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
    signedPayload(input.versionId, input.exp, input.binding)
  );
}
