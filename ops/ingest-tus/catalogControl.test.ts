import { describe, expect, it, mock } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCatalogControlHandler } from './catalogControl';

const SHARED_SECRET = 'test-catalog-control-secret-with-32-bytes';
const VERSION_ID = '018f25cb-8b08-8e5b-9c5d-4bbdc544208d';
const PACKAGE_ID = 'com.creator.avatar';
const EDITION_ID = 'commercial';
const TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01';

async function withServer(
  handler: ReturnType<typeof createCatalogControlHandler>,
  operation: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  try {
    await operation(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function request(baseUrl: string, input?: { secret?: string; traceparent?: string }): Request {
  return new Request(`${baseUrl}/v1/internal/catalog/package-versions/delete`, {
    body: JSON.stringify({
      editionId: EDITION_ID,
      packageId: PACKAGE_ID,
      versionId: VERSION_ID,
    }),
    headers: {
      Authorization: `Bearer ${input?.secret ?? SHARED_SECRET}`,
      'Content-Type': 'application/json',
      ...(input?.traceparent ? { traceparent: input.traceparent } : {}),
    },
    method: 'POST',
  });
}

describe('ingest catalog control boundary', () => {
  it('lists a bounded edition page without leaking storage or provider details', async () => {
    const listVersionsPage = mock(async () => ({
      data: [
        {
          catalogProductId: 'must-not-cross-the-control-boundary',
          createdAt: new Date('2026-07-26T12:00:00.000Z'),
          editionId: 'commercial',
          id: VERSION_ID,
          packageId: PACKAGE_ID,
          releaseRoot: 'f'.repeat(64),
          state: 'READY',
          updatedAt: new Date('2026-07-26T12:01:00.000Z'),
          version: 'release-fuchsia',
        },
      ],
      hasMore: true,
      nextCursor: {
        createdAt: new Date('2026-07-26T12:00:00.000Z'),
        versionId: VERSION_ID,
      },
    }));
    const events: unknown[] = [];
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion: mock(async () => null as never),
        getVersion: mock(async () => null),
        listVersionsPage,
      },
      onEvent: (event) => events.push(event),
      sharedSecret: SHARED_SECRET,
    });

    await withServer(handler, async (baseUrl) => {
      const url = new URL(`${baseUrl}/v1/internal/catalog/package-versions`);
      url.searchParams.set('editionId', 'commercial');
      url.searchParams.set('limit', '25');
      url.searchParams.set('packageId', PACKAGE_ID);
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${SHARED_SECRET}`,
          traceparent: TRACEPARENT,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        data: [
          {
            createdAt: '2026-07-26T12:00:00.000Z',
            editionId: 'commercial',
            packageId: PACKAGE_ID,
            releaseRoot: 'f'.repeat(64),
            state: 'ready',
            updatedAt: '2026-07-26T12:01:00.000Z',
            version: 'release-fuchsia',
            versionId: VERSION_ID,
          },
        ],
        hasMore: true,
        nextCursor: expect.any(String),
      });
      expect(listVersionsPage).toHaveBeenCalledWith(PACKAGE_ID, {
        editionId: 'commercial',
        limit: 25,
      });
      expect(events).toContainEqual({
        durationMs: expect.any(Number),
        event: 'catalog.version.list_read',
        status: 'accepted',
        traceId: '11111111111111111111111111111111',
      });
    });
  });

  it('rejects malformed and cross-edition page cursors before reading the catalog', async () => {
    const listVersionsPage = mock(async () => null as never);
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion: mock(async () => null as never),
        getVersion: mock(async () => null),
        listVersionsPage,
      },
      sharedSecret: SHARED_SECRET,
    });
    const otherEditionCursor = Buffer.from(
      JSON.stringify({
        createdAt: '2026-07-26T12:00:00.000Z',
        editionId: 'personal',
        packageId: PACKAGE_ID,
        versionId: VERSION_ID,
      })
    ).toString('base64url');

    await withServer(handler, async (baseUrl) => {
      for (const cursor of ['not*base64url', otherEditionCursor]) {
        const url = new URL(`${baseUrl}/v1/internal/catalog/package-versions`);
        url.searchParams.set('cursor', cursor);
        url.searchParams.set('editionId', 'commercial');
        url.searchParams.set('limit', '25');
        url.searchParams.set('packageId', PACKAGE_ID);
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${SHARED_SECRET}` },
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          errorCode: 'CATALOG_CONTROL_REQUEST_INVALID',
        });
      }
      expect(listVersionsPage).not.toHaveBeenCalled();
    });
  });

  it('acquires and idempotently releases a bounded package-operation pin', async () => {
    const pin = {
      expiresAt: new Date('2037-07-27T12:00:00.000Z'),
      id: '018f25cb-8b08-8e5b-9c5d-4bbdc544299d',
      ownerId: 'job-1',
      packageVersionId: VERSION_ID,
      pinKind: 'materialization-job' as const,
      releasedAt: null,
    };
    const createReleasePin = mock(async () => pin);
    const releaseReleasePin = mock(async () => undefined);
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion: mock(async () => null as never),
        getVersion: mock(async () => null),
        listVersionsPage: mock(async () => ({ data: [], hasMore: false, nextCursor: null })),
      },
      releasePins: { createReleasePin, releaseReleasePin },
      sharedSecret: SHARED_SECRET,
    });

    await withServer(handler, async (baseUrl) => {
      const acquire = await fetch(`${baseUrl}/v1/internal/catalog/release-pins/acquire`, {
        body: JSON.stringify({
          expiresAt: '2037-07-27T12:00:00.000Z',
          ownerId: 'job-1',
          packageVersionId: VERSION_ID,
          pinKind: 'materialization-job',
        }),
        headers: {
          Authorization: `Bearer ${SHARED_SECRET}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });
      expect(acquire.status).toBe(200);
      await expect(acquire.json()).resolves.toEqual({
        expiresAt: '2037-07-27T12:00:00.000Z',
        ownerId: 'job-1',
        packageVersionId: VERSION_ID,
        pinId: pin.id,
        pinKind: 'materialization-job',
      });
      expect(createReleasePin).toHaveBeenCalledWith({
        expiresAt: new Date('2037-07-27T12:00:00.000Z'),
        ownerId: 'job-1',
        packageVersionId: VERSION_ID,
        pinKind: 'materialization-job',
      });

      const release = await fetch(`${baseUrl}/v1/internal/catalog/release-pins/release`, {
        body: JSON.stringify({ pinId: pin.id }),
        headers: {
          Authorization: `Bearer ${SHARED_SECRET}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });
      expect(release.status).toBe(200);
      await expect(release.json()).resolves.toEqual({
        pinId: pin.id,
        released: true,
      });
      expect(releaseReleasePin).toHaveBeenCalledWith(pin.id);
    });
  });

  it('returns only a safe durable version status with preserved trace context', async () => {
    const getVersion = mock(async () => ({
      editionId: 'commercial',
      error: 'duplicate key value violates unique constraint package_versions_secret',
      id: VERSION_ID,
      packageId: PACKAGE_ID,
      state: 'FAILED',
      updatedAt: new Date('2026-07-26T12:00:00.000Z'),
      version: '2.5.0',
    }));
    const deleteVersion = mock(async () => null as never);
    const events: unknown[] = [];
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion,
        getVersion,
        listVersionsPage: mock(async () => ({ data: [], hasMore: false, nextCursor: null })),
      },
      onEvent: (event) => events.push(event),
      sharedSecret: SHARED_SECRET,
    });

    await withServer(handler, async (baseUrl) => {
      const url = new URL(`${baseUrl}/v1/internal/catalog/package-versions/status`);
      url.searchParams.set('editionId', 'commercial');
      url.searchParams.set('packageId', PACKAGE_ID);
      url.searchParams.set('versionId', VERSION_ID);
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${SHARED_SECRET}`,
          traceparent: TRACEPARENT,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-trace-id')).toBe('11111111111111111111111111111111');
      const body = await response.json();
      expect(body).toEqual({
        editionId: 'commercial',
        errorCategory: 'processing',
        errorCode: 'PACKAGE_VERSION_PROCESSING_FAILED',
        estimatedStartAt: null,
        packageId: PACKAGE_ID,
        queuePosition: null,
        state: 'failed',
        updatedAt: '2026-07-26T12:00:00.000Z',
        version: '2.5.0',
        versionId: VERSION_ID,
      });
      expect(events).toContainEqual({
        durationMs: expect.any(Number),
        event: 'catalog.version.status_read',
        status: 'accepted',
        traceId: '11111111111111111111111111111111',
        versionId: VERSION_ID,
      });
      expect(JSON.stringify(body).includes('duplicate key')).toBe(false);
    });
  });

  it('rejects a version status lookup when the edition identity does not match', async () => {
    const getVersion = mock(async () => ({
      editionId: 'personal',
      id: VERSION_ID,
      packageId: PACKAGE_ID,
      state: 'READY',
      updatedAt: new Date('2026-07-26T12:00:00.000Z'),
      version: '2.5.0',
    }));
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion: mock(async () => null as never),
        getVersion,
        listVersionsPage: mock(async () => ({ data: [], hasMore: false, nextCursor: null })),
      },
      sharedSecret: SHARED_SECRET,
    });

    await withServer(handler, async (baseUrl) => {
      const url = new URL(`${baseUrl}/v1/internal/catalog/package-versions/status`);
      url.searchParams.set('editionId', 'commercial');
      url.searchParams.set('packageId', PACKAGE_ID);
      url.searchParams.set('versionId', VERSION_ID);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${SHARED_SECRET}` },
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        errorCode: 'PACKAGE_VERSION_NOT_FOUND',
      });
      expect(getVersion).toHaveBeenCalledWith(VERSION_ID);
    });
  });

  it('rejects an unauthenticated command before reading the catalog', async () => {
    const getVersion = mock(async () => null);
    const deleteVersion = mock(async () => null as never);
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion,
        getVersion,
        listVersionsPage: mock(async () => ({ data: [], hasMore: false, nextCursor: null })),
      },
      sharedSecret: SHARED_SECRET,
    });

    await withServer(handler, async (baseUrl) => {
      const response = await fetch(
        new Request(`${baseUrl}/v1/internal/catalog/package-versions/delete`, {
          body: JSON.stringify({ packageId: PACKAGE_ID, versionId: VERSION_ID }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        })
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.json()).resolves.toEqual({
        errorCode: 'CATALOG_CONTROL_AUTH_REQUIRED',
      });
      expect(getVersion).not.toHaveBeenCalled();
      expect(deleteVersion).not.toHaveBeenCalled();
    });
  });

  it('deletes only the expected package version and preserves a valid trace identifier', async () => {
    const deletedAt = new Date('2026-07-25T12:00:00.000Z');
    const getVersion = mock(async () => ({
      editionId: EDITION_ID,
      id: VERSION_ID,
      packageId: PACKAGE_ID,
      state: 'READY',
    }));
    const deleteVersion = mock(async () => ({
      deletedAt,
      id: VERSION_ID,
      packageId: PACKAGE_ID,
      state: 'DELETED',
    }));
    const events: unknown[] = [];
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion,
        getVersion,
        listVersionsPage: mock(async () => ({ data: [], hasMore: false, nextCursor: null })),
      },
      onEvent: (event) => events.push(event),
      sharedSecret: SHARED_SECRET,
    });

    await withServer(handler, async (baseUrl) => {
      const response = await fetch(request(baseUrl, { traceparent: TRACEPARENT }));

      expect(response.status).toBe(200);
      expect(response.headers.get('x-trace-id')).toBe('11111111111111111111111111111111');
      await expect(response.json()).resolves.toEqual({
        deletedAt: deletedAt.toISOString(),
        state: 'DELETED',
        versionId: VERSION_ID,
      });
      expect(getVersion).toHaveBeenCalledWith(VERSION_ID);
      expect(deleteVersion).toHaveBeenCalledWith(VERSION_ID, {
        editionId: EDITION_ID,
        packageId: PACKAGE_ID,
        reason: 'creator-request',
      });
      expect(events).toContainEqual({
        durationMs: expect.any(Number),
        event: 'catalog.version.delete_command',
        status: 'accepted',
        traceId: '11111111111111111111111111111111',
        versionId: VERSION_ID,
      });
    });
  });

  it('returns not found without deleting when the package identity does not match', async () => {
    const getVersion = mock(async () => ({
      editionId: EDITION_ID,
      id: VERSION_ID,
      packageId: 'com.other.product',
      state: 'READY',
    }));
    const deleteVersion = mock(async () => null as never);
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion,
        getVersion,
        listVersionsPage: mock(async () => ({ data: [], hasMore: false, nextCursor: null })),
      },
      sharedSecret: SHARED_SECRET,
    });

    await withServer(handler, async (baseUrl) => {
      const response = await fetch(request(baseUrl));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        errorCode: 'PACKAGE_VERSION_NOT_FOUND',
      });
      expect(deleteVersion).not.toHaveBeenCalled();
    });
  });

  it('returns not found without deleting when the edition identity does not match', async () => {
    const getVersion = mock(async () => ({
      editionId: 'personal',
      id: VERSION_ID,
      packageId: PACKAGE_ID,
      state: 'READY',
    }));
    const deleteVersion = mock(async () => null as never);
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion,
        getVersion,
        listVersionsPage: mock(async () => ({ data: [], hasMore: false, nextCursor: null })),
      },
      sharedSecret: SHARED_SECRET,
    });

    await withServer(handler, async (baseUrl) => {
      const response = await fetch(request(baseUrl));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        errorCode: 'PACKAGE_VERSION_NOT_FOUND',
      });
      expect(deleteVersion).not.toHaveBeenCalled();
    });
  });

  it('accepts repeated deletion commands without producing a different result', async () => {
    const deletedAt = new Date('2026-07-25T12:00:00.000Z');
    const getVersion = mock(async () => ({
      deletedAt,
      editionId: EDITION_ID,
      id: VERSION_ID,
      packageId: PACKAGE_ID,
      state: 'DELETED',
    }));
    const deleteVersion = mock(async () => ({
      deletedAt,
      id: VERSION_ID,
      packageId: PACKAGE_ID,
      state: 'DELETED',
    }));
    const handler = createCatalogControlHandler({
      catalog: {
        deleteVersion,
        getVersion,
        listVersionsPage: mock(async () => ({ data: [], hasMore: false, nextCursor: null })),
      },
      sharedSecret: SHARED_SECRET,
    });

    await withServer(handler, async (baseUrl) => {
      const first = await fetch(request(baseUrl));
      const second = await fetch(request(baseUrl));

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await first.json()).toEqual(await second.json());
      expect(deleteVersion).toHaveBeenCalledTimes(2);
    });
  });
});
