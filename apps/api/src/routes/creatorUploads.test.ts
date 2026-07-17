import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { verifyUploadCapability } from '../../../../ops/storage-core/uploadSigning';

const convexQueryMock = mock(async (_reference?: unknown, _args?: unknown) => null as unknown);

const apiMock = {
  packageRegistry: {
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

function createRoutes(userId: string | null) {
  return createCreatorUploadRoutes({
    auth: {
      getSession: async () =>
        userId
          ? {
              user: { id: userId },
            }
          : null,
    } as never,
    config,
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

  it('returns a verifiable capability for the package owner', async () => {
    convexQueryMock.mockResolvedValue({
      packageId: 'com.yucp.avatar',
      yucpUserId: 'creator-123',
      status: 'active',
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
      'x-yucp-upload-exp': body.exp,
      'x-yucp-upload-sig': body.sig,
      'x-yucp-upload-version-id': body.versionId,
    });
    expect(
      await verifyUploadCapability(
        { exp: body.exp, sig: body.sig, versionId: body.versionId },
        uploadHmacKey
      )
    ).toBe(true);
  });
});
