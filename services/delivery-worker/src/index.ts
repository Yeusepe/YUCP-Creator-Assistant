import { AwsClient } from 'aws4fetch';
import {
  type DeliveryManifest,
  type DeliveryManifestChunk,
  deliveryManifestObjectId,
  parseDeliveryManifest,
} from '../../../ops/storage-core/deliveryManifest';
import { verifyDeliveryUrl } from '../../../ops/storage-core/deliverySigning';
import { buildS3ObjectUrl } from '../../../ops/storage-core/s3ObjectUrl';

const REQUIRED_BINDING_NAMES = [
  'CAS_S3_ENDPOINT',
  'CAS_S3_REGION',
  'CAS_S3_BUCKET',
  'CAS_S3_READONLY_ACCESS_KEY_ID',
  'CAS_S3_READONLY_SECRET_ACCESS_KEY',
  'CAS_INDEX_PREFIX',
  'CAS_CHUNK_PREFIX',
  'DELIVERY_HMAC_KEY',
  'STORAGE_FORMAT_VERSION',
] as const;

type RequiredBindingName = (typeof REQUIRED_BINDING_NAMES)[number];
type DeliveryWorkerEnv = Readonly<Record<RequiredBindingName, string>>;

type DeliveryRange = {
  end: number;
  start: number;
};

type DeliveryStats = {
  bytesDelivered: number;
  cacheHits: number;
  cacheMisses: number;
  chunkOriginFetches: number;
  storageFetches: number;
};

type StorageClient = {
  aws: AwsClient;
  config: DeliveryWorkerEnv;
  stats: DeliveryStats;
};

const MAX_DELIVERY_CHUNKS = 256;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const OVERSIZED_MANIFEST_MESSAGE =
  'Delivery manifest exceeds direct delivery limits; use the importer path';
const VERSION_PATH_PATTERN = /^\/d\/([^/]+)$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: HeadersInit
  ) {
    super(message);
  }
}

function requestId(): string {
  return crypto.randomUUID();
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

function logError(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields }));
}

function requireBinding(env: Env, name: RequiredBindingName): string {
  const value = Reflect.get(env, name);
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(500, `Missing required Worker binding: ${name}`);
  }
  return value.trim();
}

function normalizePrefix(value: string, name: 'CAS_CHUNK_PREFIX' | 'CAS_INDEX_PREFIX'): string {
  const withoutLeadingSlash = value.replace(/^\/+/, '');
  const segments = withoutLeadingSlash.split('/').filter(Boolean);
  if (
    !withoutLeadingSlash ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new HttpError(500, `Invalid Worker binding: ${name}`);
  }
  return `${segments.join('/')}/`;
}

function loadStorageEnv(env: Env): DeliveryWorkerEnv {
  const bindings = Object.fromEntries(
    REQUIRED_BINDING_NAMES.map((name) => [name, requireBinding(env, name)])
  ) as Record<RequiredBindingName, string>;
  let endpoint: URL;
  try {
    endpoint = new URL(bindings.CAS_S3_ENDPOINT);
  } catch {
    throw new HttpError(500, 'Invalid Worker binding: CAS_S3_ENDPOINT');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new HttpError(500, 'Invalid Worker binding: CAS_S3_ENDPOINT');
  }
  if (bindings.CAS_S3_BUCKET.includes('/') || bindings.CAS_S3_BUCKET.includes('\\')) {
    throw new HttpError(500, 'Invalid Worker binding: CAS_S3_BUCKET');
  }
  return {
    ...bindings,
    CAS_S3_ENDPOINT: endpoint.origin,
    CAS_CHUNK_PREFIX: normalizePrefix(bindings.CAS_CHUNK_PREFIX, 'CAS_CHUNK_PREFIX'),
    CAS_INDEX_PREFIX: normalizePrefix(bindings.CAS_INDEX_PREFIX, 'CAS_INDEX_PREFIX'),
  };
}

