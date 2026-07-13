import {
  isLoreBackstageArtifactReference,
  type LoreBackstageArtifactReference,
} from './loreBackstageDelivery';

const HEX_RE = /^[0-9a-f]+$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LORE_ADDRESS_RE = /^[0-9a-f]{64}-[0-9a-f]{32}$/;
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
  exp: number;
};

export type BackstageSourceKind = 'zip' | 'unitypackage';

export type BackstageUploadResult = {
  typ: 'backstage-upload-result';
  authUserId: string;
  packageId: string;
  version: string;
  loreSource: LoreBackstageArtifactReference;
  rawSha256: string;
  rawByteSize: number;
  rawDeliveryName: string;
  rawContentType: string;
  sourceKind: BackstageSourceKind;
  managedPaths: string[];
  exp: number;
};

export type BackstageMaterializeClaims = {
  typ: 'backstage-materialize';
  authUserId: string;
  packageId: string;
  version: string;
  repositoryId: string;
  loreSourceAddress: string;
  loreSourceSha256: string;
  deliveryName: string;
  sourceContentType: string;
  sourceKind: BackstageSourceKind;
  managedPaths: string[];
  materializeMetadata?: {
    displayName?: string;
    metadata?: Record<string, unknown>;
  };
  exp: number;
};

export type BackstageMaterializePollClaims = {
  typ: 'backstage-materialize-poll';
  authUserId: string;
  packageId: string;
  version: string;
  jobId: string;
  exp: number;
};

