import { createHash, timingSafeEqual } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
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
  method: 'DELETE' | 'GET' | 'PUT';
  operation: string;
  key?: string;
  query?: Record<string, string>;
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
    retries: 2,
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
 *
 * Object Lock must be enabled when older S3-compatible providers cannot enable it later.
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
}): Promise<S3ExactObjectVersion> {
  const body =
    typeof input.body === 'string'
      ? Uint8Array.from(Buffer.from(input.body))
      : Uint8Array.from(input.body);
  return exactVersionFromResponse(
    await signedRequest({
      body,
      config: input.config,
      headers: {
        'content-type': input.contentType,
      },
      key: input.key,
      method: 'PUT',
      operation: 'PutObject',
    })
  );
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
 * Conditional PutObject reference:
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
 */
export async function putS3ObjectImmutable(input: {
  body: Uint8Array | string;
  config: CasConfig;
  contentType: string;
  key: string;
}): Promise<'created' | 'existing'> {
  const body =
    typeof input.body === 'string'
      ? Uint8Array.from(Buffer.from(input.body))
      : Uint8Array.from(input.body);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await signedRequest({
      allowedStatuses: [409, 412],
      body,
      config: input.config,
      headers: {
        'content-type': input.contentType,
        'if-none-match': '*',
      },
      key: input.key,
      method: 'PUT',
      operation: 'PutObject',
    });
    if (response.ok) {
      return 'created';
    }
    if (response.status === 409) {
      continue;
    }

    const existingResponse = await getS3Object(input.config, input.key);
    const existing = new Uint8Array(await existingResponse.arrayBuffer());
    if (existing.byteLength !== body.byteLength) {
      throw new Error('Immutable S3 object exists with different bytes');
    }
    if (body.byteLength > 0 && !timingSafeEqual(Buffer.from(existing), Buffer.from(body))) {
      throw new Error('Immutable S3 object exists with different bytes');
    }
    return 'existing';
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
