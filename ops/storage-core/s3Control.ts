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

type SignedRequestInput = {
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
 * S3 requests are signed by the pinned aws4fetch dependency. Artifact chunks and binary indexes
 * are transferred by desync itself.
 *
 * AWS Signature V4: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
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
    retries: 0,
  });
  const response = await client.fetch(url, {
    body: input.body,
    headers: input.headers,
    method: input.method,
  });
  if (!response.ok) {
    throw new Error(`S3 ${input.operation} failed with HTTP status ${response.status}`);
  }
  return response;
}

/** Create the throwaway MinIO bucket used by the local integration test. */
export async function createS3Bucket(config: CasConfig): Promise<void> {
  await signedRequest({ config, method: 'PUT', operation: 'CreateBucket' });
}

/** GetObject reference: https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html */
export async function getS3Object(config: CasConfig, key: string): Promise<Response> {
  return signedRequest({ config, key, method: 'GET', operation: 'GetObject' });
}

/** PutObject reference: https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html */
export async function putS3Object(input: {
  body: BodyInit;
  config: CasConfig;
  contentType: string;
  key: string;
}): Promise<void> {
  await signedRequest({
    body: input.body,
    config: input.config,
    headers: { 'content-type': input.contentType },
    key: input.key,
    method: 'PUT',
    operation: 'PutObject',
  });
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
 */
export async function deleteS3Objects(config: CasConfig, keys: string[]): Promise<number> {
  const pending = [...keys];
  const workers = Array.from({ length: Math.min(10, pending.length) }, async () => {
    while (pending.length > 0) {
      const key = pending.shift();
      if (key === undefined) {
        return;
      }
      await signedRequest({ config, method: 'DELETE', operation: 'DeleteObject', key });
    }
  });
  await Promise.all(workers);
  return keys.length;
}
