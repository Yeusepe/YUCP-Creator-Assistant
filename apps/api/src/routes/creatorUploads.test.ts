import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { verifyUploadCapability } from '../../../../ops/storage-core/uploadSigning';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);

const apiMock = {
  certificateBilling: {
    getAccountOverview: 'certificateBilling.getAccountOverview',
  },
  packageRegistry: {
    getBuyerAccessContextByCatalogProductId:
      'packageRegistry.getBuyerAccessContextByCatalogProductId',
    lookupRegistration: 'packageRegistry.lookupRegistration',
  },
} as const;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: {},
}));

mock.module('../lib/apiActor', () => ({
  createAuthUserActorBinding: async () => 'creator-actor-binding',
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: convexQueryMock,
  }),
}));

const { createCreatorUploadRoutes } = await import('./creatorUploads');

const uploadHmacKey = 'creator-upload-route-test-hmac-key';
const config = {
  apiBaseUrl: 'http://localhost:3001',
  frontendBaseUrl: 'http://localhost:3000',
  convexApiSecret: 'test-convex-api-secret',
  convexUrl: 'http://localhost:3210',
  ingestTusUrl: 'https://ingest.example.test/',
  uploadHmacKey,
};

const activeVpmBilling = {
  billing: {
    capabilities: [{ capabilityKey: 'vpm_repo', status: 'active' }],
  },
};

function createRoutes(userId: string | null, configOverrides: Partial<typeof config> = {}) {
  return createCreatorUploadRoutes({
    auth: {
      getSession: async () =>
        userId
          ? {
              user: { id: userId },
            }
          : null,
    } as never,
    config: { ...config, ...configOverrides },
  });
}

function authorizeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3001/api/creator/uploads/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('creator upload authorization', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    convexQueryMock.mockReset();
  });

  it('returns 401 without a Better Auth session', async () => {
    const response = await createRoutes(null).authorizeUpload(
      authorizeRequest({ packageId: 'com.yucp.avatar', version: '1.0.0' })
    );

    expect(response.status).toBe(401);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the signed-in creator does not own the package', async () => {
    convexQueryMock.mockResolvedValue({
      packageId: 'com.yucp.avatar',
      yucpUserId: 'different-creator',
      status: 'active',
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({ packageId: 'com.yucp.avatar', version: '1.0.0' })
    );

    expect(response.status).toBe(403);
    expect(convexQueryMock).toHaveBeenCalledWith(apiMock.packageRegistry.lookupRegistration, {
      apiSecret: config.convexApiSecret,
      actor: 'creator-actor-binding',
      packageId: 'com.yucp.avatar',
    });
  });

  it('returns 503 for the package owner when creator uploads are not configured', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.lookupRegistration) {
        return {
          packageId: 'com.yucp.avatar',
          yucpUserId: 'creator-123',
          status: 'active',
        };
      }
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return activeVpmBilling;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123', {
      ingestTusUrl: undefined,
      uploadHmacKey: undefined,
    }).authorizeUpload(authorizeRequest({ packageId: 'com.yucp.avatar', version: '1.0.0' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Creator uploads are not configured' });
  });

  it('returns 403 when the owned package is archived', async () => {
    convexQueryMock.mockResolvedValue({
      packageId: 'com.yucp.avatar',
      yucpUserId: 'creator-123',
      status: 'archived',
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({ packageId: 'com.yucp.avatar', version: '1.0.0' })
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 when the package owner lacks the VPM repository capability', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.lookupRegistration) {
        return {
          packageId: 'com.yucp.avatar',
          yucpUserId: 'creator-123',
          status: 'active',
        };
      }
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return { billing: { capabilities: [] } };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({ packageId: 'com.yucp.avatar', version: '1.0.0' })
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 when the catalog product belongs to another creator', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.lookupRegistration) {
        return {
          packageId: 'com.yucp.avatar',
          yucpUserId: 'creator-123',
          status: 'active',
        };
      }
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return activeVpmBilling;
      }
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return { creatorAuthUserId: 'different-creator' };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.avatar',
        version: '1.2.3',
        catalogProductId: 'catalog-product-456',
      })
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 when the catalog product belongs to a different package', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.lookupRegistration) {
        return {
          packageId: 'com.yucp.avatar',
          yucpUserId: 'creator-123',
          status: 'active',
        };
      }
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return activeVpmBilling;
      }
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          creatorAuthUserId: 'creator-123',
          packageId: 'com.yucp.different-avatar',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.avatar',
        version: '1.2.3',
        catalogProductId: 'catalog-product-456',
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Catalog product ownership required',
    });
  });

  it('returns a verifiable capability for the package owner', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.lookupRegistration) {
        return {
          packageId: 'com.yucp.avatar',
          yucpUserId: 'creator-123',
          status: 'active',
        };
      }
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return activeVpmBilling;
      }
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return { creatorAuthUserId: 'creator-123', packageId: 'com.yucp.avatar' };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.avatar',
        version: '1.2.3',
        catalogProductId: 'catalog-product-456',
      })
    );
    const body = (await response.json()) as {
      catalogProductId?: string;
      exp: string;
      headers: Record<string, string>;
      sig: string;
      tusEndpoint: string;
      versionId: string;
    };

    expect(response.status).toBe(200);
    expect(body.tusEndpoint).toBe('https://ingest.example.test/files');
    expect(body.catalogProductId).toBe('catalog-product-456');
    expect(body.headers).toEqual({
      'x-yucp-upload-catalog-product-id': 'catalog-product-456',
      'x-yucp-upload-exp': body.exp,
      'x-yucp-upload-package-id': 'com.yucp.avatar',
      'x-yucp-upload-sig': body.sig,
      'x-yucp-upload-version': '1.2.3',
      'x-yucp-upload-version-id': body.versionId,
    });
    expect(
      await verifyUploadCapability(
        {
          catalogProductId: 'catalog-product-456',
          exp: body.exp,
          packageId: 'com.yucp.avatar',
          sig: body.sig,
          version: '1.2.3',
          versionId: body.versionId,
        },
        uploadHmacKey
      )
    ).toBe(true);
  });
});
