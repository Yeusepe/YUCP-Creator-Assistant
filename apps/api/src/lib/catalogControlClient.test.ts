import { describe, expect, it, mock } from 'bun:test';
import { CatalogControlClientError, createCatalogControlClient } from './catalogControlClient';

const TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01';

describe('catalog control client', () => {
  it('reads a bounded edition page with opaque catalog pagination', async () => {
    const requests: Request[] = [];
    const client = createCatalogControlClient({
      baseUrl: 'http://127.0.0.1:3002',
      fetchImplementation: async (request) => {
        requests.push(request.clone());
        return Response.json({
          data: [
            {
              createdAt: '2026-07-26T12:00:00.000Z',
              editionId: 'commercial',
              packageId: 'com.creator.avatar',
              releaseRoot: 'f'.repeat(64),
              state: 'ready',
              updatedAt: '2026-07-26T12:01:00.000Z',
              version: 'release-fuchsia',
              versionId: 'version-fuchsia',
            },
          ],
          hasMore: true,
          nextCursor: 'opaque-catalog-cursor',
        });
      },
      sharedSecret: 'test-catalog-control-secret-with-32-bytes',
    });

    await expect(
      client.listVersions({
        cursor: 'prior-opaque-cursor',
        editionId: 'commercial',
        limit: 25,
        packageId: 'com.creator.avatar',
        traceparent: TRACEPARENT,
      })
    ).resolves.toEqual({
      data: [
        {
          createdAt: '2026-07-26T12:00:00.000Z',
          editionId: 'commercial',
          packageId: 'com.creator.avatar',
          releaseRoot: 'f'.repeat(64),
          state: 'ready',
          updatedAt: '2026-07-26T12:01:00.000Z',
          version: 'release-fuchsia',
          versionId: 'version-fuchsia',
        },
      ],
      hasMore: true,
      nextCursor: 'opaque-catalog-cursor',
    });
    const url = new URL(requests[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/internal/catalog/package-versions');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      cursor: 'prior-opaque-cursor',
      editionId: 'commercial',
      limit: '25',
      packageId: 'com.creator.avatar',
    });
    expect(requests[0]?.headers.get('traceparent')).toBe(TRACEPARENT);
  });

  it('rejects deleted and oversized version pages from the catalog boundary', async () => {
    const responseFor = (count: number, state: string) =>
      Response.json({
        data: Array.from({ length: count }, (_, index) => ({
          createdAt: '2026-07-26T12:00:00.000Z',
          editionId: 'commercial',
          packageId: 'com.creator.avatar',
          releaseRoot: 'f'.repeat(64),
          state,
          updatedAt: '2026-07-26T12:01:00.000Z',
          version: `release-${index}`,
          versionId: `version-${index}`,
        })),
        hasMore: false,
        nextCursor: null,
      });
    for (const [count, state] of [
      [1, 'deleted'],
      [26, 'ready'],
    ] as const) {
      const client = createCatalogControlClient({
        baseUrl: 'http://127.0.0.1:3002',
        fetchImplementation: async () => responseFor(count, state),
        sharedSecret: 'test-catalog-control-secret-with-32-bytes',
      });

      await expect(
        client.listVersions({
          editionId: 'commercial',
          limit: 25,
          packageId: 'com.creator.avatar',
        })
      ).rejects.toThrow('Catalog control returned an invalid response');
    }
  });

  it('acquires and idempotently releases durable package-operation pins', async () => {
    const requests: Request[] = [];
    const client = createCatalogControlClient({
      baseUrl: 'https://catalog.example.test',
      fetchImplementation: async (request) => {
        requests.push(request.clone());
        if (request.url.endsWith('/release-pins/acquire')) {
          return Response.json({
            expiresAt: '2037-07-27T12:00:00.000Z',
            ownerId: 'job-1',
            packageVersionId: '018f25cb-8b08-8e5b-9c5d-4bbdc544208d',
            pinId: '018f25cb-8b08-8e5b-9c5d-4bbdc544299d',
            pinKind: 'materialization-job',
          });
        }
        return Response.json({
          pinId: '018f25cb-8b08-8e5b-9c5d-4bbdc544299d',
          released: true,
        });
      },
      sharedSecret: 'test-catalog-control-secret-with-32-bytes',
    });

    const pin = await client.acquireReleasePin({
      expiresAt: '2037-07-27T12:00:00.000Z',
      ownerId: 'job-1',
      packageVersionId: '018f25cb-8b08-8e5b-9c5d-4bbdc544208d',
      pinKind: 'materialization-job',
    });
    await client.releaseReleasePin({ pinId: pin.pinId });

    expect(pin.pinId).toBe('018f25cb-8b08-8e5b-9c5d-4bbdc544299d');
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/v1/internal/catalog/release-pins/acquire',
      '/v1/internal/catalog/release-pins/release',
    ]);
    expect(await requests[0]?.json()).toEqual({
      expiresAt: '2037-07-27T12:00:00.000Z',
      ownerId: 'job-1',
      packageVersionId: '018f25cb-8b08-8e5b-9c5d-4bbdc544208d',
      pinKind: 'materialization-job',
    });
    expect(await requests[1]?.json()).toEqual({
      pinId: '018f25cb-8b08-8e5b-9c5d-4bbdc544299d',
    });
  });

  it('reads and validates a purpose-separated safe version status', async () => {
    const fetchImplementation = mock(async (request: Request) => {
      expect(request.url).toBe(
        'http://127.0.0.1:3002/v1/internal/catalog/package-versions/status?editionId=standard&packageId=com.creator.avatar&versionId=version-1'
      );
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe(
        'Bearer test-catalog-control-secret-with-32-bytes'
      );
      expect(request.headers.get('traceparent')).toBe(TRACEPARENT);
      return Response.json({
        editionId: 'standard',
        errorCategory: null,
        errorCode: null,
        estimatedStartAt: null,
        packageId: 'com.creator.avatar',
        queuePosition: null,
        state: 'recovering',
        updatedAt: '2026-07-26T12:00:00.000Z',
        version: '2.5.0',
        versionId: 'version-1',
      });
    });
    const client = createCatalogControlClient({
      baseUrl: 'http://127.0.0.1:3002',
      fetchImplementation,
      sharedSecret: 'test-catalog-control-secret-with-32-bytes',
    });

    await expect(
      client.getVersionStatus({
        editionId: 'standard',
        packageId: 'com.creator.avatar',
        traceparent: TRACEPARENT,
        versionId: 'version-1',
      })
    ).resolves.toEqual({
      editionId: 'standard',
      errorCategory: null,
      errorCode: null,
      estimatedStartAt: null,
      packageId: 'com.creator.avatar',
      queuePosition: null,
      state: 'recovering',
      updatedAt: '2026-07-26T12:00:00.000Z',
      version: '2.5.0',
      versionId: 'version-1',
    });
  });

  it('sends the purpose-separated credential and valid trace context', async () => {
    const fetchImplementation = mock(async (request: Request) => {
      expect(request.url).toBe('http://127.0.0.1:3002/v1/internal/catalog/package-versions/delete');
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe(
        'Bearer test-catalog-control-secret-with-32-bytes'
      );
      expect(request.headers.get('traceparent')).toBe(TRACEPARENT);
      expect(await request.json()).toEqual({
        editionId: 'commercial',
        packageId: 'com.creator.avatar',
        versionId: 'version-1',
      });
      return Response.json({
        deletedAt: '2026-07-25T12:00:00.000Z',
        state: 'DELETED',
        versionId: 'version-1',
      });
    });
    const client = createCatalogControlClient({
      baseUrl: 'http://127.0.0.1:3002',
      fetchImplementation,
      sharedSecret: 'test-catalog-control-secret-with-32-bytes',
    });

    await expect(
      client.deleteVersion({
        editionId: 'commercial',
        packageId: 'com.creator.avatar',
        traceparent: TRACEPARENT,
        versionId: 'version-1',
      })
    ).resolves.toEqual({
      deletedAt: '2026-07-25T12:00:00.000Z',
      state: 'DELETED',
      versionId: 'version-1',
    });
  });

  it('preserves a stable control-plane error code', async () => {
    const client = createCatalogControlClient({
      baseUrl: 'http://127.0.0.1:3002',
      fetchImplementation: async () =>
        Response.json({ errorCode: 'PACKAGE_VERSION_DELETE_BLOCKED' }, { status: 409 }),
      sharedSecret: 'test-catalog-control-secret-with-32-bytes',
    });

    const result = client.deleteVersion({
      editionId: 'commercial',
      packageId: 'com.creator.avatar',
      versionId: 'version-1',
    });

    await expect(result).rejects.toBeInstanceOf(CatalogControlClientError);
    await expect(result).rejects.toMatchObject({
      errorCode: 'PACKAGE_VERSION_DELETE_BLOCKED',
      status: 409,
    });
  });
});
