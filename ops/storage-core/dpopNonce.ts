// RFC 9449 sections 8, 9, and 11.1 define server-provided DPoP nonces.
// Reference: https://www.rfc-editor.org/rfc/rfc9449#section-8
// Reference: https://www.rfc-editor.org/rfc/rfc9449#section-9
// Reference: https://www.rfc-editor.org/rfc/rfc9449#section-11.1

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DEFAULT_LIFETIME_SECONDS = 5 * 60;
const DEFAULT_PURPOSE = 'yucp:dpop-resource-nonce:v1';
const MAX_NONCE_LENGTH = 512;
const NONCE_VERSION = 'v1';
const RANDOM_BYTES = 16;
const SIGNATURE_BYTES = 32;
const TIMESTAMP_BYTES = 8;
const textEncoder = new TextEncoder();

export interface DpopNonceManager {
  issue(now?: Date): Promise<{ expiresAt: Date; nonce: string }>;
  verify(nonce: string, now?: Date): Promise<{ expiresAt: Date } | null>;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string, expectedBytes: number): Uint8Array | null {
  if (!value || !BASE64URL.test(value)) {
    return null;
  }
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return decoded.byteLength === expectedBytes && encodeBase64Url(decoded) === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function timestampBytes(seconds: number): Uint8Array {
  const bytes = new Uint8Array(TIMESTAMP_BYTES);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(seconds));
  return bytes;
}

function readTimestamp(bytes: Uint8Array): number | null {
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0);
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function createDpopNonceManager(input: {
  acceptedFutureSkewSeconds?: number;
  lifetimeSeconds?: number;
  purpose?: string;
  secret: Uint8Array;
}): DpopNonceManager {
  const acceptedFutureSkewSeconds = input.acceptedFutureSkewSeconds ?? 5;
  const lifetimeSeconds = input.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  const purpose = input.purpose ?? DEFAULT_PURPOSE;
  if (
    input.secret.byteLength < 32 ||
    !Number.isSafeInteger(acceptedFutureSkewSeconds) ||
    acceptedFutureSkewSeconds < 0 ||
    acceptedFutureSkewSeconds > 60 ||
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds < 1 ||
    lifetimeSeconds > 3_600 ||
    !purpose ||
    textEncoder.encode(purpose).byteLength > 128
  ) {
    throw new Error('DPoP nonce configuration is invalid');
  }
  const secret = new Uint8Array(input.secret);
  let keyPromise: Promise<CryptoKey> | undefined;
  const getKey = () => {
    keyPromise ??= crypto.subtle
      .importKey('raw', secret, 'HKDF', false, ['deriveKey'])
      .then((material) =>
        crypto.subtle.deriveKey(
          {
            hash: 'SHA-256',
            info: textEncoder.encode(purpose),
            name: 'HKDF',
            salt: new Uint8Array(),
          },
          material,
          { hash: 'SHA-256', length: 256, name: 'HMAC' },
          false,
          ['sign', 'verify']
        )
      );
    return keyPromise;
  };

  async function signNonce(unsigned: string): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        await getKey(),
        textEncoder.encode(`${purpose}\0${unsigned}`)
      )
    );
  }

  return {
    async issue(now = new Date()) {
      if (!validDate(now)) {
        throw new Error('DPoP nonce issue time is invalid');
      }
      const issuedAtSeconds = Math.floor(now.getTime() / 1_000);
      const random = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
      const unsigned = [
        NONCE_VERSION,
        encodeBase64Url(timestampBytes(issuedAtSeconds)),
        encodeBase64Url(random),
      ].join('.');
      const signature = await signNonce(unsigned);
      return {
        expiresAt: new Date((issuedAtSeconds + lifetimeSeconds) * 1_000),
        nonce: `${unsigned}.${encodeBase64Url(signature)}`,
      };
    },

    async verify(nonce, now = new Date()) {
      if (!validDate(now) || !nonce || nonce.length > MAX_NONCE_LENGTH) {
        return null;
      }
      const parts = nonce.split('.');
      if (parts.length !== 4 || parts[0] !== NONCE_VERSION) {
        return null;
      }
      const issuedAtBytes = decodeBase64Url(parts[1] ?? '', TIMESTAMP_BYTES);
      const random = decodeBase64Url(parts[2] ?? '', RANDOM_BYTES);
      const signature = decodeBase64Url(parts[3] ?? '', SIGNATURE_BYTES);
      if (!issuedAtBytes || !random || !signature) {
        return null;
      }
      const issuedAtSeconds = readTimestamp(issuedAtBytes);
      if (issuedAtSeconds === null) {
        return null;
      }
      const nowSeconds = Math.floor(now.getTime() / 1_000);
      const expiresAtSeconds = issuedAtSeconds + lifetimeSeconds;
      if (
        issuedAtSeconds > nowSeconds + acceptedFutureSkewSeconds ||
        expiresAtSeconds <= nowSeconds
      ) {
        return null;
      }
      const unsigned = parts.slice(0, 3).join('.');
      if (
        !(await crypto.subtle.verify(
          'HMAC',
          await getKey(),
          copyArrayBuffer(signature),
          textEncoder.encode(`${purpose}\0${unsigned}`)
        ))
      ) {
        return null;
      }
      return { expiresAt: new Date(expiresAtSeconds * 1_000) };
    },
  };
}
