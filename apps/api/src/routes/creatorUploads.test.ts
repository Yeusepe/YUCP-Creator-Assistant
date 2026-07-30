import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  UPLOAD_CAPABILITY_HEADERS,
  verifyUploadCapability,
} from '../../../../ops/storage-core/uploadSigning';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);
const convexMutationMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);

const apiMock = {
  certificateBilling: {
    getAccountOverview: 'certificateBilling.getAccountOverview',
  },
  packageRegistry: {
    getBuyerAccessContextByCatalogProductId: 'packageRegistry.getByIdForAuthUser',
    getByIdForAuthUser: 'packageRegistry.getByIdForAuthUser',
    getByPackageIdForAuthUser: 'packageRegistry.getByPackageIdForAuthUser',
    claimPackageForCreatorUpload: 'packageRegistry.claimPackageForCreatorUpload',
    lookupRegistration: 'packageRegistry.lookupRegistration',
  },
  packageEditions: {
    ensureCatalogTierForCreatorUpload: 'packageEditions.ensureCatalogTierForCreatorUpload',
    ensureStandardForCreatorUpload: 'packageEditions.ensureStandardForCreatorUpload',
    listForCreator: 'packageEditions.listForCreator',
  },
} as const;

mock.module('../../../../convex/_generated/api', () => ({
  api: apiMock,
  components: {},
  internal: {},
}));

