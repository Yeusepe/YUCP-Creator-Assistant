import { AwsClient } from 'aws4fetch';
import {
  type DeliveryManifest,
  deliveryManifestObjectId,
  parseDeliveryManifest,
} from '../../../ops/storage-core/deliveryManifest';
import { verifyDpopProof } from '../../../ops/storage-core/dpop';
import { BoundedDpopReplayCache } from '../../../ops/storage-core/dpopReplayCache';
import {
  type DeliveryGrantV2,
  packageContractKeyId,
  verifyDeliveryGrantV2,
} from '../../../ops/storage-core/packageContractsV2';
import { createLogicalReleasePublicationV4 } from '../../../ops/storage-core/releasePublication';
import { buildS3ObjectUrl } from '../../../ops/storage-core/s3ObjectUrl';

// Cloudflare Workers support response streaming, but origin subrequests stay bounded.
// Reference: https://developers.cloudflare.com/workers/platform/limits/
// Backblaze B2 S3-compatible API:
// https://www.backblaze.com/docs/cloud-storage-s3-compatible-api

const REQUIRED_BINDINGS = [
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_BUCKET',
  'METADATA_S3_READONLY_ACCESS_KEY_ID',
  'METADATA_S3_READONLY_SECRET_ACCESS_KEY',
  'METADATA_INDEX_PREFIX',
  'PROTECTED_S3_ENDPOINT',
  'PROTECTED_S3_REGION',
  'PROTECTED_S3_BUCKET',
  'PROTECTED_S3_READONLY_ACCESS_KEY_ID',
  'PROTECTED_S3_READONLY_SECRET_ACCESS_KEY',
  'PROTECTED_CHUNK_PREFIX',
  'STORAGE_FORMAT_VERSION',
  'DELIVERY_GRANT_KEY_ID',
  'DELIVERY_GRANT_ISSUER',
  'DELIVERY_GRANT_PUBLIC_KEY',
  'MATERIALIZATION_SOURCE_AUDIENCE',
] as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CHUNK_ID = /^[0-9a-f]{64}$/;
const SOURCE_PATH =
  /^\/v2\/internal\/materialization-sources\/([^/]+)\/(manifest|chunks\/([^/]+))$/;
const MAX_GRANT_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_CHUNKS = 100_000;
const MAX_CHUNK_BYTES = 1024 * 1024;
const ORIGIN_TIMEOUT_MS = 30_000;
const MAX_DPOP_REPLAY_ENTRIES = 8_192;
const DPOP_REPLAY_SWEEP_LIMIT = 128;
const DPOP_REPLAY_WINDOW_MS = 5 * 60 * 1_000;
// This bounded module cache is same-isolate abuse detection, not cross-region security truth.
const dpopReplayCache = new BoundedDpopReplayCache({
  maxEntries: MAX_DPOP_REPLAY_ENTRIES,
  sweepLimit: DPOP_REPLAY_SWEEP_LIMIT,
});

type BindingName = (typeof REQUIRED_BINDINGS)[number];
type S3ReadRole = {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  region: string;
  secretAccessKey: string;
};
type SourceConfig = {
  deliveryGrantIssuer: string;
  deliveryGrantKeyId: string;
  deliveryGrantPublicKey: string;
  materializationSourceAudience: string;
  metadata: S3ReadRole & { indexPrefix: string };
  protected: S3ReadRole & { chunkPrefix: string };
  storageFormatVersion: string;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly storageFetches = 0
  ) {
    super(message);
  }
}

function requireBinding(env: Env, name: BindingName): string {
  const value = Reflect.get(env, name);
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(500, `Missing required Worker binding: ${name}`);
  }
  return value.trim();
}

function normalizePrefix(value: string, name: string): string {
  const normalized = value.replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (
    !normalized ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new HttpError(500, `Invalid Worker binding: ${name}`);
  }
  return `${segments.join('/')}/`;
}

function loadRole(input: {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  name: string;
  region: string;
  secretAccessKey: string;
}): S3ReadRole {
  const endpoint = new URL(input.endpoint);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    input.bucket.includes('/') ||
    input.bucket.includes('\\')
  ) {
    throw new HttpError(500, `${input.name} storage configuration is invalid`);
  }
  return {
    accessKeyId: input.accessKeyId,
    bucket: input.bucket,
    endpoint: endpoint.origin,
    region: input.region,
    secretAccessKey: input.secretAccessKey,
  };
}

