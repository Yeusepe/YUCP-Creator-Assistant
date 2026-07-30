import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { loadCasConfig } from './config';
import { createS3Bucket, putS3ObjectImmutable } from './s3Control';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config() {
  return loadCasConfig({
    CAS_S3_ACCESS_KEY_ID: 'test-access',
    CAS_S3_BUCKET: 'common',
    CAS_S3_ENDPOINT: 'https://s3.example.test',
    CAS_S3_REGION: 'us-east-1',
    CAS_S3_SECRET_ACCESS_KEY: 'test-secret',
  });
}

describe('S3 bucket lifecycle', () => {
  it('creates a bucket without requiring provider versioning support', async () => {
    const body = Uint8Array.from([1, 2, 3, 4]);
    const bodyMd5 = createHash('md5').update(body).digest('hex');
    const operations: string[] = [];

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.searchParams.has('versioning') || url.searchParams.has('object-lock')) {
        throw new Error('Unexpected versioning or Object Lock configuration call');
      }
      if (url.pathname.endsWith('/v2/common/chunks/abcd')) {
        operations.push('immutable-put');
        return new Response(null, { headers: { etag: `"${bodyMd5}"` } });
      }
      operations.push('create-bucket');
      return new Response(null);
    }) as unknown as typeof fetch;

    const bucketConfig = config();
    await createS3Bucket(bucketConfig);
    const stored = await putS3ObjectImmutable({
      body,
      config: bucketConfig,
      contentType: 'application/octet-stream',
      key: 'v2/common/chunks/abcd',
    });

    expect(stored.versionId).toBe(bodyMd5);
    expect(stored.fileIdentifier).toBe(bodyMd5);
    expect(operations).toEqual(['create-bucket', 'immutable-put']);
  });
});
