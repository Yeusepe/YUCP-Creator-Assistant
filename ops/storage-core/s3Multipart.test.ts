import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCasConfig } from './config';
import { putS3FileVersioned, S3MultipartCompletionUncertainError } from './s3Control';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('S3 multipart file upload', () => {
  it('uploads bounded parts and identifies the object by its multipart ETag, never the version-id header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-s3-multipart-'));
    try {
      const bytes = Buffer.alloc(6 * 1024 * 1024, 0x4a);
      const path = join(root, 'raw.bin');
      await writeFile(path, bytes);
      const multipartEtag = '0f343b0931126a20f133d67c2b018a3b-2';
      const requests: Array<{ bytes: number; method: string; url: string }> = [];
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const request = new Request(input);
        const body = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
        requests.push({
          bytes: body.byteLength,
          method: request.method,
          url: request.url,
        });
        const url = new URL(request.url);
        if (request.method === 'POST' && url.searchParams.has('uploads')) {
          return new Response(
            '<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>'
          );
        }
        if (request.method === 'PUT') {
          return new Response(null, {
            headers: { etag: `"part-${url.searchParams.get('partNumber')}"` },
          });
        }
        if (request.method === 'POST' && url.searchParams.has('uploadId')) {
          // R2 shape: a decorative x-amz-version-id header beside the real ETag.
          return new Response(
            '<CompleteMultipartUploadResult>' +
              `<ETag>&quot;${multipartEtag}&quot;</ETag>` +
              '</CompleteMultipartUploadResult>',
            { headers: { 'x-amz-version-id': 'decorative-r2-version-id' } }
          );
        }
        throw new Error('Unexpected S3 request');
      }) as unknown as typeof fetch;

      const result = await putS3FileVersioned({
        config: loadCasConfig({
          CAS_S3_ACCESS_KEY_ID: 'test-access',
          CAS_S3_BUCKET: 'quarantine',
          CAS_S3_ENDPOINT: 'https://s3.example.test',
          CAS_S3_REGION: 'us-east-1',
          CAS_S3_SECRET_ACCESS_KEY: 'test-secret',
        }),
        contentType: 'application/octet-stream',
        expectedBytes: bytes.byteLength,
        expectedSha256: createHash('sha256').update(bytes).digest('hex'),
        key: 'raw/version-1/package.bin',
        partBytes: 5 * 1024 * 1024,
        path,
      });

      expect(result).toEqual({
        fileIdentifier: multipartEtag,
        multipart: true,
        parts: 2,
        versionId: multipartEtag,
      });
      expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT', 'PUT', 'POST']);
      expect(requests.map((request) => request.bytes)).toEqual([
        0,
        5 * 1024 * 1024,
        1024 * 1024,
        239,
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('returns the completion ETag as the exact version when the store has no versioning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-s3-multipart-'));
    try {
      const bytes = Buffer.alloc(6 * 1024 * 1024, 0x4a);
      const path = join(root, 'raw.bin');
      await writeFile(path, bytes);
      const multipartEtag = '9b2cf535f27731c974343645a3985328-2';
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const request = new Request(input);
        const url = new URL(request.url);
        if (request.method === 'POST' && url.searchParams.has('uploads')) {
          return new Response(
            '<InitiateMultipartUploadResult><UploadId>upload-2</UploadId></InitiateMultipartUploadResult>'
          );
        }
        if (request.method === 'PUT') {
          return new Response(null, {
            headers: { etag: `"part-${url.searchParams.get('partNumber')}"` },
          });
        }
        if (request.method === 'POST' && url.searchParams.has('uploadId')) {
          return new Response(
            '<CompleteMultipartUploadResult>' +
              `<ETag>&quot;${multipartEtag}&quot;</ETag>` +
              '</CompleteMultipartUploadResult>'
          );
        }
        throw new Error('Unexpected S3 request');
      }) as unknown as typeof fetch;

      const result = await putS3FileVersioned({
        config: loadCasConfig({
          CAS_S3_ACCESS_KEY_ID: 'test-access',
          CAS_S3_BUCKET: 'quarantine',
          CAS_S3_ENDPOINT: 'https://s3.example.test',
          CAS_S3_REGION: 'us-east-1',
          CAS_S3_SECRET_ACCESS_KEY: 'test-secret',
        }),
        contentType: 'application/octet-stream',
        expectedBytes: bytes.byteLength,
        expectedSha256: createHash('sha256').update(bytes).digest('hex'),
        key: 'raw/version-1/package.bin',
        partBytes: 5 * 1024 * 1024,
        path,
      });

      expect(result).toEqual({
        fileIdentifier: multipartEtag,
        multipart: true,
        parts: 2,
        versionId: multipartEtag,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('reports uncertain completion without aborting an upload that might exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-s3-multipart-'));
    try {
      const bytes = Buffer.alloc(6 * 1024 * 1024, 0x5b);
      const path = join(root, 'raw.bin');
      await writeFile(path, bytes);
      const methods: string[] = [];
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const request = new Request(input);
        methods.push(request.method);
        const url = new URL(request.url);
        if (request.method === 'POST' && url.searchParams.has('uploads')) {
          return new Response(
            '<InitiateMultipartUploadResult><UploadId>upload-uncertain</UploadId></InitiateMultipartUploadResult>'
          );
        }
        if (request.method === 'PUT') {
          return new Response(null, { headers: { etag: '"part"' } });
        }
        if (request.method === 'POST') {
          throw new TypeError('connection closed');
        }
        return new Response(null);
      }) as unknown as typeof fetch;

      await expect(
        putS3FileVersioned({
          config: loadCasConfig({
            CAS_S3_ACCESS_KEY_ID: 'test-access',
            CAS_S3_BUCKET: 'quarantine',
            CAS_S3_ENDPOINT: 'https://s3.example.test',
            CAS_S3_REGION: 'us-east-1',
            CAS_S3_SECRET_ACCESS_KEY: 'test-secret',
          }),
          contentType: 'application/octet-stream',
          expectedBytes: bytes.byteLength,
          expectedSha256: createHash('sha256').update(bytes).digest('hex'),
          key: 'raw/version-1/package.bin',
          partBytes: 5 * 1024 * 1024,
          path,
        })
      ).rejects.toBeInstanceOf(S3MultipartCompletionUncertainError);
      expect(methods).not.toContain('DELETE');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
