import { verifyDpopProof } from '../../../ops/storage-core/dpop';
import { BoundedDpopReplayCache } from '../../../ops/storage-core/dpopReplayCache';
import {
  type DeliveryGrantV2,
  type MaterializationReceiptV2,
  packageContractKeyId,
  verifyDeliveryGrantV2,
  verifyMaterializationReceiptV2,
} from '../../../ops/storage-core/packageContractsV2';
import { fetchWithSlowDownBackoff } from '../../../ops/storage-core/storageBackoff';

// Cloudflare recommends streamed responses and bounded request bodies.
// Reference: https://developers.cloudflare.com/workers/platform/limits/

const REQUIRED_BINDINGS = [
  'PACKAGE_DELIVERY_AUDIENCE',
  'PACKAGE_INSTALL_ISSUER',
  'PACKAGE_INSTALL_SIGNING_KEY_ID',
  'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY',
  'RENDITION_RECEIPT_KEY_ID',
  'RENDITION_RECEIPT_PUBLIC_KEY',
  'MATERIALIZER_ORIGIN_URL',
  'MATERIALIZER_RENDITION_SHARED_SECRET',
] as const;
const RENDITION_PATH = /^\/v2\/renditions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_GRANT_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const ORIGIN_HEADER_TIMEOUT_MS = 30 * 1_000;
const MAX_DPOP_REPLAY_ENTRIES = 8_192;
const DPOP_REPLAY_SWEEP_LIMIT = 128;
const DPOP_REPLAY_WINDOW_MS = 5 * 60 * 1_000;
// This bounded module cache is same-isolate abuse detection, not cross-region security truth.
const dpopReplayCache = new BoundedDpopReplayCache({
  maxEntries: MAX_DPOP_REPLAY_ENTRIES,
  sweepLimit: DPOP_REPLAY_SWEEP_LIMIT,
});

type BindingName = (typeof REQUIRED_BINDINGS)[number];
type RenditionEnv = Readonly<Record<BindingName, string>>;
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

function loadEnv(env: Env): RenditionEnv {
  const values = Object.fromEntries(
    REQUIRED_BINDINGS.map((name) => [name, requireBinding(env, name)])
  ) as Record<BindingName, string>;
  let origin: URL;
  try {
    origin = new URL(values.MATERIALIZER_ORIGIN_URL);
  } catch {
    throw new HttpError(500, 'Materializer origin configuration is invalid');
  }
  // HTTP is limited to loopback development origins.
  const loopbackHttp =
    origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (
    (origin.protocol !== 'https:' && !loopbackHttp) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new HttpError(500, 'Materializer origin configuration is invalid');
  }
  return { ...values, MATERIALIZER_ORIGIN_URL: origin.origin };
}

function decodeBase64Url(value: string, name: string): Uint8Array {
  if (!value || !BASE64URL.test(value)) {
    throw new HttpError(403, `${name} is invalid`);
  }
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new HttpError(403, `${name} is invalid`);
  }
}

function parseAuthorization(request: Request): {
  grant: string;
  proof: string;
} {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^DPoP ([A-Za-z0-9_-]+)$/.exec(authorization);
  const proof = request.headers.get('dpop') ?? '';
  if (!match?.[1] || match[1].length > MAX_GRANT_BYTES || !proof || proof.length > 8_192) {
    throw new HttpError(403, 'Forbidden');
  }
  return { grant: match[1], proof };
}

