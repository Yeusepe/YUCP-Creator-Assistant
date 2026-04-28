import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  publishBackstagePackage,
  resolvePublishBackstagePackageConfig,
} from './publish-backstage-package';

describe('publish-backstage-package', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('publishes a package by creating an upload URL, uploading the ZIP, and publishing the release', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.zip');
    writeFileSync(sourcePath, Buffer.from('zip-bytes'));
    const expectedSha = createHash('sha256').update('zip-bytes').digest('hex');

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/packages/com.yucp.example/backstage/upload-url')) {
        return Response.json({
          packageId: 'com.yucp.example',
          uploadUrl: 'https://upload.test/backstage',
        });
      }
      if (url === 'https://upload.test/backstage') {
        return Response.json({ storageId: 'storage_123' });
      }
      if (url.endsWith('/api/packages/com.yucp.example/backstage/releases')) {
        return new Response(
          JSON.stringify({
            deliveryPackageReleaseId: 'release_1',
            artifactId: 'artifact_1',
            artifactKey: 'backstage-package:com.yucp.example',
            zipSha256: 'a'.repeat(64),
            version: '1.2.3',
            channel: 'stable',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const result = await publishBackstagePackage(
      {
        apiBaseUrl: 'https://api.test',
        accessToken: 'oauth-token',
        packageId: 'com.yucp.example',
        catalogProductId: 'product_123',
        version: '1.2.3',
        sourcePath,
      },
      fetchImpl
    );

    expect(result).toMatchObject({
      deliveryPackageReleaseId: 'release_1',
      artifactId: 'artifact_1',
      version: '1.2.3',
      channel: 'stable',
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].init?.headers).toEqual({
      Authorization: 'Bearer oauth-token',
    });
    expect(calls[1].init?.headers).toEqual({
      'Content-Type': 'application/zip',
    });
    expect(calls[2].init?.headers).toEqual({
      Authorization: 'Bearer oauth-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({
      catalogProductId: 'product_123',
      storageId: 'storage_123',
      version: '1.2.3',
      zipSha256: expectedSha,
      metadata: {},
    });
  });

  it('allows using an existing storageId without uploading a ZIP', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith('/api/packages/com.yucp.example/backstage/releases')) {
        return new Response(
          JSON.stringify({
            deliveryPackageReleaseId: 'release_2',
            artifactId: 'artifact_2',
            artifactKey: 'backstage-package:com.yucp.example',
            zipSha256: 'b'.repeat(64),
            version: '2.0.0',
            channel: 'beta',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const result = await publishBackstagePackage(
      {
        apiBaseUrl: 'https://api.test',
        accessToken: 'oauth-token',
        packageId: 'com.yucp.example',
        catalogProductId: 'product_123',
        version: '2.0.0',
        storageId: 'storage_existing',
        zipSha256: 'b'.repeat(64),
        channel: 'beta',
      },
      fetchImpl
    );

    expect(result.channel).toBe('beta');
    expect(calls).toEqual(['https://api.test/api/packages/com.yucp.example/backstage/releases']);
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

  it('uploads unitypackage source files raw before publishing', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.unitypackage');
    writeFileSync(sourcePath, Buffer.from('unitypackage-bytes'));
    const expectedSha = createHash('sha256').update('unitypackage-bytes').digest('hex');

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/packages/com.yucp.example/backstage/upload-url')) {
        return Response.json({
          packageId: 'com.yucp.example',
          uploadUrl: 'https://upload.test/backstage',
        });
      }
      if (url === 'https://upload.test/backstage') {
        return Response.json({ storageId: 'storage_789' });
      }
      if (url.endsWith('/api/packages/com.yucp.example/backstage/releases')) {
        return new Response(
          JSON.stringify({
            deliveryPackageReleaseId: 'release_3',
            artifactId: 'artifact_3',
            artifactKey: 'backstage-package:com.yucp.example',
            zipSha256: 'c'.repeat(64),
            version: '3.0.0',
            channel: 'stable',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await publishBackstagePackage(
      {
        apiBaseUrl: 'https://api.test',
        accessToken: 'oauth-token',
        packageId: 'com.yucp.example',
        catalogProductId: 'product_123',
        version: '3.0.0',
        sourcePath,
      },
      fetchImpl
    );

    expect(calls[1].init?.headers).toEqual({
      'Content-Type': 'application/octet-stream',
    });
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({
      deliveryName: 'example.unitypackage',
      contentType: 'application/octet-stream',
      zipSha256: expectedSha,
      metadata: {},
    });
  });
});
