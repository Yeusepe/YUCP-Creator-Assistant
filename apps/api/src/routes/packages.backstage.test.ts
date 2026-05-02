import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { gzipSync, unzipSync, zipSync } from 'fflate';

let mutationImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let actionImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let queryImpl: (...args: unknown[]) => Promise<unknown> = async () => null;
let listProviderProductsViaApiImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  products: [],
});
let listProviderTiersViaApiImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  tiers: [],
});
let lastActionArgs: unknown;
const originalFetch = globalThis.fetch;
let cdngineUploadCounter = 0;
let cdngineCreateUploadBodies: unknown[] = [];
let cdngineUploadTargetBodies: Array<{ url: string; bytes: Uint8Array }> = [];

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

const cdngineSourceFixture = {
  assetId: 'ast_source_1',
  assetOwner: 'creator:auth-user-1',
  byteSize: 128,
  serviceNamespaceId: 'yucp-backstage',
  sha256: 'c'.repeat(64),
  tenantId: 'auth-user-1',
  uploadedAt: 1_710_000_000_000,
  versionId: 'ver_source_1',
};

function writeAscii(target: Uint8Array, offset: number, length: number, value: string) {
  const encoded = new TextEncoder().encode(value);
  target.set(encoded.subarray(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeAscii(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function writeChecksum(target: Uint8Array, value: number) {
  const encoded = value.toString(8).padStart(6, '0');
  writeAscii(target, 148, 6, encoded);
  target[154] = 0;
  target[155] = 0x20;
}

function buildTarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 315619200);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar');
  writeAscii(header, 263, 2, '00');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeChecksum(header, checksum);
  return header;
}

function buildUnitypackage(entries: Array<{ path: string; content: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    blocks.push(buildTarHeader(entry.path, entry.content.byteLength));
    blocks.push(entry.content);
    const remainder = entry.content.byteLength % 512;
    if (remainder !== 0) {
      blocks.push(new Uint8Array(512 - remainder));
    }
  }
  blocks.push(new Uint8Array(1024));
  const bytes = new Uint8Array(blocks.reduce((sum, block) => sum + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    bytes.set(block, offset);
    offset += block.byteLength;
  }
  return gzipSync(bytes, { level: 9, mtime: 315619200 });
}

function responseFromBytes(bytes: Uint8Array, contentType: string): Response {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(new Blob([body], { type: contentType }), {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
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
      publishCdngineReleaseForAuthUser: 'backstageRepos.publishCdngineReleaseForAuthUser',
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
  verifyBetterAuthAccessToken: async () => ({
    ok: true,
    token: { sub: 'auth-user-1' },
  }),
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
const { createPackageRoutes } = await import('./packages');
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
      cdngine: {
        apiBaseUrl: 'https://cdngine.test',
        accessToken: 'cdngine-token',
      },
    }
  );

  beforeEach(() => {
    cdngineUploadCounter = 0;
    cdngineCreateUploadBodies = [];
    cdngineUploadTargetBodies = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/source/authorize')) {
        return new Response(JSON.stringify({ url: 'https://cdn.test/source.zip' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://cdn.test/source.zip') {
        const sourceZip = zipSync({
          'Packages/com.yucp.example/package.json': [
            new TextEncoder().encode('{"name":"com.yucp.example"}'),
            { mtime: new Date() },
          ],
        });
        const sourceZipBuffer = sourceZip.buffer.slice(
          sourceZip.byteOffset,
          sourceZip.byteOffset + sourceZip.byteLength
        ) as ArrayBuffer;
        return new Response(new Blob([sourceZipBuffer], { type: 'application/zip' }), {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        });
      }
      if (url === 'https://cdngine.test/v1/upload-sessions') {
        cdngineUploadCounter += 1;
        cdngineCreateUploadBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            uploadSessionId: `upl_${cdngineUploadCounter}`,
            assetId: `ast_${cdngineUploadCounter}`,
            versionId: `ver_pending_${cdngineUploadCounter}`,
            uploadTarget: {
              protocol: 'tus',
              method: 'PATCH',
              url: `https://uploads.cdngine.test/files/upl_${cdngineUploadCounter}`,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://uploads.cdngine.test/files/')) {
        cdngineUploadTargetBodies.push({
          url,
          bytes: bodyToUint8Array(init?.body),
        });
        return new Response(null, { status: 204 });
      }
      const completeMatch = url.match(
        /^https:\/\/cdngine\.test\/v1\/upload-sessions\/upl_(\d+)\/complete$/
      );
      if (completeMatch) {
        return new Response(
          JSON.stringify({
            assetId: `ast_${completeMatch[1]}`,
            versionId: `ver_${completeMatch[1]}`,
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
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
        case 'backstageRepos.publishCdngineReleaseForAuthUser':
          return {
            deliveryPackageReleaseId: 'release_1',
            zipSha256: 'a'.repeat(64),
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

  it('creates upload URLs for Backstage package release uploads', async () => {
    const response = await routes.createBackstageReleaseUploadUrl(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-url', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.packageId).toBe('com.yucp.example');
    expect(payload.uploadUrl).toStartWith(
      'https://api.test/api/packages/com.yucp.example/backstage/upload-source?uploadToken='
    );
  });

  it('creates direct CDNgine upload sessions for 5 GiB Backstage packages without accepting bytes', async () => {
    const fiveGib = 5 * 1024 * 1024 * 1024;
    const response = await routes.createBackstageReleaseUploadSession(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-session', {
        body: JSON.stringify({
          byteSize: fiveGib,
          deliveryName: 'huge.unitypackage',
          sha256: 'f'.repeat(64),
          sourceContentType: 'application/octet-stream',
        }),
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'content-type': 'application/json',
        },
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      packageId: 'com.yucp.example',
      uploadSessionId: 'upl_1',
      uploadTarget: {
        method: 'PATCH',
        protocol: 'tus',
        url: 'https://uploads.cdngine.test/files/upl_1',
      },
    });
    expect(payload.completeUrl).toStartWith(
      'https://api.test/api/packages/com.yucp.example/backstage/upload-session/complete?completionToken='
    );
    expect(cdngineCreateUploadBodies).toHaveLength(1);
    expect(cdngineCreateUploadBodies[0]).toMatchObject({
      assetOwner: 'creator:auth-user-1',
      tenantId: 'auth-user-1',
      upload: {
        byteLength: fiveGib,
        checksum: {
          algorithm: 'sha256',
          value: 'f'.repeat(64),
        },
      },
    });
  });

  it('rejects Backstage package upload sessions larger than the Unity package limit', async () => {
    const response = await routes.createBackstageReleaseUploadSession(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-session', {
        body: JSON.stringify({
          byteSize: 5 * 1024 * 1024 * 1024 + 1,
          deliveryName: 'too-large.unitypackage',
          sha256: 'f'.repeat(64),
          sourceContentType: 'application/octet-stream',
        }),
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'content-type': 'application/json',
        },
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Backstage package uploads are limited to 5 GiB.',
    });
  });

  it('completes direct CDNgine Backstage upload sessions into source coordinates', async () => {
    const sessionResponse = await routes.createBackstageReleaseUploadSession(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-session', {
        body: JSON.stringify({
          byteSize: 1024,
          deliveryName: 'example.unitypackage',
          sha256: 'e'.repeat(64),
          sourceContentType: 'application/octet-stream',
        }),
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'content-type': 'application/json',
        },
      }),
      'com.yucp.example'
    );
    const { completeUrl } = (await sessionResponse.json()) as { completeUrl: string };

    const completeResponse = await routes.completeBackstageReleaseUploadSession(
      new Request(completeUrl, {
        method: 'POST',
      }),
      'com.yucp.example'
    );

    expect(completeResponse.status).toBe(200);
    await expect(completeResponse.json()).resolves.toMatchObject({
      cdngineSource: {
        assetId: 'ast_1',
        assetOwner: 'creator:auth-user-1',
        byteSize: 1024,
        serviceNamespaceId: 'yucp-backstage',
        sha256: 'e'.repeat(64),
        tenantId: 'auth-user-1',
        versionId: 'ver_1',
      },
      deliveryName: 'example.unitypackage',
      sourceContentType: 'application/octet-stream',
    });
  });

  it('reports missing CDNgine configuration before accepting Backstage package bytes', async () => {
    const unconfiguredRoutes = createPackageRoutes(
      {
        getSession: async () => null,
      } as never,
      {
        apiBaseUrl: 'https://api.test',
        frontendBaseUrl: 'https://creators.test',
        convexApiSecret: 'convex-secret',
        convexSiteUrl: 'https://convex.test',
        convexUrl: 'https://convex.cloud',
      }
    );
    const uploadUrlResponse = await unconfiguredRoutes.createBackstageReleaseUploadUrl(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-url', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'com.yucp.example'
    );
    const { uploadUrl } = (await uploadUrlResponse.json()) as { uploadUrl: string };

    const uploadResponse = await unconfiguredRoutes.uploadBackstageReleaseSource(
      new Request(uploadUrl, {
        body: new Uint8Array([1, 2, 3]),
        headers: {
          'content-type': 'application/octet-stream',
          'x-yucp-file-name': 'example.unitypackage',
        },
        method: 'POST',
      }),
      'com.yucp.example'
    );

    expect(uploadResponse.status).toBe(503);
    await expect(uploadResponse.json()).resolves.toEqual({
      error: 'CDNgine Backstage delivery is not configured',
    });
  });

  it('uploads Backstage source bytes as a new CDNgine asset instead of claiming a missing assetId', async () => {
    const uploadUrlResponse = await routes.createBackstageReleaseUploadUrl(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-url', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
        },
      }),
      'com.yucp.example'
    );
    const { uploadUrl } = (await uploadUrlResponse.json()) as { uploadUrl: string };

    const uploadResponse = await routes.uploadBackstageReleaseSource(
      new Request(uploadUrl, {
        body: new TextEncoder().encode('unity package bytes'),
        headers: {
          'content-type': 'application/octet-stream',
          'x-yucp-file-name': 'example.unitypackage',
        },
        method: 'POST',
      }),
      'com.yucp.example'
    );

    expect(uploadResponse.status).toBe(200);
    expect(cdngineCreateUploadBodies).toHaveLength(1);
    expect(cdngineCreateUploadBodies[0]).not.toHaveProperty('assetId');
    expect(cdngineCreateUploadBodies[0]).toMatchObject({
      assetOwner: 'creator:auth-user-1',
      serviceNamespaceId: 'yucp-backstage',
      tenantId: 'auth-user-1',
    });
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
          description: '<div><p>Includes <strong>Discord</strong> role</p></div>',
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
              description: 'Includes Discord role',
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
    ])) as
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

  it('publishes uploaded Backstage releases for the authenticated creator', async () => {
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1', 'product_2'],
          cdngineSource: cdngineSourceFixture,
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
    expect(payload).not.toHaveProperty('rawArtifactId');
    expect(payload).not.toHaveProperty('deliverableArtifactId');
    expect(payload).not.toHaveProperty('deliveryArtifactMode');
    expect(payload).not.toHaveProperty('materializationStrategy');
    expect(cdngineCreateUploadBodies).toHaveLength(1);
    expect(cdngineCreateUploadBodies[0]).toMatchObject({
      assetOwner: 'creator:auth-user-1',
      serviceNamespaceId: 'yucp-backstage',
      source: {
        contentType: 'application/zip',
        filename: 'source.zip',
      },
      tenantId: 'auth-user-1',
    });
    expect(cdngineUploadTargetBodies).toHaveLength(1);
    expect(Array.from(cdngineUploadTargetBodies[0].bytes.slice(0, 4))).toEqual([80, 75, 3, 4]);
    expect(lastActionArgs).toMatchObject({
      cdngineDelivery: {
        assetId: 'ast_1',
        deliveryScopeId: 'paid-downloads',
        variant: 'vpm-package',
        versionId: 'ver_1',
      },
      deliverableContentType: 'application/zip',
      deliverableDeliveryName: 'source.zip',
    });
  });

  it('materializes unitypackage CDNgine sources into VPM ZIP deliverables before publishing', async () => {
    const sourceBytes = buildUnitypackage([
      {
        path: 'asset',
        content: new TextEncoder().encode('song thing payload'),
      },
      {
        path: 'asset.meta',
        content: new TextEncoder().encode('fileFormatVersion: 2'),
      },
    ]);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/source/authorize')) {
        throw new Error('Unitypackage shim materialization must not download the CDNgine source');
      }
      if (url === 'https://cdn.test/source.unitypackage') {
        throw new Error('Unitypackage shim materialization must not fetch source bytes');
      }
      if (url === 'https://cdngine.test/v1/upload-sessions') {
        cdngineUploadCounter += 1;
        cdngineCreateUploadBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            uploadSessionId: `upl_${cdngineUploadCounter}`,
            assetId: `ast_${cdngineUploadCounter}`,
            versionId: `ver_pending_${cdngineUploadCounter}`,
            uploadTarget: {
              protocol: 'tus',
              method: 'PATCH',
              url: `https://uploads.cdngine.test/files/upl_${cdngineUploadCounter}`,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://uploads.cdngine.test/files/')) {
        cdngineUploadTargetBodies.push({ url, bytes: bodyToUint8Array(init?.body) });
        return new Response(null, { status: 204 });
      }
      const completeMatch = url.match(
        /^https:\/\/cdngine\.test\/v1\/upload-sessions\/upl_(\d+)\/complete$/
      );
      if (completeMatch) {
        return new Response(
          JSON.stringify({
            assetId: `ast_${completeMatch[1]}`,
            versionId: `ver_${completeMatch[1]}`,
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.songthing/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          cdngineSource: {
            ...cdngineSourceFixture,
            byteSize: sourceBytes.byteLength,
            sha256: 'e'.repeat(64),
          },
          version: '1.0.6',
          channel: 'stable',
          deliveryName: 'Song Thing_1.0.6.unitypackage',
          sourceContentType: 'application/octet-stream',
          displayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
        }),
      }),
      'com.yucp.songthing'
    );

    expect(response.status).toBe(201);
    expect(cdngineCreateUploadBodies).toHaveLength(1);
    expect(cdngineCreateUploadBodies[0]).toMatchObject({
      source: {
        contentType: 'application/zip',
        filename: 'vrc-get-com.yucp.songthing-1.0.6.zip',
      },
      upload: {
        checksum: {
          algorithm: 'sha256',
        },
      },
    });
    expect(
      (cdngineCreateUploadBodies[0] as { upload: { checksum: { value: string } } }).upload.checksum
        .value
    ).not.toBe('e'.repeat(64));
    expect(Array.from(cdngineUploadTargetBodies[0].bytes.slice(0, 4))).toEqual([80, 75, 3, 4]);
    const shimArchive = unzipSync(cdngineUploadTargetBodies[0].bytes);
    expect(Object.keys(shimArchive).sort()).toEqual(['package.json']);
    expect(JSON.parse(new TextDecoder().decode(shimArchive['package.json']))).toMatchObject({
      name: 'com.yucp.songthing',
      version: '1.0.6',
      displayName: 'Song Thing - Your Spotify® library within VRChat - VRCFury Ready',
      vpmDependencies: {
        'com.yucp.importer': '>=0.1.0',
      },
      yucp: {
        kind: 'alias-v1',
        importerPackage: 'com.yucp.importer',
        packageDisplayName: 'Song Thing | Your Spotify® library within VRChat | VRCFury Ready',
      },
    });
    expect(lastActionArgs).toMatchObject({
      cdngineDelivery: {
        assetId: 'ast_1',
        deliveryScopeId: 'paid-downloads',
        variant: 'vpm-package',
        versionId: 'ver_1',
      },
      deliverableContentType: 'application/zip',
      deliverableDeliveryName: 'vrc-get-com.yucp.songthing-1.0.6.zip',
      rawDeliveryName: 'Song Thing_1.0.6.unitypackage',
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
          cdngineSource: cdngineSourceFixture,
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

  it('publishes server-generated metadata inputs for unitypackage sources', async () => {
    const sourceBytes = buildUnitypackage([
      {
        path: 'asset',
        content: new TextEncoder().encode('avatar installer payload'),
      },
    ]);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/source/authorize')) {
        throw new Error('Unitypackage shim materialization must not download the CDNgine source');
      }
      if (url === 'https://cdn.test/avatar-installer.unitypackage') {
        throw new Error('Unitypackage shim materialization must not fetch source bytes');
      }
      if (url === 'https://cdngine.test/v1/upload-sessions') {
        cdngineUploadCounter += 1;
        cdngineCreateUploadBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            uploadSessionId: `upl_${cdngineUploadCounter}`,
            assetId: `ast_${cdngineUploadCounter}`,
            versionId: `ver_pending_${cdngineUploadCounter}`,
            uploadTarget: {
              protocol: 'tus',
              method: 'PATCH',
              url: `https://uploads.cdngine.test/files/upl_${cdngineUploadCounter}`,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://uploads.cdngine.test/files/')) {
        cdngineUploadTargetBodies.push({ url, bytes: bodyToUint8Array(init?.body) });
        return new Response(null, { status: 204 });
      }
      const completeMatch = url.match(
        /^https:\/\/cdngine\.test\/v1\/upload-sessions\/upl_(\d+)\/complete$/
      );
      if (completeMatch) {
        return new Response(
          JSON.stringify({
            assetId: `ast_${completeMatch[1]}`,
            versionId: `ver_${completeMatch[1]}`,
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          cdngineSource: cdngineSourceFixture,
          version: '4.0.0',
          deliveryName: 'avatar-installer.unitypackage',
          sourceContentType: 'application/octet-stream',
          displayName: 'Avatar Installer',
          description: 'Server-generated wrapper metadata',
          unityVersion: '2022.3',
          dependencyVersions: [{ packageId: 'com.yucp.importer', version: '1.4.0' }],
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(201);
    expect(lastActionArgs).toMatchObject({
      rawDeliveryName: 'avatar-installer.unitypackage',
      rawContentType: 'application/octet-stream',
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
          cdngineSource: cdngineSourceFixture,
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
