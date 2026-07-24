import { AwsClient } from 'aws4fetch';
import { verifyDpopProof } from '../../../ops/storage-core/dpop';
import {
  packageContractKeyId,
  verifyDeliveryGrantV2,
  verifyMaterializationReceiptV2,
  type DeliveryGrantV2,
  type MaterializationReceiptV2,
} from '../../../ops/storage-core/packageContractsV2';
import { buildS3ObjectUrl } from '../../../ops/storage-core/s3ObjectUrl';

// Cloudflare recommends streamed responses and bounded request bodies.
// Reference: https://developers.cloudflare.com/workers/platform/limits/

const REQUIRED_BINDINGS = [
  'PACKAGE_DELIVERY_AUDIENCE',
  'PACKAGE_INSTALL_ISSUER',
  'PACKAGE_INSTALL_SIGNING_KEY_ID',
  'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY',
  'RENDITION_RECEIPT_KEY_ID',
  'RENDITION_RECEIPT_PUBLIC_KEY',
  'RENDITION_S3_BUCKET',
  'RENDITION_S3_ENDPOINT',
  'RENDITION_S3_READONLY_ACCESS_KEY_ID',
  'RENDITION_S3_READONLY_SECRET_ACCESS_KEY',
  'RENDITION_S3_REGION',
] as const;
const RENDITION_PATH =
  /^\/v2\/renditions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_GRANT_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const ORIGIN_TIMEOUT_MS = 5 * 60 * 1_000;

type BindingName = (typeof REQUIRED_BINDINGS)[number];
type RenditionEnv = Readonly<Record<BindingName, string>>;

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
  const endpoint = new URL(values.RENDITION_S3_ENDPOINT);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    values.RENDITION_S3_BUCKET.includes('/') ||
    values.RENDITION_S3_BUCKET.includes('\\')
  ) {
    throw new HttpError(500, 'Rendition storage configuration is invalid');
  }
  return { ...values, RENDITION_S3_ENDPOINT: endpoint.origin };
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
  if (
    !match?.[1] ||
    match[1].length > MAX_GRANT_BYTES ||
    !proof ||
    proof.length > 8_192
  ) {
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
  return {
    grant: await verifyDeliveryGrantV2({
      context: {
        audience: input.config.PACKAGE_DELIVERY_AUDIENCE,
        deviceKeyThumbprint: verifiedProof.thumbprint,
        issuer: input.config.PACKAGE_INSTALL_ISSUER,
        now: Math.floor(Date.now() / 1_000),
        requiredScope: `materialization:${input.jobId}:read`,
      },
      coseSign1: decodeBase64Url(grant, 'Delivery grant'),
      expectedKeyId: packageContractKeyId(
        input.config.PACKAGE_INSTALL_SIGNING_KEY_ID
      ),
      publicKey: decodeBase64Url(
        input.config.PACKAGE_INSTALL_SIGNING_PUBLIC_KEY,
        'Package install public key'
      ),
    }),
  };
}

async function readReceipt(request: Request): Promise<string> {
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  ) {
    throw new HttpError(415, 'Content type is invalid');
  }
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_REQUEST_BYTES)
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
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function validateReceipt(input: {
  config: RenditionEnv;
  grant: DeliveryGrantV2;
  jobId: string;
  receipt: MaterializationReceiptV2;
}): void {
  const now = Math.floor(Date.now() / 1_000);
  const rendition = input.receipt.rendition;
  const objectSegments = rendition.objectKey.split('/');
  if (
    input.receipt.grantId !== input.grant.grantId ||
    input.receipt.jobId !== input.jobId ||
    input.receipt.creatorId !== input.grant.creatorId ||
    input.receipt.productId !== input.grant.productId ||
    !bytesEqual(input.receipt.releaseRoot, input.grant.releaseRoot) ||
    input.receipt.issuedAt > now + 60 ||
    input.receipt.expiresAt < now ||
    input.receipt.expiresAt - input.receipt.issuedAt > 30 * 24 * 60 * 60 ||
    rendition.storageRole !== 'renditions' ||
    rendition.bucketName !== input.config.RENDITION_S3_BUCKET ||
    !rendition.objectKey.startsWith('v2/renditions/') ||
    rendition.objectKey.includes('\\') ||
    objectSegments.some(
      (segment) => !segment || segment === '.' || segment === '..'
    ) ||
    !rendition.providerVersion ||
    rendition.providerVersion.length > 512
  ) {
    throw new HttpError(403, 'Receipt binding is invalid');
  }
}

function createStorageClient(config: RenditionEnv): AwsClient {
  return new AwsClient({
    accessKeyId: config.RENDITION_S3_READONLY_ACCESS_KEY_ID,
    secretAccessKey: config.RENDITION_S3_READONLY_SECRET_ACCESS_KEY,
    region: config.RENDITION_S3_REGION,
    service: 's3',
    retries: 0,
  });
}

async function getExactRendition(
  client: AwsClient,
  config: RenditionEnv,
  receipt: MaterializationReceiptV2
): Promise<Response> {
  const objectUrl = new URL(
    buildS3ObjectUrl(
      {
        bucket: config.RENDITION_S3_BUCKET,
        endpoint: config.RENDITION_S3_ENDPOINT,
      },
      receipt.rendition.objectKey
    )
  );
  objectUrl.searchParams.set('versionId', receipt.rendition.providerVersion);
  return client.fetch(objectUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
  });
}

function noStoreResponse(
  body: BodyInit | null,
  status: number,
  storageFetches: number,
  headers?: HeadersInit
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('cache-control', 'private, no-store');
  responseHeaders.set(
    'x-rendition-storage-fetches',
    String(storageFetches)
  );
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
        config,
        grant: authorization.grant,
        jobId: pathMatch[1],
        receipt,
      });
      const origin = await getExactRendition(
        createStorageClient(config),
        config,
        receipt
      );
      storageFetches = 1;
      if (!origin.ok || !origin.body) {
        throw new HttpError(502, 'Rendition storage request failed', 1);
      }
      const contentLength = Number(origin.headers.get('content-length'));
      const metadataDigest = origin.headers.get('x-amz-meta-yucp-sha256');
      const providerVersion = origin.headers.get('x-amz-version-id');
      if (
        contentLength !== receipt.rendition.objectBytes ||
        metadataDigest !==
          Array.from(receipt.rendition.objectSha256, (byte) =>
            byte.toString(16).padStart(2, '0')
          ).join('') ||
        (providerVersion &&
          providerVersion !== receipt.rendition.providerVersion) ||
        origin.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase() !== 'application/zip'
      ) {
        throw new HttpError(502, 'Rendition exact-version metadata failed', 1);
      }
      return noStoreResponse(origin.body, 200, 1, {
        'content-length': String(receipt.rendition.objectBytes),
        'content-type': 'application/zip',
        'x-yucp-receipt-id': receipt.receiptId,
      });
    } catch (error) {
      const httpError =
        error instanceof HttpError
          ? error
          : new HttpError(403, 'Forbidden', storageFetches);
      return noStoreResponse(
        httpError.status === 403 ? 'Forbidden' : httpError.message,
        httpError.status,
        httpError.storageFetches
      );
    }
  },
} satisfies ExportedHandler<Env>;
