import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  publishBackstagePackage,
  resolvePublishBackstagePackageConfig,
} from './publish-backstage-package';

describe('publish-backstage-package', () => {
  let tempDir: string | undefined;
  const cdngineSource = {
    assetId: 'asset_123',
    assetOwner: 'creator:auth-user-1',
    byteSize: 9,
    serviceNamespaceId: 'yucp-backstage',
    sha256: 'a'.repeat(64),
    uploadedAt: 1_714_000_000_000,
    versionId: 'version_123',
  };

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('publishes a package by creating a direct CDNgine upload session, uploading the ZIP, and publishing the release', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.zip');
    writeFileSync(sourcePath, Buffer.from('zip-bytes'));

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/packages/com.yucp.example/backstage/upload-session')) {
        return Response.json({
          packageId: 'com.yucp.example',
          uploadSessionId: 'upl_1',
          uploadTarget: {
            method: 'PATCH',
            protocol: 'tus',
            url: 'https://upload.test/backstage',
          },
          completeUrl:
            'https://api.test/api/packages/com.yucp.example/backstage/upload-session/complete?completionToken=token',
        });
      }
      if (url === 'https://upload.test/backstage') {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/backstage/upload-session/complete')) {
        return Response.json({
          cdngineSource,
          deliveryName: 'example.zip',
          sourceContentType: 'application/zip',
        });
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
    expect(calls).toHaveLength(4);
    expect(calls[0].init?.headers).toEqual({
      Authorization: 'Bearer oauth-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      byteSize: 9,
      deliveryName: 'example.zip',
      sourceContentType: 'application/zip',
    });
    expect(calls[1].init?.headers).toEqual({
      'Content-Type': 'application/offset+octet-stream',
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': '0',
    });
    expect(calls[2].init?.method).toBe('POST');
    expect(calls[3].init?.headers).toEqual({
      Authorization: 'Bearer oauth-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(calls[3].init?.body))).toMatchObject({
      catalogProductId: 'product_123',
      cdngineSource,
      deliveryName: 'example.zip',
      sourceContentType: 'application/zip',
      version: '1.2.3',
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

  it('uploads unitypackage source files raw before publishing', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.unitypackage');
    writeFileSync(sourcePath, Buffer.from('unitypackage-bytes'));

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/packages/com.yucp.example/backstage/upload-session')) {
        return Response.json({
          packageId: 'com.yucp.example',
          uploadSessionId: 'upl_1',
          uploadTarget: {
            method: 'PATCH',
            protocol: 'tus',
            url: 'https://upload.test/backstage',
          },
          completeUrl:
            'https://api.test/api/packages/com.yucp.example/backstage/upload-session/complete?completionToken=token',
        });
      }
      if (url === 'https://upload.test/backstage') {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/backstage/upload-session/complete')) {
        return Response.json({
          cdngineSource,
          deliveryName: 'example.unitypackage',
          sourceContentType: 'application/octet-stream',
        });
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

    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      deliveryName: 'example.unitypackage',
      sourceContentType: 'application/octet-stream',
    });
    expect(calls[1].init?.headers).toEqual({
      'Content-Type': 'application/offset+octet-stream',
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': '0',
    });
    expect(JSON.parse(String(calls[3].init?.body))).toMatchObject({
      cdngineSource,
      deliveryName: 'example.unitypackage',
      sourceContentType: 'application/octet-stream',
    });
  });
});