function loadEnv(env: Env): SourceConfig {
  const values = Object.fromEntries(
    REQUIRED_BINDINGS.map((name) => [name, requireBinding(env, name)])
  ) as Record<BindingName, string>;
  return {
    deliveryGrantIssuer: values.DELIVERY_GRANT_ISSUER,
    deliveryGrantKeyId: values.DELIVERY_GRANT_KEY_ID,
    deliveryGrantPublicKey: values.DELIVERY_GRANT_PUBLIC_KEY,
    materializationSourceAudience: values.MATERIALIZATION_SOURCE_AUDIENCE,
    metadata: {
      ...loadRole({
        accessKeyId: values.METADATA_S3_READONLY_ACCESS_KEY_ID,
        bucket: values.METADATA_S3_BUCKET,
        endpoint: values.METADATA_S3_ENDPOINT,
        name: 'Metadata',
        region: values.METADATA_S3_REGION,
        secretAccessKey: values.METADATA_S3_READONLY_SECRET_ACCESS_KEY,
      }),
      indexPrefix: normalizePrefix(values.METADATA_INDEX_PREFIX, 'METADATA_INDEX_PREFIX'),
    },
    protected: {
      ...loadRole({
        accessKeyId: values.PROTECTED_S3_READONLY_ACCESS_KEY_ID,
        bucket: values.PROTECTED_S3_BUCKET,
        endpoint: values.PROTECTED_S3_ENDPOINT,
        name: 'Protected',
        region: values.PROTECTED_S3_REGION,
        secretAccessKey: values.PROTECTED_S3_READONLY_SECRET_ACCESS_KEY,
      }),
      chunkPrefix: normalizePrefix(values.PROTECTED_CHUNK_PREFIX, 'PROTECTED_CHUNK_PREFIX'),
    },
    storageFormatVersion: values.STORAGE_FORMAT_VERSION,
  };
}

function decodeBase64Url(value: string, name: string): Uint8Array {
  if (!value || !BASE64URL.test(value)) {
    throw new HttpError(500, `${name} must use unpadded base64url`);
  }
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new HttpError(500, `${name} is invalid`);
  }
}

function createStorageClient(role: S3ReadRole): AwsClient {
  return new AwsClient({
    accessKeyId: role.accessKeyId,
    secretAccessKey: role.secretAccessKey,
    region: role.region,
    service: 's3',
    retries: 0,
  });
}

