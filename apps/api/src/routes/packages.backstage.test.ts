import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { gzipSync, unzipSync, zipSync } from 'fflate';

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
let cdngineUploadCounter = 0;
let cdngineCreateUploadBodies: unknown[] = [];
let cdngineCreateUploadIdempotencyKeys: Array<string | null> = [];
let cdngineUploadTargetBodies: Array<{ url: string; bytes: Uint8Array }> = [];
let cdngineVersionReadStates: string[] = [];

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

const defaultCdngineSourceZip = zipSync({
  'Packages/com.yucp.example/package.json': [
    new TextEncoder().encode('{"name":"com.yucp.example"}'),
    { mtime: new Date(315619200000) },
  ],
});
const defaultCdngineSourceSha256 = await sha256HexForTest(defaultCdngineSourceZip);

const cdngineSourceFixture = {
  assetId: 'ast_source_1',
  assetOwner: 'creator:auth-user-1',
  byteSize: defaultCdngineSourceZip.byteLength,
  serviceNamespaceId: 'yucp-backstage',
  sha256: defaultCdngineSourceSha256,
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

function signMalformedBackstageToken(payload: string): string {
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = createHmac('sha256', 'convex-secret')
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
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
        publicationPollIntervalMs: 0,
        publicationTimeoutMs: 100,
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
    cdngineUploadCounter = 0;
    cdngineCreateUploadBodies = [];
    cdngineCreateUploadIdempotencyKeys = [];
    cdngineUploadTargetBodies = [];
    cdngineVersionReadStates = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/source/authorize')) {
        return new Response(JSON.stringify({ url: 'https://cdn.test/source.zip' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://cdn.test/source.zip') {
        const sourceZipBuffer = defaultCdngineSourceZip.buffer.slice(
          defaultCdngineSourceZip.byteOffset,
          defaultCdngineSourceZip.byteOffset + defaultCdngineSourceZip.byteLength
        ) as ArrayBuffer;
        return new Response(new Blob([sourceZipBuffer], { type: 'application/zip' }), {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        });
      }
      if (url === 'https://cdngine.test/v1/upload-sessions') {
        cdngineUploadCounter += 1;
        cdngineCreateUploadBodies.push(JSON.parse(String(init?.body)));
        cdngineCreateUploadIdempotencyKeys.push(new Headers(init?.headers).get('idempotency-key'));
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
      const versionMatch = url.match(
        /^https:\/\/cdngine\.test\/v1\/assets\/ast_(\d+)\/versions\/ver_(\d+)$/
      );
      if (versionMatch) {
        cdngineVersionReadStates.push('published');
        return new Response(
          JSON.stringify({
            assetId: `ast_${versionMatch[1]}`,
            versionId: `ver_${versionMatch[2]}`,
            lifecycleState: 'published',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
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

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('trims trailing URL slashes without backtracking', () => {
    expect(trimTrailingForwardSlashes('https://api.test///')).toBe('https://api.test');
    expect(trimTrailingForwardSlashes('https://api.test')).toBe('https://api.test');
    expect(trimTrailingForwardSlashes('/')).toBe('');

    const untrimmedPrefix = 'a'.repeat(100_000);
    const adversarialInput = `${untrimmedPrefix}${'/'.repeat(100_000)}`;

    expect(trimTrailingForwardSlashes(adversarialInput)).toBe(untrimmedPrefix);
  });

  it('does not expose API-mediated Backstage package byte upload routes', () => {
    const routeSurface = routes as unknown as Record<string, unknown>;

    expect(routeSurface.createBackstageReleaseUploadUrl).toBeUndefined();
    expect(routeSurface.uploadBackstageReleaseSource).toBeUndefined();
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
      completionToken: expect.any(String),
      packageId: 'com.yucp.example',
      uploadSessionId: 'upl_1',
      uploadTarget: {
        method: 'PATCH',
        protocol: 'tus',
        url: 'https://uploads.cdngine.test/files/upl_1',
      },
    });
    expect(payload.completeUrl).toBe(
      'https://api.test/api/packages/com.yucp.example/backstage/upload-session/complete'
    );
    expect(new URL(payload.completeUrl).search).toBe('');
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

  it('uses the normalized API base URL in Backstage upload completion URLs', async () => {
    const routesWithTrailingApiBaseUrl = createPackageRoutes(
      {
        getSession: async () => null,
      } as never,
      {
        apiBaseUrl: 'https://api.test///',
        frontendBaseUrl: 'https://creators.test',
        convexApiSecret: 'convex-secret',
        convexSiteUrl: 'https://convex.test',
        convexUrl: 'https://convex.cloud',
        cdngine: {
          apiBaseUrl: 'https://cdngine.test',
          accessToken: 'cdngine-token',
          publicationPollIntervalMs: 0,
          publicationTimeoutMs: 100,
        },
      }
    );
    const response = await routesWithTrailingApiBaseUrl.createBackstageReleaseUploadSession(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-session', {
        body: JSON.stringify({
          byteSize: 1024,
          deliveryName: 'example.unitypackage',
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
    await expect(response.json()).resolves.toMatchObject({
      completeUrl:
        'https://api.test/api/packages/com.yucp.example/backstage/upload-session/complete',
    });
  });

  it('creates a fresh CDNgine upload session attempt when the same Backstage file is retried', async () => {
    const requestBody = {
      byteSize: 1024,
      deliveryName: 'example.unitypackage',
      sha256: 'e'.repeat(64),
      sourceContentType: 'application/octet-stream',
    };

    const firstResponse = await routes.createBackstageReleaseUploadSession(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-session', {
        body: JSON.stringify(requestBody),
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'content-type': 'application/json',
        },
      }),
      'com.yucp.example'
    );
    const secondResponse = await routes.createBackstageReleaseUploadSession(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/upload-session', {
        body: JSON.stringify(requestBody),
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'content-type': 'application/json',
        },
      }),
      'com.yucp.example'
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(cdngineCreateUploadIdempotencyKeys).toHaveLength(2);
    expect(cdngineCreateUploadIdempotencyKeys[0]).toStartWith(
      `backstage-source:auth-user-1:com.yucp.example:${requestBody.sha256}:`
    );
    expect(cdngineCreateUploadIdempotencyKeys[1]).toStartWith(
      `backstage-source:auth-user-1:com.yucp.example:${requestBody.sha256}:`
    );
    expect(cdngineCreateUploadIdempotencyKeys[0]).not.toBe(cdngineCreateUploadIdempotencyKeys[1]);
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
    const { completeUrl, completionToken } = (await sessionResponse.json()) as {
      completeUrl: string;
      completionToken: string;
    };

    const completeResponse = await routes.completeBackstageReleaseUploadSession(
      new Request(completeUrl, {
        method: 'POST',
        headers: {
          'X-YUCP-Upload-Completion-Token': completionToken,
        },
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

  it('surfaces expired direct CDNgine upload sessions as a restartable upload error', async () => {
    const defaultFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (/^https:\/\/cdngine\.test\/v1\/upload-sessions\/upl_\d+\/complete$/.test(url)) {
        return new Response(
          JSON.stringify({
            type: 'https://docs.cdngine.dev/problems/upload-session-expired',
            title: 'Upload session expired',
            status: 410,
            detail: 'Upload session expired before valid completion.',
            retryable: false,
          }),
          { status: 410, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return defaultFetch(input, init);
    }) as typeof fetch;

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
    const { completeUrl, completionToken } = (await sessionResponse.json()) as {
      completeUrl: string;
      completionToken: string;
    };

    const completeResponse = await routes.completeBackstageReleaseUploadSession(
      new Request(completeUrl, {
        method: 'POST',
        headers: {
          'X-YUCP-Upload-Completion-Token': completionToken,
        },
      }),
      'com.yucp.example'
    );

    expect(completeResponse.status).toBe(410);
    await expect(completeResponse.json()).resolves.toEqual({
      code: 'BACKSTAGE_UPLOAD_SESSION_EXPIRED',
      error: 'Backstage upload session expired. Start a new upload session and try again.',
    });
  });

  it('reports non-expired CDNgine upload completion failures as temporary upstream outages', async () => {
    const defaultFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (/^https:\/\/cdngine\.test\/v1\/upload-sessions\/upl_\d+\/complete$/.test(url)) {
        return new Response(
          JSON.stringify({
            type: 'https://docs.cdngine.dev/problems/upload-not-ready',
            title: 'Upload not ready',
            status: 409,
            detail: 'Upload target has not committed the package bytes yet.',
            retryable: true,
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return defaultFetch(input, init);
    }) as typeof fetch;

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
    const { completeUrl, completionToken } = (await sessionResponse.json()) as {
      completeUrl: string;
      completionToken: string;
    };

    const completeResponse = await routes.completeBackstageReleaseUploadSession(
      new Request(completeUrl, {
        method: 'POST',
        headers: {
          'X-YUCP-Upload-Completion-Token': completionToken,
        },
      }),
      'com.yucp.example'
    );

    expect(completeResponse.status).toBe(502);
    await expect(completeResponse.json()).resolves.toEqual({
      error: 'Backstage upload service is temporarily unavailable',
    });
  });

  it('rejects malformed upload completion tokens without throwing', async () => {
    const response = await routes.completeBackstageReleaseUploadSession(
      new Request(
        'https://api.test/api/packages/com.yucp.example/backstage/upload-session/complete',
        {
          method: 'POST',
          headers: {
            'X-YUCP-Upload-Completion-Token': signMalformedBackstageToken('not-json'),
          },
        }
      ),
      'com.yucp.example'
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid upload completion token',
    });
  });

  it('rejects upload completion tokens sent through query strings', async () => {
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
    const { completeUrl, completionToken } = (await sessionResponse.json()) as {
      completeUrl: string;
      completionToken: string;
    };

    const response = await routes.completeBackstageReleaseUploadSession(
      new Request(`${completeUrl}?completionToken=${encodeURIComponent(completionToken)}`, {
        method: 'POST',
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid upload completion token',
    });
  });

  it('uploads Backstage package media as separate CDNgine delivery references', async () => {
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
      cdngineDelivery: {
        assetId: 'ast_1',
        assetOwner: 'creator:auth-user-1',
        byteSize: bytes.byteLength,
        deliveryScopeId: 'paid-downloads',
        serviceNamespaceId: 'yucp-backstage',
        tenantId: 'auth-user-1',
        variant: 'preserve-original',
        versionId: 'ver_1',
      },
      contentType: 'image/png',
      deliveryName: 'icon.png',
      kind: 'icon',
      sourcePath: 'Assets/YUCP/icon.png',
    });
    expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cdngineVersionReadStates).toEqual(['published']);
    expect(cdngineCreateUploadBodies[0]).toMatchObject({
      assetOwner: 'creator:auth-user-1',
      serviceNamespaceId: 'yucp-backstage',
      source: {
        contentType: 'image/png',
        filename: 'icon.png',
      },
      tenantId: 'auth-user-1',
      upload: {
        byteLength: bytes.byteLength,
        checksum: {
          algorithm: 'sha256',
          value: payload.sha256,
        },
        objectKey: expect.stringContaining(
          'staging/yucp-backstage/auth-user-1/backstage-media/com.yucp.example/icon/'
        ),
      },
    });
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
    expect(cdngineCreateUploadBodies).toEqual([]);
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
          cdngineSource: cdngineSourceFixture,
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
    expect(cdngineCreateUploadBodies).toHaveLength(0);
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

    const uploadSessionResponse = await routes.createBackstageReleaseUploadSession(
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
    expect(cdngineCreateUploadBodies).toHaveLength(0);
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
        variant: 'preserve-original',
        versionId: 'ver_1',
      },
      deliverableContentType: 'application/zip',
      deliverableDeliveryName: 'source.zip',
    });
  });

  it('rejects CDNgine source references that are not owned by the authenticated creator', async () => {
    const response = await routes.publishBackstageRelease(
      new Request('https://api.test/api/packages/com.yucp.example/backstage/releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          catalogProductIds: ['product_1'],
          cdngineSource: {
            ...cdngineSourceFixture,
            assetOwner: 'creator:other-auth-user',
            tenantId: 'other-auth-user',
          },
          version: '1.2.4',
          channel: 'stable',
        }),
      }),
      'com.yucp.example'
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'CDNgine source is not owned by this creator',
    });
    expect(cdngineCreateUploadBodies).toHaveLength(0);
    expect(lastActionArgs).toBeUndefined();
  });

  it('maps aborted CDNgine source downloads to temporary upstream failures', async () => {
    let sourceDownloadCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/source/authorize')) {
        return new Response(JSON.stringify({ url: 'https://cdn.test/source.zip' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://cdn.test/source.zip') {
        sourceDownloadCount += 1;
        const abortError = new Error('The operation was aborted.');
        abortError.name = 'AbortError';
        throw abortError;
      }
      return failUnmockedFetch(input);
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
          version: '1.2.5',
          channel: 'stable',
        }),
      }),
      'com.yucp.example'
    );

    expect(sourceDownloadCount).toBe(1);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Backstage package delivery is temporarily unavailable',
    });
    expect(lastActionArgs).toBeUndefined();
  });

  it('rejects oversized Backstage sources before in-process materialization', async () => {
    const oversizedSourceBytes = 300 * 1024 * 1024;
    let sourceDownloadCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/source/authorize')) {
        return new Response(JSON.stringify({ url: 'https://cdn.test/huge-source.unitypackage' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://cdn.test/huge-source.unitypackage') {
        sourceDownloadCount += 1;
        return new Response(new Blob([new Uint8Array([1])]), {
          status: 200,
          headers: {
            'Content-Length': String(oversizedSourceBytes),
            'Content-Type': 'application/octet-stream',
          },
        });
      }
      return failUnmockedFetch(input);
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
          cdngineSource: {
            ...cdngineSourceFixture,
            byteSize: oversizedSourceBytes,
            sha256: 'f'.repeat(64),
          },
          version: '1.2.6',
          channel: 'stable',
        }),
      }),
      'com.yucp.example'
    );

    expect(sourceDownloadCount).toBe(1);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Backstage source exceeds the in-process publish limit',
      limitBytes: 268435456,
    });
    expect(cdngineCreateUploadBodies).toHaveLength(0);
    expect(lastActionArgs).toBeUndefined();
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
    const sourceSha256 = await sha256HexForTest(sourceBytes);
    let sourceAuthorizeCount = 0;
    let sourceDownloadCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/source/authorize')) {
        sourceAuthorizeCount += 1;
        return new Response(JSON.stringify({ url: 'https://cdn.test/source.unitypackage' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://cdn.test/source.unitypackage') {
        sourceDownloadCount += 1;
        const sourceBuffer = sourceBytes.buffer.slice(
          sourceBytes.byteOffset,
          sourceBytes.byteOffset + sourceBytes.byteLength
        ) as ArrayBuffer;
        return new Response(new Blob([sourceBuffer], { type: 'application/octet-stream' }), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
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
      const versionMatch = url.match(
        /^https:\/\/cdngine\.test\/v1\/assets\/ast_(\d+)\/versions\/ver_(\d+)$/
      );
      if (versionMatch) {
        const lifecycleState = cdngineVersionReadStates.length === 0 ? 'canonical' : 'published';
        cdngineVersionReadStates.push(lifecycleState);
        return new Response(
          JSON.stringify({
            assetId: `ast_${versionMatch[1]}`,
            versionId: `ver_${versionMatch[2]}`,
            lifecycleState,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return failUnmockedFetch(input);
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
            sha256: sourceSha256,
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
    expect(sourceAuthorizeCount).toBe(1);
    expect(sourceDownloadCount).toBe(1);
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
    ).not.toBe(sourceSha256);
    expect(Array.from(cdngineUploadTargetBodies[0].bytes.slice(0, 4))).toEqual([80, 75, 3, 4]);
    const shimArchive = unzipSync(cdngineUploadTargetBodies[0].bytes);
    expect(Object.keys(shimArchive).sort()).toEqual(['package.json']);
    expect(JSON.parse(new TextDecoder().decode(shimArchive['package.json']))).toMatchObject({
      name: 'com.yucp.songthing',
      version: '1.0.6',
      displayName: 'Song Thing - Your Spotify® library within VRChat - VRCFury Ready',
      vpmDependencies: {
        'com.yucp.importer': '>=0.1.9',
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
        variant: 'preserve-original',
        versionId: 'ver_1',
      },
      deliverableContentType: 'application/zip',
      deliverableDeliveryName: 'vrc-get-com.yucp.songthing-1.0.6.zip',
      rawDeliveryName: 'Song Thing_1.0.6.unitypackage',
    });
    expect(cdngineVersionReadStates).toEqual(['canonical', 'published']);
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
      { path: 'asset-guid/asset', content: new TextEncoder().encode('avatar payload') },
      { path: 'asset-guid/pathname', content: new TextEncoder().encode('Assets/Avatar.prefab') },
    ]);
    const sourceSha256 = await sha256HexForTest(sourceBytes);
    let sourceAuthorizeCount = 0;
    let sourceDownloadCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/source/authorize')) {
        sourceAuthorizeCount += 1;
        return new Response(
          JSON.stringify({ url: 'https://cdn.test/avatar-installer.unitypackage' }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      if (url === 'https://cdn.test/avatar-installer.unitypackage') {
        sourceDownloadCount += 1;
        const sourceBuffer = sourceBytes.buffer.slice(
          sourceBytes.byteOffset,
          sourceBytes.byteOffset + sourceBytes.byteLength
        ) as ArrayBuffer;
        return new Response(new Blob([sourceBuffer], { type: 'application/octet-stream' }), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
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
      const versionMatch = url.match(
        /^https:\/\/cdngine\.test\/v1\/assets\/ast_(\d+)\/versions\/ver_(\d+)$/
      );
      if (versionMatch) {
        cdngineVersionReadStates.push('published');
        return new Response(
          JSON.stringify({
            assetId: `ast_${versionMatch[1]}`,
            versionId: `ver_${versionMatch[2]}`,
            lifecycleState: 'published',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return failUnmockedFetch(input);
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
          cdngineSource: {
            ...cdngineSourceFixture,
            byteSize: sourceBytes.byteLength,
            sha256: sourceSha256,
          },
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
    expect(sourceAuthorizeCount).toBe(1);
    expect(sourceDownloadCount).toBe(1);
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
