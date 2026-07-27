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
  it('uploads bounded parts and returns the exact completed object version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-s3-multipart-'));
    try {
      const bytes = Buffer.alloc(6 * 1024 * 1024, 0x4a);
      const path = join(root, 'raw.bin');
      await writeFile(path, bytes);
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
          return new Response('<CompleteMultipartUploadResult/>', {
            headers: { 'x-amz-version-id': 'exact-version-1' },
          });
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
        fileIdentifier: 'exact-version-1',
        multipart: true,
        parts: 2,
        versionId: 'exact-version-1',
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
