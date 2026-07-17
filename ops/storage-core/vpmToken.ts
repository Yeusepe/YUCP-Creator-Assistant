export type SignVpmRepoTokenInput = {
  authUserId: string;
  /** Expiration as a Date or Unix epoch milliseconds. */
  expiresAt: Date | number;
  key: string;
};

export type VerifyVpmRepoTokenInput = {
  key: string;
  /** Verification time as a Date or Unix epoch milliseconds. */
  now?: Date | number;
  token: string;
};

export type SignedVpmRepoToken = {
  expiresAt: number;
  token: string;
};

export type VerifiedVpmRepoToken = {
  authUserId: string;
  expiresAt: number;
};

const TOKEN_DOMAIN = 'yucp-vpm-repo-token.v1';
const TOKEN_VERSION = 1;
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{1,2048})\.([0-9a-f]{64})$/;
const MIN_UNAMBIGUOUS_EPOCH_MILLISECONDS = 1_000_000_000_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function unixSeconds(value: Date | number): number {
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) {
    throw new Error('VPM repository token expiry must be a finite timestamp');
  }
  if (
    typeof value === 'number' &&
    (!Number.isSafeInteger(value) || value < MIN_UNAMBIGUOUS_EPOCH_MILLISECONDS)
  ) {
    throw new Error('Numeric VPM repository token expiry must use Unix epoch milliseconds');
  }
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error('VPM repository token expiry must be a non-negative Unix timestamp');
  }
  return seconds;
}

function encodeUtf8(value: string): ArrayBuffer {
  const encoded = textEncoder.encode(value);
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!value || /[^A-Za-z0-9_-]/.test(value)) {
    return null;
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  const padded =
    padding === 0 ? normalized : normalized.padEnd(normalized.length + (4 - padding), '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function signatureBytes(signature: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(signature.length / 2);
  for (let offset = 0; offset < signature.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(signature.slice(offset, offset + 2), 16);
  }
  return bytes;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function importHmacKey(key: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (!key.trim()) {
    throw new Error('VPM repository token HMAC key must not be empty');
  }
  return crypto.subtle.importKey('raw', encodeUtf8(key), { hash: 'SHA-256', name: 'HMAC' }, false, [
    usage,
  ]);
}

function signedPayload(encodedPayload: string): ArrayBuffer {
  return encodeUtf8(`${TOKEN_DOMAIN}.${encodedPayload}`);
}

export async function signVpmRepoToken(input: SignVpmRepoTokenInput): Promise<SignedVpmRepoToken> {
  const authUserId = input.authUserId.trim();
  if (!authUserId || authUserId.length > 512) {
    throw new Error('VPM repository token auth user ID must be between 1 and 512 characters');
  }
  const exp = unixSeconds(input.expiresAt);
  const encodedPayload = toBase64Url(
    textEncoder.encode(JSON.stringify({ exp, sub: authUserId, v: TOKEN_VERSION }))
  );
  const key = await importHmacKey(input.key, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, signedPayload(encodedPayload));
  return {
    expiresAt: exp * 1000,
    token: `${encodedPayload}.${toHex(signature)}`,
  };
}

export async function verifyVpmRepoToken(
  input: VerifyVpmRepoTokenInput
): Promise<VerifiedVpmRepoToken | null> {
  try {
    const match = TOKEN_PATTERN.exec(input.token);
    if (!match) {
      return null;
    }
    const encodedPayload = match[1] ?? '';
    const encodedSignature = match[2] ?? '';
    const payloadBytes = fromBase64Url(encodedPayload);
    if (!payloadBytes) {
      return null;
    }
    const parsed = JSON.parse(textDecoder.decode(payloadBytes)) as {
      exp?: unknown;
      sub?: unknown;
      v?: unknown;
    };
    if (
      parsed.v !== TOKEN_VERSION ||
      typeof parsed.sub !== 'string' ||
      !parsed.sub.trim() ||
      parsed.sub.length > 512 ||
      typeof parsed.exp !== 'number' ||
      !Number.isSafeInteger(parsed.exp) ||
      parsed.exp < 0 ||
      parsed.exp <= unixSeconds(input.now ?? Date.now())
    ) {
      return null;
    }
    const key = await importHmacKey(input.key, 'verify');
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes(encodedSignature),
      signedPayload(encodedPayload)
    );
    if (!valid) {
      return null;
    }
    return {
      authUserId: parsed.sub,
      expiresAt: parsed.exp * 1000,
    };
  } catch {
    return null;
  }
}
