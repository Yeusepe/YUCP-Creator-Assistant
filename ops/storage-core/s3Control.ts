import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { AwsClient, AwsV4Signer } from 'aws4fetch';
import type { CasConfig } from './config';
import { buildS3ObjectUrl } from './s3ObjectUrl';

export { buildS3ObjectUrl } from './s3ObjectUrl';

export type S3Object = {
  key: string;
  size: number;
};

export type S3ObjectMetadata = S3Object & {
  lastModified: Date;
};

export interface S3ObjectPage {
  nextContinuationToken?: string;
  objects: S3ObjectMetadata[];
}

export interface S3ObjectVersion extends S3ObjectMetadata {
  deleteMarker: boolean;
  isLatest: boolean;
  versionId: string;
}

type SignedRequestInput = {
  allowedStatuses?: readonly number[];
  body?: BodyInit;
  config: CasConfig;
  headers?: HeadersInit;
  method: 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT';
  operation: string;
  key?: string;
  query?: Record<string, string>;
  retries?: number;
};

function xmlDecode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16))
    )
    .replace(/&#([0-9]+);/g, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10))
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * S3 requests are signed by the pinned aws4fetch dependency. Artifact chunks are transferred by
 * desync itself.
 *
 * AWS Signature V4: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 * AWS S3 retry guidance:
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-design-patterns.html
 */
async function signedRequest(input: SignedRequestInput): Promise<Response> {
  const url = buildS3ObjectUrl(input.config, input.key);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const client = new AwsClient({
    accessKeyId: input.config.accessKeyId,
    secretAccessKey: input.config.secretAccessKey,
    region: input.config.region,
    service: 's3',
    retries: input.retries ?? 2,
  });
  const response = await client.fetch(url, {
    body: input.body,
    headers: input.headers,
    method: input.method,
    signal: AbortSignal.timeout(input.config.requestTimeoutMs),
  });
  if (!response.ok && !input.allowedStatuses?.includes(response.status)) {
    throw new Error(`S3 ${input.operation} failed with HTTP status ${response.status}`);
  }
  return response;
}

/**
 * CreateBucket reference: https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html
 * PutBucketVersioning reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketVersioning.html
 *
 * Object Lock must be enabled when older S3-compatible providers cannot enable it later.
 * Every created bucket enables and verifies versioning before this function returns.
 */
export async function createS3Bucket(
  config: CasConfig,
  options: { objectLockEnabled?: boolean } = {}
): Promise<void> {
  await signedRequest({
    config,
    headers: options.objectLockEnabled
      ? {
          'x-amz-bucket-object-lock-enabled': 'true',
        }
      : undefined,
    method: 'PUT',
    operation: 'CreateBucket',
  });
  await enableS3BucketVersioning(config);
  if ((await getS3BucketVersioning(config)) !== 'Enabled') {
    throw new Error('S3 bucket versioning was not enabled after bucket creation');
  }
}

/**
 * PutBucketVersioning reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketVersioning.html
 */
export async function enableS3BucketVersioning(config: CasConfig): Promise<void> {
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    '<Status>Enabled</Status>' +
    '</VersioningConfiguration>';
  await signedRequest({
    body,
    config,
    headers: {
      'content-md5': createHash('md5').update(body).digest('base64'),
      'content-type': 'application/xml',
    },
    method: 'PUT',
    operation: 'PutBucketVersioning',
    query: { versioning: '' },
  });
}

/**
 * GetBucketVersioning reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketVersioning.html
 */
export async function getS3BucketVersioning(config: CasConfig): Promise<'Enabled' | 'Suspended'> {
  const response = await signedRequest({
    config,
    method: 'GET',
    operation: 'GetBucketVersioning',
    query: { versioning: '' },
  });
  const xml = await response.text();
  const status = xml.match(/<Status>(Enabled|Suspended)<\/Status>/)?.[1];
  if (status !== 'Enabled' && status !== 'Suspended') {
    throw new Error('S3 GetBucketVersioning returned no supported status');
  }
  return status;
}

/**
 * GetObjectLockConfiguration reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectLockConfiguration.html
 */
export async function getS3ObjectLockConfiguration(config: CasConfig): Promise<'Enabled'> {
  const response = await signedRequest({
    config,
    method: 'GET',
    operation: 'GetObjectLockConfiguration',
    query: { 'object-lock': '' },
  });
  const xml = await response.text();
  if (!/<ObjectLockEnabled>Enabled<\/ObjectLockEnabled>/.test(xml)) {
    throw new Error('S3 GetObjectLockConfiguration returned no enabled state');
  }
  return 'Enabled';
}

/** GetObject reference: https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html */
export async function getS3Object(config: CasConfig, key: string): Promise<Response> {
  return signedRequest({ config, key, method: 'GET', operation: 'GetObject' });
}

/** PutObject reference: https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html */
export async function putS3Object(input: {
  body: Uint8Array | string;
  config: CasConfig;
  contentType: string;
  key: string;
}): Promise<void> {
  const body =
    typeof input.body === 'string'
      ? Uint8Array.from(Buffer.from(input.body))
      : Uint8Array.from(input.body);
  await signedRequest({
    body,
    config: input.config,
    headers: {
      'content-type': input.contentType,
    },
    key: input.key,
    method: 'PUT',
    operation: 'PutObject',
  });
}

export type S3ExactObjectVersion = {
  fileIdentifier: string;
  versionId: string;
};

export type S3ExactFileVersion = S3ExactObjectVersion & {
  multipart: boolean;
  parts: number;
};

export type S3ImmutableObjectVersion = S3ExactObjectVersion & {
  bytes: number;
  sha256: string;
  status: 'created' | 'existing';
};

export type S3VersionedObjectVersion = S3ExactObjectVersion & {
  bytes: number;
  sha256: string;
};

export type S3ObjectRetention = {
  mode: 'COMPLIANCE' | 'GOVERNANCE';
  retainUntil: Date;
};

export class S3MultipartCompletionUncertainError extends Error {
  override readonly name = 'S3MultipartCompletionUncertainError';

  constructor(
    readonly key: string,
    readonly uploadId: string,
    options?: ErrorOptions
  ) {
    super('S3 multipart completion has an uncertain result', options);
  }
}

export type S3PutObjectUploadTicket = {
  headers: Record<string, string>;
  url: string;
};

export type S3ExactObjectHead = S3ExactObjectVersion & {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  metadata: Record<string, string>;
};

function exactVersionFromResponse(response: Response): S3ExactObjectVersion {
  const versionId = response.headers.get('x-amz-version-id')?.trim();
  if (!versionId || versionId === 'null') {
    throw new Error('S3 versioned object response omitted its exact version identifier');
  }
  return {
    fileIdentifier: versionId,
    versionId,
  };
}

/**
 * PutObject response reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
 */
export async function putS3ObjectVersioned(input: {
  body: Uint8Array | string;
  config: CasConfig;
  contentType: string;
  key: string;
}): Promise<S3VersionedObjectVersion> {
  const body =
    typeof input.body === 'string'
      ? Uint8Array.from(Buffer.from(input.body))
      : Uint8Array.from(input.body);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const version = exactVersionFromResponse(
    await signedRequest({
      body,
      config: input.config,
      headers: {
        'content-type': input.contentType,
        'x-amz-meta-yucp-sha256': sha256,
      },
      key: input.key,
      method: 'PUT',
      operation: 'PutObject',
    })
  );
  return {
    ...version,
    bytes: body.byteLength,
    sha256,
  };
}

function xmlEncode(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function readExactFilePart(input: {
  length: number;
  offset: number;
  path: string;
}): Promise<Uint8Array> {
  const handle = await open(input.path, 'r');
  try {
    const bytes = Buffer.allocUnsafe(input.length);
    let position = 0;
    while (position < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        position,
        bytes.byteLength - position,
        input.offset + position
      );
      if (result.bytesRead === 0) {
        throw new Error('S3 multipart source file ended before the declared length');
      }
      position += result.bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

async function abortS3MultipartUpload(input: {
  config: CasConfig;
  key: string;
  uploadId: string;
}): Promise<void> {
  await signedRequest({
    config: input.config,
    key: input.key,
    method: 'DELETE',
    operation: 'AbortMultipartUpload',
    query: { uploadId: input.uploadId },
    retries: 0,
  });
}

/**
 * Uploads one bounded local file and returns its exact S3 object version.
 *
 * S3 multipart operations:
 * https://www.backblaze.com/docs/cloud-storage-api-operations
 */
export async function putS3FileVersioned(input: {
  config: CasConfig;
  contentType: string;
  expectedBytes: number;
  expectedSha256: string;
  key: string;
  partBytes?: number;
  path: string;
}): Promise<S3ExactFileVersion> {
  const partBytes = input.partBytes ?? 100 * 1024 * 1024;
  if (
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes < 0 ||
    !/^[0-9a-f]{64}$/.test(input.expectedSha256) ||
    !Number.isSafeInteger(partBytes) ||
    partBytes < 5 * 1024 * 1024 ||
    partBytes > 5 * 1024 * 1024 * 1024
  ) {
    throw new Error('S3 file upload bounds are invalid');
  }
  const details = await stat(input.path);
  if (!details.isFile() || details.size !== input.expectedBytes) {
    throw new Error('S3 file upload source length is invalid');
  }
  if ((await sha256File(input.path)) !== input.expectedSha256) {
    throw new Error('S3 file upload source digest is invalid');
  }
  if (input.expectedBytes <= partBytes) {
    const bytes = new Uint8Array(await readFile(input.path));
    const version = exactVersionFromResponse(
      await signedRequest({
        body: bytes,
        config: input.config,
        headers: {
          'content-length': String(bytes.byteLength),
          'content-type': input.contentType,
          'x-amz-content-sha256': input.expectedSha256,
          'x-amz-meta-yucp-sha256': input.expectedSha256,
        },
        key: input.key,
        method: 'PUT',
        operation: 'PutObject',
      })
    );
    return { ...version, multipart: false, parts: 1 };
  }

  const initiated = await signedRequest({
    config: input.config,
    headers: {
      'content-type': input.contentType,
      'x-amz-meta-yucp-sha256': input.expectedSha256,
    },
    key: input.key,
    method: 'POST',
    operation: 'CreateMultipartUpload',
    query: { uploads: '' },
    retries: 0,
  });
  const initiatedXml = await initiated.text();
  const encodedUploadId = initiatedXml.match(/<UploadId>([\s\S]*?)<\/UploadId>/)?.[1];
  if (!encodedUploadId) {
    throw new Error('S3 multipart initiation omitted its upload identifier');
  }
  const uploadId = xmlDecode(encodedUploadId);
  const completedParts: Array<{ etag: string; number: number }> = [];
  let completionStarted = false;
  try {
    for (
      let offset = 0, partNumber = 1;
      offset < input.expectedBytes;
      offset += partBytes, partNumber += 1
    ) {
      const length = Math.min(partBytes, input.expectedBytes - offset);
      const bytes = await readExactFilePart({
        length,
        offset,
        path: input.path,
      });
      const response = await signedRequest({
        body: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer,
        config: input.config,
        headers: {
          'content-length': String(bytes.byteLength),
          'content-md5': createHash('md5').update(bytes).digest('base64'),
        },
        key: input.key,
        method: 'PUT',
        operation: 'UploadPart',
        query: {
          partNumber: String(partNumber),
          uploadId,
        },
      });
      const etag = response.headers.get('etag')?.trim();
      if (!etag) {
        throw new Error('S3 multipart part response omitted its ETag');
      }
      completedParts.push({ etag, number: partNumber });
    }
    const body =
      '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      completedParts
        .map(
          (part) =>
            `<Part><PartNumber>${part.number}</PartNumber>` +
            `<ETag>${xmlEncode(part.etag)}</ETag></Part>`
        )
        .join('') +
      '</CompleteMultipartUpload>';
    completionStarted = true;
    let completed: Response;
    try {
      completed = await signedRequest({
        body,
        config: input.config,
        headers: {
          'content-md5': createHash('md5').update(body).digest('base64'),
          'content-type': 'application/xml',
        },
        key: input.key,
        method: 'POST',
        operation: 'CompleteMultipartUpload',
        query: { uploadId },
        retries: 0,
      });
    } catch (error) {
      throw new S3MultipartCompletionUncertainError(input.key, uploadId, {
        cause: error,
      });
    }
    const completedXml = await completed.text();
    if (/<Error(?:\s|>)/.test(completedXml)) {
      throw new S3MultipartCompletionUncertainError(input.key, uploadId);
    }
    return {
      ...exactVersionFromResponse(completed),
      multipart: true,
      parts: completedParts.length,
    };
  } catch (error) {
    if (completionStarted || error instanceof S3MultipartCompletionUncertainError) {
      throw error;
    }
    try {
      await abortS3MultipartUpload({
        config: input.config,
        key: input.key,
        uploadId,
      });
    } catch (abortError) {
      throw new AggregateError(
        [error, abortError],
        'S3 multipart upload and cancellation both failed'
      );
    }
    throw error;
  }
}

/**
 * GetObject versionId reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
 */
export async function getS3ObjectVersion(
  config: CasConfig,
  key: string,
  versionId: string
): Promise<Response> {
  if (!versionId.trim()) {
    throw new Error('S3 exact version identifier must not be empty');
  }
  const response = await signedRequest({
    config,
    key,
    method: 'GET',
    operation: 'GetObjectVersion',
    query: { versionId },
  });
  const returnedVersion = exactVersionFromResponse(response);
  if (returnedVersion.versionId !== versionId) {
    throw new Error('S3 exact-version read returned a different object version');
  }
  return response;
}

/**
 * HeadObject versionId reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
 */
export async function headS3ObjectVersion(
  config: CasConfig,
  key: string,
  versionId: string
): Promise<S3ExactObjectHead> {
  if (!versionId.trim()) {
    throw new Error('S3 exact version identifier must not be empty');
  }
  const response = await signedRequest({
    config,
    key,
    method: 'HEAD',
    operation: 'HeadObjectVersion',
    query: { versionId },
  });
  const returnedVersion = exactVersionFromResponse(response);
  if (returnedVersion.versionId !== versionId) {
    throw new Error('S3 exact-version head returned a different object version');
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new Error('S3 exact-version head returned an invalid content length');
  }
  const metadata: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (name.startsWith('x-amz-meta-')) {
      metadata[name.slice('x-amz-meta-'.length)] = value;
    }
  }
  return {
    ...returnedVersion,
    contentLength,
    contentType: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    metadata,
  };
}

function copySourceHeader(input: { bucket: string; key: string; versionId: string }): string {
  if (!input.bucket.trim() || !input.key || !input.versionId.trim()) {
    throw new Error('S3 exact copy source is invalid');
  }
  const bucket = encodeURIComponent(input.bucket);
  const key = input.key.split('/').map(encodeURIComponent).join('/');
  return `/${bucket}/${key}?versionId=${encodeURIComponent(input.versionId)}`;
}

/**
 * CopyObject exact-version reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
 */
export async function copyS3ObjectVersion(input: {
  destination: CasConfig;
  destinationKey: string;
  source: CasConfig;
  sourceKey: string;
  sourceVersionId: string;
}): Promise<S3ExactObjectVersion> {
  if (
    input.destination.endpoint !== input.source.endpoint ||
    input.destination.region !== input.source.region
  ) {
    throw new Error('S3 exact copy requires one provider endpoint and region');
  }
  const response = await signedRequest({
    config: input.destination,
    headers: {
      'x-amz-copy-source': copySourceHeader({
        bucket: input.source.bucket,
        key: input.sourceKey,
        versionId: input.sourceVersionId,
      }),
      'x-amz-metadata-directive': 'COPY',
    },
    key: input.destinationKey,
    method: 'PUT',
    operation: 'CopyObjectVersion',
    retries: 0,
  });
  const body = await response.text();
  if (/<Error(?:\s|>)/.test(body)) {
    throw new Error('S3 exact copy returned an embedded error');
  }
  const copiedSourceVersion = response.headers.get('x-amz-copy-source-version-id')?.trim();
  if (copiedSourceVersion !== input.sourceVersionId) {
    throw new Error('S3 exact copy used a different source version');
  }
  return exactVersionFromResponse(response);
}

/**
 * GetObjectRetention reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectRetention.html
 */
export async function getS3ObjectRetention(
  config: CasConfig,
  key: string,
  versionId: string
): Promise<S3ObjectRetention> {
  if (!versionId.trim()) {
    throw new Error('S3 retention version identifier must not be empty');
  }
  const response = await signedRequest({
    config,
    key,
    method: 'GET',
    operation: 'GetObjectRetention',
    query: { retention: '', versionId },
  });
  const xml = await response.text();
  const mode = xml.match(/<Mode>(GOVERNANCE|COMPLIANCE)<\/Mode>/)?.[1];
  const retainedUntil = xml.match(/<RetainUntilDate>([\s\S]*?)<\/RetainUntilDate>/)?.[1];
  const retainUntil = new Date(retainedUntil ? xmlDecode(retainedUntil) : '');
  if ((mode !== 'GOVERNANCE' && mode !== 'COMPLIANCE') || Number.isNaN(retainUntil.getTime())) {
    throw new Error('S3 object retention response is invalid');
  }
  return { mode, retainUntil };
}

/**
 * DeleteObject exact-version reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html
 */
export async function deleteS3ObjectVersion(
  config: CasConfig,
  key: string,
  versionId: string
): Promise<void> {
  if (!versionId.trim()) {
    throw new Error('S3 deletion version identifier must not be empty');
  }
  await signedRequest({
    config,
    key,
    method: 'DELETE',
    operation: 'DeleteObjectVersion',
    query: { versionId },
    retries: 0,
  });
}

/**
 * A presigned PUT gives one data node bounded write access without storage credentials.
 *
 * AWS presigned upload reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
 * Backblaze B2 S3-compatible presigned URL support:
 * https://www.backblaze.com/docs/cloud-storage-s3-compatible-api
 * aws4fetch query-signing reference:
 * https://github.com/mhart/aws4fetch#new-awsv4signeroptions
 */
export async function createS3PutObjectUploadTicket(input: {
  bytes: number;
  config: CasConfig;
  contentType: string;
  expiresSeconds: number;
  key: string;
  now?: Date;
  sha256Hex: string;
}): Promise<S3PutObjectUploadTicket> {
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 5 * 1024 ** 3) {
    throw new Error('S3 upload ticket byte length is invalid');
  }
  if (
    !Number.isSafeInteger(input.expiresSeconds) ||
    input.expiresSeconds < 1 ||
    input.expiresSeconds > 900
  ) {
    throw new Error('S3 upload ticket expiry is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256Hex)) {
    throw new Error('S3 upload ticket digest is invalid');
  }
  if (!input.contentType.trim() || input.contentType.length > 255) {
    throw new Error('S3 upload ticket content type is invalid');
  }
  const url = buildS3ObjectUrl(input.config, input.key);
  url.searchParams.set('X-Amz-Expires', String(input.expiresSeconds));
  const requiredHeaders = new Headers({
    'content-length': String(input.bytes),
    'content-type': input.contentType,
    'x-amz-content-sha256': input.sha256Hex,
    'x-amz-meta-yucp-sha256': input.sha256Hex,
  });
  const signer = new AwsV4Signer({
    accessKeyId: input.config.accessKeyId,
    allHeaders: true,
    datetime: (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, ''),
    headers: requiredHeaders,
    method: 'PUT',
    region: input.config.region,
    secretAccessKey: input.config.secretAccessKey,
    service: 's3',
    signQuery: true,
    url: url.toString(),
  });
  const signed = await signer.sign();
  return {
    headers: Object.fromEntries(signed.headers),
    url: signed.url.toString(),
  };
}

/**
 * Conditional PutObject reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
 */
export async function putS3ObjectImmutable(input: {
  body: Uint8Array | string;
  config: CasConfig;
  contentType: string;
  key: string;
}): Promise<S3ImmutableObjectVersion> {
  const body =
    typeof input.body === 'string'
      ? Uint8Array.from(Buffer.from(input.body))
      : Uint8Array.from(input.body);
  const sha256 = createHash('sha256').update(body).digest('hex');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await signedRequest({
      allowedStatuses: [409, 412],
      body,
      config: input.config,
      headers: {
        'content-type': input.contentType,
        'if-none-match': '*',
        'x-amz-meta-yucp-sha256': sha256,
      },
      key: input.key,
      method: 'PUT',
      operation: 'PutObject',
    });
    if (response.ok) {
      return {
        ...exactVersionFromResponse(response),
        bytes: body.byteLength,
        sha256,
        status: 'created',
      };
    }
    if (response.status === 409) {
      continue;
    }

    const versions = (await listS3ObjectVersions(input.config, input.key)).filter(
      (version) => !version.deleteMarker && version.key === input.key
    );
    if (versions.length !== 1) {
      throw new Error(
        versions.length === 0
          ? 'Immutable S3 object has no physical version'
          : 'Immutable S3 object has multiple physical versions'
      );
    }
    const existingVersion = versions[0];
    const existingResponse = await getS3ObjectVersion(
      input.config,
      input.key,
      existingVersion.versionId
    );
    if (existingResponse.headers.get('x-amz-meta-yucp-sha256') !== sha256) {
      throw new Error('Immutable S3 object exists with different digest metadata');
    }
    const existing = new Uint8Array(await existingResponse.arrayBuffer());
    if (existing.byteLength !== body.byteLength) {
      throw new Error('Immutable S3 object exists with different bytes');
    }
    if (body.byteLength > 0 && !timingSafeEqual(Buffer.from(existing), Buffer.from(body))) {
      throw new Error('Immutable S3 object exists with different bytes');
    }
    return {
      bytes: body.byteLength,
      fileIdentifier: existingVersion.versionId,
      sha256,
      status: 'existing',
      versionId: existingVersion.versionId,
    };
  }

  throw new Error('Immutable S3 object write remained in conflict');
}

/**
 * ListObjectsV2 reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
 */
export async function listS3Objects(config: CasConfig, prefix?: string): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let continuationToken: string | undefined;

  do {
    const query: Record<string, string> = { 'list-type': '2' };
    if (prefix) {
      query.prefix = prefix;
    }
    if (continuationToken) {
      query['continuation-token'] = continuationToken;
    }
    const response = await signedRequest({
      config,
      method: 'GET',
      operation: 'ListObjectsV2',
      query,
    });
    const xml = await response.text();
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const content = match[1] ?? '';
      const key = content.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      const size = content.match(/<Size>(\d+)<\/Size>/)?.[1];
      if (key === undefined || size === undefined) {
        throw new Error('S3 ListObjectsV2 returned an invalid object entry');
      }
      objects.push({ key: xmlDecode(key), size: Number(size) });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const nextToken = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
    if (truncated && !nextToken) {
      throw new Error('S3 ListObjectsV2 omitted its continuation token');
    }
    continuationToken = truncated && nextToken ? xmlDecode(nextToken) : undefined;
  } while (continuationToken);

  return objects;
}

/**
 * ListObjectVersions reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html
 */
export async function listS3ObjectVersions(
  config: CasConfig,
  prefix?: string
): Promise<S3ObjectVersion[]> {
  const versions: S3ObjectVersion[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  do {
    const query: Record<string, string> = { versions: '' };
    if (prefix) {
      query.prefix = prefix;
    }
    if (keyMarker) {
      query['key-marker'] = keyMarker;
    }
    if (versionIdMarker) {
      query['version-id-marker'] = versionIdMarker;
    }
    const response = await signedRequest({
      config,
      method: 'GET',
      operation: 'ListObjectVersions',
      query,
    });
    const xml = await response.text();
    for (const match of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
      const deleteMarker = match[1] === 'DeleteMarker';
      const content = match[2] ?? '';
      const key = content.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      const versionId = content.match(/<VersionId>([\s\S]*?)<\/VersionId>/)?.[1];
      const isLatest = content.match(/<IsLatest>(true|false)<\/IsLatest>/)?.[1];
      const lastModified = content.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
      const size = deleteMarker ? '0' : content.match(/<Size>(\d+)<\/Size>/)?.[1];
      if (
        key === undefined ||
        versionId === undefined ||
        isLatest === undefined ||
        lastModified === undefined ||
        size === undefined
      ) {
        throw new Error('S3 ListObjectVersions returned an invalid version entry');
      }
      const parsedLastModified = new Date(xmlDecode(lastModified));
      const parsedSize = Number(size);
      if (
        !Number.isSafeInteger(parsedSize) ||
        parsedSize < 0 ||
        Number.isNaN(parsedLastModified.getTime())
      ) {
        throw new Error('S3 ListObjectVersions returned invalid version metadata');
      }
      versions.push({
        deleteMarker,
        isLatest: isLatest === 'true',
        key: xmlDecode(key),
        lastModified: parsedLastModified,
        size: parsedSize,
        versionId: xmlDecode(versionId),
      });
    }

    const truncatedMatch = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/);
    if (!truncatedMatch) {
      throw new Error('S3 ListObjectVersions omitted its IsTruncated value');
    }
    if (truncatedMatch[1] !== 'true') {
      keyMarker = undefined;
      versionIdMarker = undefined;
      continue;
    }
    const nextKeyMarker = xml.match(/<NextKeyMarker>([\s\S]*?)<\/NextKeyMarker>/)?.[1];
    const nextVersionIdMarker = xml.match(
      /<NextVersionIdMarker>([\s\S]*?)<\/NextVersionIdMarker>/
    )?.[1];
    if (!nextKeyMarker || !nextVersionIdMarker) {
      throw new Error('S3 ListObjectVersions omitted its continuation markers');
    }
    keyMarker = xmlDecode(nextKeyMarker);
    versionIdMarker = xmlDecode(nextVersionIdMarker);
  } while (keyMarker);

  return versions;
}

/**
 * Bounded ListObjectsV2 page with the object age metadata needed by maintenance operations.
 * Existing callers of listS3Objects retain their current all-pages behavior and return shape.
 *
 * ListObjectsV2 reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
 */
export async function listS3ObjectPage(
  config: CasConfig,
  input: {
    continuationToken?: string;
    maxKeys: number;
    prefix: string;
  }
): Promise<S3ObjectPage> {
  if (!Number.isSafeInteger(input.maxKeys) || input.maxKeys <= 0 || input.maxKeys > 1000) {
    throw new RangeError('S3 ListObjectsV2 maxKeys must be an integer from 1 through 1000');
  }

  const query: Record<string, string> = {
    'list-type': '2',
    'max-keys': String(input.maxKeys),
    prefix: input.prefix,
  };
  if (input.continuationToken) {
    query['continuation-token'] = input.continuationToken;
  }
  const response = await signedRequest({
    config,
    method: 'GET',
    operation: 'ListObjectsV2',
    query,
  });
  const xml = await response.text();
  const objects: S3ObjectMetadata[] = [];

  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const content = match[1] ?? '';
    const key = content.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const size = content.match(/<Size>(\d+)<\/Size>/)?.[1];
    const lastModified = content.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
    if (key === undefined || size === undefined || lastModified === undefined) {
      throw new Error('S3 ListObjectsV2 returned an invalid object metadata entry');
    }

    const parsedSize = Number(size);
    const parsedLastModified = new Date(xmlDecode(lastModified));
    if (
      !Number.isSafeInteger(parsedSize) ||
      parsedSize < 0 ||
      Number.isNaN(parsedLastModified.getTime())
    ) {
      throw new Error('S3 ListObjectsV2 returned invalid object size or LastModified metadata');
    }
    objects.push({
      key: xmlDecode(key),
      size: parsedSize,
      lastModified: parsedLastModified,
    });
  }

  const truncatedMatch = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/);
  if (!truncatedMatch) {
    throw new Error('S3 ListObjectsV2 omitted its IsTruncated value');
  }
  const truncated = truncatedMatch[1] === 'true';
  const nextToken = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
  if (truncated && !nextToken) {
    throw new Error('S3 ListObjectsV2 omitted its continuation token');
  }

  return {
    objects,
    nextContinuationToken: truncated && nextToken ? xmlDecode(nextToken) : undefined,
  };
}

/**
 * DeleteObject reference: https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html
 *
 * Backblaze exact-version reference: https://www.backblaze.com/apidocs/s3-delete-object
 */
export async function deleteS3Objects(config: CasConfig, keys: string[]): Promise<number> {
  const pending = [...keys];
  const workers = Array.from({ length: Math.min(10, pending.length) }, async () => {
    while (pending.length > 0) {
      const key = pending.shift();
      if (key === undefined) {
        return;
      }
      const versions = (await listS3ObjectVersions(config, key)).filter(
        (version) => version.key === key
      );
      if (versions.length === 0) {
        continue;
      }
      if (versions.some((version) => version.versionId === 'null')) {
        await signedRequest({ config, method: 'DELETE', operation: 'DeleteObject', key });
      }
      for (const version of versions) {
        if (version.versionId === 'null') {
          continue;
        }
        await signedRequest({
          config,
          key,
          method: 'DELETE',
          operation: 'DeleteObjectVersion',
          query: { versionId: version.versionId },
        });
      }
    }
  });
  await Promise.all(workers);
  return keys.length;
}
