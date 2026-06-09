/**
 * Purpose: Verifies Backstage CDNgine upload integration behavior without Convex file storage.
 * Governing docs:
 * - README.md
 * - agents.md
 * External references:
 * - CDNgine public API surface and OpenAPI contract in the companion service docs.
 * Tests:
 * - apps/api/src/lib/cdngineBackstage.test.ts
 */

import { afterEach, expect, it } from 'bun:test';

import {
  authorizeCdngineBackstageSource,
  uploadBackstageBytesToCdngine,
  uploadBackstageDeliverableToCdngine,
} from './cdngineBackstage';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('resolves relative CDNgine upload target URLs against the configured API base URL', async () => {
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url);

    if (url === 'https://cdngine.test/v1/upload-sessions') {
      return new Response(
        JSON.stringify({
          uploadSessionId: 'upl_1',
          uploadTarget: {
            method: 'PATCH',
            protocol: 'tus',
            url: '/uploads/staging/backstage/source.unitypackage',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url === 'https://cdngine.test/uploads/staging/backstage/source.unitypackage') {
      expect(init?.method).toBe('PATCH');
      return new Response(null, { status: 204 });
    }

    if (url === 'https://cdngine.test/v1/upload-sessions/upl_1/complete') {
      return new Response(
        JSON.stringify({
          assetId: 'ast_1',
          versionId: 'ver_1',
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('unexpected URL', { status: 500 });
  }) as typeof fetch;

  const bytes = new Uint8Array([1, 2, 3]);
  const source = await uploadBackstageBytesToCdngine({
    bytes: bytes.buffer,
    byteSize: bytes.byteLength,
    config: {
      accessToken: 'cdngine-token',
      apiBaseUrl: 'https://cdngine.test',
    },
    contentType: 'application/octet-stream',
    deliveryName: 'source.unitypackage',
    idempotencyBase: 'backstage-source:test',
    objectKey: 'staging/backstage/source.unitypackage',
    assetOwner: 'creator:test',
    tenantId: 'test',
    sha256: 'a'.repeat(64),
  });

  expect(source.assetId).toBe('ast_1');
  expect(source.versionId).toBe('ver_1');
  expect(requestedUrls).toContain(
    'https://cdngine.test/uploads/staging/backstage/source.unitypackage'
  );
});

it('resolves relative CDNgine authorized source URLs against the configured API base URL', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);

    if (url === 'https://cdngine.test/v1/assets/ast_1/versions/ver_1/source/authorize') {
      return new Response(
        JSON.stringify({
          url: '/downloads/assets/ast_1/versions/ver_1/source?token=source-token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('unexpected URL', { status: 500 });
  }) as typeof fetch;

  await expect(
    authorizeCdngineBackstageSource({
      config: {
        accessToken: 'cdngine-token',
        apiBaseUrl: 'https://cdngine.test',
      },
      idempotencyKey: 'source-read:test',
      source: {
        assetId: 'ast_1',
        assetOwner: 'creator:test',
        byteSize: 123,
        serviceNamespaceId: 'yucp-backstage',
        sha256: 'a'.repeat(64),
        tenantId: 'test',
        uploadedAt: 1,
        versionId: 'ver_1',
      },
    })
  ).resolves.toBe(
    'https://cdngine.test/downloads/assets/ast_1/versions/ver_1/source?token=source-token'
  );
});

it('waits until CDNgine publishes Backstage deliverables before returning delivery references', async () => {
  const requestedUrls: string[] = [];
  let versionReadCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(`${init?.method ?? 'GET'} ${url}`);

    if (url === 'https://cdngine.test/v1/upload-sessions') {
      return new Response(
        JSON.stringify({
          uploadSessionId: 'upl_1',
          assetId: 'ast_1',
          versionId: 'ver_pending_1',
          uploadTarget: {
            method: 'PATCH',
            protocol: 'tus',
            url: '/uploads/staging/backstage/source.zip',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url === 'https://cdngine.test/uploads/staging/backstage/source.zip') {
      return new Response(null, { status: 204 });
    }

    if (url === 'https://cdngine.test/v1/upload-sessions/upl_1/complete') {
      return new Response(
        JSON.stringify({
          assetId: 'ast_1',
          versionId: 'ver_1',
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url === 'https://cdngine.test/v1/assets/ast_1/versions/ver_1') {
      versionReadCount += 1;
      return new Response(
        JSON.stringify({
          assetId: 'ast_1',
          versionId: 'ver_1',
          lifecycleState: versionReadCount === 1 ? 'canonical' : 'published',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('unexpected URL', { status: 500 });
  }) as typeof fetch;

  const bytes = new Uint8Array([80, 75, 3, 4]);
  const delivery = await uploadBackstageDeliverableToCdngine({
    bytes: bytes.buffer,
    byteSize: bytes.byteLength,
    config: {
      accessToken: 'cdngine-token',
      apiBaseUrl: 'https://cdngine.test',
      publicationPollIntervalMs: 0,
      publicationTimeoutMs: 100,
    },
    contentType: 'application/zip',
    deliveryName: 'source.zip',
    releaseId: 'release_1',
    assetOwner: 'creator:test',
    tenantId: 'test',
    sha256: 'b'.repeat(64),
  });

  expect(delivery).toMatchObject({
    assetId: 'ast_1',
    deliveryScopeId: 'paid-downloads',
    variant: 'vpm-package',
    versionId: 'ver_1',
  });
  expect(
    requestedUrls.filter((url) => url === 'GET https://cdngine.test/v1/assets/ast_1/versions/ver_1')
  ).toEqual([
    'GET https://cdngine.test/v1/assets/ast_1/versions/ver_1',
    'GET https://cdngine.test/v1/assets/ast_1/versions/ver_1',
  ]);
});
