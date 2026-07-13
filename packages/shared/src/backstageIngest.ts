import {
  isLoreBackstageArtifactReference,
  type LoreBackstageArtifactReference,
} from './loreBackstageDelivery';

const HEX_RE = /^[0-9a-f]+$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type BackstageUploadClaims = {
  typ: 'backstage-upload';
  authUserId: string;
  packageId: string;
  version: string;
  repositoryId: string;
  deliveryName: string;
  sourceContentType: string;
  declaredSha256: string;
  byteSize: number;
  materializeMetadata?: {
    displayName?: string;
    metadata?: Record<string, unknown>;
  };
  exp: number;
};

export type BackstageIngestResult = {
  typ: 'backstage-ingest-result';
  authUserId: string;
  packageId: string;
  version: string;
  loreSource: LoreBackstageArtifactReference;
  loreDelivery: LoreBackstageArtifactReference;
  rawSha256: string;
  rawByteSize: number;
  rawDeliveryName: string;
  rawContentType: string;
  deliverableSha256: string;
  deliverableByteSize: number;
  deliverableDeliveryName: string;
  deliverableContentType: string;
  exp: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(payload: Record<string, unknown>, field: string, label: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} ${field} must be a non-empty string.`);
  }
  return value;
}

function requiredSha256(payload: Record<string, unknown>, field: string, label: string): string {
  const value = requiredString(payload, field, label).toLowerCase();
  if (!SHA256_RE.test(value)) {
    throw new Error(`${label} ${field} must be 64 hexadecimal characters.`);
  }
  return value;
}

function requiredNonNegativeSafeInteger(
  payload: Record<string, unknown>,
  field: string,
  label: string
): number {
  const value = payload[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} ${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requiredExpiration(payload: Record<string, unknown>, label: string): number {
  const value = payload.exp;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} exp must be a positive integer.`);
  }
  return value as number;
}

export function parseUploadClaims(value: unknown): BackstageUploadClaims {
  if (!isRecord(value)) {
    throw new Error('Upload token payload must be an object.');
  }
  if (value.typ !== 'backstage-upload') {
    throw new Error('Upload token typ must be backstage-upload.');
  }

  const declaredSha256 = requiredSha256(value, 'declaredSha256', 'Upload token');
  const repositoryId = requiredString(value, 'repositoryId', 'Upload token');
  if (!/^[0-9a-f]{32}$/.test(repositoryId)) {
    throw new Error('Upload token repositoryId must be 32 lowercase hexadecimal characters.');
  }

  let materializeMetadata: BackstageUploadClaims['materializeMetadata'];
  if (value.materializeMetadata !== undefined) {
    if (!isRecord(value.materializeMetadata)) {
      throw new Error('Upload token materializeMetadata must be an object.');
    }
    const displayName = value.materializeMetadata.displayName;
    if (displayName !== undefined && typeof displayName !== 'string') {
      throw new Error('Upload token materializeMetadata.displayName must be a string.');
    }
    const metadata = value.materializeMetadata.metadata;
    if (metadata !== undefined && !isRecord(metadata)) {
      throw new Error('Upload token materializeMetadata.metadata must be an object.');
    }
    materializeMetadata = {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
  }

  return {
    typ: 'backstage-upload',
    authUserId: requiredString(value, 'authUserId', 'Upload token'),
    packageId: requiredString(value, 'packageId', 'Upload token'),
    version: requiredString(value, 'version', 'Upload token'),
    repositoryId,
    deliveryName: requiredString(value, 'deliveryName', 'Upload token'),
    sourceContentType: requiredString(value, 'sourceContentType', 'Upload token'),
    declaredSha256,
    byteSize: requiredNonNegativeSafeInteger(value, 'byteSize', 'Upload token'),
    ...(materializeMetadata ? { materializeMetadata } : {}),
    exp: requiredExpiration(value, 'Upload token'),
  };
}

export function parseIngestResult(value: unknown): BackstageIngestResult {
  if (!isRecord(value)) {
    throw new Error('Ingest result payload must be an object.');
  }
  if (value.typ !== 'backstage-ingest-result') {
    throw new Error('Ingest result typ must be backstage-ingest-result.');
  }
  if (!isLoreBackstageArtifactReference(value.loreSource)) {
    throw new Error('Ingest result loreSource must be a Lore artifact reference.');
  }
  if (!isLoreBackstageArtifactReference(value.loreDelivery)) {
    throw new Error('Ingest result loreDelivery must be a Lore artifact reference.');
  }

  const result: BackstageIngestResult = {
    typ: 'backstage-ingest-result',
    authUserId: requiredString(value, 'authUserId', 'Ingest result'),
    packageId: requiredString(value, 'packageId', 'Ingest result'),
    version: requiredString(value, 'version', 'Ingest result'),
    loreSource: value.loreSource,
    loreDelivery: value.loreDelivery,
    rawSha256: requiredSha256(value, 'rawSha256', 'Ingest result'),
    rawByteSize: requiredNonNegativeSafeInteger(value, 'rawByteSize', 'Ingest result'),
    rawDeliveryName: requiredString(value, 'rawDeliveryName', 'Ingest result'),
    rawContentType: requiredString(value, 'rawContentType', 'Ingest result'),
    deliverableSha256: requiredSha256(value, 'deliverableSha256', 'Ingest result'),
    deliverableByteSize: requiredNonNegativeSafeInteger(
      value,
      'deliverableByteSize',
      'Ingest result'
    ),
    deliverableDeliveryName: requiredString(value, 'deliverableDeliveryName', 'Ingest result'),
    deliverableContentType: requiredString(value, 'deliverableContentType', 'Ingest result'),
    exp: requiredExpiration(value, 'Ingest result'),
  };

  if (
    result.rawSha256 !== result.loreSource.sha256 ||
    result.rawByteSize !== result.loreSource.byteSize
  ) {
    throw new Error('Ingest result raw bundle metadata must match loreSource.');
  }
  if (
    result.deliverableSha256 !== result.loreDelivery.sha256 ||
    result.deliverableByteSize !== result.loreDelivery.byteSize
  ) {
    throw new Error('Ingest result deliverable bundle metadata must match loreDelivery.');
  }

  return result;
}

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
  token: string,
  options: { ignoreExpiry?: boolean } = {}
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

  if (!isRecord(payload)) {
    throw new Error('Backstage ingest token payload must be an object.');
  }
  const exp = payload.exp;
  if (
    !options.ignoreExpiry &&
    (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000))
  ) {
    throw new Error('Backstage ingest token is expired or has an invalid expiration.');
  }

  return payload as T;
}
