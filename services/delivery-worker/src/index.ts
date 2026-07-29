import { AwsClient } from 'aws4fetch';
import {
  type DeliveryManifest,
  deliveryManifestObjectId,
  parseDeliveryManifest,
} from '../../../ops/storage-core/deliveryManifest';
import { verifyDpopProof } from '../../../ops/storage-core/dpop';
import { BoundedDpopReplayCache } from '../../../ops/storage-core/dpopReplayCache';
import { BoundedManifestCache, type CachedManifest } from '../../../ops/storage-core/manifestCache';
import {
  type DeliveryGrantV2,
  packageContractKeyId,
  verifyDeliveryGrantV2,
} from '../../../ops/storage-core/packageContractsV2';
import { createLogicalReleasePublicationV4 } from '../../../ops/storage-core/releasePublication';
import { buildS3ObjectUrl } from '../../../ops/storage-core/s3ObjectUrl';
import { fetchWithSlowDownBackoff } from '../../../ops/storage-core/storageBackoff';

// Cloudflare Workers support response streaming, but origin subrequests stay bounded.
// Reference: https://developers.cloudflare.com/workers/platform/limits/

const REQUIRED_BINDINGS = [
  'COMMON_S3_ENDPOINT',
  'COMMON_S3_REGION',
  'COMMON_S3_BUCKET',
  'COMMON_S3_READONLY_ACCESS_KEY_ID',
  'COMMON_S3_READONLY_SECRET_ACCESS_KEY',
  'COMMON_CHUNK_PREFIX',
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_BUCKET',
  'METADATA_S3_READONLY_ACCESS_KEY_ID',
  'METADATA_S3_READONLY_SECRET_ACCESS_KEY',
  'METADATA_INDEX_PREFIX',
  'STORAGE_FORMAT_VERSION',
  'PACKAGE_INSTALL_SIGNING_KEY_ID',
  'PACKAGE_INSTALL_ISSUER',
  'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY',
  'PACKAGE_DELIVERY_AUDIENCE',
] as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CHUNK_ID = /^[0-9a-f]{64}$/;
const DELIVERY_PATH = /^\/v2\/delivery\/([^/]+)\/(manifest|chunks\/([^/]+))$/;
const MAX_GRANT_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_DELIVERY_CHUNKS = 100_000;
const MAX_CHUNK_BYTES = 1024 * 1024;
const ORIGIN_TIMEOUT_MS = 30_000;
const MAX_DPOP_REPLAY_ENTRIES = 8_192;
const DPOP_REPLAY_SWEEP_LIMIT = 128;
const MANIFEST_CACHE_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MANIFEST_CACHE_MAX_ENTRIES = 64;
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1_000;
// This bounded module cache is same-isolate abuse detection, not cross-region security truth.
const dpopReplayCache = new BoundedDpopReplayCache({
  maxEntries: MAX_DPOP_REPLAY_ENTRIES,
  sweepLimit: DPOP_REPLAY_SWEEP_LIMIT,
});
// Same-isolate reuse of a validated manifest; the per-request grant binding check
// below invalidates a stale entry after a manifest republish, and the TTL bounds
// how long republished-but-still-granted manifests can serve from cache.
const manifestCache = new BoundedManifestCache({
  maxBodyBytes: MANIFEST_CACHE_MAX_BODY_BYTES,
  maxEntries: MANIFEST_CACHE_MAX_ENTRIES,
  ttlMs: MANIFEST_CACHE_TTL_MS,
});
// Concurrent chunk requests on a cold isolate share one storage load per version
// instead of racing sixteen identical downloads.
const inflightManifestLoads = new Map<string, Promise<CachedManifest>>();

type BindingName = (typeof REQUIRED_BINDINGS)[number];
type S3ReadRole = {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  region: string;
  secretAccessKey: string;
};
type DeliveryConfig = {
  common: S3ReadRole & { chunkPrefix: string };
  metadata: S3ReadRole & { indexPrefix: string };
  packageDeliveryAudience: string;
  packageInstallIssuer: string;
  packageInstallSigningKeyId: string;
  packageInstallSigningPublicKey: string;
  storageFormatVersion: string;
};

