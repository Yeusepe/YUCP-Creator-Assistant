import { afterEach, describe, expect, it, mock } from 'bun:test';
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
  it('enables and verifies versioning before the first immutable object write', async () => {
    const operations: string[] = [];
    let versioningEnabled = false;

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.searchParams.has('versioning')) {
        if (request.method === 'PUT') {
          operations.push('enable-versioning');
          versioningEnabled = true;
          return new Response(null);
        }
        operations.push('verify-versioning');
        return new Response(
          versioningEnabled
            ? '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'
            : '<VersioningConfiguration></VersioningConfiguration>'
        );
      }

      if (url.pathname.endsWith('/v2/common/chunks/abcd')) {
        operations.push('immutable-put');
        return new Response(null, {
          headers: versioningEnabled ? { 'x-amz-version-id': 'version-created' } : undefined,
        });
      }

      operations.push('create-bucket');
      return new Response(null);
    }) as unknown as typeof fetch;

    const bucketConfig = config();
    await createS3Bucket(bucketConfig);
    const stored = await putS3ObjectImmutable({
      body: Uint8Array.from([1, 2, 3, 4]),
      config: bucketConfig,
      contentType: 'application/octet-stream',
      key: 'v2/common/chunks/abcd',
    });

    expect(stored.versionId).toBe('version-created');
    expect(operations).toEqual([
      'create-bucket',
      'enable-versioning',
      'verify-versioning',
      'immutable-put',
    ]);
  });
});