mock.module('../lib/apiActor', () => ({
  createApiServiceActorBinding: async () => 'service-actor-binding',
  createAuthUserActorBinding: async () => 'creator-actor-binding',
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    mutation: convexMutationMock,
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
  it('rejects release labels that are not strict Semantic Versions', async () => {
    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.avatar',
        version: 'Summer release',
        catalogProductIds: ['avatar-product-slug'],
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'version must be a valid Semantic Version',
    });
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    convexMutationMock.mockReset();
    convexMutationMock.mockResolvedValue({
      registered: true,
      conflict: false,
      archived: false,
    });
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

  it('claims an unregistered package for every selected storefront before first upload', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args?: unknown) => {
      if (reference === apiMock.packageRegistry.lookupRegistration) {
        return null;
      }
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return activeVpmBilling;
      }
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        const catalogProductId = (args as { catalogProductId: string }).catalogProductId;
        return {
          catalogProductId,
          creatorAuthUserId: 'creator-123',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    convexMutationMock.mockResolvedValue({
      registered: true,
      conflict: false,
      archived: false,
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.first-upload',
        version: '1.0.0',
        catalogProductIds: ['catalog-product-456', 'catalog-product-789'],
      })
    );

    expect(response.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.packageRegistry.claimPackageForCreatorUpload,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'creator-123',
        catalogProductIds: ['catalog-product-456', 'catalog-product-789'],
        packageId: 'com.yucp.first-upload',
      }
    );
  });

  it('authorizes a collaborating creator to publish for the shared creator workspace', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args?: unknown) => {
      if (reference === apiMock.packageRegistry.lookupRegistration) {
        return null;
      }
      if (reference === apiMock.packageRegistry.getByIdForAuthUser) {
        expect(args).toMatchObject({
          authUserId: 'collaborating-creator',
          catalogProductId: 'shared-catalog-product',
        });
        return {
          _id: 'shared-catalog-product',
          creatorAuthUserId: 'shared-store-owner',
        };
      }
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        expect(args).toMatchObject({ authUserId: 'shared-store-owner' });
        return activeVpmBilling;
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('collaborating-creator').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.shared-store-product',
        version: '1.0.0',
        catalogProductIds: ['shared-catalog-product'],
      })
    );

    expect(response.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.packageRegistry.claimPackageForCreatorUpload,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'shared-store-owner',
        catalogProductIds: ['shared-catalog-product'],
        packageId: 'com.yucp.shared-store-product',
      }
    );
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.packageEditions.ensureStandardForCreatorUpload,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'shared-store-owner',
        catalogProductIds: ['shared-catalog-product'],
        packageId: 'com.yucp.shared-store-product',
      }
    );
    await expect(response.json()).resolves.toMatchObject({
      headers: {
        [UPLOAD_CAPABILITY_HEADERS.creatorId]: 'shared-store-owner',
      },
    });
  });

  it('returns 409 when another creator wins the package namespace claim', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.lookupRegistration) {
        return null;
      }
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return activeVpmBilling;
      }
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog-product-456',
          creatorAuthUserId: 'creator-123',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    convexMutationMock.mockResolvedValue({
      registered: false,
      conflict: true,
      archived: false,
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.contested',
        version: '1.0.0',
        catalogProductIds: ['catalog-product-456'],
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Package ID is already registered' });
  });

  it('does not claim a package namespace when creator uploads are not configured', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown) => {
      if (reference === apiMock.packageRegistry.lookupRegistration) {
        return null;
      }
      if (reference === apiMock.certificateBilling.getAccountOverview) {
        return activeVpmBilling;
      }
      if (reference === apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId) {
        return {
          catalogProductId: 'catalog-product-456',
          creatorAuthUserId: 'creator-123',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123', {
      ingestTusUrl: undefined,
      uploadHmacKey: undefined,
    }).authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.unconfigured',
        version: '1.0.0',
        catalogProductIds: ['catalog-product-456'],
      })
    );

    expect(response.status).toBe(503);
    expect(convexMutationMock).not.toHaveBeenCalled();
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
        catalogProductIds: ['catalog-product-456'],
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
        catalogProductIds: ['catalog-product-456'],
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Catalog product ownership required',
    });
  });

  it('signs the resolved catalog product id when authorization uses a product slug', async () => {
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
          catalogProductId: 'catalog-product-456',
          creatorAuthUserId: 'creator-123',
          packageId: 'com.yucp.avatar',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.avatar',
        version: '1.2.3',
        catalogProductIds: ['avatar-product-slug'],
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
    expect(convexQueryMock).toHaveBeenCalledWith(
      apiMock.packageRegistry.getBuyerAccessContextByCatalogProductId,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'creator-123',
        catalogProductId: 'avatar-product-slug',
      }
    );
    expect(body.tusEndpoint).toBe('https://ingest.example.test/files');
    expect(body.catalogProductId).toBe('catalog-product-456');
    expect(body.headers).toEqual({
      'x-yucp-upload-catalog-product-id': 'catalog-product-456',
      'x-yucp-upload-creator-id': 'creator-123',
      'x-yucp-upload-edition-id': 'standard',
      'x-yucp-upload-exp': body.exp,
      'x-yucp-upload-package-id': 'com.yucp.avatar',
      'x-yucp-upload-protection-policy-id': 'supported-visual-assets-v2',
      'x-yucp-upload-sig': body.sig,
      'x-yucp-upload-version': '1.2.3',
      'x-yucp-upload-version-id': body.versionId,
    });
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.packageEditions.ensureStandardForCreatorUpload,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'creator-123',
        catalogProductIds: ['catalog-product-456'],
        packageId: 'com.yucp.avatar',
      }
    );
    expect(
      await verifyUploadCapability(
        {
          catalogProductId: 'catalog-product-456',
          creatorId: 'creator-123',
          editionId: 'standard',
          exp: body.exp,
          packageId: 'com.yucp.avatar',
          protectionPolicyId: 'supported-visual-assets-v2',
          sig: body.sig,
          version: '1.2.3',
          versionId: body.versionId,
        },
        uploadHmacKey
      )
    ).toBe(true);
  });

  it('binds an owned package edition to the upload capability and upload identity', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args?: unknown) => {
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
        const catalogProductId = (args as { catalogProductId: string }).catalogProductId;
        return {
          catalogProductId,
          creatorAuthUserId: 'creator-123',
          packageId: 'com.yucp.avatar',
        };
      }
      if (reference === apiMock.packageEditions.listForCreator) {
        return [
          {
            catalogProductIds: ['catalog-product-456'],
            editionId: 'commercial',
            status: 'active',
          },
        ];
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        catalogProductIds: ['catalog-product-456', 'catalog-product-789'],
        editionId: 'commercial',
        packageId: 'com.yucp.avatar',
        version: '1.2.3',
      })
    );
    const body = (await response.json()) as {
      editionId?: string;
      headers: Record<string, string>;
      versionId: string;
    };

    expect(response.status).toBe(200);
    expect(body.editionId).toBe('commercial');
    expect(body.headers['x-yucp-upload-edition-id']).toBe('commercial');
    expect(convexQueryMock).toHaveBeenCalledWith(apiMock.packageEditions.listForCreator, {
      apiSecret: config.convexApiSecret,
      actor: 'creator-actor-binding',
      authUserId: 'creator-123',
      packageId: 'com.yucp.avatar',
    });
  });

  it('creates a provider-neutral edition from an owned catalog tier before upload', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args?: unknown) => {
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
          catalogProductId: (args as { catalogProductId: string }).catalogProductId,
          creatorAuthUserId: 'creator-123',
          packageId: 'com.yucp.avatar',
        };
      }
      if (reference === apiMock.packageEditions.listForCreator) {
        return [];
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        catalogProductIds: ['catalog-product-patreon'],
        catalogTierId: 'catalogtierpatreongold',
        editionId: 'tier-catalogtierpatreongold',
        packageId: 'com.yucp.avatar',
        version: '1.2.4',
      })
    );

    expect(response.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.packageEditions.ensureCatalogTierForCreatorUpload,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'creator-123',
        catalogProductIds: ['catalog-product-patreon'],
        catalogTierId: 'catalogtierpatreongold',
        editionId: 'tier-catalogtierpatreongold',
        packageId: 'com.yucp.avatar',
      }
    );
  });

  it('revalidates a catalog-tier edition on every upload authorization', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args?: unknown) => {
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
          catalogProductId: (args as { catalogProductId: string }).catalogProductId,
          creatorAuthUserId: 'creator-123',
          packageId: 'com.yucp.avatar',
        };
      }
      if (reference === apiMock.packageEditions.listForCreator) {
        return [
          {
            catalogProductIds: ['catalog-product-patreon'],
            editionId: 'tier-catalogtierpatreongold',
            status: 'active',
          },
        ];
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        catalogProductIds: ['catalog-product-patreon'],
        catalogTierId: 'catalogtierpatreongold',
        editionId: 'tier-catalogtierpatreongold',
        packageId: 'com.yucp.avatar',
        version: '1.2.5',
      })
    );

    expect(response.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.packageEditions.ensureCatalogTierForCreatorUpload,
      expect.objectContaining({
        catalogTierId: 'catalogtierpatreongold',
        editionId: 'tier-catalogtierpatreongold',
      })
    );
  });

  it('reuses one upload identity when the creator retries the same package version', async () => {
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
          catalogProductId: 'catalog-product-456',
          creatorAuthUserId: 'creator-123',
          packageId: 'com.yucp.avatar',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });
    const requestBody = {
      packageId: 'com.yucp.avatar',
      version: '1.2.3',
      catalogProductIds: ['catalog-product-456'],
    };

    const first = await createRoutes('creator-123').authorizeUpload(authorizeRequest(requestBody));
    const second = await createRoutes('creator-123').authorizeUpload(authorizeRequest(requestBody));
    const firstBody = (await first.json()) as { versionId: string };
    const secondBody = (await second.json()) as { versionId: string };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody.versionId).toBe(firstBody.versionId);
  });

  it('reuses one upload identity across equivalent store product references', async () => {
    convexQueryMock.mockImplementation(async (reference: unknown, args: unknown) => {
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
          catalogProductId: (args as { catalogProductId: string }).catalogProductId,
          creatorAuthUserId: 'creator-123',
          packageId: 'com.yucp.avatar',
        };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const gumroad = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        catalogProductIds: ['catalog-product-gumroad'],
        packageId: 'com.yucp.avatar',
        version: '1.2.3',
      })
    );
    const jinxxy = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        catalogProductIds: ['catalog-product-jinxxy'],
        packageId: 'com.yucp.avatar',
        version: '1.2.3',
      })
    );
    const gumroadBody = (await gumroad.json()) as { versionId: string };
    const jinxxyBody = (await jinxxy.json()) as { versionId: string };

    expect(gumroad.status).toBe(200);
    expect(jinxxy.status).toBe(200);
    expect(jinxxyBody.versionId).toBe(gumroadBody.versionId);
  });

  it('claims every selected storefront before authorizing an existing package upload', async () => {
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
        // No READY version yet, so the product is not bound to any packageId.
        return { catalogProductId: 'catalog-product-456', creatorAuthUserId: 'creator-123' };
      }
      throw new Error(`Unexpected query ${String(reference)}`);
    });

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.avatar',
        version: '1.0.0',
        catalogProductIds: ['catalog-product-456'],
      })
    );

    expect(response.status).toBe(200);
    expect(convexMutationMock).toHaveBeenCalledWith(
      apiMock.packageRegistry.claimPackageForCreatorUpload,
      {
        apiSecret: config.convexApiSecret,
        actor: 'creator-actor-binding',
        authUserId: 'creator-123',
        catalogProductIds: ['catalog-product-456'],
        packageId: 'com.yucp.avatar',
      }
    );
  });

  it('always authorizes the current protected upload policy for a package publisher', async () => {
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

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.avatar',
        version: '1.0.0',
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      protectionPolicyId: 'supported-visual-assets-v2',
    });
  });

  it('does not let direct clients disable the current protected upload policy', async () => {
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

    const response = await createRoutes('creator-123').authorizeUpload(
      authorizeRequest({
        packageId: 'com.yucp.avatar',
        protectionPolicyId: 'common-only-v1',
        version: '1.0.0',
      })
    );
    const body = (await response.json()) as {
      exp: string;
      headers: Record<string, string>;
      protectionPolicyId: string;
      sig: string;
      versionId: string;
    };

    expect(response.status).toBe(200);
    expect(body.protectionPolicyId).toBe('supported-visual-assets-v2');
    expect(body.headers['x-yucp-upload-protection-policy-id']).toBe('supported-visual-assets-v2');
    expect(
      await verifyUploadCapability(
        {
          creatorId: 'creator-123',
          editionId: 'standard',
          exp: body.exp,
          packageId: 'com.yucp.avatar',
          protectionPolicyId: 'supported-visual-assets-v2',
          sig: body.sig,
          version: '1.0.0',
          versionId: body.versionId,
        },
        uploadHmacKey
      )
    ).toBe(true);
  });
});
