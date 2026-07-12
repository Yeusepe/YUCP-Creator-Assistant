import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BACKSTAGE_INGEST_RESULT_HEADER = 'X-Backstage-Ingest-Result';

type TusUploadOptions = {
  endpoint?: string;
  metadata?: Record<string, string>;
  onAfterResponse?: (
    request: unknown,
    response: { getHeader(name: string): string | undefined }
  ) => void;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

const tusUploadCalls: Array<{ source: unknown; options: TusUploadOptions }> = [];
let nextIngestResult: string | undefined = 'signed-ingest-result';

mock.module('tus-js-client', () => ({
  Upload: class {
    readonly options: TusUploadOptions;

    constructor(source: unknown, options: TusUploadOptions) {
      this.options = options;
      tusUploadCalls.push({ source, options });
    }

    start(): void {
      this.options.onAfterResponse?.(
        {},
        {
          getHeader: (name) =>
            name === BACKSTAGE_INGEST_RESULT_HEADER ? nextIngestResult : undefined,
        }
      );
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
};

function createFetch(calls: FetchCall[], releaseResult: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const call = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    };
    calls.push(call);

    if (call.url.endsWith('/api/packages/com.yucp.example/backstage/upload-authorization')) {
      return Response.json({
        tusEndpoint: 'https://ingest.test/files',
        uploadToken: 'upload-token',
        uploadMetadataKey: 'backstageUploadToken',
        maxByteSize: 1024,
      });
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
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    tusUploadCalls.length = 0;
    nextIngestResult = 'signed-ingest-result';
  });

  it('authorizes a resumable upload, reads its ingest result, and publishes the release', async () => {
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
    expect(calls).toHaveLength(2);
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
    expect(Buffer.from(tusUploadCalls[0].source as Uint8Array).toString('utf8')).toBe('zip-bytes');

    expect(calls[1].url).toBe('https://api.test/api/packages/com.yucp.example/backstage/releases');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].headers.get('authorization')).toBe('Bearer oauth-token');
    expect(calls[1].headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[1].body)).toEqual({
      catalogProductId: 'product_123',
      ingestResult: 'signed-ingest-result',
      version: '1.2.3',
      deliveryName: 'example.zip',
      sourceContentType: 'application/zip',
    });
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
    expect(Buffer.from(tusUploadCalls[0].source as Uint8Array).toString('utf8')).toBe(
      'unitypackage-bytes'
    );
    expect(JSON.parse(calls[1].body)).toMatchObject({
      ingestResult: 'signed-ingest-result',
      version: '3.0.0',
      deliveryName: 'example.unitypackage',
      sourceContentType: 'application/octet-stream',
    });
  });

  it('fails clearly when the TUS sidecar omits the signed ingest result header', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.zip');
    writeFileSync(sourcePath, Buffer.from('zip-bytes'));
    nextIngestResult = undefined;

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
        createFetch(calls, {})
      )
    ).rejects.toThrow('Backstage ingest sidecar did not return a signed result');
    expect(calls).toHaveLength(1);
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
