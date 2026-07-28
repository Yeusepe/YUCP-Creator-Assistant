import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { loadCasConfig } from './config';
import {
  putS3ObjectImmutable,
  putS3ObjectVersioned,
  resetConditionalWriteCapabilityForTests,
} from './s3Control';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetConditionalWriteCapabilityForTests();
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
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(null, {
        headers: { 'x-amz-version-id': 'version-replaceable' },
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
      fileIdentifier: 'version-replaceable',
      sha256: digest,
      versionId: 'version-replaceable',
    });
    expect(request?.headers.get('if-none-match')).toBeNull();
    expect(request?.headers.get('x-amz-meta-yucp-sha256')).toBe(digest);
  });

  it('returns the exact version created by a conditional immutable put', async () => {
    const body = Uint8Array.from([1, 2, 3, 4]);
    let request: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      request = new Request(input);
      return new Response(null, {
        headers: { 'x-amz-version-id': 'version-created' },
      });
    }) as unknown as typeof fetch;

    const result = await putS3ObjectImmutable({
      body,
      config: config(),
      contentType: 'application/octet-stream',
      key: 'v2/common/chunks/abcd',
    });

    expect(result).toEqual({
      bytes: body.byteLength,
      fileIdentifier: 'version-created',
      sha256: createHash('sha256').update(body).digest('hex'),
      status: 'created',
      versionId: 'version-created',
    });
    expect(request?.headers.get('if-none-match')).toBe('*');
    expect(request?.headers.get('x-amz-meta-yucp-sha256')).toBe(result.sha256);
  });

  it('adopts one byte-exact existing version and never reads the latest key', async () => {
    const body = Uint8Array.from([9, 8, 7]);
    const digest = createHash('sha256').update(body).digest('hex');
    const requests: Array<{ method: string; url: string }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const request = new Request(input);
      requests.push({ method: request.method, url: request.url });
      const url = new URL(request.url);
      if (request.method === 'PUT') {
        return new Response(null, { status: 412 });
      }
      if (url.searchParams.has('versions')) {
        return new Response(
          '<ListVersionsResult>' +
            '<IsTruncated>false</IsTruncated>' +
            '<Version>' +
            '<Key>v2/common/chunks/abcd</Key>' +
            '<VersionId>version-existing</VersionId>' +
            '<IsLatest>true</IsLatest>' +
            '<LastModified>2026-07-24T00:00:00.000Z</LastModified>' +
            '<Size>3</Size>' +
            '</Version>' +
            '</ListVersionsResult>'
        );
      }
      if (url.searchParams.get('versionId') === 'version-existing') {
        return new Response(body, {
          headers: {
            'content-length': String(body.byteLength),
            'content-type': 'application/octet-stream',
            'x-amz-meta-yucp-sha256': digest,
            'x-amz-version-id': 'version-existing',
          },
        });
      }
      throw new Error('Unexpected latest-key read');
    }) as unknown as typeof fetch;

    const result = await putS3ObjectImmutable({
      body,
      config: config(),
      contentType: 'application/octet-stream',
      key: 'v2/common/chunks/abcd',
    });

    expect(result.status).toBe('existing');
    expect(result.versionId).toBe('version-existing');
    expect(
      requests.some((entry) => {
        const url = new URL(entry.url);
        return (
          entry.method === 'GET' &&
          url.pathname.endsWith('/v2/common/chunks/abcd') &&
          url.search === ''
        );
      })
    ).toBeFalse();
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

  it('writes without the conditional header when the store answers 501', async () => {
    // Backblaze B2 does not implement If-None-Match and answers 501, which
    // aborted every package assembly with "PutObject failed with HTTP status
    // 501" after the upload had already been chunked.
    const body = Uint8Array.from([9, 9, 9]);
    const digest = createHash('sha256').update(body).digest('hex');
    const conditionalHeaders: (string | null)[] = [];

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const request = new Request(input);
      const url = new URL(request.url);
      if (request.method === 'PUT') {
        const ifNoneMatch = request.headers.get('if-none-match');
        conditionalHeaders.push(ifNoneMatch);
        if (ifNoneMatch) {
          return new Response(null, { status: 501 });
        }
        return new Response(null, { headers: { 'x-amz-version-id': 'plain-version' } });
      }
      if (url.searchParams.has('versions')) {
        return new Response(
          '<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>'
        );
      }
      throw new Error('Unexpected exact read');
    }) as unknown as typeof fetch;

    const result = await putS3ObjectImmutable({
      body,
      config: config(),
      contentType: 'application/octet-stream',
      key: 'v2/common/chunks/b2fallback',
    });

    expect(conditionalHeaders).toEqual(['*', null]);
    expect(result).toEqual({
      bytes: body.byteLength,
      fileIdentifier: 'plain-version',
      sha256: digest,
      status: 'created',
      versionId: 'plain-version',
    });
  });

  it('reuses the existing object when the store answers 501 and the bytes already match', async () => {
    const body = Uint8Array.from([9, 9, 9]);
    const digest = createHash('sha256').update(body).digest('hex');
    let plainPutCount = 0;

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const request = new Request(input);
      const url = new URL(request.url);
      if (request.method === 'PUT') {
        if (request.headers.get('if-none-match')) {
          return new Response(null, { status: 501 });
        }
        plainPutCount += 1;
        return new Response(null, { headers: { 'x-amz-version-id': 'unexpected' } });
      }
      if (url.searchParams.has('versions')) {
        return new Response(
          '<ListVersionsResult>' +
            '<IsTruncated>false</IsTruncated>' +
            '<Version><Key>v2/common/chunks/b2existing</Key><VersionId>existing</VersionId>' +
            '<IsLatest>true</IsLatest><LastModified>2026-07-24T00:00:00.000Z</LastModified>' +
            '<Size>3</Size></Version>' +
            '</ListVersionsResult>'
        );
      }
      return new Response(body, {
        headers: { 'x-amz-meta-yucp-sha256': digest, 'x-amz-version-id': 'existing' },
      });
    }) as unknown as typeof fetch;

    const result = await putS3ObjectImmutable({
      body,
      config: config(),
      contentType: 'application/octet-stream',
      key: 'v2/common/chunks/b2existing',
    });

    expect(plainPutCount).toBe(0);
    expect(result.status).toBe('existing');
    expect(result.versionId).toBe('existing');
  });
});
