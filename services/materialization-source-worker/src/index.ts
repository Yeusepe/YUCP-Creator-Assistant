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
// Backblaze B2 S3-compatible API:
// https://www.backblaze.com/docs/cloud-storage-s3-compatible-api

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
// instead of racing identical downloads.
const inflightManifestLoads = new Map<string, Promise<CachedManifest>>();

type BindingName = (typeof REQUIRED_BINDINGS)[number];
type S3ReadRole = {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  region: string;
  secretAccessKey: string;
};
type SourceConfig = {
  common: S3ReadRole & { chunkPrefix: string };
  deliveryGrantIssuer: string;
  deliveryGrantKeyId: string;
  deliveryGrantPublicKey: string;
  materializationSourceAudience: string;
  metadata: S3ReadRole & { indexPrefix: string };
  protected: S3ReadRole & { chunkPrefix: string };
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

function loadEnv(env: Env): SourceConfig {
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
    throw new HttpError(
      502,
      'Materialization source manifest exceeded its size limit',
      1,
      'manifest'
    );
  }
  if (!response.body) {
    throw new HttpError(502, 'Materialization source manifest has no body', 1, 'manifest');
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
        throw new HttpError(
          502,
          'Materialization source manifest exceeded its size limit',
          1,
          'manifest'
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function logManifestValidationFailure(input: {
  jobId: string;
  reason: string;
  versionId: string;
}): void {
  console.error(
    JSON.stringify({
      errorCode: 'MATERIALIZATION_SOURCE_MANIFEST_INVALID',
      event: 'materialization.source_manifest.validation_failed',
      jobId: input.jobId,
      reason: input.reason,
      versionId: input.versionId,
    })
  );
}

function logMissingManifestChunk(input: {
  chunkId: string;
  jobId: string;
  manifest: DeliveryManifest;
  versionId: string;
}): void {
  console.error(
    JSON.stringify({
      chunkCount: input.manifest.files.reduce((total, file) => total + file.chunks.length, 0),
      errorCode: 'MATERIALIZATION_SOURCE_CHUNK_NOT_IN_MANIFEST',
      event: 'materialization.source_chunk.not_in_manifest',
      fileCount: input.manifest.files.length,
      jobId: input.jobId,
      requestedIdMatchesChunkSha256: input.manifest.files.some((file) =>
        file.chunks.some((chunk) => chunk.sha256 === input.chunkId)
      ),
      requestedIdMatchesFileSha256: input.manifest.files.some(
        (file) => file.sha256 === input.chunkId
      ),
      versionId: input.versionId,
    })
  );
}

function manifestMatchesGrant(entry: CachedManifest, grant: DeliveryGrantV2): boolean {
  return (
    entry.releaseRoot === bytesToHex(grant.releaseRoot) &&
    entry.bindingRoot === bytesToHex(grant.bindingRoot)
  );
}

async function loadManifestFromStorage(
  aws: AwsClient,
  config: SourceConfig,
  diagnosticJobId: string,
  versionId: string
): Promise<CachedManifest> {
  const key = `${config.metadata.indexPrefix}${deliveryManifestObjectId(versionId)}`;
  const response = await getStorageObject(aws, config.metadata, key);
  if (response.status === 404) {
    throw new HttpError(404, 'Materialization source version was not found', 1, 'manifest');
  }
  if (!response.ok) {
    throw new HttpError(
      502,
      'Materialization source manifest storage request failed',
      1,
      'manifest'
    );
  }
  let body: string;
  let manifest: DeliveryManifest;
  try {
    body = await readLimitedText(response, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(502, 'Materialization source manifest failed validation', 1, 'manifest');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    logManifestValidationFailure({
      jobId: diagnosticJobId,
      reason: 'Materialization source manifest is not valid JSON',
      versionId,
    });
    throw new HttpError(502, 'Materialization source manifest failed validation', 1, 'manifest');
  }
  try {
    manifest = parseDeliveryManifest(parsed);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    logManifestValidationFailure({
      jobId: diagnosticJobId,
      reason:
        error instanceof Error
          ? error.message
          : 'Materialization source manifest validation raised an unknown error',
      versionId,
    });
    throw new HttpError(502, 'Materialization source manifest failed validation', 1, 'manifest');
  }
  if (
    manifest.versionId !== versionId ||
    manifest.storageFormatVersion !== config.storageFormatVersion ||
    manifest.files.reduce((total, file) => total + file.chunks.length, 0) > MAX_SOURCE_CHUNKS ||
    manifest.files.some((file) => file.chunks.some((chunk) => chunk.size > MAX_CHUNK_BYTES))
  ) {
    throw new HttpError(502, 'Materialization source manifest is not accepted', 1, 'manifest');
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
  config: SourceConfig,
  diagnosticJobId: string,
  versionId: string
): Promise<CachedManifest> {
  const pending = inflightManifestLoads.get(versionId);
  if (pending) {
    return pending;
  }
  const load = loadManifestFromStorage(aws, config, diagnosticJobId, versionId);
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
  config: SourceConfig,
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
    entry = await loadManifestShared(aws, config, grant.installSessionId, versionId);
  }
  if (entry.manifest.packageId !== grant.productId) {
    throw new HttpError(502, 'Materialization source manifest is not accepted', 1, 'manifest');
  }
  if (!manifestMatchesGrant(entry, grant)) {
    throw new HttpError(403, 'Materialization source manifest binding is invalid', 1, 'binding');
  }
  // storageFetches reports actual origin reads; the x-yucp-denial-stage header
  // carries the phase information the materializer previously inferred from it.
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
):
  | { classification: 'common' | 'protected'; id: string; sha256: string; size: number }
  | undefined {
  let matched:
    | {
        classification: 'common' | 'protected';
        id: string;
        sha256: string;
        size: number;
      }
    | undefined;
  for (const file of manifest.files) {
    for (const chunk of file.chunks) {
      if (chunk.id !== chunkId) {
        continue;
      }
      if (matched && (matched.size !== chunk.size || matched.sha256 !== chunk.sha256)) {
        throw new HttpError(502, 'Materialization manifest has conflicting chunk recipes');
      }
      matched = {
        classification:
          matched?.classification === 'protected' || file.classification === 'protected'
            ? 'protected'
            : 'common',
        ...chunk,
      };
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

function chunkObjectKey(role: S3ReadRole & { chunkPrefix: string }, chunkId: string): string {
  return `${role.chunkPrefix}${chunkId.slice(0, 4)}/${chunkId}`;
}

// Cache only digest-verified chunks; authorization still runs per request.
const CHUNK_CACHE_VERSION = 'v1';

function edgeCache(): Cache | undefined {
  return (globalThis as { caches?: CacheStorage }).caches?.default;
}

function chunkCacheKey(input: {
  chunkId: string;
  classification: 'common' | 'protected';
  sha256: string;
  url: URL;
}): Request {
  return new Request(
    `https://${input.url.hostname}/__internal/chunk-cache/${CHUNK_CACHE_VERSION}/${input.classification}/${input.chunkId}/${input.sha256}`,
    { method: 'GET' }
  );
}

async function matchVerifiedChunk(
  cache: Cache,
  cacheKey: Request,
  chunk: { sha256: string; size: number }
): Promise<Uint8Array | undefined> {
  let cached: Response | undefined;
  try {
    cached = await cache.match(cacheKey);
  } catch {
    return undefined;
  }
  if (!cached) {
    return undefined;
  }
  const bytes = new Uint8Array(await cached.arrayBuffer());
  if (bytes.byteLength !== chunk.size || (await sha256Hex(bytes)) !== chunk.sha256) {
    return undefined;
  }
  return bytes;
}

function storeVerifiedChunk(
  ctx: ExecutionContext | undefined,
  cache: Cache,
  cacheKey: Request,
  bytes: Uint8Array
): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stored = cache
    .put(
      cacheKey,
      new Response(copy, {
        headers: {
          'cache-control': 'public, max-age=31536000, immutable',
          'content-length': String(copy.byteLength),
          'content-type': 'application/octet-stream',
        },
      })
    )
    .catch(() => undefined);
  ctx?.waitUntil(stored);
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

async function handleRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
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
        'x-yucp-manifest-source': loaded.manifestSource,
      });
    }

    const chunkId = match[3] ?? '';
    if (!CHUNK_ID.test(chunkId)) {
      throw new HttpError(403, 'Forbidden', loaded.storageFetches, 'membership');
    }
    const chunk = findManifestChunk(loaded.manifest, chunkId);
    if (!chunk) {
      logMissingManifestChunk({
        chunkId,
        jobId: grant.installSessionId,
        manifest: loaded.manifest,
        versionId,
      });
      throw new HttpError(403, 'Forbidden', loaded.storageFetches, 'membership');
    }
    const sourceRole = chunk.classification === 'protected' ? config.protected : config.common;
    const cache = edgeCache();
    const cacheKey = cache
      ? chunkCacheKey({
          chunkId,
          classification: chunk.classification,
          sha256: chunk.sha256,
          url,
        })
      : undefined;
    let bytes = cache && cacheKey ? await matchVerifiedChunk(cache, cacheKey, chunk) : undefined;
    let chunkSource: 'edge-cache' | 'storage' = 'edge-cache';
    let storageFetches = loaded.storageFetches;
    if (!bytes) {
      chunkSource = 'storage';
      const response = await getStorageObject(
        createStorageClient(sourceRole),
        sourceRole,
        chunkObjectKey(sourceRole, chunkId)
      );
      storageFetches += 1;
      if (!response.ok) {
        throw new HttpError(
          502,
          'Materialization source chunk storage request failed',
          storageFetches
        );
      }
      const fetched = new Uint8Array(await response.arrayBuffer());
      if (fetched.byteLength !== chunk.size || (await sha256Hex(fetched)) !== chunk.sha256) {
        throw new HttpError(
          502,
          'Materialization source chunk failed verification',
          storageFetches,
          'chunk'
        );
      }
      bytes = fetched;
      if (cache && cacheKey) {
        storeVerifiedChunk(ctx, cache, cacheKey, bytes);
      }
    }
    return noStoreResponse(bytes, 200, storageFetches, {
      'content-length': String(bytes.byteLength),
      'content-type': 'application/octet-stream',
      etag: `"${chunk.id}"`,
      'x-yucp-chunk-source': chunkSource,
      'x-yucp-manifest-source': loaded.manifestSource,
    });
  } catch (error) {
    const httpError = error instanceof HttpError ? error : new HttpError(403, 'Forbidden');
    return noStoreResponse(httpError.message, httpError.status, httpError.storageFetches, {
      'content-type': 'text/plain; charset=utf-8',
      'x-yucp-denial-stage': httpError.stage,
    });
  }
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