export type BackstageMaterializeResult = {
  typ: 'backstage-materialize-result';
  authUserId: string;
  packageId: string;
  version: string;
  loreDelivery: LoreBackstageArtifactReference;
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

function requiredRepositoryId(
  payload: Record<string, unknown>,
  field: string,
  label: string
): string {
  const repositoryId = requiredString(payload, field, label);
  if (!/^[0-9a-f]{32}$/.test(repositoryId)) {
    throw new Error(`${label} ${field} must be 32 lowercase hexadecimal characters.`);
  }
  return repositoryId;
}

function requiredSourceKind(payload: Record<string, unknown>, label: string): BackstageSourceKind {
  if (payload.sourceKind !== 'zip' && payload.sourceKind !== 'unitypackage') {
    throw new Error(`${label} sourceKind must be zip or unitypackage.`);
  }
  return payload.sourceKind;
}

function parseMaterializeMetadata(
  value: unknown,
  label: string
): BackstageMaterializeClaims['materializeMetadata'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} materializeMetadata must be an object.`);
  }
  const displayName = value.displayName;
  if (displayName !== undefined && typeof displayName !== 'string') {
    throw new Error(`${label} materializeMetadata.displayName must be a string.`);
  }
  const metadata = value.metadata;
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new Error(`${label} materializeMetadata.metadata must be an object.`);
  }
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function assertSafeRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} must contain non-empty strings.`);
  }
  if (
    value.trim() !== value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value) ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must contain safe relative path strings.`);
  }
  return value;
}

function requiredManagedPaths(payload: Record<string, unknown>, label: string): string[] {
  if (!Array.isArray(payload.managedPaths) || payload.managedPaths.length === 0) {
    throw new Error(
      `${label} managedPaths must be a non-empty array of safe relative path strings.`
    );
  }
  return payload.managedPaths.map((path) => assertSafeRelativePath(path, `${label} managedPaths`));
}

export function parseUploadClaims(value: unknown): BackstageUploadClaims {
  if (!isRecord(value)) {
    throw new Error('Upload token payload must be an object.');
  }
  if (value.typ !== 'backstage-upload') {
    throw new Error('Upload token typ must be backstage-upload.');
  }

  const declaredSha256 = requiredSha256(value, 'declaredSha256', 'Upload token');
  const repositoryId = requiredRepositoryId(value, 'repositoryId', 'Upload token');

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
    exp: requiredExpiration(value, 'Upload token'),
  };
}

export function parseUploadResult(value: unknown): BackstageUploadResult {
  if (!isRecord(value)) {
    throw new Error('Upload result payload must be an object.');
  }
  if (value.typ !== 'backstage-upload-result') {
    throw new Error('Upload result typ must be backstage-upload-result.');
  }
  if (!isLoreBackstageArtifactReference(value.loreSource)) {
    throw new Error('Upload result loreSource must be a Lore artifact reference.');
  }
  const result: BackstageUploadResult = {
    typ: 'backstage-upload-result',
    authUserId: requiredString(value, 'authUserId', 'Upload result'),
    packageId: requiredString(value, 'packageId', 'Upload result'),
    version: requiredString(value, 'version', 'Upload result'),
    loreSource: value.loreSource,
    rawSha256: requiredSha256(value, 'rawSha256', 'Upload result'),
    rawByteSize: requiredNonNegativeSafeInteger(value, 'rawByteSize', 'Upload result'),
    rawDeliveryName: requiredString(value, 'rawDeliveryName', 'Upload result'),
    rawContentType: requiredString(value, 'rawContentType', 'Upload result'),
    sourceKind: requiredSourceKind(value, 'Upload result'),
    managedPaths: requiredManagedPaths(value, 'Upload result'),
    exp: requiredExpiration(value, 'Upload result'),
  };

  if (
    result.rawSha256 !== result.loreSource.sha256 ||
    result.rawByteSize !== result.loreSource.byteSize
  ) {
    throw new Error('Upload result raw bundle metadata must match loreSource.');
  }
  return result;
}

export function parseMaterializeClaims(value: unknown): BackstageMaterializeClaims {
  if (!isRecord(value)) {
    throw new Error('Materialize token payload must be an object.');
  }
  if (value.typ !== 'backstage-materialize') {
    throw new Error('Materialize token typ must be backstage-materialize.');
  }

  const materializeMetadata = parseMaterializeMetadata(
    value.materializeMetadata,
    'Materialize token'
  );
  const loreSourceAddress = requiredString(value, 'loreSourceAddress', 'Materialize token');
  if (!LORE_ADDRESS_RE.test(loreSourceAddress)) {
    throw new Error(
      'Materialize token loreSourceAddress must match <64 lowercase hex>-<32 lowercase hex>.'
    );
  }
  return {
    typ: 'backstage-materialize',
    authUserId: requiredString(value, 'authUserId', 'Materialize token'),
    packageId: requiredString(value, 'packageId', 'Materialize token'),
    version: requiredString(value, 'version', 'Materialize token'),
    repositoryId: requiredRepositoryId(value, 'repositoryId', 'Materialize token'),
    loreSourceAddress,
    loreSourceSha256: requiredSha256(value, 'loreSourceSha256', 'Materialize token'),
    deliveryName: requiredString(value, 'deliveryName', 'Materialize token'),
    sourceContentType: requiredString(value, 'sourceContentType', 'Materialize token'),
    sourceKind: requiredSourceKind(value, 'Materialize token'),
    managedPaths: requiredManagedPaths(value, 'Materialize token'),
    ...(materializeMetadata ? { materializeMetadata } : {}),
    exp: requiredExpiration(value, 'Materialize token'),
  };
}

export function parseMaterializePollClaims(value: unknown): BackstageMaterializePollClaims {
  if (!isRecord(value)) {
    throw new Error('Materialize poll token payload must be an object.');
  }
  if (value.typ !== 'backstage-materialize-poll') {
    throw new Error('Materialize poll token typ must be backstage-materialize-poll.');
  }
  const allowedFields = new Set(['typ', 'authUserId', 'packageId', 'version', 'jobId', 'exp']);
  const unexpectedField = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unexpectedField) {
    throw new Error(`Materialize poll token contains unexpected field ${unexpectedField}.`);
  }

  return {
    typ: 'backstage-materialize-poll',
    authUserId: requiredString(value, 'authUserId', 'Materialize poll token'),
    packageId: requiredString(value, 'packageId', 'Materialize poll token'),
    version: requiredString(value, 'version', 'Materialize poll token'),
    jobId: requiredString(value, 'jobId', 'Materialize poll token'),
    exp: requiredExpiration(value, 'Materialize poll token'),
  };
}

export function parseMaterializeResult(value: unknown): BackstageMaterializeResult {
  if (!isRecord(value)) {
    throw new Error('Materialize result payload must be an object.');
  }
  if (value.typ !== 'backstage-materialize-result') {
    throw new Error('Materialize result typ must be backstage-materialize-result.');
  }
  if (!isLoreBackstageArtifactReference(value.loreDelivery)) {
    throw new Error('Materialize result loreDelivery must be a Lore artifact reference.');
  }

  const result: BackstageMaterializeResult = {
    typ: 'backstage-materialize-result',
    authUserId: requiredString(value, 'authUserId', 'Materialize result'),
    packageId: requiredString(value, 'packageId', 'Materialize result'),
    version: requiredString(value, 'version', 'Materialize result'),
    loreDelivery: value.loreDelivery,
    deliverableSha256: requiredSha256(value, 'deliverableSha256', 'Materialize result'),
    deliverableByteSize: requiredNonNegativeSafeInteger(
      value,
      'deliverableByteSize',
      'Materialize result'
    ),
    deliverableDeliveryName: requiredString(value, 'deliverableDeliveryName', 'Materialize result'),
    deliverableContentType: requiredString(value, 'deliverableContentType', 'Materialize result'),
    exp: requiredExpiration(value, 'Materialize result'),
  };

  if (
    result.deliverableSha256 !== result.loreDelivery.sha256 ||
    result.deliverableByteSize !== result.loreDelivery.byteSize
  ) {
    throw new Error('Materialize result deliverable bundle metadata must match loreDelivery.');
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
