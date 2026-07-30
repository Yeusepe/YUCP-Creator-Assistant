import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { loadCasConfig } from './config';
import { putS3ObjectImmutable, putS3ObjectVersioned } from './s3Control';

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

describe('S3 immutable exact versions', () => {
  it('creates a replaceable exact version with verifiable content metadata', async () => {
    const body = Uint8Array.from([4, 3, 2, 1]);
    const digest = createHash('sha256').update(body).digest('hex');
    const bodyMd5 = createHash('md5').update(body).digest('hex');
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(null, {
        headers: { etag: `"${bodyMd5}"`, 'x-amz-version-id': 'ignored-version' },
      });
    }) as unknown as typeof fetch;

    const result = await putS3ObjectVersioned({
      body,
      config: config(),
      contentType: 'application/json',
      key: 'v2/metadata/tuf/package-installer/metadata/timestamp.json',
    });

    expect(result).toEqual({
      bytes: body.byteLength,
      fileIdentifier: bodyMd5,
      sha256: digest,
      versionId: bodyMd5,
    });
    expect(request?.headers.get('if-none-match')).toBeNull();
    expect(request?.headers.get('x-amz-meta-yucp-sha256')).toBe(digest);
  });

  it('fails closed when an immutable key has multiple physical versions', async () => {
    const body = Uint8Array.from([5, 4, 3]);
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const request = new Request(input);
      const url = new URL(request.url);
      if (request.method === 'PUT') {
        return new Response(null, { status: 412 });
      }
      if (url.searchParams.has('versions')) {
        return new Response(
          '<ListVersionsResult>' +
            '<IsTruncated>false</IsTruncated>' +
            '<Version><Key>v2/common/chunks/abcd</Key><VersionId>one</VersionId>' +
            '<IsLatest>true</IsLatest><LastModified>2026-07-24T00:00:00.000Z</LastModified>' +
            '<Size>3</Size></Version>' +
            '<Version><Key>v2/common/chunks/abcd</Key><VersionId>two</VersionId>' +
            '<IsLatest>false</IsLatest><LastModified>2026-07-23T00:00:00.000Z</LastModified>' +
            '<Size>3</Size></Version>' +
            '</ListVersionsResult>'
        );
      }
      throw new Error('Unexpected exact read');
    }) as unknown as typeof fetch;

    await expect(
      putS3ObjectImmutable({
        body,
        config: config(),
        contentType: 'application/octet-stream',
        key: 'v2/common/chunks/abcd',
      })
    ).rejects.toThrow('multiple physical versions');
  });

  it('mints the ETag identity when the store has no versioning', async () => {
    const body = Uint8Array.from([1, 2, 3, 4]);
    const bodyMd5 = createHash('md5').update(body).digest('hex');
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(null, { headers: { etag: `"${bodyMd5}"` } });
    }) as unknown as typeof fetch;

    const result = await putS3ObjectImmutable({
      body,
      config: config(),
      contentType: 'application/octet-stream',
      key: 'v2/common/chunks/abcd',
    });

    expect(result).toEqual({
      bytes: body.byteLength,
      fileIdentifier: bodyMd5,
      sha256: createHash('sha256').update(body).digest('hex'),
      status: 'created',
      versionId: bodyMd5,
      writeProven: true,
    });
    expect(request?.headers.get('if-none-match')).toBe('*');
  });

  it('fails closed when the write ETag does not match the body MD5', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(null, { headers: { etag: '"cccccccccccccccccccccccccccccccc"' } });
    }) as unknown as typeof fetch;

    await expect(
      putS3ObjectImmutable({
        body: Uint8Array.from([1, 2, 3, 4]),
        config: config(),
        contentType: 'application/octet-stream',
        key: 'v2/common/chunks/abcd',
      })
    ).rejects.toThrow('does not match the body MD5');
  });

  it('adopts one byte-exact existing ETag version when ListObjectVersions is unimplemented', async () => {
    const body = Uint8Array.from([9, 8, 7]);
    const bodyMd5 = createHash('md5').update(body).digest('hex');
    const digest = createHash('sha256').update(body).digest('hex');
    const objectHeaders = {
      'content-length': String(body.byteLength),
      'content-type': 'application/octet-stream',
      etag: `"${bodyMd5}"`,
      'x-amz-meta-yucp-sha256': digest,
    };
    const gets: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const request = new Request(input);
      const url = new URL(request.url);
      if (request.method === 'PUT') {
        return new Response(null, { status: 412 });
      }
      if (url.searchParams.has('versions')) {
        return new Response(null, { status: 501 });
      }
      if (url.searchParams.get('list-type') === '2') {
        return new Response(
          '<ListBucketResult>' +
            '<IsTruncated>false</IsTruncated>' +
            '<Contents>' +
            '<Key>v2/common/chunks/abcd</Key>' +
            '<Size>3</Size>' +
            '<LastModified>2026-07-24T00:00:00.000Z</LastModified>' +
            '</Contents>' +
            '</ListBucketResult>'
        );
      }
      if (request.method === 'HEAD') {
        return new Response(null, { headers: objectHeaders });
      }
      gets.push(request.headers.get('if-match') ?? '');
      return new Response(body, { headers: objectHeaders });
    }) as unknown as typeof fetch;

    const result = await putS3ObjectImmutable({
      body,
      config: config(),
      contentType: 'application/octet-stream',
      key: 'v2/common/chunks/abcd',
    });

    expect(result.status).toBe('existing');
    expect(result.versionId).toBe(bodyMd5);
    expect(result.fileIdentifier).toBe(bodyMd5);
    expect(gets).toEqual([`"${bodyMd5}"`]);
  });
});
