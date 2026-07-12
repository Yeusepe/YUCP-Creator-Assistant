import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  type BackstageIngestResult,
  parseUploadClaims,
  sign,
  verify,
} from '@yucp/shared/backstageIngest';
import { zipSync } from 'fflate';

let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let actionImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let verifyBetterAuthAccessTokenImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  ok: true,
  token: {
    sub: 'auth-user-1',
    grantedScopes: ['profile:read', 'products:read', 'products:write'],
  },
});
let listProviderProductsViaApiImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  products: [],
});
let listProviderTiersViaApiImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  tiers: [],
});
let lastActionArgs: unknown;
const originalFetch = globalThis.fetch;
let lorePutBodies: Uint8Array[] = [];
const BACKSTAGE_INGEST_SECRET = '33'.repeat(32);
const MAX_BACKSTAGE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

function failUnmockedFetch(input: string | URL | Request): never {
  throw new Error(`Unexpected outbound fetch in packages.backstage.test.ts: ${String(input)}`);
}

type SyncedCatalogRow = {
  _id: string;
  aliases: string[];
  productId: string;
  provider: string;
  providerProductRef: string;
  displayName: string;
  thumbnailUrl?: string;
  canonicalSlug?: string;
  status: string;
  supportsAutoDiscovery: boolean;
  updatedAt: number;
  canArchive: boolean;
  canDelete: boolean;
  canRestore: boolean;
  backstagePackages: unknown[];
};

async function sha256HexForTest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

const defaultLoreSourceZip = zipSync({
  'Packages/com.yucp.example/package.json': [
    new TextEncoder().encode('{"name":"com.yucp.example"}'),
    { mtime: new Date(315619200000) },
  ],
});
const defaultLoreSourceSha256 = await sha256HexForTest(defaultLoreSourceZip);

const loreSourceFixture = {
  repositoryId: '',
  address: `${'1'.repeat(64)}-${'2'.repeat(32)}`,
  byteSize: defaultLoreSourceZip.byteLength,
  sha256: defaultLoreSourceSha256,
  tenantId: 'auth-user-1',
  uploadedAt: '2024-03-09T16:00:00.000Z',
};

const loreDeliveryFixture = {
  repositoryId: '',
  address: `${'3'.repeat(64)}-${'4'.repeat(32)}`,
  byteSize: 4321,
  sha256: 'd'.repeat(64),
  tenantId: 'auth-user-1',
  uploadedAt: '2024-03-09T16:01:00.000Z',
};

function makeIngestResult(overrides: Partial<BackstageIngestResult> = {}): BackstageIngestResult {
  return {
    typ: 'backstage-ingest-result',
    authUserId: 'auth-user-1',
    packageId: 'com.yucp.example',
    version: '1.2.3',
    loreSource: loreSourceFixture,
    loreDelivery: loreDeliveryFixture,
    rawSha256: loreSourceFixture.sha256,
    rawByteSize: loreSourceFixture.byteSize,
    rawDeliveryName: 'example.unitypackage',
    rawContentType: 'application/octet-stream',
    deliverableSha256: loreDeliveryFixture.sha256,
    deliverableByteSize: loreDeliveryFixture.byteSize,
    deliverableDeliveryName: 'com.yucp.example.zip',
    deliverableContentType: 'application/zip',
    exp: Math.floor(Date.now() / 1000) + 15 * 60,
    ...overrides,
  };
}

async function signedIngestResult(overrides: Partial<BackstageIngestResult> = {}): Promise<string> {
  return sign(BACKSTAGE_INGEST_SECRET, makeIngestResult(overrides));
}

function bodyToUint8Array(body: BodyInit | null | undefined): Uint8Array {
  if (!body) {
    return new Uint8Array();
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error(`Unexpected upload body type: ${typeof body}`);
}

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    authViewer: {
      getViewerByAuthUser: 'authViewer.getViewerByAuthUser',
    },
    catalogTiers: {
      upsertCatalogTier: 'catalogTiers.upsertCatalogTier',
    },
    backstageRepos: {
      getSubjectByAuthUserForApi: 'backstageRepos.getSubjectByAuthUserForApi',
      issueRepoTokenForApi: 'backstageRepos.issueRepoTokenForApi',
      publishLoreReleaseForAuthUser: 'backstageRepos.publishLoreReleaseForAuthUser',
      resolveAliasContractMetadataForApi: 'backstageRepos.resolveAliasContractMetadataForApi',
    },
    creatorProfiles: {
      getCreatorByAuthUser: 'creatorProfiles.getCreatorByAuthUser',
    },
    packageRegistry: {
      listByAuthUser: 'packageRegistry.listByAuthUser',
      listForAuthUser: 'packageRegistry.listForAuthUser',
      renameForAuthUser: 'packageRegistry.renameForAuthUser',
      archiveForAuthUser: 'packageRegistry.archiveForAuthUser',
      restoreForAuthUser: 'packageRegistry.restoreForAuthUser',
      deleteForAuthUser: 'packageRegistry.deleteForAuthUser',
      archiveProductForAuthUser: 'packageRegistry.archiveProductForAuthUser',
      restoreProductForAuthUser: 'packageRegistry.restoreProductForAuthUser',
      deleteProductForAuthUser: 'packageRegistry.deleteProductForAuthUser',
      archiveReleaseForAuthUser: 'packageRegistry.archiveReleaseForAuthUser',
      deleteReleaseForAuthUser: 'packageRegistry.deleteReleaseForAuthUser',
    },
    providerConnections: {
      getConnectionStatus: 'providerConnections.getConnectionStatus',
    },
    role_rules: {
      addCatalogProduct: 'role_rules.addCatalogProduct',
    },
  },
  internal: {},
  components: {},
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    query: (...args: unknown[]) => queryImpl(...args),
    mutation: (...args: unknown[]) => mutationImpl(...args),
    action: (...args: unknown[]) => actionImpl(...args),
  }),
}));

mock.module('../lib/oauthAccessToken', () => ({
  verifyBetterAuthAccessToken: (...args: unknown[]) => verifyBetterAuthAccessTokenImpl(...args),
}));

mock.module('../lib/apiActor', () => ({
  createAuthUserActorBinding: async () => 'actor-binding',
}));

mock.module('../internalRpc/router', () => ({
  listProviderProductsViaApi: (...args: unknown[]) => listProviderProductsViaApiImpl(...args),
  listProviderTiersViaApi: (...args: unknown[]) => listProviderTiersViaApiImpl(...args),
}));

const originalBackstageLiveSyncTimeoutMs = process.env.BACKSTAGE_LIVE_SYNC_TIMEOUT_MS;
process.env.BACKSTAGE_LIVE_SYNC_TIMEOUT_MS = '25';
const { createPackageRoutes, trimTrailingForwardSlashes } = await import('./packages');
const { loreRepositoryIdForCreator } = await import('@yucp/shared/loreBackstageClient');
const loreRepositoryId = loreRepositoryIdForCreator('auth-user-1', 'test-repository-salt');
loreSourceFixture.repositoryId = loreRepositoryId;
loreDeliveryFixture.repositoryId = loreRepositoryId;
if (originalBackstageLiveSyncTimeoutMs === undefined) {
  delete process.env.BACKSTAGE_LIVE_SYNC_TIMEOUT_MS;
} else {
  process.env.BACKSTAGE_LIVE_SYNC_TIMEOUT_MS = originalBackstageLiveSyncTimeoutMs;
}