function createStorageClient(config: DeliveryWorkerEnv, stats: DeliveryStats): StorageClient {
  return {
    aws: new AwsClient({
      accessKeyId: config.CAS_S3_READONLY_ACCESS_KEY_ID,
      secretAccessKey: config.CAS_S3_READONLY_SECRET_ACCESS_KEY,
      region: config.CAS_S3_REGION,
      service: 's3',
      retries: 0,
    }),
    config,
    stats,
  };
}

/**
 * GetObject response contract:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
 */
async function getStorageObject(client: StorageClient, key: string): Promise<Response> {
  client.stats.storageFetches += 1;
  const url = buildS3ObjectUrl(
    { bucket: client.config.CAS_S3_BUCKET, endpoint: client.config.CAS_S3_ENDPOINT },
    key
  );
  return client.aws.fetch(url, { method: 'GET' });
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > limit) {
    throw new HttpError(422, OVERSIZED_MANIFEST_MESSAGE);
  }
  if (!response.body) {
    throw new HttpError(502, 'Delivery manifest response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      output += decoder.decode();
      return output;
    }
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new HttpError(422, OVERSIZED_MANIFEST_MESSAGE);
    }
    output += decoder.decode(value, { stream: true });
  }
}

async function loadManifest(client: StorageClient, versionId: string): Promise<DeliveryManifest> {
  const key = `${client.config.CAS_INDEX_PREFIX}${deliveryManifestObjectId(versionId)}`;
  const response = await getStorageObject(client, key);
  if (response.status === 404) {
    throw new HttpError(404, 'Delivery version not found');
  }
  if (!response.ok) {
    throw new HttpError(502, `Delivery manifest storage request failed with ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readLimitedText(response, MAX_MANIFEST_BYTES));
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(502, 'Delivery manifest is not valid JSON');
  }

  let manifest: DeliveryManifest;
  try {
    manifest = parseDeliveryManifest(parsed);
  } catch {
    throw new HttpError(502, 'Delivery manifest failed validation');
  }
  if (manifest.versionId !== versionId) {
    throw new HttpError(502, 'Delivery manifest version does not match the request');
  }
  if (manifest.storageFormatVersion !== client.config.STORAGE_FORMAT_VERSION) {
    throw new HttpError(502, 'Delivery manifest storage format is not supported');
  }
  return manifest;
}

function parseRange(value: string | null, totalSize: number): DeliveryRange | undefined {
  if (value === null) {
    return undefined;
  }
  if (value.includes(',')) {
    throw new HttpError(416, 'Multiple byte ranges are not supported', {
      'content-range': `bytes */${totalSize}`,
    });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || totalSize === 0) {
    throw new HttpError(416, 'Invalid byte range', {
      'content-range': `bytes */${totalSize}`,
    });
  }

  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  let start: number;
  let end: number;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new HttpError(416, 'Invalid byte range', {
        'content-range': `bytes */${totalSize}`,
      });
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : totalSize - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= totalSize ||
      end < start
    ) {
      throw new HttpError(416, 'Invalid byte range', {
        'content-range': `bytes */${totalSize}`,
      });
    }
    end = Math.min(end, totalSize - 1);
  }
  return { end, start };
}

function chunkCacheRequest(
  request: Request,
  storageFormatVersion: string,
  chunkId: string
): Request {
  // The Cache API keys by Request URL and is independent of front-of-Worker caching. Keep the
  // deployment-stable route origin and immutable CAS identity, but remove delivery authorization.
  // https://developers.cloudflare.com/workers/reference/how-the-cache-works/#cache-api
  const url = new URL(request.url);
  url.pathname = `/cas/${encodeURIComponent(storageFormatVersion)}/${chunkId}`;
  url.search = '';
  return new Request(url, { method: 'GET' });
}

/** Web Crypto digest contract: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ */
async function readExactChunk(
  response: Response,
  expectedSize: number,
  expectedSha256: string
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expectedSize) {
    throw new Error(
      `CAS chunk size mismatch: expected ${expectedSize} bytes, received ${bytes.byteLength}`
    );
  }
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  if (sha256 !== expectedSha256) {
    throw new Error(`CAS chunk SHA-256 mismatch: expected ${expectedSha256}, received ${sha256}`);
  }
  return bytes;
}

/**
 * desync raw chunks use `<first-four-hex>/<full-id>` object keys:
 * https://github.com/folbricht/desync#compressed-vs-uncompressed
 */
function chunkObjectKey(config: DeliveryWorkerEnv, chunkId: string): string {
  return `${config.CAS_CHUNK_PREFIX}${chunkId.slice(0, 4)}/${chunkId}`;
}

async function loadChunk(
  request: Request,
  client: StorageClient,
  manifest: DeliveryManifest,
  chunk: DeliveryManifestChunk,
  ctx: ExecutionContext,
  requestId: string,
  versionId: string
): Promise<Uint8Array> {
  const cacheRequest = chunkCacheRequest(request, manifest.storageFormatVersion, chunk.id);
  const cached = await caches.default.match(cacheRequest);
  if (cached) {
    try {
      const bytes = await readExactChunk(cached, chunk.size, chunk.id);
      client.stats.cacheHits += 1;
      return bytes;
    } catch {
      await caches.default.delete(cacheRequest);
    }
  }

  client.stats.cacheMisses += 1;
  client.stats.chunkOriginFetches += 1;
  const response = await getStorageObject(client, chunkObjectKey(client.config, chunk.id));
  if (response.status === 404) {
    throw new Error('CAS chunk is missing from storage');
  }
  if (!response.ok || !response.body) {
    throw new Error(`CAS chunk storage request failed with ${response.status}`);
  }

  const bytes = await readExactChunk(response, chunk.size, chunk.id);
  const cacheWrite = caches.default
    .put(
      cacheRequest,
      new Response(bytes, {
        headers: {
          'cache-control': 'public, max-age=31536000, immutable',
          'content-length': chunk.size.toString(),
          'content-type': 'application/octet-stream',
          etag: `"${chunk.id}"`,
        },
      })
    )
    .catch((error: unknown) => {
      logError('delivery.cache_write_failed', {
        requestId,
        versionId,
        message: error instanceof Error ? error.message : 'Unknown cache write error',
      });
    });
  ctx.waitUntil(cacheWrite);
  return bytes;
}

function createDeliveryStream(input: {
  client: StorageClient;
  ctx: ExecutionContext;
  manifest: DeliveryManifest;
  range?: DeliveryRange;
  request: Request;
  requestId: string;
  versionId: string;
}): ReadableStream<Uint8Array> {
  const deliveryStart = input.range?.start ?? 0;
  const deliveryEnd = input.range?.end ?? input.manifest.totalSize - 1;
  let chunkIndex = 0;
  let chunkStart = 0;
  let settled = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (chunkIndex < input.manifest.chunks.length) {
          const chunk = input.manifest.chunks[chunkIndex];
          if (!chunk) {
            throw new Error('Delivery manifest chunk order changed during streaming');
          }
          chunkIndex += 1;
          const currentChunkStart = chunkStart;
          const chunkEnd = currentChunkStart + chunk.size - 1;
          chunkStart += chunk.size;
          if (chunkEnd < deliveryStart || currentChunkStart > deliveryEnd) {
            continue;
          }

          const bytes = await loadChunk(
            input.request,
            input.client,
            input.manifest,
            chunk,
            input.ctx,
            input.requestId,
            input.versionId
          );
          const sliceStart = Math.max(0, deliveryStart - currentChunkStart);
          const sliceEnd = Math.min(chunk.size, deliveryEnd - currentChunkStart + 1);
          const output = bytes.subarray(sliceStart, sliceEnd);
          input.client.stats.bytesDelivered += output.byteLength;
          controller.enqueue(output);
          return;
        }

        settled = true;
        controller.close();
        logEvent('delivery.completed', {
          requestId: input.requestId,
          versionId: input.versionId,
          ...input.client.stats,
          ranged: input.range !== undefined,
        });
      } catch (error) {
        settled = true;
        controller.error(error);
        logError('delivery.stream_failed', {
          requestId: input.requestId,
          versionId: input.versionId,
          ...input.client.stats,
          message: error instanceof Error ? error.message : 'Unknown streaming error',
        });
      }
    },
    cancel() {
      if (!settled) {
        logEvent('delivery.cancelled', {
          requestId: input.requestId,
          versionId: input.versionId,
          ...input.client.stats,
          ranged: input.range !== undefined,
        });
      }
    },
  });
}

function errorResponse(error: unknown, id: string): Response {
  const httpError = error instanceof HttpError ? error : new HttpError(500, 'Delivery failed');
  if (!(error instanceof HttpError)) {
    logError('delivery.request_failed', {
      requestId: id,
      message: error instanceof Error ? error.message : 'Unknown request error',
    });
  }
  return new Response(httpError.message, {
    status: httpError.status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      ...Object.fromEntries(new Headers(httpError.headers)),
    },
  });
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const id = requestId();
  try {
    if (request.method !== 'GET') {
      throw new HttpError(405, 'Method not allowed', { allow: 'GET' });
    }
    const url = new URL(request.url);
    const pathMatch = VERSION_PATH_PATTERN.exec(url.pathname);
    if (!pathMatch?.[1]) {
      throw new HttpError(404, 'Not found');
    }
    let versionId: string;
    try {
      versionId = decodeURIComponent(pathMatch[1]);
    } catch {
      throw new HttpError(403, 'Forbidden', { 'x-delivery-storage-fetches': '0' });
    }
    const exps = url.searchParams.getAll('exp');
    const signatures = url.searchParams.getAll('sig');
    const hmacKey = requireBinding(env, 'DELIVERY_HMAC_KEY');
    const authorized =
      exps.length === 1 &&
      signatures.length === 1 &&
      (await verifyDeliveryUrl({
        exp: exps[0] ?? '',
        key: hmacKey,
        sig: signatures[0] ?? '',
        versionId,
      }));
    if (!authorized) {
      throw new HttpError(403, 'Forbidden', { 'x-delivery-storage-fetches': '0' });
    }

    const stats: DeliveryStats = {
      bytesDelivered: 0,
      cacheHits: 0,
      cacheMisses: 0,
      chunkOriginFetches: 0,
      storageFetches: 0,
    };
    const config = loadStorageEnv(env);
    const client = createStorageClient(config, stats);
    const manifest = await loadManifest(client, versionId);
    if (manifest.chunks.length > MAX_DELIVERY_CHUNKS) {
      logError('delivery.chunk_ceiling_exceeded', {
        requestId: id,
        versionId,
        chunkCount: manifest.chunks.length,
        chunkCeiling: MAX_DELIVERY_CHUNKS,
      });
      throw new HttpError(
        422,
        `This file exceeds the ${MAX_DELIVERY_CHUNKS}-chunk delivery ceiling; use the importer path`
      );
    }

    const range = parseRange(request.headers.get('range'), manifest.totalSize);
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, manifest.totalSize - 1);
    const contentLength = manifest.totalSize === 0 ? 0 : end - start + 1;
    const source = createDeliveryStream({
      client,
      ctx,
      manifest,
      range,
      request,
      requestId: id,
      versionId,
    });
    const fixedLength = new FixedLengthStream(contentLength);
    const pipeline = source.pipeTo(fixedLength.writable).catch((error: unknown) => {
      logError('delivery.pipeline_failed', {
        requestId: id,
        versionId,
        message: error instanceof Error ? error.message : 'Unknown pipeline error',
      });
    });
    ctx.waitUntil(pipeline);

    const headers = new Headers({
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'content-type': manifest.contentType,
    });
    if (range) {
      headers.set('content-range', `bytes ${range.start}-${range.end}/${manifest.totalSize}`);
    }
    return new Response(fixedLength.readable, { headers, status: range ? 206 : 200 });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
