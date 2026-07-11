import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  printUsage,
  publishBackstagePackage,
  resolvePublishBackstagePackageConfig,
} from './publish-backstage-package';

describe('publish-backstage-package', () => {
  let tempDir: string | undefined;
  const loreSource = {
    repositoryId: 'repo_creator_1',
    address: `sha256:${'a'.repeat(64)}`,
    byteSize: 9,
    sha256: 'a'.repeat(64),
    uploadedAt: '2026-07-11T12:00:00.000Z',
    tenantId: 'auth-user-1',
  };

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('uploads package bytes to Lore and publishes the returned source reference', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.zip');
    writeFileSync(sourcePath, Buffer.from('zip-bytes'));

    const calls: Array<{ url: string; method: string; headers: Headers; body: Uint8Array }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = request.url;
      calls.push({
        url,
        method: request.method,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      });
      if (url.includes('/api/packages/com.yucp.example/backstage/upload?')) {
        return Response.json({
          loreSource,
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

    expect(result).toEqual({
      deliveryPackageReleaseId: 'release_1',
      artifactId: 'artifact_1',
      artifactKey: 'backstage-package:com.yucp.example',
      zipSha256: 'a'.repeat(64),
      version: '1.2.3',
      channel: 'stable',
    });
    expect(calls).toHaveLength(2);
    const uploadUrl = new URL(calls[0].url);
    expect(uploadUrl.pathname).toBe('/api/packages/com.yucp.example/backstage/upload');
    expect(Object.fromEntries(uploadUrl.searchParams)).toEqual({
      sha256: createHash('sha256').update('zip-bytes').digest('hex'),
      deliveryName: 'example.zip',
      sourceContentType: 'application/zip',
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('authorization')).toBe('Bearer oauth-token');
    expect(calls[0].headers.get('content-type')).toBe('application/zip');
    expect(Buffer.from(calls[0].body).toString('utf8')).toBe('zip-bytes');
    expect(calls[1].url).toBe('https://api.test/api/packages/com.yucp.example/backstage/releases');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].headers.get('authorization')).toBe('Bearer oauth-token');
    expect(calls[1].headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(Buffer.from(calls[1].body).toString('utf8'))).toEqual({
      catalogProductId: 'product_123',
      loreSource,
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

  it('uploads unitypackage source files raw before publishing', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'publish-backstage-package-'));
    const sourcePath = join(tempDir, 'example.unitypackage');
    writeFileSync(sourcePath, Buffer.from('unitypackage-bytes'));

    const calls: Array<{ url: string; method: string; headers: Headers; body: Uint8Array }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = request.url;
      calls.push({
        url,
        method: request.method,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      });
      if (url.includes('/api/packages/com.yucp.example/backstage/upload?')) {
        return Response.json({
          loreSource,
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

    const uploadUrl = new URL(calls[0].url);
    expect(Object.fromEntries(uploadUrl.searchParams)).toEqual({
      sha256: createHash('sha256').update('unitypackage-bytes').digest('hex'),
      deliveryName: 'example.unitypackage',
      sourceContentType: 'application/octet-stream',
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(calls[0].body).toString('utf8')).toBe('unitypackage-bytes');
    expect(JSON.parse(Buffer.from(calls[1].body).toString('utf8'))).toMatchObject({
      loreSource,
      deliveryName: 'example.unitypackage',
      sourceContentType: 'application/octet-stream',
    });
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
