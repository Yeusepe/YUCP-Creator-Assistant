import { createHash, createHmac } from 'node:crypto';
import type { CasConfig } from './config';

export type S3Object = {
  key: string;
  size: number;
};

type SignedRequestInput = {
  config: CasConfig;
  method: 'DELETE' | 'GET' | 'PUT';
  operation: string;
  key?: string;
  query?: Record<string, string>;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalPath(config: CasConfig, key?: string): string {
  const segments = [config.bucket, ...(key === undefined ? [] : key.split('/'))];
  return `/${segments.map(encodeRfc3986).join('/')}`;
}

function canonicalQuery(query: Record<string, string> | undefined): string {
  return Object.entries(query ?? {})
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

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
 * Minimal S3 control-plane request signing used only for bucket setup, object inventory, and smoke
 * cleanup. Artifact chunks and indexes are transferred by desync itself.
 *
 * AWS Signature V4: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */
async function signedRequest(input: SignedRequestInput): Promise<Response> {
  const endpoint = new URL(input.config.endpoint);
  const path = canonicalPath(input.config, input.key);
  const query = canonicalQuery(input.query);
  const url = new URL(endpoint.origin);
  url.pathname = path;
  url.search = query;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = amzDate.slice(0, 8);
  const payloadHash = sha256('');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [
    input.method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${shortDate}/${input.config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${input.config.secretAccessKey}`, shortDate);
  const regionKey = hmac(dateKey, input.config.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const response = await fetch(url, {
    method: input.method,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${input.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
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