// The denial stage names which phase rejected the request so the materializer's
// failure classifier no longer has to infer it from the storage-fetch counter.
type DenialStage = 'authorization' | 'binding' | 'chunk' | 'manifest' | 'membership';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly storageFetches = 0,
    readonly stage: DenialStage = 'authorization'
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

function loadEnv(env: Env): DeliveryConfig {
  const values = Object.fromEntries(
    REQUIRED_BINDINGS.map((name) => [name, requireBinding(env, name)])
  ) as Record<BindingName, string>;
  return {
    common: {
      ...loadRole({
        accessKeyId: values.COMMON_S3_READONLY_ACCESS_KEY_ID,
        bucket: values.COMMON_S3_BUCKET,
        endpoint: values.COMMON_S3_ENDPOINT,
        name: 'Common',
        region: values.COMMON_S3_REGION,
        secretAccessKey: values.COMMON_S3_READONLY_SECRET_ACCESS_KEY,
      }),
      chunkPrefix: normalizePrefix(values.COMMON_CHUNK_PREFIX, 'COMMON_CHUNK_PREFIX'),
    },
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
    packageDeliveryAudience: values.PACKAGE_DELIVERY_AUDIENCE,
    packageInstallIssuer: values.PACKAGE_INSTALL_ISSUER,
    packageInstallSigningKeyId: values.PACKAGE_INSTALL_SIGNING_KEY_ID,
    packageInstallSigningPublicKey: values.PACKAGE_INSTALL_SIGNING_PUBLIC_KEY,
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

// Chunk bytes are only ever cached after verification via caches.default in
// loadChunk; an origin-level cf cache was rejected because a corrupted upstream
// 200 under the third-party Backblaze hostname could not be purged.
async function getStorageObject(
  aws: AwsClient,
  role: S3ReadRole,
  key: string,
  stage: DenialStage = 'manifest'
): Promise<Response> {
  const url = buildS3ObjectUrl({ bucket: role.bucket, endpoint: role.endpoint }, key);
  try {
    return await fetchWithSlowDownBackoff(() =>
      aws.fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
      })
    );
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    // Persistent network failures are storage outages, not authorization denials.
    throw new HttpError(502, 'Storage request failed', 1, stage);
  }
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > limit) {
    throw new HttpError(502, 'Delivery manifest exceeded its size limit', 1);
  }
  if (!response.body) {
    throw new HttpError(502, 'Delivery manifest has no body', 1);
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
        throw new HttpError(502, 'Delivery manifest exceeded its size limit', 1);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function manifestMatchesGrant(entry: CachedManifest, grant: DeliveryGrantV2): boolean {
  return (
    entry.releaseRoot === bytesToHex(grant.releaseRoot) &&
    entry.bindingRoot === bytesToHex(grant.bindingRoot)
  );
}

async function loadManifestFromStorage(
  aws: AwsClient,
  config: DeliveryConfig,
  versionId: string
): Promise<CachedManifest> {
  const key = `${config.metadata.indexPrefix}${deliveryManifestObjectId(versionId)}`;
  const response = await getStorageObject(aws, config.metadata, key);
  if (response.status === 404) {
    throw new HttpError(404, 'Package version was not found', 1, 'manifest');
  }
  if (!response.ok) {
    throw new HttpError(502, 'Delivery manifest storage request failed', 1, 'manifest');
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
    throw new HttpError(502, 'Delivery manifest failed validation', 1, 'manifest');
  }
  if (
    manifest.versionId !== versionId ||
    manifest.storageFormatVersion !== config.storageFormatVersion ||
    manifest.files.reduce((total, file) => total + file.chunks.length, 0) > MAX_DELIVERY_CHUNKS ||
    manifest.files.some((file) => file.chunks.some((chunk) => chunk.size > MAX_CHUNK_BYTES))
  ) {
    throw new HttpError(502, 'Delivery manifest is not accepted', 1, 'manifest');
  }
  const publication = createLogicalReleasePublicationV4({
    files: manifest.files,
    manifest: new TextEncoder().encode(body),
    packageId: manifest.packageId,
    version: manifest.version,
    versionId: manifest.versionId,
  });
  const entry: CachedManifest = {
    bindingRoot: publication.bindingRoot,
    body,
    manifest,
    releaseRoot: publication.releaseRoot,
  };
  manifestCache.set(versionId, entry);
  return entry;
}

function loadManifestShared(
  aws: AwsClient,
  config: DeliveryConfig,
  versionId: string
): Promise<CachedManifest> {
  const pending = inflightManifestLoads.get(versionId);
  if (pending) {
    return pending;
  }
  const load = loadManifestFromStorage(aws, config, versionId);
  inflightManifestLoads.set(versionId, load);
  const cleanup = () => {
    if (inflightManifestLoads.get(versionId) === load) {
      inflightManifestLoads.delete(versionId);
    }
  };
  load.then(cleanup, cleanup);
  return load;
}

async function loadManifest(
  aws: AwsClient,
  config: DeliveryConfig,
  grant: DeliveryGrantV2,
  versionId: string
): Promise<{
  body: string;
  manifest: DeliveryManifest;
  manifestSource: 'cache' | 'storage';
  storageFetches: number;
}> {
  let manifestSource: 'cache' | 'storage' = 'cache';
  let entry = manifestCache.get(versionId);
  if (entry && !manifestMatchesGrant(entry, grant)) {
    manifestCache.delete(versionId);
    entry = undefined;
  }
  if (!entry) {
    manifestSource = 'storage';
    entry = await loadManifestShared(aws, config, versionId);
  }
  if (entry.manifest.packageId !== grant.productId) {
    throw new HttpError(502, 'Delivery manifest is not accepted', 1, 'manifest');
  }
  if (!manifestMatchesGrant(entry, grant)) {
    throw new HttpError(403, 'Delivery manifest binding is invalid', 1, 'binding');
  }
  // storageFetches reports actual origin reads; the x-yucp-denial-stage header
  // carries the phase information consumers previously inferred from it.
  return {
    body: entry.body,
    manifest: entry.manifest,
    manifestSource,
    storageFetches: manifestSource === 'cache' ? 0 : 1,
  };
}

function findManifestChunk(
  manifest: DeliveryManifest,
  chunkId: string
): { id: string; sha256: string; size: number } | undefined {
  let matched: { id: string; sha256: string; size: number } | undefined;
  for (const file of manifest.files) {
    if (file.classification !== 'common') {
      continue;
    }
    for (const chunk of file.chunks) {
      if (chunk.id !== chunkId) {
        continue;
      }
      if (matched && (matched.size !== chunk.size || matched.sha256 !== chunk.sha256)) {
        throw new HttpError(502, 'Delivery manifest has conflicting chunk recipes');
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
  config: DeliveryConfig;
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
      audience: input.config.packageDeliveryAudience,
      deviceKeyThumbprint: verifiedProof.thumbprint,
      issuer: input.config.packageInstallIssuer,
      now: Math.floor(Date.now() / 1_000),
      requiredScope: `package:${input.versionId}:read`,
    },
    coseSign1: decodeBase64Url(grant, 'Delivery grant'),
    expectedKeyId: packageContractKeyId(input.config.packageInstallSigningKeyId),
    publicKey: decodeBase64Url(
      input.config.packageInstallSigningPublicKey,
      'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY'
    ),
  });
  reserveLocalDpopProof({
    expiresAt: verifiedGrant.expiresAt,
    jti: verifiedProof.jti,
    thumbprint: bytesToBase64Url(verifiedProof.thumbprint),
  });
  return verifiedGrant;
}

function reserveLocalDpopProof(input: {
  expiresAt: number;
  jti: string;
  thumbprint: string;
}): void {
  const reserved = dpopReplayCache.reserve({
    expiresAtMs: input.expiresAt * 1_000,
    key: `${input.thumbprint.length}:${input.thumbprint}${input.jti}`,
  });
  if (!reserved) {
    throw new HttpError(403, 'Forbidden');
  }
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

function chunkObjectKey(config: DeliveryConfig, chunkId: string): string {
  return `${config.common.chunkPrefix}${chunkId.slice(0, 4)}/${chunkId}`;
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

function chunkCacheRequest(request: Request, chunkId: string): Request {
  const url = new URL(request.url);
  url.pathname = `/__yucp_common_chunk_cache/v1/${chunkId}`;
  url.search = '';
  url.hash = '';
  return new Request(url, { method: 'GET' });
}

async function readVerifiedChunk(
  response: Response,
  chunk: { id: string; sha256: string; size: number }
) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== chunk.size || (await sha256Hex(bytes)) !== chunk.sha256) {
    throw new HttpError(502, 'Common chunk failed verification', 0, 'chunk');
  }
  return bytes;
}

async function loadChunk(input: {
  aws: AwsClient;
  chunk: { id: string; sha256: string; size: number };
  config: DeliveryConfig;
  request: Request;
}): Promise<{ bytes: Uint8Array; storageFetches: number }> {
  const cache = typeof caches === 'undefined' ? undefined : caches.default;
  const cacheRequest = chunkCacheRequest(input.request, input.chunk.id);
  if (cache) {
    const cached = await cache.match(cacheRequest);
    if (cached) {
      try {
        return { bytes: await readVerifiedChunk(cached, input.chunk), storageFetches: 0 };
      } catch {
        await cache.delete(cacheRequest);
      }
    }
  }
  const response = await getStorageObject(
    input.aws,
    input.config.common,
    chunkObjectKey(input.config, input.chunk.id),
    'chunk'
  );
  if (!response.ok) {
    throw new HttpError(502, 'Common chunk storage request failed', 1, 'chunk');
  }
  const bytes = await readVerifiedChunk(response, input.chunk);
  if (cache) {
    await cache.put(
      cacheRequest,
      new Response(bytes, {
        headers: {
          'cache-control': 'public, max-age=31536000, immutable',
          'content-length': String(bytes.byteLength),
          etag: `"${input.chunk.id}"`,
        },
      })
    );
  }
  return { bytes, storageFetches: 1 };
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    if (request.method !== 'GET') {
      throw new HttpError(405, 'Method not allowed');
    }
    const url = new URL(request.url);
    const match = DELIVERY_PATH.exec(url.pathname);
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
        'x-yucp-manifest-source': loaded.manifestSource,
      });
    }

    const chunkId = match[3] ?? '';
    if (!CHUNK_ID.test(chunkId)) {
      throw new HttpError(403, 'Forbidden', loaded.storageFetches, 'membership');
    }
    const chunk = findManifestChunk(loaded.manifest, chunkId);
    if (!chunk) {
      throw new HttpError(403, 'Forbidden', loaded.storageFetches, 'membership');
    }
    const loadedChunk = await loadChunk({
      aws: createStorageClient(config.common),
      chunk,
      config,
      request,
    });
    return noStoreResponse(
      loadedChunk.bytes.buffer.slice(
        loadedChunk.bytes.byteOffset,
        loadedChunk.bytes.byteOffset + loadedChunk.bytes.byteLength
      ) as ArrayBuffer,
      200,
      loaded.storageFetches + loadedChunk.storageFetches,
      {
        'content-length': String(loadedChunk.bytes.byteLength),
        'content-type': 'application/octet-stream',
        etag: `"${chunk.id}"`,
        'x-yucp-manifest-source': loaded.manifestSource,
      }
    );
  } catch (error) {
    const httpError = error instanceof HttpError ? error : new HttpError(403, 'Forbidden');
    const reason =
      error instanceof Error && error.message.length <= 256
        ? error.message
        : 'Unknown delivery error';
    console.warn(
      JSON.stringify({
        event: 'delivery.request.denied',
        method: request.method,
        pathname: new URL(request.url).pathname,
        reason,
        stage: httpError.stage,
        status: httpError.status,
        storageFetches: httpError.storageFetches,
      })
    );
    return noStoreResponse(httpError.message, httpError.status, httpError.storageFetches, {
      'content-type': 'text/plain; charset=utf-8',
      'x-yucp-denial-stage': httpError.stage,
    });
  }
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