describe('package Backstage publishing routes', () => {
  const routes = createPackageRoutes(
    {
      getSession: async () => null,
    } as never,
    {
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://creators.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      backstageIngestSecret: BACKSTAGE_INGEST_SECRET,
      ingestBaseUrl: 'https://ingest.test///',
      lore: {
        apiBaseUrl: 'https://lore.test',
        presignHmacKey: '11'.repeat(32),
        repoNamespaceSalt: 'test-repository-salt',
        accessClientId: 'lore-client-id',
        accessClientSecret: 'lore-client-secret',
      },
    }
  );

  beforeEach(() => {
    verifyBetterAuthAccessTokenImpl = async () => ({
      ok: true,
      token: {
        sub: 'auth-user-1',
        grantedScopes: ['profile:read', 'products:read', 'products:write'],
      },
    });
    lorePutBodies = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://lore.test/v1/repository/${loreRepositoryId}` && init?.method === 'PUT') {
        lorePutBodies.push(bodyToUint8Array(init.body));
        const address = `${String(lorePutBodies.length).padStart(64, '0')}-${'a'.repeat(32)}`;
        return Response.json({ data: { address } });
      }
      if (url.startsWith(`https://lore.test/v1/repository/${loreRepositoryId}/content/`)) {
        return new Response(defaultLoreSourceZip.slice().buffer as ArrayBuffer, {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        });
      }
      return failUnmockedFetch(input);
    }) as typeof fetch;
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.resolveAliasContractMetadataForApi':
          return { aliasId: 'backstage-bundle', catalogProductIds: ['product_1'] };
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'creatorProfiles.getCreatorByAuthUser':
          return { _id: 'creator_1', name: '10705330', slug: 'mapache' };
        case 'authViewer.getViewerByAuthUser':
          return {
            authUserId: 'auth-user-1',
            name: 'Mapache',
            email: null,
            image: null,
            discordUserId: 'discord-user-1',
          };
        case 'providerConnections.getConnectionStatus':
          return {};
        case 'packageRegistry.listByAuthUser':
          return {
            data: [
              {
                _id: 'product_1',
                aliases: ['Backstage Bundle'],
                productId: 'gumroad-product-1',
                provider: 'gumroad',
                providerProductRef: 'gumroad-product-1',
                displayName: 'Backstage Bundle',
                thumbnailUrl: 'https://public-files.gumroad.com/backstage-bundle.png',
                canonicalSlug: 'backstage-bundle',
                status: 'active',
                supportsAutoDiscovery: true,
                updatedAt: 1_710_000_000_000,
                canArchive: true,
                canDelete: false,
                canRestore: false,
                deleteBlockedReason: 'Product has package history.',
                catalogTiers: [
                  {
                    _id: 'tier_gold',
                    catalogProductId: 'product_1',
                    provider: 'gumroad',
                    providerTierRef: 'gumroad-tier-gold',
                    displayName: 'Gold Monthly',
                    description: 'Monthly supporter tier',
                    amountCents: 1200,
                    currency: 'USD',
                    status: 'active',
                    createdAt: 1_710_000_000_000,
                    updatedAt: 1_710_000_000_000,
                  },
                ],
                backstagePackages: [
                  {
                    packageId: 'com.yucp.example',
                    packageName: 'Example Package',
                    displayName: 'Example Package',
                    status: 'active',
                    repositoryVisibility: 'listed',
                    defaultChannel: 'stable',
                    latestPublishedVersion: '1.2.3',
                    latestRelease: {
                      deliveryPackageReleaseId: 'release_current',
                      version: '1.2.3',
                      channel: 'stable',
                      releaseStatus: 'published',
                      repositoryVisibility: 'listed',
                      artifactKey: 'artifact:example',
                      contentType: 'application/zip',
                      createdAt: 1_709_999_900_000,
                      deliveryName: 'example-package-1.2.3.zip',
                      metadata: { source: 'unitypackage' },
                      publishedAt: 1_710_000_000_000,
                      unityVersion: '2022.3',
                      updatedAt: 1_710_000_000_000,
                      zipSha256: 'a'.repeat(64),
                    },
                    releases: [
                      {
                        deliveryPackageReleaseId: 'release_current',
                        version: '1.2.3',
                        channel: 'stable',
                        releaseStatus: 'published',
                        repositoryVisibility: 'listed',
                        artifactKey: 'artifact:example',
                        contentType: 'application/zip',
                        createdAt: 1_709_999_900_000,
                        deliveryName: 'example-package-1.2.3.zip',
                        metadata: { source: 'unitypackage' },
                        publishedAt: 1_710_000_000_000,
                        unityVersion: '2022.3',
                        updatedAt: 1_710_000_000_000,
                        zipSha256: 'a'.repeat(64),
                      },
                      {
                        deliveryPackageReleaseId: 'release_old',
                        version: '1.2.2',
                        channel: 'stable',
                        releaseStatus: 'superseded',
                        repositoryVisibility: 'hidden',
                        artifactKey: 'artifact:example-older',
                        contentType: 'application/zip',
                        createdAt: 1_709_000_000_000,
                        deliveryName: 'example-package-1.2.2.zip',
                        metadata: { source: 'zip' },
                        publishedAt: 1_709_000_500_000,
                        unityVersion: '2022.3',
                        updatedAt: 1_709_001_000_000,
                        zipSha256: 'b'.repeat(64),
                      },
                    ],
                  },
                ],
              },
            ],
            hasMore: false,
            nextCursor: null,
          };
        default:
          return [];
      }
    };
    lastActionArgs = undefined;
    listProviderProductsViaApiImpl = async () => ({ products: [] });
    mutationImpl = async (ref: unknown, args: unknown) => {
      lastActionArgs = args;
      switch (ref) {
        case 'backstageRepos.issueRepoTokenForApi':
          return {
            tokenId: 'repo_token_1',
            token: 'ybt_example',
            expiresAt: 1_710_000_000_000,
          };
        case 'backstageRepos.publishLoreReleaseForAuthUser':
          return {
            deliveryPackageReleaseId: 'release_1',
            zipSha256: (args as { deliverableSha256: string }).deliverableSha256,
            version: '1.2.3',
            channel: 'stable',
          };
        case 'packageRegistry.archiveProductForAuthUser':
          return { archived: true, catalogProductId: 'product_1' };
        case 'packageRegistry.archiveReleaseForAuthUser':
          return { archived: true, deliveryPackageReleaseId: 'release_old' };
        case 'packageRegistry.deleteReleaseForAuthUser':
          return { deleted: true, deliveryPackageReleaseId: 'release_old' };
        case 'packageRegistry.deleteProductForAuthUser':
          return { deleted: true, catalogProductId: 'product_2' };
        default:
          return null;
      }
    };
    actionImpl = async (ref: unknown, args: unknown) => {
      lastActionArgs = args;
      switch (ref) {
        default:
          return null;
      }
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('trims trailing URL slashes in linear time', () => {
    expect(trimTrailingForwardSlashes('https://api.test///')).toBe('https://api.test');
    expect(trimTrailingForwardSlashes('https://api.test')).toBe('https://api.test');
    expect(trimTrailingForwardSlashes('/')).toBe('');

    const adversarialInput = 'a'.repeat(100_000);
    const startedAt = performance.now();

    expect(trimTrailingForwardSlashes(adversarialInput)).toBe(adversarialInput);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it('authorizes a TUS upload with creator-scoped signed claims', async () => {
    const before = Math.floor(Date.now() / 1000);
    const response = await routes.authorizeBackstageReleaseUpload(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-authorization', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: '1.2.3',
          deliveryName: 'example.unitypackage',
          sourceContentType: 'application/x-gzip',
          sha256: 'a'.repeat(64),
          byteSize: 2_500_000_000,
          materializeMetadata: {
            displayName: 'Example Package',
            metadata: { source: 'creator' },
          },
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      tusEndpoint: 'https://ingest.test/files',
      uploadMetadataKey: 'uploadToken',
      maxByteSize: MAX_BACKSTAGE_UPLOAD_BYTES,
    });
    expect(payload.uploadToken).toBeString();
    const claims = parseUploadClaims(
      await verify(BACKSTAGE_INGEST_SECRET, payload.uploadToken as string)
    );
    expect(claims).toMatchObject({
      typ: 'backstage-upload',
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.example',
      version: '1.2.3',
      repositoryId: loreRepositoryId,
      deliveryName: 'example.unitypackage',
      sourceContentType: 'application/x-gzip',
      declaredSha256: 'a'.repeat(64),
      byteSize: 2_500_000_000,
      materializeMetadata: {
        displayName: 'Example Package',
        metadata: { source: 'creator' },
      },
    });
    expect(claims.exp).toBeGreaterThan(before);
    expect(claims.exp).toBeLessThanOrEqual(before + 3601);
    expect(lorePutBodies).toHaveLength(0);
  });

  it('exposes upload authorization and removes the worker byte-upload handler', () => {
    const routeSurface = routes as unknown as Record<string, unknown>;

    expect(routeSurface.authorizeBackstageReleaseUpload).toBeFunction();
    expect(routeSurface.uploadBackstageReleaseSource).toBeUndefined();
  });

  it('defaults the signed upload content type without reading package bytes', async () => {
    const response = await routes.authorizeBackstageReleaseUpload(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-authorization', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: '1.2.3',
          deliveryName: 'example.zip',
          sha256: 'b'.repeat(64),
          byteSize: 1234,
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { uploadToken: string };
    const claims = parseUploadClaims(await verify(BACKSTAGE_INGEST_SECRET, payload.uploadToken));
    expect(claims.sourceContentType).toBe('application/octet-stream');
    expect(claims.byteSize).toBe(1234);
    expect(lorePutBodies).toHaveLength(0);
  });

  it('rejects malformed upload authorization digests', async () => {
    const response = await routes.authorizeBackstageReleaseUpload(
      new Request('https://api.test/upload-authorization', {
        method: 'POST',
        headers: { authorization: 'Bearer oauth-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '1.2.3',
          deliveryName: 'example.zip',
          sha256: 'not-a-digest',
          byteSize: 1234,
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'sha256 must be a lowercase hex SHA-256 digest',
    });
  });

  it('rejects upload authorization above the 5 GiB limit', async () => {
    const response = await routes.authorizeBackstageReleaseUpload(
      new Request('https://api.test/upload-authorization', {
        method: 'POST',
        headers: { authorization: 'Bearer oauth-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '1.2.3',
          deliveryName: 'too-large.unitypackage',
          sha256: 'c'.repeat(64),
          byteSize: MAX_BACKSTAGE_UPLOAD_BYTES + 1,
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Backstage package uploads are limited to 5 GiB.',
    });
  });

  it('requires the sidecar, signing, and Lore configuration for upload authorization', async () => {
    const baseConfig = {
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://creators.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
    };
    const bodies = [
      createPackageRoutes({ getSession: async () => null } as never, baseConfig),
      createPackageRoutes({ getSession: async () => null } as never, {
        ...baseConfig,
        backstageIngestSecret: BACKSTAGE_INGEST_SECRET,
        ingestBaseUrl: 'https://ingest.test',
      }),
    ];

    for (const unconfiguredRoutes of bodies) {
      const response = await unconfiguredRoutes.authorizeBackstageReleaseUpload(
        new Request('https://api.test/upload-authorization', {
          method: 'POST',
          headers: { authorization: 'Bearer oauth-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: '1.2.3',
            deliveryName: 'example.zip',
            sha256: 'd'.repeat(64),
            byteSize: 1234,
          }),
        }),
        'com.yucp.example'
      );

      expect(response.status).toBe(503);
    }
  });

  it('uploads Backstage package media as separate Lore delivery references', async () => {
    const bytes = new TextEncoder().encode('icon-bytes');

    const response = await routes.uploadBackstageReleaseMedia(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/media?kind=icon', {
        body: bytes,
        headers: {
          authorization: 'Bearer oauth-token',
          'content-type': 'image/png',
          'x-yucp-file-name': encodeURIComponent('icon.png'),
          'x-yucp-source-path': 'Assets/YUCP/icon.png',
        },
        method: 'POST',
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload).toMatchObject({
      byteSize: bytes.byteLength,
      loreDelivery: {
        address: `${'0'.repeat(63)}1-${'a'.repeat(32)}`,
        byteSize: bytes.byteLength,
        repositoryId: loreRepositoryId,
        tenantId: 'auth-user-1',
      },
      contentType: 'image/png',
      deliveryName: 'icon.png',
      kind: 'icon',
      sourcePath: 'Assets/YUCP/icon.png',
    });
    expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.loreDelivery.uploadedAt).toBeString();
    const mediaLoreSha256 = payload.loreDelivery.sha256;
    expect(mediaLoreSha256).toBe(payload.sha256);
    expect(lorePutBodies).toHaveLength(1);
    expect(lorePutBodies[0]).toEqual(bytes);
  });

  it('rejects chunked Backstage package media before reading past the media limit', async () => {
    const maxMediaBytes = 5 * 1024 * 1024;
    let pullCount = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new Uint8Array(maxMediaBytes));
          return;
        }
        if (pullCount === 2) {
          controller.enqueue(new Uint8Array([1]));
          return;
        }
        controller.error(new Error('media body should not be read after the limit is exceeded'));
      },
    });

    const response = await routes.uploadBackstageReleaseMedia(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/media?kind=icon', {
        body,
        duplex: 'half',
        headers: {
          authorization: 'Bearer oauth-token',
          'content-type': 'image/png',
          'x-yucp-file-name': encodeURIComponent('icon.png'),
        },
        method: 'POST',
      } as RequestInit & { duplex: 'half' }),
      'com.yucp.example'
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Backstage package media exceeds the maximum allowed size',
    });
    expect(pullCount).toBeGreaterThanOrEqual(2);
    expect(lorePutBodies).toEqual([]);
  });

  it('issues creator repo access links from the authenticated package workspace', async () => {
    const response = await routes.getBackstageRepoAccess(
      new Request('https://api.test/api/packages/backstage/repo-access', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      repositoryUrl: 'https://api.test/v1/backstage/repos/mapache/index.json',
      repositoryName: 'Mapache repo',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fmapache%2Findex.json&headers%5B%5D=X-YUCP-Repo-Token%3Aybt_example',
      expiresAt: 1_710_000_000_000,
    });
    expect(payload).not.toHaveProperty('repoToken');
    expect(payload).not.toHaveProperty('repoTokenHeader');
    expect(lastActionArgs).toEqual(
      expect.objectContaining({
        actor: 'actor-binding',
        authUserId: 'auth-user-1',
        subjectId: 'subject_1',
      })
    );
  });

  it('falls back to generic repo labeling for synthetic creator names', async () => {
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'backstageRepos.getSubjectByAuthUserForApi':
          return { _id: 'subject_1' };
        case 'creatorProfiles.getCreatorByAuthUser':
          return { _id: 'creator_1', name: 'Creator 10705330' };
        case 'authViewer.getViewerByAuthUser':
          return {
            authUserId: 'auth-user-1',
            name: 'Actual Discord Name',
            email: null,
            image: null,
            discordUserId: 'discord-user-1',
          };
        case 'packageRegistry.listByAuthUser':
          return {
            data: [],
            hasMore: false,
            nextCursor: null,
          };
        default:
          return [];
      }
    };

    const response = await routes.getBackstageRepoAccess(
      new Request('https://api.test/api/packages/backstage/repo-access', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      creatorName: 'Actual Discord Name',
      creatorRepoRef: 'auth-user-1',
      repositoryUrl: 'https://api.test/v1/backstage/repos/auth-user-1/index.json',
      repositoryName: 'Actual Discord Name repo',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fauth-user-1%2Findex.json&headers%5B%5D=X-YUCP-Repo-Token%3Aybt_example',
      expiresAt: 1_710_000_000_000,
    });
    expect(payload).not.toHaveProperty('repoToken');
    expect(payload).not.toHaveProperty('repoTokenHeader');
  });

  it('requires products:read before OAuth Backstage repo and package read handlers', async () => {
    verifyBetterAuthAccessTokenImpl = async (_token: unknown, options: unknown) => {
      const requiredScopes =
        typeof options === 'object' && options && 'requiredScopes' in options
          ? ((options as { requiredScopes?: string[] }).requiredScopes ?? [])
          : [];
      if (requiredScopes.includes('products:read')) {
        return { ok: false, reason: 'insufficient_scope' };
      }
      return {
        ok: true,
        token: { sub: 'auth-user-1', grantedScopes: ['profile:read'] },
      };
    };
    const queryRefs: unknown[] = [];
    const mutationRefs: unknown[] = [];
    queryImpl = async (ref: unknown) => {
      queryRefs.push(ref);
      return [];
    };
    mutationImpl = async (ref: unknown) => {
      mutationRefs.push(ref);
      return null;
    };

    const repoAccessResponse = await routes.getBackstageRepoAccess(
      new Request('https://api.test/api/packages/backstage/repo-access', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );
    const backstageProductsResponse = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );
    const packagesResponse = await routes.listPackages(
      new Request('https://api.test/api/packages', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    for (const response of [repoAccessResponse, backstageProductsResponse, packagesResponse]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'Token missing required scope: products:read',
      });
    }
    expect(queryRefs).toEqual([]);
    expect(mutationRefs).toEqual([]);
  });

  it('lists creator product links for the Backstage release picker', async () => {
    const response = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products?liveSync=true', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      products: [
        {
          aliases: ['Backstage Bundle'],
          catalogTiers: [
            {
              catalogTierId: 'tier_gold',
              catalogProductId: 'product_1',
              provider: 'gumroad',
              providerTierRef: 'gumroad-tier-gold',
              displayName: 'Gold Monthly',
              description: 'Monthly supporter tier',
              amountCents: 1200,
              currency: 'USD',
              status: 'active',
              createdAt: 1_710_000_000_000,
              updatedAt: 1_710_000_000_000,
            },
          ],
          backstagePackages: [
            {
              packageId: 'com.yucp.example',
              packageName: 'Example Package',
              displayName: 'Example Package',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '1.2.3',
              latestRelease: {
                deliveryPackageReleaseId: 'release_current',
                version: '1.2.3',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:example',
                contentType: 'application/zip',
                createdAt: 1_709_999_900_000,
                deliveryName: 'example-package-1.2.3.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_000_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_000_000,
                zipSha256: 'a'.repeat(64),
              },
              releases: [
                {
                  deliveryPackageReleaseId: 'release_current',
                  version: '1.2.3',
                  channel: 'stable',
                  releaseStatus: 'published',
                  repositoryVisibility: 'listed',
                  artifactKey: 'artifact:example',
                  contentType: 'application/zip',
                  createdAt: 1_709_999_900_000,
                  deliveryName: 'example-package-1.2.3.zip',
                  metadata: { source: 'unitypackage' },
                  publishedAt: 1_710_000_000_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_710_000_000_000,
                  zipSha256: 'a'.repeat(64),
                },
                {
                  deliveryPackageReleaseId: 'release_old',
                  version: '1.2.2',
                  channel: 'stable',
                  releaseStatus: 'superseded',
                  repositoryVisibility: 'hidden',
                  artifactKey: 'artifact:example-older',
                  contentType: 'application/zip',
                  createdAt: 1_709_000_000_000,
                  deliveryName: 'example-package-1.2.2.zip',
                  metadata: { source: 'zip' },
                  publishedAt: 1_709_000_500_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_709_001_000_000,
                  zipSha256: 'b'.repeat(64),
                },
              ],
            },
          ],
          canArchive: true,
          canDelete: false,
          canRestore: false,
          canonicalSlug: 'backstage-bundle',
          catalogProductId: 'product_1',
          displayName: 'Backstage Bundle',
          thumbnailUrl: 'https://public-files.gumroad.com/backstage-bundle.png',
          productId: 'gumroad-product-1',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_000_000,
          deleteBlockedReason: 'Product has package history.',
        },
      ],
    });
  });

  it('returns stored products by default without triggering live provider sync', async () => {
    let liveProductSyncCalls = 0;
    let liveTierSyncCalls = 0;

    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'providerConnections.getConnectionStatus':
          return { gumroad: true };
        case 'packageRegistry.listByAuthUser':
          return {
            data: [
              {
                _id: 'product_1',
                aliases: ['Backstage Bundle'],
                productId: 'gumroad-product-1',
                provider: 'gumroad',
                providerProductRef: 'gumroad-product-1',
                displayName: 'Backstage Bundle',
                thumbnailUrl: 'https://public-files.gumroad.com/backstage-bundle.png',
                canonicalSlug: 'backstage-bundle',
                status: 'active',
                supportsAutoDiscovery: true,
                updatedAt: 1_710_000_000_000,
                canArchive: true,
                canDelete: false,
                canRestore: false,
                deleteBlockedReason: 'Product has package history.',
                catalogTiers: [],
                backstagePackages: [],
              },
            ],
            hasMore: false,
            nextCursor: null,
          };
        default:
          return [];
      }
    };

    listProviderProductsViaApiImpl = async () => {
      liveProductSyncCalls += 1;
      return { products: [] };
    };
    listProviderTiersViaApiImpl = async () => {
      liveTierSyncCalls += 1;
      return { tiers: [] };
    };

    const response = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(liveProductSyncCalls).toBe(0);
    expect(liveTierSyncCalls).toBe(0);
    await expect(response.json()).resolves.toEqual({
      products: [
        {
          aliases: ['Backstage Bundle'],
          catalogTiers: [],
          backstagePackages: [],
          canArchive: true,
          canDelete: false,
          canRestore: false,
          canonicalSlug: 'backstage-bundle',
          catalogProductId: 'product_1',
          displayName: 'Backstage Bundle',
          thumbnailUrl: 'https://public-files.gumroad.com/backstage-bundle.png',
          productId: 'gumroad-product-1',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_000_000,
          deleteBlockedReason: 'Product has package history.',
        },
      ],
    });
  });

  it('surfaces alias package delivery semantics for importer-aware releases', async () => {
    const baseQueryImpl = queryImpl;
    queryImpl = async (ref: unknown, ...args: unknown[]) => {
      if (ref === 'packageRegistry.listByAuthUser') {
        return {
          data: [
            {
              _id: 'product_1',
              aliases: ['Backstage Bundle'],
              productId: 'gumroad-product-1',
              provider: 'gumroad',
              providerProductRef: 'gumroad-product-1',
              displayName: 'Backstage Bundle',
              thumbnailUrl: 'https://public-files.gumroad.com/backstage-bundle.png',
              canonicalSlug: 'backstage-bundle',
              status: 'active',
              supportsAutoDiscovery: true,
              updatedAt: 1_710_000_000_000,
              canArchive: true,
              canDelete: false,
              canRestore: false,
              deleteBlockedReason: 'Product has package history.',
              catalogTiers: [],
              backstagePackages: [
                {
                  packageId: 'com.yucp.alias.song',
                  packageName: 'Song Thing Alias',
                  displayName: 'Song Thing Alias',
                  status: 'active',
                  repositoryVisibility: 'listed',
                  defaultChannel: 'stable',
                  latestPublishedVersion: '1.2.3',
                  latestRelease: {
                    deliveryPackageReleaseId: 'release_current',
                    version: '1.2.3',
                    channel: 'stable',
                    releaseStatus: 'published',
                    repositoryVisibility: 'listed',
                    artifactKey: 'artifact:example',
                    contentType: 'application/zip',
                    createdAt: 1_709_999_900_000,
                    deliveryName: 'example-package-1.2.3.zip',
                    metadata: {
                      yucp: {
                        kind: 'alias-v1',
                        aliasId: 'song-thing',
                        installStrategy: 'server-authorized',
                        importerPackage: 'com.yucp.importer',
                        minImporterVersion: '1.4.0',
                        catalogProductIds: ['product_1'],
                        channel: 'stable',
                      },
                    },
                    aliasContract: {
                      kind: 'alias-v1',
                      aliasId: 'song-thing',
                      installStrategy: 'server-authorized',
                      importerPackage: 'com.yucp.importer',
                      minImporterVersion: '1.4.0',
                      catalogProductIds: ['product_1'],
                      channel: 'stable',
                    },
                    publishedAt: 1_710_000_000_000,
                    unityVersion: '2022.3',
                    updatedAt: 1_710_000_000_000,
                    zipSha256: 'a'.repeat(64),
                  },
                  releases: [],
                },
              ],
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      }

      return await baseQueryImpl(ref, ...args);
    };

    const response = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products?liveSync=true', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      products: [
        {
          backstagePackages: [
            {
              packageId: 'com.yucp.alias.song',
              latestRelease: {
                aliasContract: {
                  kind: 'alias-v1',
                  aliasId: 'song-thing',
                  installStrategy: 'server-authorized',
                  importerPackage: 'com.yucp.importer',
                  minImporterVersion: '1.4.0',
                  catalogProductIds: ['product_1'],
                  channel: 'stable',
                },
                importerDelivery: {
                  packageInstallStrategy: 'server-authorized',
                  repoCatalogDeliveryMode: 'repo-token-vpm-v1',
                  repoCatalogReadOnly: true,
                },
              },
            },
          ],
        },
      ],
    });
  });

  it('syncs provider tiers into the Backstage picker and strips Patreon HTML descriptions', async () => {
    let syncedTiers: Array<{
      _id: string;
      catalogProductId: string;
      provider: string;
      providerTierRef: string;
      displayName: string;
      description?: string;
      amountCents?: number;
      currency?: string;
      status: 'active' | 'archived';
      createdAt: number;
      updatedAt: number;
    }> = [
      {
        _id: 'tier_existing',
        catalogProductId: 'product_1',
        provider: 'patreon',
        providerTierRef: 'tier_existing',
        displayName: 'Existing Tier',
        description: '<p>Legacy <strong>HTML</strong></p>',
        amountCents: 500,
        currency: 'USD',
        status: 'active',
        createdAt: 1_710_000_000_000,
        updatedAt: 1_710_000_000_000,
      },
    ];
    const tierUpserts: Array<Record<string, unknown>> = [];

    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'providerConnections.getConnectionStatus':
          return { patreon: true };
        case 'packageRegistry.listByAuthUser':
          return {
            data: [
              {
                _id: 'product_1',
                aliases: ['Membership Bundle'],
                productId: 'patreon-campaign-1',
                provider: 'patreon',
                providerProductRef: 'patreon-campaign-1',
                displayName: 'Membership Bundle',
                canonicalSlug: 'membership-bundle',
                status: 'active',
                supportsAutoDiscovery: true,
                updatedAt: 1_710_000_000_000,
                canArchive: true,
                canDelete: true,
                canRestore: false,
                catalogTiers: syncedTiers,
                backstagePackages: [],
              },
            ],
          };
        default:
          return null;
      }
    };

    mutationImpl = async (ref: unknown, args: unknown) => {
      switch (ref) {
        case 'catalogTiers.upsertCatalogTier': {
          const payload = args as {
            providerTierRef: string;
            displayName: string;
            description?: string;
            amountCents?: number;
            currency?: string;
            status?: 'active' | 'archived';
          };
          tierUpserts.push(payload as Record<string, unknown>);
          syncedTiers = [
            ...syncedTiers.filter((tier) => tier.providerTierRef !== payload.providerTierRef),
            {
              _id: payload.providerTierRef,
              catalogProductId: 'product_1',
              provider: 'patreon',
              providerTierRef: payload.providerTierRef,
              displayName: payload.displayName,
              description: payload.description,
              amountCents: payload.amountCents,
              currency: payload.currency,
              status: payload.status ?? 'active',
              createdAt: 1_710_000_000_000,
              updatedAt: 1_710_000_000_100,
            },
          ];
          return payload.providerTierRef;
        }
        default:
          return null;
      }
    };

    listProviderProductsViaApiImpl = async () => ({ products: [] });
    listProviderTiersViaApiImpl = async () => ({
      tiers: [
        {
          id: 'tier_existing',
          productId: 'patreon-campaign-1',
          name: 'Existing Tier',
          description: '<p>Legacy <strong>HTML</strong></p>',
          amountCents: 500,
          currency: 'USD',
          active: true,
        },
        {
          id: 'tier_gold',
          productId: 'patreon-campaign-1',
          name: 'Gold Monthly',
          description: '<div><p>Includes <strong>Discord</strong> role &#999999999;</p></div>',
          amountCents: 1200,
          currency: 'USD',
          active: true,
        },
      ],
    });

    const response = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products?liveSync=true', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(tierUpserts).toHaveLength(2);
    await expect(response.json()).resolves.toMatchObject({
      products: [
        {
          catalogProductId: 'product_1',
          provider: 'patreon',
          catalogTiers: [
            {
              catalogTierId: 'tier_existing',
              displayName: 'Existing Tier',
              description: 'Legacy HTML',
            },
            {
              catalogTierId: 'tier_gold',
              displayName: 'Gold Monthly',
              description: 'Includes Discord role &#999999999;',
            },
          ],
        },
      ],
    });
  });

  it('syncs connected provider products into the Backstage picker with canonical identity metadata', async () => {
    const catalogUpserts: Array<Record<string, unknown>> = [];
    const syncedCatalogRows: SyncedCatalogRow[] = [
      {
        _id: 'product_song_gumroad',
        aliases: [],
        productId: 'QAJc7ErxdAC815P5P8R89g==',
        provider: 'gumroad',
        providerProductRef: 'QAJc7ErxdAC815P5P8R89g==',
        displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
        thumbnailUrl: 'https://public-files.gumroad.com/song-thing.png',
        canonicalSlug: 'song-thing',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1_710_000_000_000,
        canArchive: true,
        canDelete: true,
        canRestore: false,
        backstagePackages: [],
      },
    ];

    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'providerConnections.getConnectionStatus':
          return {
            gumroad: true,
            jinxxy: true,
            patreon: false,
          };
        case 'packageRegistry.listByAuthUser':
          return {
            data: syncedCatalogRows,
            hasMore: false,
            nextCursor: null,
          };
        default:
          return [];
      }
    };

    listProviderProductsViaApiImpl = async (_config: unknown, request: unknown) => {
      const provider = (request as { provider?: string }).provider;
      if (provider === 'gumroad') {
        return {
          products: [
            {
              id: 'QAJc7ErxdAC815P5P8R89g==',
              name: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
              productUrl: 'https://yeusepe.gumroad.com/l/songthing',
              thumbnailUrl: 'https://public-files.gumroad.com/song-thing.png',
            },
          ],
        };
      }
      if (provider === 'jinxxy') {
        return {
          products: [
            {
              id: '3788600424102102387',
              name: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
              aliases: ['Song Thing Deluxe'],
              canonicalSlug: 'song-thing',
            },
          ],
        };
      }
      return { products: [] };
    };

    mutationImpl = async (ref: unknown, args: unknown) => {
      if (ref === 'role_rules.addCatalogProduct') {
        catalogUpserts.push(args as Record<string, unknown>);
        syncedCatalogRows.push({
          _id: 'product_song_jinxxy',
          aliases: Array.isArray((args as { aliases?: unknown }).aliases)
            ? ([...(args as { aliases: string[] }).aliases] as string[])
            : [],
          productId: (args as { productId: string }).productId,
          provider: (args as { provider: string }).provider,
          providerProductRef: (args as { providerProductRef: string }).providerProductRef,
          displayName:
            (args as { displayName?: string }).displayName ??
            'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
          canonicalSlug: (args as { canonicalSlug?: string }).canonicalSlug,
          status: 'active',
          supportsAutoDiscovery: false,
          updatedAt: 1_710_000_000_001,
          canArchive: true,
          canDelete: true,
          canRestore: false,
          backstagePackages: [],
        });
        return {
          productId: (args as { productId: string }).productId,
          catalogProductId:
            (args as { provider: string }).provider === 'gumroad'
              ? 'product_song_gumroad'
              : 'product_song_jinxxy',
        };
      }
      return null;
    };

    const response = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products?liveSync=true', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(catalogUpserts).toHaveLength(1);
    expect(catalogUpserts).toEqual([
      {
        apiSecret: 'convex-secret',
        authUserId: 'auth-user-1',
        productId: '3788600424102102387',
        providerProductRef: '3788600424102102387',
        provider: 'jinxxy',
        canonicalUrl: 'https://jinxxy.app/products/3788600424102102387',
        supportsAutoDiscovery: false,
        aliases: ['Song Thing Deluxe'],
        canonicalSlug: 'song-thing',
        displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
      },
    ]);
    await expect(response.json()).resolves.toEqual({
      products: [
        {
          aliases: [],
          backstagePackages: [],
          canArchive: true,
          canDelete: true,
          canRestore: false,
          canonicalSlug: 'song-thing',
          catalogProductId: 'product_song_gumroad',
          catalogTiers: [],
          displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
          thumbnailUrl: 'https://public-files.gumroad.com/song-thing.png',
          productId: 'QAJc7ErxdAC815P5P8R89g==',
          provider: 'gumroad',
          providerProductRef: 'QAJc7ErxdAC815P5P8R89g==',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_000_000,
        },
        {
          aliases: ['Song Thing Deluxe'],
          backstagePackages: [],
          canArchive: true,
          canDelete: true,
          canRestore: false,
          canonicalSlug: 'song-thing',
          catalogProductId: 'product_song_jinxxy',
          catalogTiers: [],
          displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
          productId: '3788600424102102387',
          provider: 'jinxxy',
          providerProductRef: '3788600424102102387',
          status: 'active',
          supportsAutoDiscovery: false,
          updatedAt: 1_710_000_000_001,
        },
      ],
    });
  });

  it('backfills canonical identity metadata for existing synced products during live sync', async () => {
    const catalogUpserts: Array<Record<string, unknown>> = [];
    const syncedCatalogRows: SyncedCatalogRow[] = [
      {
        _id: 'product_song_jinxxy',
        aliases: [],
        productId: '3788600424102102387',
        provider: 'jinxxy',
        providerProductRef: '3788600424102102387',
        displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
        canonicalSlug: undefined,
        status: 'active',
        supportsAutoDiscovery: false,
        updatedAt: 1_710_000_000_001,
        canArchive: true,
        canDelete: true,
        canRestore: false,
        backstagePackages: [],
      },
    ];

    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'providerConnections.getConnectionStatus':
          return {
            gumroad: false,
            jinxxy: true,
            patreon: false,
          };
        case 'packageRegistry.listByAuthUser':
          return {
            data: syncedCatalogRows,
            hasMore: false,
            nextCursor: null,
          };
        default:
          return [];
      }
    };

    listProviderProductsViaApiImpl = async (_config: unknown, request: unknown) => {
      const provider = (request as { provider?: string }).provider;
      if (provider === 'jinxxy') {
        return {
          products: [
            {
              id: '3788600424102102387',
              name: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
              aliases: ['Song Thing Deluxe'],
              canonicalSlug: 'song-thing',
            },
          ],
        };
      }
      return { products: [] };
    };

    mutationImpl = async (ref: unknown, args: unknown) => {
      if (ref === 'role_rules.addCatalogProduct') {
        catalogUpserts.push(args as Record<string, unknown>);
        syncedCatalogRows[0] = {
          ...syncedCatalogRows[0],
          aliases: [...((args as { aliases?: string[] }).aliases ?? [])] as string[],
          canonicalSlug: (args as { canonicalSlug?: string }).canonicalSlug,
        };
        return {
          productId: (args as { productId: string }).productId,
          catalogProductId: 'product_song_jinxxy',
        };
      }
      return null;
    };

    const response = await routes.listBackstageProducts(
      new Request('https://api.test/api/packages/backstage/products?liveSync=true', {
        method: 'GET',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(catalogUpserts).toHaveLength(1);
    expect(catalogUpserts[0]).toMatchObject({
      provider: 'jinxxy',
      providerProductRef: '3788600424102102387',
      canonicalSlug: 'song-thing',
      aliases: ['Song Thing Deluxe'],
    });
    await expect(response.json()).resolves.toEqual({
      products: [
        {
          aliases: ['Song Thing Deluxe'],
          backstagePackages: [],
          canArchive: true,
          canDelete: true,
          canRestore: false,
          canonicalSlug: 'song-thing',
          catalogProductId: 'product_song_jinxxy',
          catalogTiers: [],
          displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
          thumbnailUrl: undefined,
          productId: '3788600424102102387',
          provider: 'jinxxy',
          providerProductRef: '3788600424102102387',
          status: 'active',
          supportsAutoDiscovery: false,
          updatedAt: 1_710_000_000_001,
        },
      ],
    });
  });

  it('returns stored products when live provider sync stalls', async () => {
    const previousTimeout = process.env.BACKSTAGE_LIVE_SYNC_TIMEOUT_MS;
    process.env.BACKSTAGE_LIVE_SYNC_TIMEOUT_MS = '25';
    queryImpl = async (ref: unknown) => {
      switch (ref) {
        case 'providerConnections.getConnectionStatus':
          return { gumroad: true };
        case 'packageRegistry.listByAuthUser':
          return {
            data: [
              {
                _id: 'product_1',
                aliases: ['Backstage Bundle'],
                productId: 'gumroad-product-1',
                provider: 'gumroad',
                providerProductRef: 'gumroad-product-1',
                displayName: 'Backstage Bundle',
                thumbnailUrl: 'https://public-files.gumroad.com/backstage-bundle.png',
                canonicalSlug: 'backstage-bundle',
                status: 'active',
                supportsAutoDiscovery: true,
                updatedAt: 1_710_000_000_000,
                canArchive: true,
                canDelete: false,
                canRestore: false,
                deleteBlockedReason: 'Product has package history.',
                catalogTiers: [],
                backstagePackages: [],
              },
            ],
            hasMore: false,
            nextCursor: null,
          };
        default:
          return [];
      }
    };

    listProviderProductsViaApiImpl = async () => new Promise<never>(() => {});

    const outcome = (await Promise.race([
      routes
        .listBackstageProducts(
          new Request('https://api.test/api/packages/backstage/products?liveSync=true', {
            method: 'GET',
            headers: {
              authorization: 'Bearer oauth-token',
            },
          })
        )
        .then(async (response) => ({
          type: 'response' as const,
          status: response.status,
          payload: await response.json(),
        })),
      new Promise<{ type: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ type: 'timeout' }), 250)
      ),
    ]).finally(() => {
      if (previousTimeout === undefined) {
        delete process.env.BACKSTAGE_LIVE_SYNC_TIMEOUT_MS;
      } else {
        process.env.BACKSTAGE_LIVE_SYNC_TIMEOUT_MS = previousTimeout;
      }
    })) as
      | { type: 'response'; status: number; payload: { products: Array<Record<string, unknown>> } }
      | { type: 'timeout' };

    expect(outcome).not.toEqual({ type: 'timeout' });
    if (outcome.type !== 'response') {
      throw new Error('Backstage products response timed out');
    }

    expect(outcome.status).toBe(200);
    expect(outcome.payload).toEqual({
      products: [
        expect.objectContaining({
          catalogProductId: 'product_1',
          displayName: 'Backstage Bundle',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-1',
        }),
      ],
    });
  });

  it('hides and deletes Backstage product links through catalog product mutations', async () => {
    const archiveResponse = await routes.archiveBackstageProduct(
      new Request('https://api.test/api/packages/backstage/products/product_1/archive', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'product_1'
    );
    expect(archiveResponse.status).toBe(200);
    await expect(archiveResponse.json()).resolves.toEqual({
      archived: true,
      catalogProductId: 'product_1',
    });

    const deleteResponse = await routes.deleteBackstageProduct(
      new Request('https://api.test/api/packages/backstage/products/product_2', {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'product_2'
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      deleted: true,
      catalogProductId: 'product_2',
    });
  });

  it('archives old Backstage package releases through release mutations', async () => {
    const response = await routes.archiveBackstageRelease(
      new Request(
        'https://api.test/api/packages/com.yucp.example/backstage/releases/release_old/archive',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
          },
        }
      ),
      'com.yucp.example',
      'release_old'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archived: true,
      deliveryPackageReleaseId: 'release_old',
    });
  });

  it('deletes old Backstage package releases through release mutations', async () => {
    const response = await routes.deleteBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases/release_old', {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'com.yucp.example',
      'release_old'
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      deliveryPackageReleaseId: 'release_old',
    });
  });

  it('requires products:write before accepting OAuth Backstage release publishing', async () => {
    verifyBetterAuthAccessTokenImpl = async (_token: unknown, options: unknown) => {
      const requiredScopes =
        typeof options === 'object' && options && 'requiredScopes' in options
          ? ((options as { requiredScopes?: string[] }).requiredScopes ?? [])
          : [];
      if (requiredScopes.includes('products:write')) {
        return { ok: false, reason: 'insufficient_scope' };
      }
      return {
        ok: true,
        token: { sub: 'auth-user-1', grantedScopes: ['profile:read'] },
      };
    };

    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          ingestResult: await signedIngestResult(),
          version: '1.2.3',
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Token missing required scope: products:write',
    });
    expect(lastActionArgs).toBeUndefined();
    expect(lorePutBodies).toHaveLength(0);
  });

  it('requires products:write before OAuth Backstage upload setup and destructive handlers', async () => {
    verifyBetterAuthAccessTokenImpl = async (_token: unknown, options: unknown) => {
      const requiredScopes =
        typeof options === 'object' && options && 'requiredScopes' in options
          ? ((options as { requiredScopes?: string[] }).requiredScopes ?? [])
          : [];
      if (requiredScopes.includes('products:write')) {
        return { ok: false, reason: 'insufficient_scope' };
      }
      return {
        ok: true,
        token: { sub: 'auth-user-1', grantedScopes: ['profile:read'] },
      };
    };

    const uploadSessionResponse = await routes.authorizeBackstageReleaseUpload(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-authorization', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: '1.2.3',
          deliveryName: 'example.unitypackage',
          sha256: 'e'.repeat(64),
          byteSize: 1,
        }),
      }),
      'com.yucp.example'
    );
    const mediaResponse = await routes.uploadBackstageReleaseMedia(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/media?kind=icon', {
        body: new TextEncoder().encode('icon-bytes'),
        headers: {
          authorization: 'Bearer oauth-token',
          'content-type': 'image/png',
        },
        method: 'POST',
      }),
      'com.yucp.example'
    );
    const archiveProductResponse = await routes.archiveBackstageProduct(
      new Request('https://api.test/api/packages/backstage/products/product_1/archive', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'product_1'
    );
    const deleteProductResponse = await routes.deleteBackstageProduct(
      new Request('https://api.test/api/packages/backstage/products/product_2', {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'product_2'
    );
    const archiveReleaseResponse = await routes.archiveBackstageRelease(
      new Request(
        'https://api.test/api/packages/com.yucp.example/backstage/releases/release_old/archive',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
          },
        }
      ),
      'com.yucp.example',
      'release_old'
    );
    const deleteReleaseResponse = await routes.deleteBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases/release_old', {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'com.yucp.example',
      'release_old'
    );

    for (const response of [
      uploadSessionResponse,
      mediaResponse,
      archiveProductResponse,
      deleteProductResponse,
      archiveReleaseResponse,
      deleteReleaseResponse,
    ]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'Token missing required scope: products:write',
      });
    }
    expect(lastActionArgs).toBeUndefined();
    expect(lorePutBodies).toHaveLength(0);
  });

  it('requires signing configuration before publishing a sidecar result', async () => {
    const unconfiguredRoutes = createPackageRoutes({ getSession: async () => null } as never, {
      apiBaseUrl: 'https://api.test',
      frontendBaseUrl: 'https://creators.test',
      convexApiSecret: 'convex-secret',
      convexSiteUrl: 'https://convex.test',
      convexUrl: 'https://convex.cloud',
      ingestBaseUrl: 'https://ingest.test',
      lore: {
        apiBaseUrl: 'https://lore.test',
        presignHmacKey: '11'.repeat(32),
        repoNamespaceSalt: 'test-repository-salt',
        accessClientId: 'lore-client-id',
        accessClientSecret: 'lore-client-secret',
      },
    });
    const response = await unconfiguredRoutes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          ingestResult: await signedIngestResult(),
          version: '1.2.3',
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Backstage ingest service is not configured',
    });
    expect(lastActionArgs).toBeUndefined();
  });

  it('publishes uploaded Backstage releases for the authenticated creator', async () => {
    const bundle = makeIngestResult();
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1', 'product_2'],
          ingestResult: await sign(BACKSTAGE_INGEST_SECRET, bundle),
          version: '1.2.3',
          channel: 'stable',
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(201);
    expect(lastActionArgs).toMatchObject({
      accessSelectors: [
        { kind: 'catalogProduct', catalogProductId: 'product_1' },
        { kind: 'catalogProduct', catalogProductId: 'product_2' },
      ],
    });
    const payload = await response.json();
    expect(payload).toMatchObject({
      deliveryPackageReleaseId: 'release_1',
      version: '1.2.3',
      channel: 'stable',
    });
    expect(payload.zipSha256).toBe(
      (lastActionArgs as { deliverableSha256: string }).deliverableSha256
    );
    expect(payload).not.toHaveProperty('rawArtifactId');
    expect(payload).not.toHaveProperty('deliverableArtifactId');
    expect(payload).not.toHaveProperty('deliveryArtifactMode');
    expect(payload).not.toHaveProperty('materializationStrategy');
    expect(lastActionArgs).toMatchObject({
      loreSource: bundle.loreSource,
      loreDelivery: bundle.loreDelivery,
      rawSha256: bundle.rawSha256,
      rawByteSize: bundle.rawByteSize,
      rawDeliveryName: bundle.rawDeliveryName,
      rawContentType: bundle.rawContentType,
      deliverableSha256: bundle.deliverableSha256,
      deliverableByteSize: bundle.deliverableByteSize,
      deliverableDeliveryName: bundle.deliverableDeliveryName,
      deliverableContentType: bundle.deliverableContentType,
    });
    expect(lorePutBodies).toHaveLength(0);
  });

  it('rejects ingest results owned by another creator or tenant', async () => {
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          ingestResult: await signedIngestResult({ authUserId: 'other-auth-user' }),
          version: '1.2.3',
          channel: 'stable',
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Ingest result is not owned by this creator',
    });

    for (const wrongTenantResult of [
      makeIngestResult({
        loreSource: { ...loreSourceFixture, tenantId: 'other-auth-user' },
      }),
      makeIngestResult({
        loreDelivery: { ...loreDeliveryFixture, tenantId: 'other-auth-user' },
      }),
    ]) {
      const wrongTenantResponse = await routes.publishBackstageRelease(
        new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            catalogProductIds: ['product_1'],
            ingestResult: await sign(BACKSTAGE_INGEST_SECRET, wrongTenantResult),
            version: '1.2.3',
            channel: 'stable',
          }),
        }),
        'com.yucp.example'
      );
      expect(wrongTenantResponse.status).toBe(403);
      await expect(wrongTenantResponse.json()).resolves.toEqual({
        error: 'Ingest result is not owned by this creator',
      });
    }
    expect(lorePutBodies).toHaveLength(0);
    expect(lastActionArgs).toBeUndefined();
  });

  it('rejects tampered and expired ingest results', async () => {
    const validToken = await signedIngestResult();
    const tamperedToken = `${validToken.slice(0, -1)}${validToken.endsWith('a') ? 'b' : 'a'}`;
    const expiredToken = await signedIngestResult({ exp: Math.floor(Date.now() / 1000) - 1 });

    for (const ingestResult of [tamperedToken, expiredToken]) {
      const response = await routes.publishBackstageRelease(
        new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
          method: 'POST',
          headers: {
            authorization: 'Bearer oauth-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            catalogProductIds: ['product_1'],
            ingestResult,
            version: '1.2.3',
          }),
        }),
        'com.yucp.example'
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Invalid or expired ingest result',
      });
    }
    expect(lastActionArgs).toBeUndefined();
  });

  it('rejects release-version and package mismatches in signed ingest results', async () => {
    const versionResponse = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          ingestResult: await signedIngestResult(),
          version: '9.9.9',
        }),
      }),
      'com.yucp.example'
    );

    expect(versionResponse.status).toBe(409);
    await expect(versionResponse.json()).resolves.toEqual({
      error: 'Ingest result does not match the release version — re-upload',
    });

    const packageResponse = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          ingestResult: await signedIngestResult({ packageId: 'com.yucp.other' }),
          version: '1.2.3',
        }),
      }),
      'com.yucp.example'
    );
    expect(packageResponse.status).toBe(400);
    await expect(packageResponse.json()).resolves.toEqual({
      error: 'Ingest result does not match the release package',
    });
    expect(lastActionArgs).toBeUndefined();
  });

  it('publishes sidecar materialization results without touching artifact bytes', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCount += 1;
      return failUnmockedFetch(input);
    }) as unknown as typeof fetch;
    const bundle = makeIngestResult({
      packageId: 'com.yucp.songthing',
      version: '1.0.6',
      rawDeliveryName: 'Song Thing_1.0.6.unitypackage',
      deliverableDeliveryName: 'vrc-get-com.yucp.songthing-1.0.6.zip',
    });
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.songthing/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          ingestResult: await sign(BACKSTAGE_INGEST_SECRET, bundle),
          version: '1.0.6',
          channel: 'stable',
          displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
        }),
      }),
      'com.yucp.songthing'
    );

    expect(response.status).toBe(201);
    expect(fetchCount).toBe(0);
    expect(lorePutBodies).toHaveLength(0);
    expect(lastActionArgs).toMatchObject({
      loreSource: bundle.loreSource,
      loreDelivery: bundle.loreDelivery,
      rawSha256: bundle.rawSha256,
      rawByteSize: bundle.rawByteSize,
      rawDeliveryName: bundle.rawDeliveryName,
      rawContentType: bundle.rawContentType,
      deliverableSha256: bundle.deliverableSha256,
      deliverableByteSize: bundle.deliverableByteSize,
      deliverableDeliveryName: bundle.deliverableDeliveryName,
      deliverableContentType: bundle.deliverableContentType,
    });
  });

  it('preserves alias package metadata when publishing Backstage releases', async () => {
    const metadata = {
      yucp: {
        kind: 'alias-v1',
        aliasId: 'song-thing',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: '1.4.0',
        catalogProductIds: ['product_1'],
        channel: 'stable',
      },
    };

    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.alias.song/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          ingestResult: await signedIngestResult({
            packageId: 'com.yucp.alias.song',
          }),
          version: '1.2.3',
          channel: 'stable',
          metadata,
        }),
      }),
      'com.yucp.alias.song'
    );

    expect(response.status).toBe(201);
    expect(lastActionArgs).toMatchObject({
      packageId: 'com.yucp.alias.song',
      metadata: {
        yucp: {
          kind: 'alias-v1',
          aliasId: 'backstage-bundle',
          catalogProductIds: ['product_1'],
          channel: 'stable',
        },
      },
    });
  });

  it('publishes server-generated metadata alongside the verified sidecar bundle', async () => {
    const bundle = makeIngestResult({
      version: '4.0.0',
      rawDeliveryName: 'avatar-installer.unitypackage',
    });
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          ingestResult: await sign(BACKSTAGE_INGEST_SECRET, bundle),
          version: '4.0.0',
          displayName: 'Avatar Installer',
          description: 'Server-generated wrapper metadata',
          unityVersion: '2022.3',
          dependencyVersions: [{ packageId: 'com.yucp.importer', version: '1.4.0' }],
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(201);
    expect(lorePutBodies).toHaveLength(0);
    expect(lastActionArgs).toMatchObject({
      loreSource: bundle.loreSource,
      loreDelivery: bundle.loreDelivery,
      rawDeliveryName: bundle.rawDeliveryName,
      rawContentType: bundle.rawContentType,
      displayName: 'Avatar Installer',
      description: 'Server-generated wrapper metadata',
      unityVersion: '2022.3',
      metadata: {
        vpmDependencies: { 'com.yucp.importer': '1.4.0' },
      },
    });
  });

  it('publishes uploaded Backstage releases with selector-based access rules', async () => {
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accessSelectors: [
            { kind: 'catalogProduct', catalogProductId: 'product_1' },
            { kind: 'catalogTier', catalogTierId: 'tier_1' },
          ],
          ingestResult: await signedIngestResult({ version: '5.0.0' }),
          version: '5.0.0',
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(201);
    expect(lastActionArgs).toMatchObject({
      accessSelectors: [
        { kind: 'catalogProduct', catalogProductId: 'product_1' },
        { kind: 'catalogTier', catalogTierId: 'tier_1' },
      ],
    });
  });
});