async function getStorageObject(aws: AwsClient, role: S3ReadRole, key: string): Promise<Response> {
  const url = buildS3ObjectUrl({ bucket: role.bucket, endpoint: role.endpoint }, key);
  return aws.fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
  });
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > limit) {
    throw new HttpError(502, 'Materialization source manifest exceeded its size limit', 1);
  }
  if (!response.body) {
    throw new HttpError(502, 'Materialization source manifest has no body', 1);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        return text;
      }
      if (!value) {
        continue;
      }
      received += value.byteLength;
      if (received > limit) {
        throw new HttpError(502, 'Materialization source manifest exceeded its size limit', 1);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function loadManifest(
  aws: AwsClient,
  config: SourceConfig,
  grant: DeliveryGrantV2,
  versionId: string
): Promise<{ body: string; manifest: DeliveryManifest; storageFetches: number }> {
  const key = `${config.metadata.indexPrefix}${deliveryManifestObjectId(versionId)}`;
  const response = await getStorageObject(aws, config.metadata, key);
  if (response.status === 404) {
    throw new HttpError(404, 'Materialization source version was not found', 1);
  }
  if (!response.ok) {
    throw new HttpError(502, 'Materialization source manifest storage request failed', 1);
  }
  let body: string;
  let manifest: DeliveryManifest;
  try {
    body = await readLimitedText(response, MAX_MANIFEST_BYTES);
    manifest = parseDeliveryManifest(JSON.parse(body));
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(502, 'Materialization source manifest failed validation', 1);
  }
  if (
    manifest.versionId !== versionId ||
    manifest.storageFormatVersion !== config.storageFormatVersion ||
    manifest.packageId !== grant.productId ||
    manifest.files.reduce((total, file) => total + file.chunks.length, 0) > MAX_SOURCE_CHUNKS ||
    manifest.files.some((file) => file.chunks.some((chunk) => chunk.size > MAX_CHUNK_BYTES))
  ) {
    throw new HttpError(502, 'Materialization source manifest is not accepted', 1);
  }
  const publication = createLogicalReleasePublicationV4({
    files: manifest.files,
    manifest: new TextEncoder().encode(body),
    packageId: manifest.packageId,
    version: manifest.version,
    versionId: manifest.versionId,
  });
  if (
    publication.releaseRoot !== bytesToHex(grant.releaseRoot) ||
    publication.bindingRoot !== bytesToHex(grant.bindingRoot)
  ) {
    throw new HttpError(403, 'Materialization source manifest binding is invalid', 1);
  }
  return { body, manifest, storageFetches: 1 };
}

function findManifestChunk(
  manifest: DeliveryManifest,
  chunkId: string
): { id: string; sha256: string; size: number } | undefined {
  let matched: { id: string; sha256: string; size: number } | undefined;
  for (const file of manifest.files) {
    if (file.classification !== 'protected') {
      continue;
    }
    for (const chunk of file.chunks) {
      if (chunk.id !== chunkId) {
        continue;
      }
      if (matched && (matched.size !== chunk.size || matched.sha256 !== chunk.sha256)) {
        throw new HttpError(502, 'Materialization manifest has conflicting chunk recipes');
      }
      matched = chunk;
    }
  }
  return matched;
}

function parseAuthorization(request: Request): { grant: string; proof: string } {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^DPoP ([A-Za-z0-9_-]+)$/.exec(authorization);
  const proof = request.headers.get('dpop') ?? '';
  if (!match?.[1] || match[1].length > MAX_GRANT_BYTES || !proof || proof.length > 8_192) {
    throw new HttpError(403, 'Forbidden');
  }
  return { grant: match[1], proof };
}

async function authorize(input: {
  config: SourceConfig;
  request: Request;
  versionId: string;
}): Promise<DeliveryGrantV2> {
  const { grant, proof } = parseAuthorization(input.request);
  const verifiedProof = await verifyDpopProof({
    accessToken: grant,
    method: input.request.method,
    proof,
    url: input.request.url,
  });
  const verifiedGrant = await verifyDeliveryGrantV2({
    context: {
      audience: input.config.materializationSourceAudience,
      deviceKeyThumbprint: verifiedProof.thumbprint,
      issuer: input.config.deliveryGrantIssuer,
      now: Math.floor(Date.now() / 1_000),
      requiredScope: `materialization-source:${input.versionId}`,
    },
    coseSign1: decodeBase64Url(grant, 'Delivery grant'),
    expectedKeyId: packageContractKeyId(input.config.deliveryGrantKeyId),
    publicKey: decodeBase64Url(input.config.deliveryGrantPublicKey, 'DELIVERY_GRANT_PUBLIC_KEY'),
  });
  const thumbprint = bytesToBase64Url(verifiedProof.thumbprint);
  if (
    !dpopReplayCache.reserve({
      expiresAtMs: Math.min(verifiedGrant.expiresAt * 1_000, Date.now() + DPOP_REPLAY_WINDOW_MS),
      key: `${thumbprint.length}:${thumbprint}${verifiedProof.jti}`,
    })
  ) {
    throw new HttpError(403, 'Forbidden');
  }
  return verifiedGrant;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

function chunkObjectKey(config: SourceConfig, chunkId: string): string {
  return `${config.protected.chunkPrefix}${chunkId.slice(0, 4)}/${chunkId}`;
}

function noStoreResponse(
  body: BodyInit | null,
  status: number,
  storageFetches: number,
  headers?: HeadersInit
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('cache-control', 'private, no-store');
  responseHeaders.set('x-delivery-storage-fetches', storageFetches.toString());
  return new Response(body, {
    headers: responseHeaders,
    status,
  });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      throw new HttpError(405, 'Method not allowed');
    }
    const url = new URL(request.url);
    const match = SOURCE_PATH.exec(url.pathname);
    if (!match?.[1] || !match[2]) {
      throw new HttpError(404, 'Not found');
    }
    let versionId: string;
    try {
      versionId = decodeURIComponent(match[1]);
      deliveryManifestObjectId(versionId);
    } catch {
      throw new HttpError(403, 'Forbidden');
    }
    const config = loadEnv(env);
    const grant = await authorize({ config, request, versionId });
    const metadata = createStorageClient(config.metadata);
    const loaded = await loadManifest(metadata, config, grant, versionId);

    if (match[2] === 'manifest') {
      return noStoreResponse(loaded.body, 200, loaded.storageFetches, {
        'content-type': 'application/json',
      });
    }

    const chunkId = match[3] ?? '';
    if (!CHUNK_ID.test(chunkId)) {
      throw new HttpError(403, 'Forbidden', loaded.storageFetches);
    }
    const chunk = findManifestChunk(loaded.manifest, chunkId);
    if (!chunk) {
      throw new HttpError(403, 'Forbidden', loaded.storageFetches);
    }
    const response = await getStorageObject(
      createStorageClient(config.protected),
      config.protected,
      chunkObjectKey(config, chunkId)
    );
    const storageFetches = loaded.storageFetches + 1;
    if (!response.ok) {
      throw new HttpError(
        502,
        'Materialization source chunk storage request failed',
        storageFetches
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== chunk.size || (await sha256Hex(bytes)) !== chunk.sha256) {
      throw new HttpError(502, 'Materialization source chunk failed verification', storageFetches);
    }
    return noStoreResponse(bytes, 200, storageFetches, {
      'content-length': String(bytes.byteLength),
      'content-type': 'application/octet-stream',
      etag: `"${chunk.id}"`,
    });
  } catch (error) {
    const httpError = error instanceof HttpError ? error : new HttpError(403, 'Forbidden');
    return noStoreResponse(httpError.message, httpError.status, httpError.storageFetches, {
      'content-type': 'text/plain; charset=utf-8',
    });
  }
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
