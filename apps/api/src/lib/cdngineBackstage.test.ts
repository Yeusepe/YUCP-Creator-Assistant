/**
 * Purpose: Verifies Backstage CDNgine upload integration behavior without Convex file storage.
 * Governing docs:
 * - README.md
 * - agents.md
 * External references:
 * - C:/Users/svalp/OneDrive/Documents/Development/antiwork/cdngine/docs/api-surface.md
 * - C:/Users/svalp/OneDrive/Documents/Development/antiwork/cdngine/contracts/openapi/public.openapi.yaml
 * Tests:
 * - apps/api/src/lib/cdngineBackstage.test.ts
 */

import { afterEach, expect, it } from 'bun:test';

import { authorizeCdngineBackstageSource, uploadBackstageBytesToCdngine } from './cdngineBackstage';

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
