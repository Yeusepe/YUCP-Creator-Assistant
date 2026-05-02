import { createApiActorBinding } from '@yucp/shared/apiActor';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

process.env.CONVEX_API_SECRET = 'test-secret';
process.env.INTERNAL_SERVICE_AUTH_SECRET = 'test-internal-service-secret';

const CDNGINE_ENV_KEYS = [
  'CDNGINE_ACCESS_TOKEN',
  'CDNGINE_API_BASE_URL',
  'CDNGINE_BACKSTAGE_DELIVERY_SCOPE_ID',
  'CDNGINE_BACKSTAGE_REQUIRED',
  'CDNGINE_BACKSTAGE_SERVICE_NAMESPACE_ID',
  'CDNGINE_BACKSTAGE_VARIANT',
  'YUCP_ALLOW_LEGACY_CONVEX_BACKSTAGE_UPLOADS',
] as const;
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(
  CDNGINE_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof CDNGINE_ENV_KEYS)[number], string | undefined>;
let cdngineUploadCounter = 0;

beforeEach(() => {
  cdngineUploadCounter = 0;
  process.env.CDNGINE_API_BASE_URL = 'https://cdngine.test';
  process.env.CDNGINE_ACCESS_TOKEN = 'cdngine-token';
  process.env.CDNGINE_BACKSTAGE_REQUIRED = 'true';
  process.env.CDNGINE_BACKSTAGE_SERVICE_NAMESPACE_ID = 'yucp-backstage';
  process.env.CDNGINE_BACKSTAGE_DELIVERY_SCOPE_ID = 'paid-downloads';
  process.env.CDNGINE_BACKSTAGE_VARIANT = 'vpm-package';
  process.env.YUCP_ALLOW_LEGACY_CONVEX_BACKSTAGE_UPLOADS = 'true';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://cdngine.test/v1/upload-sessions') {
      cdngineUploadCounter += 1;
      return new Response(
        JSON.stringify({
          uploadSessionId: `upl_backstage_${cdngineUploadCounter}`,
          assetId: `ast_backstage_${cdngineUploadCounter}`,
          versionId: `ver_backstage_pending_${cdngineUploadCounter}`,
          uploadTarget: {
            protocol: 'tus',
            method: 'PATCH',
            url: `https://uploads.cdngine.test/files/upl_backstage_${cdngineUploadCounter}`,
          },
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    if (url.startsWith('https://uploads.cdngine.test/files/')) {
      expect(init?.method).toBe('PATCH');
      return new Response(null, { status: 204 });
    }
    const completeMatch = url.match(
      /^https:\/\/cdngine\.test\/v1\/upload-sessions\/(upl_backstage_\d+)\/complete$/
    );
    if (completeMatch) {
      const index = completeMatch[1].replace('upl_backstage_', '');
      return new Response(
        JSON.stringify({
          assetId: `ast_backstage_${index}`,
          versionId: `ver_backstage_${index}`,
        }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    return new Response(`unexpected url: ${url}`, { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of CDNGINE_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function createAuthUserActorBinding(authUserId: string) {
  const now = Date.now();
  return await createApiActorBinding(
    {
      version: 1,
      kind: 'auth_user',
      authUserId,
      source: 'session',
      scopes: [],
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function createServiceActorBinding(scopes: readonly string[]) {
  const now = Date.now();
  return await createApiActorBinding(
    {
      version: 1,
      kind: 'service',
      service: 'api-server',
      scopes: [...scopes],
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    process.env.INTERNAL_SERVICE_AUTH_SECRET as string
  );
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(input));
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

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
  writeOctal(header, 136, 12, 123);
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
    const header = buildTarHeader(entry.path, entry.content.byteLength);
    blocks.push(header);
    blocks.push(entry.content);
    const remainder = entry.content.byteLength % 512;
    if (remainder !== 0) {
      blocks.push(new Uint8Array(512 - remainder));
    }
  }
  blocks.push(new Uint8Array(1024));

  const totalSize = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const tarBytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const block of blocks) {
    tarBytes.set(block, offset);
    offset += block.byteLength;
  }
  return gzipSync(tarBytes, { level: 9, mtime: 123 });
}

async function seedCatalogProduct(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    canonicalSlug?: string;
    productId?: string;
    provider?: Doc<'product_catalog'>['provider'];
    providerProductRef?: string;
    displayName?: string;
    status?: Doc<'product_catalog'>['status'];
  } = {}
): Promise<Id<'product_catalog'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('product_catalog', {
      authUserId: overrides.authUserId ?? 'auth-user-1',
      canonicalSlug: overrides.canonicalSlug,
      productId: overrides.productId ?? 'product-1',
      provider: overrides.provider ?? 'gumroad',
      providerProductRef: overrides.providerProductRef ?? 'gumroad-product-1',
      displayName: overrides.displayName ?? 'Creator Product',
      status: overrides.status ?? 'active',
      supportsAutoDiscovery: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedSubject(
  t: ReturnType<typeof makeTestConvex>,
  overrides: {
    authUserId?: string;
    primaryDiscordUserId?: string;
  } = {}
): Promise<Id<'subjects'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('subjects', {
      authUserId: overrides.authUserId ?? 'auth-user-1',
      primaryDiscordUserId: overrides.primaryDiscordUserId ?? 'discord-user-1',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe('packageRegistry', () => {
  it('blocks legacy Convex upload URLs for new Backstage packages unless the migration flag is explicit', async () => {
    const t = makeTestConvex();
    delete process.env.YUCP_ALLOW_LEGACY_CONVEX_BACKSTAGE_UPLOADS;

    await expect(
      t.mutation(api.backstageRepos.generateReleaseUploadUrlForAuthUser, {
        apiSecret: 'test-secret',
        actor: await createAuthUserActorBinding('auth-user-1'),
        authUserId: 'auth-user-1',
      })
    ).rejects.toThrow('Legacy Convex Backstage package uploads are disabled');
  });

  it('stores package names and lists owned packages with human metadata', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.gamma',
      packageName: 'Gamma Tools',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });
    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.alpha',
      packageName: 'Alpha Suite',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const packages = await t.query(internal.packageRegistry.getRegistrationsByYucpUser, {
      yucpUserId: 'auth-user-1',
    });

    expect(
      packages.map((entry: Doc<'package_registry'>) => [entry.packageId, entry.packageName])
    ).toEqual([
      ['pkg.gamma', 'Gamma Tools'],
      ['pkg.alpha', 'Alpha Suite'],
    ]);
  });

  it('updates the registered package name when the same creator re-registers a package', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.creator-suite',
      packageName: 'Creator Suite',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.creator-suite',
      packageName: 'Creator Suite+',
      publisherId: 'publisher-2',
      yucpUserId: 'auth-user-1',
    });

    const registration = await t.query(internal.packageRegistry.getRegistration, {
      packageId: 'pkg.creator-suite',
    });

    expect(registration?.publisherId).toBe('publisher-2');
    expect(registration?.packageName).toBe('Creator Suite+');
  });

  it('allows actor-protected package lookups used by hosted verification helpers', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.lookup',
      packageName: 'Lookup Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-lookup',
    });

    const registration = await t.query(api.packageRegistry.lookupRegistration, {
      apiSecret: 'test-secret',
      actor: await createServiceActorBinding(['verification-intents:service']),
      packageId: 'pkg.lookup',
    });

    expect(registration).toEqual({
      packageId: 'pkg.lookup',
      yucpUserId: 'auth-user-lookup',
      status: 'active',
    });
  });

  it('does not disclose the owning creator when a different creator hits a package namespace conflict', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.namespace',
      packageName: 'Namespace Owner',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const conflict = await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.namespace',
      packageName: 'Namespace Challenger',
      publisherId: 'publisher-2',
      yucpUserId: 'auth-user-2',
    });

    expect(conflict).toEqual({
      registered: false,
      conflict: true,
      archived: false,
    });
    expect('ownedBy' in conflict).toBe(false);
  });

  it('hides archived packages from coupling forensics package lists', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.active',
      packageName: 'Active Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });
    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.archived',
      packageName: 'Archived Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const archived = await t.mutation(api.packageRegistry.archiveForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      packageId: 'pkg.archived',
    });

    expect(archived).toEqual({
      archived: true,
      packageId: 'pkg.archived',
    });

    const forensicsPackages = await t.query(
      api.couplingForensics.listOwnedPackageSummariesForAuthUser,
      {
        apiSecret: 'test-secret',
        authUserId: 'auth-user-1',
      }
    );

    expect(forensicsPackages.packages).toEqual([
      {
        packageId: 'pkg.active',
        packageName: 'Active Package',
        registeredAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it('blocks archived packages from being renamed or updated through package registration', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.archived',
      packageName: 'Archive Me',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(api.packageRegistry.archiveForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      packageId: 'pkg.archived',
    });

    const renameResult = await t.mutation(api.packageRegistry.renameForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      packageId: 'pkg.archived',
      packageName: 'Should Fail',
    });

    expect(renameResult).toEqual({
      updated: false,
      reason: 'Archived packages cannot be updated. Restore the package before renaming it.',
    });

    const registerResult = await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'pkg.archived',
      packageName: 'Should Not Update',
      publisherId: 'publisher-2',
      yucpUserId: 'auth-user-1',
    });

    expect(registerResult).toEqual({
      registered: false,
      conflict: false,
      archived: true,
      reason:
        'Archived packages cannot be updated. Restore the package before signing or changing it.',
    });

    const registration = await t.query(internal.packageRegistry.getRegistration, {
      packageId: 'pkg.archived',
    });

    expect(registration?.packageName).toBe('Archive Me');
    expect(registration?.publisherId).toBe('publisher-1');
  });

  it('enriches creator product listings with linked Backstage package summaries', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-backstage',
      providerProductRef: 'gumroad-product-backstage',
      displayName: 'Backstage Product',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.product',
      packageName: 'Backstage Product',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.backstage.product',
      packageName: 'Backstage Product',
      displayName: 'Backstage Product',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.backstage.product',
      version: '1.2.3',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'backstage-product-stable',
    });

    const result = await t.query(api.packageRegistry.listByAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      _id: catalogProductId,
      productId: 'product-backstage',
      displayName: 'Backstage Product',
      backstagePackages: [
        {
          packageId: 'com.yucp.backstage.product',
          packageName: 'Backstage Product',
          displayName: 'Backstage Product',
          status: 'active',
          repositoryVisibility: 'listed',
          defaultChannel: 'stable',
          latestPublishedVersion: '1.2.3',
          latestRelease: {
            version: '1.2.3',
            channel: 'stable',
            releaseStatus: 'published',
            repositoryVisibility: 'listed',
            artifactKey: 'backstage-product-stable',
          },
        },
      ],
    });
  });

  it('loads buyer access context for an active catalog product through the protected API client', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-buyer-access',
      providerProductRef: 'gumroad-product-buyer-access',
      displayName: 'Buyer Access Product',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.buyer.access',
      packageName: 'Buyer Access Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.buyer.access',
      packageName: 'Buyer Access Package',
      displayName: 'Buyer Access Package',
      repositoryVisibility: 'hidden',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.buyer.access',
      version: '1.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'hidden',
      artifactKey: 'buyer-access-stable',
    });

    const result = await t.query(api.packageRegistry.getBuyerAccessContextByCatalogProductId, {
      apiSecret: 'test-secret',
      catalogProductId,
    });

    expect(result).toMatchObject({
      catalogProductId,
      creatorAuthUserId: 'auth-user-1',
      productId: 'product-buyer-access',
      provider: 'gumroad',
      providerProductRef: 'gumroad-product-buyer-access',
      displayName: 'Buyer Access Product',
      status: 'active',
      backstagePackages: [
        {
          packageId: 'com.yucp.buyer.access',
          packageName: 'Buyer Access Package',
          displayName: 'Buyer Access Package',
          defaultChannel: 'stable',
          latestPublishedVersion: '1.0.0',
          repositoryVisibility: 'hidden',
        },
      ],
    });
  });

  it('builds an authorized alias install plan for an entitled subject and creator product ref', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-alias-plan',
      providerProductRef: 'gumroad-product-alias-plan',
      displayName: 'Alias Plan Product',
    });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-alias-plan-user',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.alias.plan',
      packageName: 'Alias Plan Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.alias.plan',
      packageName: 'Alias Plan Package',
      displayName: 'Alias Plan Package',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.alias.plan',
      version: '1.2.3',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'alias-plan-stable',
      zipSha256: 'b'.repeat(64),
      metadata: {
        yucp: {
          kind: 'alias-v1',
          aliasId: 'song-thing',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          minImporterVersion: '1.4.0',
          catalogProductIds: [String(catalogProductId)],
          channel: 'stable',
        },
      },
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-alias-plan',
        sourceProvider: 'gumroad',
        sourceReference: 'order-alias-plan',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const installPlan = await t.run(async (ctx) => {
      return await ctx.runQuery(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
        apiSecret: 'test-secret',
        authUserId: 'auth-user-1',
        subjectId,
        creatorRef: 'auth-user-1',
        productRef: 'gumroad-product-alias-plan',
      });
    });

    expect(installPlan).toEqual({
      creatorAuthUserId: 'auth-user-1',
      packages: [
        {
          packageId: 'com.yucp.alias.plan',
          displayName: 'Alias Plan Package',
          version: '1.2.3',
          channel: 'stable',
          zipSha256: 'b'.repeat(64),
          aliasContract: {
            kind: 'alias-v1',
            aliasId: 'song-thing',
            installStrategy: 'server-authorized',
            importerPackage: 'com.yucp.importer',
            minImporterVersion: '1.4.0',
            catalogProductIds: [String(catalogProductId)],
            channel: 'stable',
          },
        },
      ],
      creatorSlug: undefined,
      providerProductRef: 'gumroad-product-alias-plan',
      canonicalSlug: undefined,
      displayName: 'Alias Plan Product',
      thumbnailUrl: undefined,
    });
  });

  it('does not issue an alias install plan when the subject is not entitled to the creator product', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-alias-plan',
      providerProductRef: 'gumroad-product-alias-plan',
      displayName: 'Alias Plan Product',
    });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-alias-plan-user',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.alias.plan',
      packageName: 'Alias Plan Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.alias.plan',
      packageName: 'Alias Plan Package',
      displayName: 'Alias Plan Package',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.alias.plan',
      version: '1.2.3',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'alias-plan-stable',
      metadata: {
        yucp: {
          kind: 'alias-v1',
          aliasId: 'song-thing',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          catalogProductIds: [String(catalogProductId)],
          channel: 'stable',
        },
      },
    });

    const installPlan = await t.run(async (ctx) => {
      return await ctx.runQuery(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
        apiSecret: 'test-secret',
        authUserId: 'auth-user-1',
        subjectId,
        creatorRef: 'auth-user-1',
        productRef: 'gumroad-product-alias-plan',
      });
    });

    expect(installPlan).toBeNull();
  });

  it('resolves entitled Backstage packages for a subject through active catalog entitlements', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-entitled',
      providerProductRef: 'gumroad-product-entitled',
      displayName: 'Entitled Product',
    });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-entitled-user',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.entitled',
      packageName: 'Entitled Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.backstage.entitled',
      packageName: 'Entitled Package',
      displayName: 'Entitled Package',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.backstage.entitled',
      version: '2.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'entitled-package-stable',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-entitled',
        sourceProvider: 'gumroad',
        sourceReference: 'order-1',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const entitledPackages = await t.query(
      internal.packageRegistry.listEntitledPackagesForSubject,
      {
        authUserId: 'auth-user-1',
        subjectId,
      }
    );

    expect(entitledPackages).toMatchObject([
      {
        catalogProductIds: [catalogProductId],
        packageId: 'com.yucp.backstage.entitled',
        packageName: 'Entitled Package',
        displayName: 'Entitled Package',
        latestPublishedVersion: '2.0.0',
        latestRelease: {
          version: '2.0.0',
          channel: 'stable',
          releaseStatus: 'published',
          repositoryVisibility: 'listed',
          artifactKey: 'entitled-package-stable',
        },
      },
    ]);
  });

  it('keeps multiple Backstage packages active for the same entitled catalog product', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-subscription',
      provider: 'patreon',
      providerProductRef: 'patreon-campaign-1',
      displayName: 'Subscription Product',
    });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-subscription-user',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.subscription.core',
      packageName: 'Subscription Core',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });
    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.subscription.addons',
      packageName: 'Subscription Addons',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.subscription.core',
      packageName: 'Subscription Core',
      displayName: 'Subscription Core',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });
    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.subscription.addons',
      packageName: 'Subscription Addons',
      displayName: 'Subscription Addons',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.subscription.core',
      version: '1.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'subscription-core-stable',
    });
    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.subscription.addons',
      version: '1.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'subscription-addons-stable',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-subscription',
        sourceProvider: 'patreon',
        sourceReference: 'patreon:member:member-1:campaign:campaign-1',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const entitledPackages = await t.query(
      internal.packageRegistry.listEntitledPackagesForSubject,
      {
        authUserId: 'auth-user-1',
        subjectId,
      }
    );

    expect(entitledPackages.map((pkg) => pkg.packageId).sort()).toEqual([
      'com.yucp.subscription.addons',
      'com.yucp.subscription.core',
    ]);
  });

  it('resolves tier-gated Backstage packages from active subscription tier evidence', async () => {
    const t = makeTestConvex();
    const creatorAuthUserId = 'creator-tier-package';
    const buyerAuthUserId = 'buyer-tier-package';
    const subjectId = await seedSubject(t, {
      authUserId: buyerAuthUserId,
      primaryDiscordUserId: 'discord-tier-package-user',
    });

    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: creatorAuthUserId,
      productId: 'product-tier-package',
      provider: 'gumroad',
      providerProductRef: 'gumroad-tier-package',
      displayName: 'Tiered Subscription Product',
    });
    const catalogTierId = await t.mutation(api.catalogTiers.upsertCatalogTier, {
      apiSecret: 'test-secret',
      authUserId: creatorAuthUserId,
      provider: 'gumroad',
      productId: 'product-tier-package',
      catalogProductId,
      providerProductRef: 'gumroad-tier-package',
      providerTierRef:
        'gumroad|product|20:gumroad-tier-package|variant|4:tier|option|4:gold|recurrence|7:monthly',
      displayName: 'Gold Monthly',
      amountCents: 1500,
      currency: 'USD',
      status: 'active',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.subscription.gold',
      packageName: 'Gold Subscription Package',
      publisherId: 'publisher-1',
      yucpUserId: creatorAuthUserId,
    });
    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForAccessSelectors, {
      authUserId: creatorAuthUserId,
      accessSelectors: [{ kind: 'catalogTier', catalogTierId }],
      packageId: 'com.yucp.subscription.gold',
      packageName: 'Gold Subscription Package',
      displayName: 'Gold Subscription Package',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });
    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: creatorAuthUserId,
      packageId: 'com.yucp.subscription.gold',
      version: '1.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'subscription-gold-stable',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('purchase_facts', {
        authUserId: creatorAuthUserId,
        provider: 'gumroad',
        externalOrderId: 'sale-tier-package',
        providerProductId: 'gumroad-tier-package',
        externalVariantId:
          'gumroad|product|20:gumroad-tier-package|variant|4:tier|option|4:gold|recurrence|7:monthly',
        paymentStatus: 'paid',
        lifecycleStatus: 'active',
        purchasedAt: Date.now() - 60_000,
        subjectId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
      await ctx.db.insert('entitlements', {
        authUserId: creatorAuthUserId,
        subjectId,
        productId: 'product-tier-package',
        sourceProvider: 'gumroad',
        sourceReference: 'gumroad:sale-tier-package',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const entitledPackages = await t.query(
      internal.packageRegistry.listEntitledPackagesForSubject,
      {
        authUserId: creatorAuthUserId,
        subjectId,
      }
    );

    expect(entitledPackages.map((pkg) => pkg.packageId)).toEqual(['com.yucp.subscription.gold']);
  });

  it('builds a VPM-style Backstage Repos document from entitled packages', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-vpm',
      providerProductRef: 'gumroad-product-vpm',
      displayName: 'VPM Product',
    });
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-vpm-user',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.vpm',
      packageName: 'VPM Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProduct, {
      authUserId: 'auth-user-1',
      catalogProductId,
      packageId: 'com.yucp.backstage.vpm',
      packageName: 'VPM Package',
      displayName: 'VPM Package',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });

    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.backstage.vpm',
      version: '3.1.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      artifactKey: 'vpm-package-stable',
      zipSha256: 'abcdef1234567890',
      metadata: {
        description: 'Private VPM package',
        dependencies: {
          'com.vrchat.base': '3.7.0',
        },
        yucp: {
          kind: 'alias-v1',
          aliasId: 'song-thing',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          minImporterVersion: '1.4.0',
          catalogProductIds: [String(catalogProductId)],
          channel: 'stable',
        },
      },
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-vpm',
        sourceProvider: 'gumroad',
        sourceReference: 'order-vpm',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const repository = await t.query(internal.packageRegistry.buildBackstageRepositoryForSubject, {
      authUserId: 'auth-user-1',
      subjectId,
      repositoryUrl: 'https://api.yucp.test/v1/backstage/repos/index.json',
      packageBaseUrl: 'https://api.yucp.test/v1/backstage/package',
      packageHeaders: {
        'X-YUCP-Repo-Token': 'ybt_example',
      },
    });

    expect(repository).toMatchObject({
      name: 'Backstage Repos',
      author: 'YUCP',
      id: 'club.yucp.backstage.auth-user-1',
      url: 'https://api.yucp.test/v1/backstage/repos/index.json',
      packages: {
        'com.yucp.backstage.vpm': {
          versions: {
            '3.1.0': {
              name: 'com.yucp.backstage.vpm',
              version: '3.1.0',
              displayName: 'VPM Package',
              description: 'Private VPM package',
              vpmDependencies: {
                'com.vrchat.base': '3.7.0',
                'com.yucp.importer': '>=1.4.0',
              },
              headers: {
                'X-YUCP-Repo-Token': 'ybt_example',
              },
              zipSHA256: 'abcdef1234567890',
              yucpArtifactKey: 'vpm-package-stable',
              yucpDeliveryMode: 'repo-token-vpm-v1',
              yucpDeliverySourceKind: 'zip',
              yucp: {
                kind: 'alias-v1',
                aliasId: 'song-thing',
                installStrategy: 'server-authorized',
                importerPackage: 'com.yucp.importer',
                minImporterVersion: '1.4.0',
                catalogProductIds: [String(catalogProductId)],
                channel: 'stable',
              },
            },
          },
        },
      },
    });
    const repositoryPackages = repository.packages as Record<
      string,
      { versions: Record<string, { url: string }> }
    >;
    expect(repositoryPackages['com.yucp.backstage.vpm'].versions['3.1.0'].url).toBe(
      'https://api.yucp.test/v1/backstage/package?packageId=com.yucp.backstage.vpm&version=3.1.0&channel=stable&zipSHA256=abcdef1234567890'
    );

    const publicAccess = await t.run(async (ctx) => {
      return await ctx.runQuery(api.packageRegistry.getPublicBackstageProductAccessByRef, {
        apiSecret: 'test-secret',
        creatorRef: 'auth-user-1',
        productRef: 'gumroad-product-vpm',
      });
    });
    expect(publicAccess?.packageSummaries).toEqual([
      {
        packageId: 'com.yucp.backstage.vpm',
        displayName: 'VPM Package',
        latestPublishedVersion: '3.1.0',
        latestReleaseChannel: 'stable',
        aliasContract: {
          kind: 'alias-v1',
          aliasId: 'song-thing',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          minImporterVersion: '1.4.0',
          catalogProductIds: [String(catalogProductId)],
          channel: 'stable',
        },
      },
    ]);
  });

  it('materializes raw uploads into server-owned deliverables for published package downloads', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-raw-upload',
      providerProductRef: 'gumroad-product-raw-upload',
      displayName: 'Raw Upload Product',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.raw',
      packageName: 'Raw Upload Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const uploadBytes = zipSync(
      {
        'Packages/com.yucp.backstage.raw/package.json': [
          new TextEncoder().encode('{"name":"com.yucp.backstage.raw"}'),
          { mtime: new Date() },
        ],
        'Packages/com.yucp.backstage.raw/README.md': [
          new TextEncoder().encode('hello'),
          { mtime: new Date() },
        ],
      },
      { level: 9 }
    );
    const uploadSha256 = await sha256Hex(uploadBytes);
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(uploadBytes)], { type: 'application/zip' })
      );
    });

    const published = await t.action(api.backstageRepos.publishUploadedReleaseForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      accessSelectors: [{ kind: 'catalogProduct', catalogProductId }],
      packageId: 'com.yucp.backstage.raw',
      storageId,
      version: '1.0.0',
      deliveryName: 'example.zip',
    });

    expect(published).toEqual({
      deliveryPackageReleaseId: expect.any(String),
      zipSha256: expect.any(String),
      version: '1.0.0',
      channel: 'stable',
    });
    const release = await t.run(async (ctx) => {
      return await ctx.db.get(
        published.deliveryPackageReleaseId as Id<'delivery_package_releases'>
      );
    });
    expect(release?.zipSha256).toBe(published.zipSha256);
    expect(release?.metadata).toMatchObject({
      vpmDependencies: {
        'com.yucp.importer': '>=0.1.0',
      },
      yucp: {
        kind: 'alias-v1',
        aliasId: 'gumroad-product-raw-upload',
        installStrategy: 'server-authorized',
        importerPackage: 'com.yucp.importer',
        minImporterVersion: '0.1.0',
        catalogProductIds: [String(catalogProductId)],
        channel: 'stable',
      },
    });

    const subjectId = await seedSubject(t, {
      authUserId: 'buyer-1',
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-raw-upload',
        sourceProvider: 'gumroad',
        sourceReference: 'order-raw-upload',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const repository = await t.query(internal.packageRegistry.buildBackstageRepositoryForSubject, {
      authUserId: 'auth-user-1',
      subjectId,
      repositoryUrl: 'https://api.yucp.test/v1/backstage/repos/index.json',
      packageBaseUrl: 'https://api.yucp.test/v1/backstage/package',
      packageHeaders: {
        'X-YUCP-Repo-Token': 'ybt_example',
      },
    });
    expect(repository).toMatchObject({
      packages: {
        'com.yucp.backstage.raw': {
          versions: {
            '1.0.0': {
              vpmDependencies: {
                'com.yucp.importer': '>=0.1.0',
              },
              yucpDeliveryMode: 'repo-token-vpm-v1',
              yucpDeliverySourceKind: 'zip',
              yucp: {
                kind: 'alias-v1',
                aliasId: 'gumroad-product-raw-upload',
                installStrategy: 'server-authorized',
                importerPackage: 'com.yucp.importer',
                minImporterVersion: '0.1.0',
                catalogProductIds: [String(catalogProductId)],
                channel: 'stable',
              },
            },
          },
        },
      },
    });
    const publishedVersion = repository?.packages?.['com.yucp.backstage.raw']?.versions?.[
      '1.0.0'
    ] as Record<string, unknown> | undefined;
    expect(publishedVersion).not.toHaveProperty('yucpInstallAuth');
    expect(publishedVersion).not.toHaveProperty('yucpInstallSemantics');
    expect(publishedVersion).not.toHaveProperty('yucpPackageDownloadAuth');
    expect(publishedVersion).not.toHaveProperty('yucpPackageDownloadPath');

    const entitledResolved = await t.query(api.backstageRepos.resolvePackageDownloadForApi, {
      apiSecret: 'test-secret',
      authUserId: 'auth-user-1',
      subjectId,
      packageId: 'com.yucp.backstage.raw',
      version: '1.0.0',
      channel: 'stable',
    });

    const activeDeliverable = await t.run(async (ctx) => {
      return await ctx.db
        .query('delivery_release_artifacts')
        .withIndex('by_release_role_status', (q) =>
          q
            .eq(
              'deliveryPackageReleaseId',
              published.deliveryPackageReleaseId as Id<'delivery_package_releases'>
            )
            .eq('artifactRole', 'server_deliverable')
            .eq('status', 'active')
        )
        .first();
    });

    expect(entitledResolved).toMatchObject({
      deliveryName: 'example.zip',
      contentType: 'application/zip',
      deliveryArtifactId: activeDeliverable?._id,
      deliveryArtifactMode: 'server_materialized',
      zipSha256: activeDeliverable?.sha256,
      version: '1.0.0',
      channel: 'stable',
    });
    expect(published.zipSha256).toBe(activeDeliverable?.sha256);
    expect(published.zipSha256).not.toBe(uploadSha256);
    expect(entitledResolved?.artifactKey).toBeUndefined();
    expect(publishedVersion?.url).toBe(
      `https://api.yucp.test/v1/backstage/package?packageId=com.yucp.backstage.raw&version=1.0.0&channel=stable&zipSHA256=${activeDeliverable?.sha256}`
    );
    expect(entitledResolved?.downloadUrl).toBe('');
    expect(entitledResolved?.cdngineDelivery).toMatchObject({
      assetOwner: 'creator:auth-user-1',
      deliveryScopeId: 'paid-downloads',
      serviceNamespaceId: 'yucp-backstage',
    });

    const installPlan = await t.run(async (ctx) => {
      return await ctx.runQuery(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
        apiSecret: 'test-secret',
        authUserId: 'auth-user-1',
        subjectId,
        creatorRef: 'auth-user-1',
        productRef: 'gumroad-product-raw-upload',
      });
    });
    expect(installPlan).toMatchObject({
      packages: [
        {
          packageId: 'com.yucp.backstage.raw',
          version: '1.0.0',
          channel: 'stable',
          aliasContract: {
            kind: 'alias-v1',
            aliasId: 'gumroad-product-raw-upload',
            installStrategy: 'server-authorized',
            importerPackage: 'com.yucp.importer',
            minImporterVersion: '0.1.0',
            catalogProductIds: [String(catalogProductId)],
            channel: 'stable',
          },
        },
      ],
    });
  });

  it('preserves unitypackage uploads when deliveryName is omitted', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-unity-no-name',
      providerProductRef: 'gumroad-product-unity-no-name',
      displayName: 'Unity No Name Product',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.noname',
      packageName: 'Unity No Name Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const uploadBytes = buildUnitypackage([
      { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
      { path: 'asset-guid/pathname', content: strToU8('Assets/NoName/readme.txt') },
    ]);
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(uploadBytes)], { type: 'application/octet-stream' })
      );
    });

    const published = await t.action(api.backstageRepos.publishUploadedReleaseForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      accessSelectors: [{ kind: 'catalogProduct', catalogProductId }],
      packageId: 'com.yucp.backstage.noname',
      storageId,
      version: '1.0.0',
      sourceContentType: 'application/octet-stream',
    });

    const subjectId = await seedSubject(t, {
      authUserId: 'buyer-unity-no-name',
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-unity-no-name',
        sourceProvider: 'gumroad',
        sourceReference: 'order-unity-no-name',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const activeDeliverable = await t.run(async (ctx) => {
      return await ctx.db
        .query('delivery_release_artifacts')
        .withIndex('by_release_role_status', (q) =>
          q
            .eq(
              'deliveryPackageReleaseId',
              published.deliveryPackageReleaseId as Id<'delivery_package_releases'>
            )
            .eq('artifactRole', 'server_deliverable')
            .eq('status', 'active')
        )
        .first();
    });
    expect(activeDeliverable).toMatchObject({
      contentType: 'application/zip',
      deliveryName: 'vrc-get-com.yucp.backstage.noname-1.0.0.zip',
    });

    const repository = await t.query(internal.packageRegistry.buildBackstageRepositoryForSubject, {
      authUserId: 'auth-user-1',
      subjectId,
      repositoryUrl: 'https://api.yucp.test/v1/backstage/repos/index.json',
      packageBaseUrl: 'https://api.yucp.test/v1/backstage/package',
      packageHeaders: {
        'X-YUCP-Repo-Token': 'ybt_example',
      },
    });
    expect(repository).toMatchObject({
      packages: {
        'com.yucp.backstage.noname': {
          versions: {
            '1.0.0': {
              yucpDeliverySourceKind: 'unitypackage',
            },
          },
        },
      },
    });
  });

  it('rejects metadata-less uploads that span multiple products with different alias ids', async () => {
    const t = makeTestConvex();
    const firstCatalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-multi-a',
      providerProductRef: 'gumroad-product-multi-a',
      displayName: 'Multi Product A',
    });
    const secondCatalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-multi-b',
      providerProductRef: 'gumroad-product-multi-b',
      displayName: 'Multi Product B',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.multi-product',
      packageName: 'Multi Product Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const uploadBytes = zipSync(
      {
        'Packages/com.yucp.backstage.multi-product/package.json': [
          new TextEncoder().encode('{"name":"com.yucp.backstage.multi-product"}'),
          { mtime: new Date() },
        ],
      },
      { level: 9 }
    );
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(uploadBytes)], { type: 'application/zip' })
      );
    });

    await expect(
      t.action(api.backstageRepos.publishUploadedReleaseForAuthUser, {
        apiSecret: 'test-secret',
        actor: await createAuthUserActorBinding('auth-user-1'),
        authUserId: 'auth-user-1',
        accessSelectors: [
          { kind: 'catalogProduct', catalogProductId: firstCatalogProductId },
          { kind: 'catalogProduct', catalogProductId: secondCatalogProductId },
        ],
        packageId: 'com.yucp.backstage.multi-product',
        storageId,
        version: '1.0.0',
        deliveryName: 'multi-product.zip',
      })
    ).rejects.toThrow(
      'Cannot synthesize alias metadata across multiple catalog products with different alias ids.'
    );
  });

  it('publishes metadata-less uploads across products that share the same display identity', async () => {
    const t = makeTestConvex();
    const firstCatalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      canonicalSlug: 'gumroad-songthing',
      productId: 'product-display-a',
      provider: 'gumroad',
      providerProductRef: 'gumroad-songthing',
      displayName: 'Song Thing',
    });
    const secondCatalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      canonicalSlug: 'jinxxy-song-thing',
      productId: 'product-display-b',
      provider: 'jinxxy',
      providerProductRef: 'jinxxy-song-thing',
      displayName: 'Song Thing',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.shared-display-alias',
      packageName: 'Shared Display Alias Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const uploadBytes = zipSync(
      {
        'Packages/com.yucp.backstage.shared-display-alias/package.json': [
          new TextEncoder().encode('{"name":"com.yucp.backstage.shared-display-alias"}'),
          { mtime: new Date() },
        ],
      },
      { level: 9 }
    );
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(uploadBytes)], { type: 'application/zip' })
      );
    });

    const published = await t.action(api.backstageRepos.publishUploadedReleaseForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      accessSelectors: [
        { kind: 'catalogProduct', catalogProductId: firstCatalogProductId },
        { kind: 'catalogProduct', catalogProductId: secondCatalogProductId },
      ],
      packageId: 'com.yucp.backstage.shared-display-alias',
      storageId,
      version: '1.0.0',
      deliveryName: 'shared-display-alias.zip',
    });

    const release = await t.run(async (ctx) => {
      return await ctx.db.get(
        published.deliveryPackageReleaseId as Id<'delivery_package_releases'>
      );
    });

    expect(release?.metadata).toMatchObject({
      yucp: {
        kind: 'alias-v1',
        aliasId: 'song-thing',
        catalogProductIds: [String(firstCatalogProductId), String(secondCatalogProductId)],
        channel: 'stable',
      },
    });
  });

  it('repairs legacy persisted releases without alias metadata at repo read time', async () => {
    const t = makeTestConvex();
    const catalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-legacy-upload',
      providerProductRef: 'gumroad-product-legacy-upload',
      displayName: 'Legacy Upload Product',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.legacy-upload',
      packageName: 'Legacy Upload Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    const uploadBytes = zipSync(
      {
        'Packages/com.yucp.backstage.legacy-upload/package.json': [
          new TextEncoder().encode('{"name":"com.yucp.backstage.legacy-upload"}'),
          { mtime: new Date() },
        ],
      },
      { level: 9 }
    );
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(uploadBytes)], { type: 'application/zip' })
      );
    });

    const published = await t.action(api.backstageRepos.publishUploadedReleaseForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      accessSelectors: [{ kind: 'catalogProduct', catalogProductId }],
      packageId: 'com.yucp.backstage.legacy-upload',
      storageId,
      version: '2.0.0',
      deliveryName: 'legacy-example.zip',
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(published.deliveryPackageReleaseId as Id<'delivery_package_releases'>, {
        metadata: {
          description: 'Persisted before alias metadata synthesis.',
        },
      });
    });

    const subjectId = await seedSubject(t, {
      authUserId: 'buyer-legacy',
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-legacy-upload',
        sourceProvider: 'gumroad',
        sourceReference: 'order-legacy-upload',
        catalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const repository = await t.query(internal.packageRegistry.buildBackstageRepositoryForSubject, {
      authUserId: 'auth-user-1',
      subjectId,
      repositoryUrl: 'https://api.yucp.test/v1/backstage/repos/index.json',
      packageBaseUrl: 'https://api.yucp.test/v1/backstage/package',
      packageHeaders: {
        'X-YUCP-Repo-Token': 'ybt_example',
      },
    });

    expect(repository).toMatchObject({
      packages: {
        'com.yucp.backstage.legacy-upload': {
          versions: {
            '2.0.0': {
              description: 'Persisted before alias metadata synthesis.',
              vpmDependencies: {
                'com.yucp.importer': '>=0.1.0',
              },
              yucp: {
                kind: 'alias-v1',
                aliasId: 'gumroad-product-legacy-upload',
                installStrategy: 'server-authorized',
                importerPackage: 'com.yucp.importer',
                minImporterVersion: '0.1.0',
                catalogProductIds: [String(catalogProductId)],
                channel: 'stable',
              },
            },
          },
        },
      },
    });

    const publicAccess = await t.run(async (ctx) => {
      return await ctx.runQuery(api.packageRegistry.getPublicBackstageProductAccessByRef, {
        apiSecret: 'test-secret',
        creatorRef: 'auth-user-1',
        productRef: 'gumroad-product-legacy-upload',
      });
    });
    expect(publicAccess?.packageSummaries).toEqual([
      expect.objectContaining({
        packageId: 'com.yucp.backstage.legacy-upload',
        latestPublishedVersion: '2.0.0',
        latestReleaseChannel: 'stable',
        aliasContract: {
          kind: 'alias-v1',
          aliasId: 'gumroad-product-legacy-upload',
          installStrategy: 'server-authorized',
          importerPackage: 'com.yucp.importer',
          minImporterVersion: '0.1.0',
          catalogProductIds: [String(catalogProductId)],
          channel: 'stable',
        },
      }),
    ]);

    const installPlan = await t.run(async (ctx) => {
      return await ctx.runQuery(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
        apiSecret: 'test-secret',
        authUserId: 'auth-user-1',
        subjectId,
        creatorRef: 'auth-user-1',
        productRef: 'gumroad-product-legacy-upload',
      });
    });
    expect(installPlan).toMatchObject({
      packages: [
        {
          packageId: 'com.yucp.backstage.legacy-upload',
          version: '2.0.0',
          channel: 'stable',
          aliasContract: {
            kind: 'alias-v1',
            aliasId: 'gumroad-product-legacy-upload',
            installStrategy: 'server-authorized',
            importerPackage: 'com.yucp.importer',
            minImporterVersion: '0.1.0',
            catalogProductIds: [String(catalogProductId)],
            channel: 'stable',
          },
        },
      ],
    });
  });

  it('refuses ambiguous legacy alias synthesis when linked products resolve to different alias ids', async () => {
    const t = makeTestConvex();
    const firstCatalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-legacy-multi-a',
      providerProductRef: 'gumroad-product-legacy-multi-a',
      displayName: 'Legacy Multi Product A',
    });
    const secondCatalogProductId = await seedCatalogProduct(t, {
      authUserId: 'auth-user-1',
      productId: 'product-legacy-multi-b',
      providerProductRef: 'gumroad-product-legacy-multi-b',
      displayName: 'Legacy Multi Product B',
    });

    await t.mutation(internal.packageRegistry.registerPackage, {
      packageId: 'com.yucp.backstage.legacy-multi',
      packageName: 'Legacy Multi Package',
      publisherId: 'publisher-1',
      yucpUserId: 'auth-user-1',
    });

    await t.mutation(internal.packageRegistry.upsertDeliveryPackageForProducts, {
      authUserId: 'auth-user-1',
      catalogProductIds: [firstCatalogProductId, secondCatalogProductId],
      packageId: 'com.yucp.backstage.legacy-multi',
      packageName: 'Legacy Multi Package',
      displayName: 'Legacy Multi Package',
      repositoryVisibility: 'listed',
      defaultChannel: 'stable',
    });
    await t.mutation(internal.packageRegistry.recordDeliveryPackageRelease, {
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.backstage.legacy-multi',
      version: '3.0.0',
      channel: 'stable',
      releaseStatus: 'published',
      repositoryVisibility: 'listed',
      metadata: {
        description: 'Persisted before alias metadata synthesis.',
      },
    });

    const subjectId = await seedSubject(t, {
      authUserId: 'buyer-legacy-multi',
    });
    await t.run(async (ctx) => {
      await ctx.db.insert('entitlements', {
        authUserId: 'auth-user-1',
        subjectId,
        productId: 'product-legacy-multi-b',
        sourceProvider: 'gumroad',
        sourceReference: 'order-legacy-multi-b',
        catalogProductId: secondCatalogProductId,
        status: 'active',
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const repository = await t.query(internal.packageRegistry.buildBackstageRepositoryForSubject, {
      authUserId: 'auth-user-1',
      subjectId,
      repositoryUrl: 'https://api.yucp.test/v1/backstage/repos/index.json',
      packageBaseUrl: 'https://api.yucp.test/v1/backstage/package',
      packageHeaders: {
        'X-YUCP-Repo-Token': 'ybt_example',
      },
    });
    const publishedVersion = repository?.packages?.['com.yucp.backstage.legacy-multi']?.versions?.[
      '3.0.0'
    ] as Record<string, unknown> | undefined;
    expect(publishedVersion?.description).toBe('Persisted before alias metadata synthesis.');
    expect(publishedVersion).not.toHaveProperty('yucp');
    expect(publishedVersion?.dependencies).toBeUndefined();

    const installPlan = await t.run(async (ctx) => {
      return await ctx.runQuery(api.packageRegistry.getAuthorizedAliasInstallPlanByRef, {
        apiSecret: 'test-secret',
        authUserId: 'auth-user-1',
        subjectId,
        creatorRef: 'auth-user-1',
        productRef: 'gumroad-product-legacy-multi-b',
      });
    });
    expect(installPlan).toBeNull();
  });

  it('deletes non-current Backstage uploads and their stored release artifacts', async () => {
    const t = makeTestConvex();
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const signedStorageId = await ctx.storage.store(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' })
      );
      const rawStorageId = await ctx.storage.store(
        new Blob([new Uint8Array([4, 5, 6])], { type: 'application/zip' })
      );
      const deliverableStorageId = await ctx.storage.store(
        new Blob([new Uint8Array([7, 8, 9])], { type: 'application/zip' })
      );
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.backstage.deleteable',
        packageName: 'Deleteable Package',
        displayName: 'Deleteable Package',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        latestPublishedVersion: '2.0.0',
        latestPublishedAt: now + 1_000,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.backstage.deleteable',
        version: '2.0.0',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        zipSha256: 'a'.repeat(64),
        publishedAt: now + 1_000,
        createdAt: now + 1_000,
        updatedAt: now + 1_000,
      } as never);
      const deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.backstage.deleteable',
        version: '1.0.0',
        channel: 'stable',
        releaseStatus: 'revoked',
        repositoryVisibility: 'hidden',
        zipSha256: 'b'.repeat(64),
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      const signedArtifactId = await ctx.db.insert('signed_release_artifacts', {
        artifactKey: 'backstage-package:com.yucp.backstage.deleteable',
        channel: 'stable',
        platform: 'any',
        version: '1.0.0',
        metadataVersion: 1,
        storageId: signedStorageId,
        contentType: 'application/zip',
        deliveryName: 'deleteable-package-1.0.0.zip',
        envelopeCipher: 'aes-256-gcm',
        envelopeIvBase64: 'ZmFrZS1pdi1iYXNlNjQ=',
        ciphertextSha256: 'c'.repeat(64),
        ciphertextSize: 3,
        plaintextSha256: 'd'.repeat(64),
        plaintextSize: 3,
        status: 'active',
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(deliveryPackageReleaseId, {
        signedArtifactId,
        artifactKey: 'backstage-package:com.yucp.backstage.deleteable',
      });
      const rawArtifactId = await ctx.db.insert('delivery_release_artifacts', {
        deliveryPackageReleaseId,
        artifactRole: 'raw_upload',
        ownership: 'creator_upload',
        storageId: rawStorageId,
        contentType: 'application/zip',
        deliveryName: 'deleteable-package-1.0.0-source.zip',
        sha256: '1'.repeat(64),
        byteSize: 3,
        status: 'active',
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('delivery_release_artifacts', {
        deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
        ownership: 'server_materialized',
        materializationStrategy: 'normalized_repack',
        sourceArtifactId: rawArtifactId,
        storageId: deliverableStorageId,
        contentType: 'application/zip',
        deliveryName: 'deleteable-package-1.0.0.zip',
        sha256: '2'.repeat(64),
        byteSize: 3,
        status: 'active',
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      return {
        deliveryPackageId,
        deliveryPackageReleaseId,
        signedArtifactId,
        signedStorageId,
        rawStorageId,
        deliverableStorageId,
      };
    });

    const result = await t.mutation(api.packageRegistry.deleteReleaseForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.backstage.deleteable',
      deliveryPackageReleaseId: seeded.deliveryPackageReleaseId,
    });

    expect(result).toEqual({
      deleted: true,
      deliveryPackageReleaseId: seeded.deliveryPackageReleaseId,
    });

    const deletedState = await t.run(async (ctx) => {
      return {
        deliveryPackage: await ctx.db.get(seeded.deliveryPackageId),
        release: await ctx.db.get(seeded.deliveryPackageReleaseId),
        signedArtifact: await ctx.db.get(seeded.signedArtifactId),
        releaseArtifacts: await ctx.db
          .query('delivery_release_artifacts')
          .withIndex('by_release', (q) =>
            q.eq('deliveryPackageReleaseId', seeded.deliveryPackageReleaseId)
          )
          .collect(),
        signedBlob: await ctx.storage.get(seeded.signedStorageId),
        rawBlob: await ctx.storage.get(seeded.rawStorageId),
        deliverableBlob: await ctx.storage.get(seeded.deliverableStorageId),
      };
    });

    expect(deletedState.deliveryPackage).not.toBeNull();
    expect(deletedState.release).toBeNull();
    expect(deletedState.signedArtifact).toBeNull();
    expect(deletedState.releaseArtifacts).toHaveLength(0);
    expect(deletedState.signedBlob).toBeNull();
    expect(deletedState.rawBlob).toBeNull();
    expect(deletedState.deliverableBlob).toBeNull();
  });

  it('deletes the current Backstage upload and resets the package when it was the last file', async () => {
    const t = makeTestConvex();
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.backstage.current-delete',
        packageName: 'Current Delete Package',
        displayName: 'Current Delete Package',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        latestPublishedVersion: '1.0.0',
        latestPublishedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.backstage.current-delete',
        version: '1.0.0',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        zipSha256: 'e'.repeat(64),
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);

      return {
        deliveryPackageId,
        deliveryPackageReleaseId,
      };
    });

    const result = await t.mutation(api.packageRegistry.deleteReleaseForAuthUser, {
      apiSecret: 'test-secret',
      actor: await createAuthUserActorBinding('auth-user-1'),
      authUserId: 'auth-user-1',
      packageId: 'com.yucp.backstage.current-delete',
      deliveryPackageReleaseId: seeded.deliveryPackageReleaseId,
    });

    expect(result).toEqual({
      deleted: true,
      deliveryPackageReleaseId: seeded.deliveryPackageReleaseId,
    });

    const deletedState = await t.run(async (ctx) => {
      return {
        deliveryPackage: await ctx.db.get(seeded.deliveryPackageId),
        release: await ctx.db.get(seeded.deliveryPackageReleaseId),
      };
    });
    expect(deletedState.release).toBeNull();
    expect(deletedState.deliveryPackage?.packageId).toBe('com.yucp.backstage.current-delete');
    expect(deletedState.deliveryPackage?.latestPublishedAt).toBeUndefined();
    expect(deletedState.deliveryPackage?.latestPublishedVersion).toBeUndefined();
    expect(deletedState.deliveryPackage?.repositoryVisibility).toBe('hidden');
  });

  it('resolves legacy signed releases through the centralized release artifact resolver', async () => {
    const t = makeTestConvex();
    const deliveryPackageReleaseId = await t.run(async (ctx) => {
      const now = Date.now();
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.backstage.legacy',
        packageName: 'Legacy Resolver',
        displayName: 'Legacy Resolver',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.backstage.legacy',
        version: '1.0.0',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        zipSha256: 'e'.repeat(64),
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
    });
    const storageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([new Uint8Array([8, 9, 10])], { type: 'application/zip' })
      );
    });

    const artifactId = await t.mutation(internal.releaseArtifacts.publishArtifact, {
      artifactKey: 'backstage-package:com.yucp.backstage.legacy',
      channel: 'stable',
      platform: 'any',
      version: '1.0.0',
      metadataVersion: 1,
      storageId,
      contentType: 'application/zip',
      deliveryName: 'legacy-package-1.0.0.zip',
      envelopeCipher: 'aes-256-gcm',
      envelopeIvBase64: 'ZmFrZS1pdi1iYXNlNjQ=',
      ciphertextSha256: 'c'.repeat(64),
      ciphertextSize: 3,
      plaintextSha256: 'd'.repeat(64),
      plaintextSize: 3,
    });

    const resolved = await t.query(internal.packageRegistry.resolveDownloadableArtifactForRelease, {
      deliveryPackageReleaseId,
      signedArtifactId: artifactId,
      version: '1.0.0',
      channel: 'stable',
      zipSha256: 'e'.repeat(64),
    });

    expect(resolved).toMatchObject({
      deliveryArtifactMode: 'legacy_signed',
      artifactId,
      artifactKey: 'backstage-package:com.yucp.backstage.legacy',
      deliveryName: 'legacy-package-1.0.0.zip',
      contentType: 'application/zip',
      zipSha256: 'e'.repeat(64),
      version: '1.0.0',
      channel: 'stable',
    });
    expect(resolved?.deliveryArtifactId).toBeUndefined();
    expect(resolved?.downloadUrl).toContain('/storage/');
  });

  it('resolves server-owned deliverables through the centralized release artifact resolver', async () => {
    const t = makeTestConvex();
    const uploadBytes = zipSync(
      {
        'Packages/com.yucp.backstage.centralized/package.json': [
          new TextEncoder().encode('{"name":"com.yucp.backstage.centralized"}'),
          { mtime: new Date() },
        ],
        'Packages/com.yucp.backstage.centralized/README.md': [
          new TextEncoder().encode('hello'),
          { mtime: new Date() },
        ],
      },
      { level: 9 }
    );
    const uploadSha256 = await sha256Hex(uploadBytes);
    const uploadStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(uploadBytes)], { type: 'application/zip' })
      );
    });

    const release = await t.run(async (ctx) => {
      const now = Date.now();
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.backstage.centralized',
        packageName: 'Centralized Resolver',
        displayName: 'Centralized Resolver',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        createdAt: now,
        updatedAt: now,
      });
      const deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.backstage.centralized',
        version: '1.0.0',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        zipSha256: uploadSha256,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      return { deliveryPackageReleaseId };
    });

    const materialized = await t.action(
      internal.releaseArtifacts.materializeUploadedReleaseDeliverable,
      {
        deliveryPackageReleaseId: release.deliveryPackageReleaseId,
        storageId: uploadStorageId,
        contentType: 'application/zip',
        deliveryName: 'centralized.zip',
        sha256: uploadSha256,
      }
    );

    const resolved = await t.query(internal.packageRegistry.resolveDownloadableArtifactForRelease, {
      deliveryPackageReleaseId: release.deliveryPackageReleaseId,
      version: '1.0.0',
      channel: 'stable',
      zipSha256: materialized.deliverableSha256,
    });

    expect(resolved).toMatchObject({
      deliveryArtifactId: materialized.deliverableArtifactId,
      deliveryArtifactMode: 'server_materialized',
      deliveryName: 'centralized.zip',
      contentType: 'application/zip',
      zipSha256: materialized.deliverableSha256,
      version: '1.0.0',
      channel: 'stable',
    });
    expect(resolved?.artifactId).toBeUndefined();
    expect(resolved?.artifactKey).toBeUndefined();
    expect(resolved?.downloadUrl).toBe('');
    expect(resolved?.cdngineDelivery).toMatchObject({
      assetOwner: 'creator:auth-user-1',
      deliveryScopeId: 'paid-downloads',
      serviceNamespaceId: 'yucp-backstage',
    });
  });

  it('carries CDNgine coordinates with server-owned deliverable downloads', async () => {
    const t = makeTestConvex();
    const { deliveryPackageReleaseId, deliverableArtifactId } = await t.run(async (ctx) => {
      const now = Date.now();
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.backstage.cdngine',
        packageName: 'CDNgine Package',
        displayName: 'CDNgine Package',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        createdAt: now,
        updatedAt: now,
      });
      const deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.backstage.cdngine',
        version: '1.0.0',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        zipSha256: 'c'.repeat(64),
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      const storageId = await ctx.storage.store(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' })
      );
      const deliverableArtifactId = await ctx.db.insert('delivery_release_artifacts', {
        deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
        ownership: 'server_materialized',
        materializationStrategy: 'normalized_repack',
        storageId,
        contentType: 'application/zip',
        deliveryName: 'cdngine-package-1.0.0.zip',
        sha256: 'c'.repeat(64),
        byteSize: 3,
        status: 'active',
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
        cdngineDelivery: {
          assetId: 'ast_backstage_cdngine',
          versionId: 'ver_backstage_cdngine',
          deliveryScopeId: 'paid-downloads',
          variant: 'vpm-package',
          serviceNamespaceId: 'yucp-backstage',
          tenantId: 'auth-user-1',
          assetOwner: 'creator:auth-user-1',
          sha256: 'c'.repeat(64),
          byteSize: 3,
          uploadedAt: now,
        },
      } as never);
      return { deliveryPackageReleaseId, deliverableArtifactId };
    });

    const resolved = await t.query(internal.packageRegistry.resolveDownloadableArtifactForRelease, {
      deliveryPackageReleaseId,
      version: '1.0.0',
      channel: 'stable',
      zipSha256: 'c'.repeat(64),
    });

    expect(resolved).toMatchObject({
      deliveryArtifactId: deliverableArtifactId,
      deliveryArtifactMode: 'server_materialized',
      cdngineDelivery: {
        assetId: 'ast_backstage_cdngine',
        versionId: 'ver_backstage_cdngine',
        deliveryScopeId: 'paid-downloads',
        variant: 'vpm-package',
        serviceNamespaceId: 'yucp-backstage',
        tenantId: 'auth-user-1',
        assetOwner: 'creator:auth-user-1',
        sha256: 'c'.repeat(64),
        byteSize: 3,
      },
    });
    expect(resolved?.downloadUrl).toContain('/storage/');
  });

  it('resolves unitypackage uploads through the centralized zip deliverable resolver', async () => {
    const t = makeTestConvex();
    const uploadBytes = buildUnitypackage([
      { path: 'asset-guid/asset', content: strToU8('asset-bytes') },
      { path: 'asset-guid/pathname', content: strToU8('Assets/JAMMR/readme.txt') },
    ]);
    const uploadSha256 = await sha256Hex(uploadBytes);
    const uploadStorageId = await t.run(async (ctx) => {
      return await ctx.storage.store(
        new Blob([toArrayBuffer(uploadBytes)], { type: 'application/octet-stream' })
      );
    });

    const release = await t.run(async (ctx) => {
      const now = Date.now();
      const deliveryPackageId = await ctx.db.insert('delivery_packages', {
        authUserId: 'auth-user-1',
        packageId: 'com.yucp.jammr',
        packageName: 'JAMMR',
        displayName: 'JAMMR',
        status: 'active',
        repositoryVisibility: 'listed',
        defaultChannel: 'stable',
        createdAt: now,
        updatedAt: now,
      });
      const deliveryPackageReleaseId = await ctx.db.insert('delivery_package_releases', {
        authUserId: 'auth-user-1',
        deliveryPackageId,
        packageId: 'com.yucp.jammr',
        version: '2.1.5',
        channel: 'stable',
        releaseStatus: 'published',
        repositoryVisibility: 'listed',
        zipSha256: uploadSha256,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      return { deliveryPackageReleaseId };
    });

    const materialized = await t.action(
      internal.releaseArtifacts.materializeUploadedReleaseDeliverable,
      {
        deliveryPackageReleaseId: release.deliveryPackageReleaseId,
        storageId: uploadStorageId,
        contentType: 'application/octet-stream',
        deliveryName: 'JAMMR_2.1.5.unitypackage',
        sha256: uploadSha256,
      }
    );

    const resolved = await t.query(internal.packageRegistry.resolveDownloadableArtifactForRelease, {
      deliveryPackageReleaseId: release.deliveryPackageReleaseId,
      version: '2.1.5',
      channel: 'stable',
      zipSha256: materialized.deliverableSha256,
    });

    expect(resolved).toMatchObject({
      deliveryArtifactId: materialized.deliverableArtifactId,
      deliveryArtifactMode: 'server_materialized',
      deliveryName: 'vrc-get-com.yucp.jammr-2.1.5.zip',
      contentType: 'application/zip',
      zipSha256: materialized.deliverableSha256,
      version: '2.1.5',
      channel: 'stable',
    });
  });

  it('issues revocable Backstage repo tokens for an authenticated subject', async () => {
    const t = makeTestConvex();
    const subjectId = await seedSubject(t, {
      authUserId: 'auth-user-1',
      primaryDiscordUserId: 'discord-token-user',
    });

    const result = await t.mutation(internal.packageRegistry.issueBackstageRepoToken, {
      authUserId: 'auth-user-1',
      subjectId,
      label: 'VCC desktop',
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    expect(result.token).toMatch(/^ybt_[0-9a-f]+$/);
    const access = await t.query(internal.packageRegistry.getBackstageRepoAccessByToken, {
      tokenHash: await crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(result.token))
        .then((buffer) =>
          Array.from(new Uint8Array(buffer))
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')
        ),
    });

    expect(access).toMatchObject({
      tokenId: result.tokenId,
      authUserId: 'auth-user-1',
      subjectId,
      status: 'active',
    });
  });
});
