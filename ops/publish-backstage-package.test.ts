import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, ReadStream, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TusUploadOptions = {
  endpoint?: string;
  metadata?: Record<string, string>;
  uploadSize?: number;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

const tusUploadCalls: Array<{ source: unknown; options: TusUploadOptions }> = [];

mock.module('tus-js-client', () => ({
  Upload: class {
    readonly options: TusUploadOptions;
    readonly url = 'https://ingest.test/files/job_123';

    constructor(source: unknown, options: TusUploadOptions) {
      this.options = options;
      tusUploadCalls.push({ source, options });
    }

    start(): void {
      this.options.onSuccess?.();
    }
  },
}));

import {
  printUsage,
  publishBackstagePackage,
  resolvePublishBackstagePackageConfig,
} from './publish-backstage-package';

type FetchCall = {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal?: AbortSignal | null;
};

function createFetch(
  calls: FetchCall[],
  releaseResult: Record<string, unknown>,
  tusEndpoint = 'https://ingest.test/files',
  jobResponses: Array<Record<string, unknown> | Error> = [
    { state: 'processing' },
    { state: 'completed', result: 'signed-ingest-result' },
  ]
): typeof fetch {
  let jobResponseIndex = 0;
  return async (input, init) => {
    const request = new Request(input, init);
    const call = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      signal: init?.signal,
    };
    calls.push(call);

    if (call.url.endsWith('/api/packages/com.yucp.example/backstage/upload-authorization')) {
      return Response.json({
        tusEndpoint,
        uploadToken: 'upload-token',
        uploadMetadataKey: 'backstageUploadToken',
        maxByteSize: 1024,
      });
    }
    if (call.url === 'https://ingest.test/jobs/job_123') {
      const response = jobResponses[jobResponseIndex];
      jobResponseIndex += 1;
      if (!response) {
        throw new Error('Unexpected extra ingest job poll');
      }
      if (response instanceof Error) {
        throw response;
      }
      return Response.json(response);
    }
    if (call.url.endsWith('/api/packages/com.yucp.example/backstage/releases')) {
      return new Response(JSON.stringify(releaseResult), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${call.url}`);
  };
}

describe('publish-backstage-package', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    for (const { source } of tusUploadCalls) {
      if (source instanceof ReadStream) {
        source.destroy();
      }
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    tusUploadCalls.length = 0;
  });

  it('authorizes a resumable upload, polls its ingest job, and publishes the release', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.zip');
    writeFileSync(sourcePath, Buffer.from('zip-bytes'));

    const calls: FetchCall[] = [];
    const result = await publishBackstagePackage(
      {
        apiBaseUrl: 'https://api.test',
        accessToken: 'oauth-token',
        packageId: 'com.yucp.example',
        catalogProductId: 'product_123',
        version: '1.2.3',
        sourcePath,
      },
      createFetch(calls, {
        deliveryPackageReleaseId: 'release_1',
        artifactId: 'artifact_1',
        artifactKey: 'backstage-package:com.yucp.example',
        zipSha256: 'a'.repeat(64),
        version: '1.2.3',
        channel: 'stable',
      })
    );

    expect(result).toEqual({
      deliveryPackageReleaseId: 'release_1',
      artifactId: 'artifact_1',
      artifactKey: 'backstage-package:com.yucp.example',
      zipSha256: 'a'.repeat(64),
      version: '1.2.3',
      channel: 'stable',
    });
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toBe(
      'https://api.test/api/packages/com.yucp.example/backstage/upload-authorization'
    );
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('authorization')).toBe('Bearer oauth-token');
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0].body)).toEqual({
      version: '1.2.3',
      deliveryName: 'example.zip',
      sourceContentType: 'application/zip',
      sha256: createHash('sha256').update('zip-bytes').digest('hex'),
      byteSize: 9,
    });

    expect(tusUploadCalls).toHaveLength(1);
    expect(tusUploadCalls[0].options.endpoint).toBe('https://ingest.test/files');
    expect(tusUploadCalls[0].options.metadata).toEqual({
      backstageUploadToken: 'upload-token',
    });
    expect(tusUploadCalls[0].source).toBeInstanceOf(ReadStream);
    expect(Buffer.isBuffer(tusUploadCalls[0].source)).toBe(false);
    expect((tusUploadCalls[0].source as ReadStream).path).toBe(sourcePath);
    expect(tusUploadCalls[0].options.uploadSize).toBe(9);

    for (const pollCall of calls.slice(1, 3)) {
      expect(pollCall.url).toBe('https://ingest.test/jobs/job_123');
      expect(pollCall.method).toBe('GET');
      expect(pollCall.headers.get('authorization')).toBe('Bearer upload-token');
      expect(pollCall.body).toBe('');
    }

    expect(calls[3].url).toBe('https://api.test/api/packages/com.yucp.example/backstage/releases');
    expect(calls[3].method).toBe('POST');
    expect(calls[3].headers.get('authorization')).toBe('Bearer oauth-token');
    expect(calls[3].headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[3].body)).toEqual({
      catalogProductId: 'product_123',
      ingestResult: 'signed-ingest-result',
      version: '1.2.3',
      deliveryName: 'example.zip',
      sourceContentType: 'application/zip',
    });
  });

  it('rejects a public plaintext HTTP TUS endpoint before uploading the signed token', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.zip');
    writeFileSync(sourcePath, Buffer.from('zip-bytes'));

    const calls: FetchCall[] = [];
    await expect(
      publishBackstagePackage(
        {
          apiBaseUrl: 'https://api.test',
          accessToken: 'oauth-token',
          packageId: 'com.yucp.example',
          catalogProductId: 'product_123',
          version: '1.2.3',
          sourcePath,
        },
        createFetch(calls, {}, 'http://public.example.com/files')
      )
    ).rejects.toThrow('tusEndpoint must use HTTPS');
    expect(calls).toHaveLength(1);
    expect(tusUploadCalls).toHaveLength(0);
  });

  it('requires a sourcePath because new Backstage package files cannot be reused from Convex storage', () => {
    expect(() =>
      resolvePublishBackstagePackageConfig(
        [
          '--packageId',
          'com.yucp.example',
          '--catalogProductId',
          'product_123',
          '--version',
          '1.2.3',
        ],
        {
          YUCP_API_BASE_URL: 'https://api.test',
          YUCP_ACCESS_TOKEN: 'oauth-token',
        } as NodeJS.ProcessEnv
      )
    ).toThrow('sourcePath is required');
  });

  it('reads apiBaseUrl and accessToken from the environment when flags are omitted', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-config-'));
    const sourcePath = join(tempDir, 'example.zip');
    writeFileSync(sourcePath, Buffer.from('zip-bytes'));

    const config = resolvePublishBackstagePackageConfig(
      [
        '--packageId',
        'com.yucp.example',
        '--catalogProductId',
        'product_123',
        '--version',
        '1.2.3',
        '--sourcePath',
        sourcePath,
      ],
      {
        YUCP_API_BASE_URL: 'https://api.test',
        YUCP_ACCESS_TOKEN: 'oauth-token',
      } as NodeJS.ProcessEnv
    );

    expect(config.apiBaseUrl).toBe('https://api.test');
    expect(config.accessToken).toBe('oauth-token');
    expect(config.sourcePath).toBe(sourcePath);
  });

  it('authorizes and uploads unitypackage source files with the inferred content type', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.unitypackage');
    writeFileSync(sourcePath, Buffer.from('unitypackage-bytes'));

    const calls: FetchCall[] = [];
    await publishBackstagePackage(
      {
        apiBaseUrl: 'https://api.test',
        accessToken: 'oauth-token',
        packageId: 'com.yucp.example',
        catalogProductId: 'product_123',
        version: '3.0.0',
        sourcePath,
      },
      createFetch(calls, {
        deliveryPackageReleaseId: 'release_3',
        artifactId: 'artifact_3',
        artifactKey: 'backstage-package:com.yucp.example',
        zipSha256: 'c'.repeat(64),
        version: '3.0.0',
        channel: 'stable',
      })
    );

    expect(JSON.parse(calls[0].body)).toEqual({
      version: '3.0.0',
      deliveryName: 'example.unitypackage',
      sourceContentType: 'application/octet-stream',
      sha256: createHash('sha256').update('unitypackage-bytes').digest('hex'),
      byteSize: 18,
    });
    expect(tusUploadCalls[0].source).toBeInstanceOf(ReadStream);
    expect(Buffer.isBuffer(tusUploadCalls[0].source)).toBe(false);
    expect((tusUploadCalls[0].source as ReadStream).path).toBe(sourcePath);
    expect(tusUploadCalls[0].options.uploadSize).toBe(18);
    expect(JSON.parse(calls[3].body)).toMatchObject({
      ingestResult: 'signed-ingest-result',
      version: '3.0.0',
      deliveryName: 'example.unitypackage',
      sourceContentType: 'application/octet-stream',
    });
  });

  it('fails clearly when the ingest job reports a failed state', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.zip');
    writeFileSync(sourcePath, Buffer.from('zip-bytes'));
    const calls: FetchCall[] = [];
    await expect(
      publishBackstagePackage(
        {
          apiBaseUrl: 'https://api.test',
          accessToken: 'oauth-token',
          packageId: 'com.yucp.example',
          catalogProductId: 'product_123',
          version: '1.2.3',
          sourcePath,
        },
        createFetch(calls, {}, 'https://ingest.test/files', [
          { state: 'failed', reason: 'materialize_failed' },
        ])
      )
    ).rejects.toThrow('materialize_failed');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://ingest.test/jobs/job_123');
    expect(calls[1].method).toBe('GET');
    expect(calls[1].headers.get('authorization')).toBe('Bearer upload-token');
  });

  it('retries a timed-out ingest job poll and publishes after a later completion', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.zip');
    writeFileSync(sourcePath, Buffer.from('zip-bytes'));
    const calls: FetchCall[] = [];

    const result = await publishBackstagePackage(
      {
        apiBaseUrl: 'https://api.test',
        accessToken: 'oauth-token',
        packageId: 'com.yucp.example',
        catalogProductId: 'product_123',
        version: '1.2.3',
        sourcePath,
      },
      createFetch(
        calls,
        {
          deliveryPackageReleaseId: 'release_1',
          zipSha256: 'a'.repeat(64),
          version: '1.2.3',
          channel: 'stable',
        },
        'https://ingest.test/files',
        [
          new DOMException('The operation timed out', 'TimeoutError'),
          { state: 'completed', result: 'signed-ingest-result' },
        ]
      )
    );

    expect(result.deliveryPackageReleaseId).toBe('release_1');
    const pollCalls = calls.filter((call) => call.url === 'https://ingest.test/jobs/job_123');
    expect(pollCalls).toHaveLength(2);
    for (const pollCall of pollCalls) {
      expect(pollCall.headers.get('authorization')).toBe('Bearer upload-token');
      expect(pollCall.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('documents the products:write scope required for package publishing', () => {
    const originalLog = console.log;
    const messages: string[] = [];
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      printUsage();
    } finally {
      console.log = originalLog;
    }

    const usage = messages.join('\n');
    expect(usage).toContain('products:write');
    expect(usage).not.toContain('profile:read');
  });
});