async function authorize(input: {
  config: RenditionEnv;
  jobId: string;
  request: Request;
}): Promise<{ grant: DeliveryGrantV2 }> {
  const { grant, proof } = parseAuthorization(input.request);
  const verifiedProof = await verifyDpopProof({
    accessToken: grant,
    method: input.request.method,
    proof,
    url: input.request.url,
  });
  const verifiedGrant = await verifyDeliveryGrantV2({
    context: {
      audience: input.config.PACKAGE_DELIVERY_AUDIENCE,
      deviceKeyThumbprint: verifiedProof.thumbprint,
      issuer: input.config.PACKAGE_INSTALL_ISSUER,
      now: Math.floor(Date.now() / 1_000),
      requiredScope: `materialization:${input.jobId}:read`,
    },
    coseSign1: decodeBase64Url(grant, 'Delivery grant'),
    expectedKeyId: packageContractKeyId(input.config.PACKAGE_INSTALL_SIGNING_KEY_ID),
    publicKey: decodeBase64Url(
      input.config.PACKAGE_INSTALL_SIGNING_PUBLIC_KEY,
      'Package install public key'
    ),
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
  return {
    grant: verifiedGrant,
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function readReceipt(request: Request): Promise<string> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content type is invalid');
  }
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)
  ) {
    throw new HttpError(413, 'Request body is too large');
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new HttpError(400, 'Request body is required');
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      received += value.byteLength;
      if (received > MAX_REQUEST_BYTES) {
        throw new HttpError(413, 'Request body is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const encoded = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded));
  } catch {
    throw new HttpError(400, 'Request body is invalid');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).join(',') !== 'receipt'
  ) {
    throw new HttpError(400, 'Request body is invalid');
  }
  const receipt = Reflect.get(parsed, 'receipt');
  if (
    typeof receipt !== 'string' ||
    !receipt ||
    receipt.length > MAX_REQUEST_BYTES ||
    !BASE64URL.test(receipt)
  ) {
    throw new HttpError(400, 'Receipt is invalid');
  }
  return receipt;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

export async function fetchWithResponseHeaderTimeout(
  fetchFn: FetchFn,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Response header timeout is invalid');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(input, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function validateReceipt(input: {
  grant: DeliveryGrantV2;
  jobId: string;
  receipt: MaterializationReceiptV2;
}): void {
  const now = Math.floor(Date.now() / 1_000);
  const rendition = input.receipt.rendition;
  if (
    input.receipt.grantId !== input.grant.grantId ||
    input.receipt.jobId !== input.jobId ||
    input.receipt.creatorId !== input.grant.creatorId ||
    input.receipt.productId !== input.grant.productId ||
    !bytesEqual(input.receipt.releaseRoot, input.grant.releaseRoot) ||
    input.receipt.issuedAt > now + 60 ||
    input.receipt.expiresAt < now ||
    input.receipt.expiresAt - input.receipt.issuedAt > 30 * 24 * 60 * 60 ||
    rendition.fileIdentifier !== `${input.jobId}.zip` ||
    rendition.objectSha256.byteLength !== 32 ||
    !Number.isSafeInteger(rendition.objectBytes) ||
    rendition.objectBytes <= 0
  ) {
    throw new HttpError(403, 'Receipt binding is invalid');
  }
}

async function getExactRendition(
  config: RenditionEnv,
  jobId: string,
  offset: number
): Promise<Response> {
  try {
    return await fetchWithSlowDownBackoff(() =>
      fetchWithResponseHeaderTimeout(
        fetch,
        `${config.MATERIALIZER_ORIGIN_URL}/v2/internal/rendition-files/${jobId}`,
        {
          headers: {
            'x-yucp-rendition-secret': config.MATERIALIZER_RENDITION_SHARED_SECRET,
            ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
          },
          method: 'GET',
        },
        ORIGIN_HEADER_TIMEOUT_MS
      )
    );
  } catch {
    // Persistent origin failures are outages, not authorization denials.
    throw new HttpError(502, 'Rendition origin request failed', 1);
  }
}

function resumeOffset(request: Request, objectBytes: number): number {
  const range = request.headers.get('range');
  if (!range) {
    return 0;
  }
  const match = /^bytes=([1-9]\d*)-$/.exec(range);
  if (!match?.[1]) {
    throw new HttpError(416, 'Rendition range is invalid');
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset >= objectBytes) {
    throw new HttpError(416, 'Rendition range is invalid');
  }
  return offset;
}

function noStoreResponse(
  body: BodyInit | null,
  status: number,
  storageFetches: number,
  headers?: HeadersInit
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('cache-control', 'private, no-store');
  responseHeaders.set('x-rendition-storage-fetches', String(storageFetches));
  return new Response(body, {
    headers: responseHeaders,
    status,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let storageFetches = 0;
    try {
      const config = loadEnv(env);
      const pathMatch = RENDITION_PATH.exec(new URL(request.url).pathname);
      if (!pathMatch?.[1]) {
        throw new HttpError(404, 'Not found');
      }
      if (request.method !== 'POST') {
        throw new HttpError(405, 'Method not allowed');
      }
      const authorization = await authorize({
        config,
        jobId: pathMatch[1],
        request,
      });
      const encodedReceipt = await readReceipt(request);
      const receipt = await verifyMaterializationReceiptV2({
        coseSign1: decodeBase64Url(encodedReceipt, 'Materialization receipt'),
        expectedKeyId: packageContractKeyId(config.RENDITION_RECEIPT_KEY_ID),
        publicKey: decodeBase64Url(
          config.RENDITION_RECEIPT_PUBLIC_KEY,
          'Materialization receipt public key'
        ),
      });
      validateReceipt({
        grant: authorization.grant,
        jobId: pathMatch[1],
        receipt,
      });
      const offset = resumeOffset(request, receipt.rendition.objectBytes);
      const origin = await getExactRendition(config, pathMatch[1], offset);
      storageFetches = 1;
      const expectedStatus = offset > 0 ? 206 : 200;
      if (origin.status !== expectedStatus || !origin.body) {
        throw new HttpError(502, 'Rendition origin request failed', 1);
      }
      const contentLength = Number(origin.headers.get('content-length'));
      const expectedLength = receipt.rendition.objectBytes - offset;
      const expectedContentRange =
        offset > 0
          ? `bytes ${offset}-${receipt.rendition.objectBytes - 1}/${receipt.rendition.objectBytes}`
          : null;
      // Integrity is enforced by the buyer client's full-file hash against the receipt.
      if (
        contentLength !== expectedLength ||
        (offset > 0 && origin.headers.get('content-range') !== expectedContentRange) ||
        origin.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
          'application/zip'
      ) {
        throw new HttpError(502, 'Rendition exact-version metadata failed', 1);
      }
      return noStoreResponse(origin.body, expectedStatus, 1, {
        'accept-ranges': 'bytes',
        'content-length': String(expectedLength),
        'content-type': 'application/zip',
        ...(expectedContentRange ? { 'content-range': expectedContentRange } : {}),
        'x-yucp-receipt-id': receipt.receiptId,
      });
    } catch (error) {
      const httpError =
        error instanceof HttpError ? error : new HttpError(403, 'Forbidden', storageFetches);
      return noStoreResponse(
        httpError.status === 403 ? 'Forbidden' : httpError.message,
        httpError.status,
        httpError.storageFetches
      );
    }
  },
} satisfies ExportedHandler<Env>;
