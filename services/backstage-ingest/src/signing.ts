const HEX_RE = /^[0-9a-f]+$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function decodeSecret(secretHex: string): Uint8Array<ArrayBuffer> {
  if (secretHex.length % 2 !== 0 || !HEX_RE.test(secretHex)) {
    throw new Error('BACKSTAGE_INGEST_SECRET must be an even-length hexadecimal string.');
  }

  const secret = new Uint8Array(secretHex.length / 2);
  if (secret.byteLength < 32) {
    throw new Error('BACKSTAGE_INGEST_SECRET must decode to at least 32 bytes.');
  }

  for (let index = 0; index < secret.length; index += 1) {
    secret[index] = Number.parseInt(secretHex.slice(index * 2, index * 2 + 2), 16);
  }
  return secret;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!value || !BASE64URL_RE.test(value) || value.length % 4 === 1) {
    throw new Error('Backstage ingest token contains invalid base64url data.');
  }

  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Backstage ingest token contains invalid base64url data.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function hmacSha256(secret: Uint8Array<ArrayBuffer>, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret.buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function validateSigningSecret(secretHex: string): void {
  decodeSecret(secretHex);
}

export async function sign(secretHex: string, obj: object): Promise<string> {
  const secret = decodeSecret(secretHex);
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const signature = await hmacSha256(secret, encodedPayload);
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

export async function verify<T = Record<string, unknown>>(
  secretHex: string,
  token: string
): Promise<T> {
  const segments = token.split('.');
  if (segments.length !== 2) {
    throw new Error('Backstage ingest token must contain one payload and one signature.');
  }

  const [encodedPayload, encodedSignature] = segments;
  const secret = decodeSecret(secretHex);
  const expectedSignature = await hmacSha256(secret, encodedPayload);
  const receivedSignature = base64UrlDecode(encodedSignature);
  if (!constantTimeEqual(expectedSignature, receivedSignature)) {
    throw new Error('Backstage ingest token signature is invalid.');
  }

  let payload: unknown;
  try {
    const payloadBytes = base64UrlDecode(encodedPayload);
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
  } catch {
    throw new Error('Backstage ingest token payload is invalid JSON.');
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Backstage ingest token payload must be an object.');
  }
  const exp = (payload as Record<string, unknown>).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Backstage ingest token is expired or has an invalid expiration.');
  }

  return payload as T;
}
