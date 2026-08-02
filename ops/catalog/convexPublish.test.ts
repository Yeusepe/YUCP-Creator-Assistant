import { describe, expect, it, mock } from 'bun:test';
import { verifyApiActorBinding } from '@yucp/shared/apiActor';
import { getFunctionName } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import {
  createConvexCatalogPublish,
  createConvexPackageCreatorResolver,
  loadConvexCatalogPublishConfig,
} from './convexPublish';
import type { CatalogOutboxEvent } from './reconciler';

const config = {
  convexApiSecret: 'test-convex-api-secret',
  convexUrl: 'https://catalog-publisher.convex.cloud',
  internalServiceAuthSecret: 'test-internal-service-auth-secret',
} as const;

describe('createConvexCatalogPublish', () => {
  it('loads an optional publish timeout with a 15-second default', () => {
    const env = {
      CONVEX_API_SECRET: config.convexApiSecret,
      CONVEX_URL: config.convexUrl,
      INTERNAL_SERVICE_AUTH_SECRET: config.internalServiceAuthSecret,
    };

    expect(loadConvexCatalogPublishConfig(env).publishTimeoutMs).toBe(15_000);
    expect(
      loadConvexCatalogPublishConfig({
        ...env,
        CATALOG_CONVEX_PUBLISH_TIMEOUT_MS: '25',
      }).publishTimeoutMs
    ).toBe(25);
  });

  it('maps a READY outbox event to one authenticated Convex upsert', async () => {
    const mutation = mock(async (_reference: unknown, _args: unknown) => 'version-ref-id');
    const createClient = mock((url: string) => {
      expect(url).toBe(config.convexUrl);
      return { mutation };
    });
    const publish = createConvexCatalogPublish(config, { createClient });
    const createdAt = new Date('2026-07-17T15:30:00.000Z');
    const event: CatalogOutboxEvent = {
      id: 'outbox-ready-1',
      aggregateId: 'version-123',
      eventType: 'catalog.version.ready',
      payload: {
        versionId: 'version-123',
        packageId: 'com.yucp.avatar-tools',
        catalogProductId: 'catalog-product-123',
        editionId: 'commercial',
        version: '1.2.3',
        activeContentDigest: '55'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        bindingRoot: '22'.repeat(32),
        bootstrapMedia: [
          {
            bucketName: 'metadata',
            byteSize: 9,
            contentType: 'image/png',
            kind: 'icon',
            localPath: 'Documentation~/YUCP/icon.png',
            objectKey: 'indexes/bootstrap-media/aa.png',
            providerVersion: 'exact-version-1',
            sha256: 'aa'.repeat(32),
          },
        ],
        commonRoot: '66'.repeat(32),
        logicalBytes: 1_048_576,
        logicalFiles: 42,
        manifestSha256: '33'.repeat(32),
        packageMetadata: {
          author: 'YUCP Studio',
          packageName: 'Avatar Tools',
          version: '1.2.3',
        },
        protectedFiles: [
          {
            materializerType: 'png',
            normalizedPath: 'Assets/Textures/body.png',
            required: false,
            sourceSha256: '77'.repeat(32),
          },
        ],
        protectedSourceRoot: '88'.repeat(32),
        protectionPolicyDigest: '99'.repeat(32),
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        previousState: 'PROMOTING',
        releaseRoot: '44'.repeat(32),
        state: 'READY',
        verification: 'full-reassembly',
        vpmDependencies: {
          'com.example.runtime': '>=2.0.0',
        },
        vpmRepositories: {
          'Example Repository': 'https://packages.example.test/index.json',
        },
      },
      createdAt,
    };

    await publish(event);

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledTimes(1);
    const [reference, args] = mutation.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(getFunctionName(reference as never)).toBe(
      getFunctionName(api.packageVersions.upsertReadyVersion)
    );
    expect(args).toMatchObject({
      apiSecret: config.convexApiSecret,
      packageId: 'com.yucp.avatar-tools',
      catalogProductId: 'catalog-product-123',
      editionId: 'commercial',
      version: '1.2.3',
      versionId: 'version-123',
      activeContentDigest: '55'.repeat(32),
      activePolicyVersion: 'active-content-policy-v1',
      bindingRoot: '22'.repeat(32),
      bootstrapMedia: [
        {
          bucketName: 'metadata',
          byteSize: 9,
          contentType: 'image/png',
          kind: 'icon',
          localPath: 'Documentation~/YUCP/icon.png',
          objectKey: 'indexes/bootstrap-media/aa.png',
          providerVersion: 'exact-version-1',
          sha256: 'aa'.repeat(32),
        },
      ],
      commonRoot: '66'.repeat(32),
      logicalBytes: 1_048_576,
      logicalFiles: 42,
      manifestSha256: '33'.repeat(32),
      packageMetadata: {
        author: 'YUCP Studio',
        packageName: 'Avatar Tools',
        version: '1.2.3',
      },
      protectedFiles: [
        {
          materializerType: 'png',
          normalizedPath: 'Assets/Textures/body.png',
          required: false,
          sourceSha256: '77'.repeat(32),
        },
      ],
      protectedSourceRoot: '88'.repeat(32),
      protectionPolicyDigest: '99'.repeat(32),
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      releaseRoot: '44'.repeat(32),
      createdAt: createdAt.getTime(),
      vpmDependencies: {
        'com.example.runtime': '>=2.0.0',
      },
      vpmRepositories: {
        'Example Repository': 'https://packages.example.test/index.json',
      },
    });
    await expect(
      verifyApiActorBinding(
        args.actor as { payload: string; signature: string },
        config.internalServiceAuthSecret
      )
    ).resolves.toMatchObject({
      kind: 'service',
      service: 'catalog-ready-publisher',
      scopes: ['downloads:service'],
    });
  });

  it('preserves best-effort protected file requirements', async () => {
    const mutation = mock(async (_reference: unknown, _args: unknown) => 'version-ref-id');
    const publish = createConvexCatalogPublish(config, {
      createClient: () => ({ mutation }),
    });

    await publish({
      id: 'outbox-ready-best-effort',
      aggregateId: 'version-best-effort',
      eventType: 'catalog.version.ready',
      payload: {
        versionId: 'version-best-effort',
        packageId: 'com.yucp.best-effort',
        editionId: 'standard',
        version: '2.0.0',
        activeContentDigest: '11'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        bindingRoot: '22'.repeat(32),
        commonRoot: '33'.repeat(32),
        logicalBytes: 64,
        logicalFiles: 1,
        manifestSha256: '44'.repeat(32),
        protectedFiles: [
          {
            materializerType: 'png',
            normalizedPath: 'Assets/Textures/tiny.png',
            required: false,
            sourceSha256: '55'.repeat(32),
          },
        ],
        protectedSourceRoot: '66'.repeat(32),
        protectionPolicyDigest: '77'.repeat(32),
        protectionPolicyId: 'supported-visual-assets-v3',
        previousState: 'PROMOTING',
        releaseRoot: '88'.repeat(32),
        state: 'READY',
        verification: 'full-reassembly',
        vpmDependencies: {},
        vpmRepositories: {},
      },
      createdAt: new Date('2026-07-24T12:00:00.000Z'),
    });

    const [, args] = mutation.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(args.protectedFiles).toEqual([
      {
        materializerType: 'png',
        normalizedPath: 'Assets/Textures/tiny.png',
        required: false,
        sourceSha256: '55'.repeat(32),
      },
    ]);
  });

  it('maps a DELETED outbox event to one authenticated Convex tombstone', async () => {
    const mutation = mock(async (_reference: unknown, _args: unknown) => undefined);
    const publish = createConvexCatalogPublish(config, {
      createClient: () => ({ mutation }),
    });
    const createdAt = new Date('2026-07-17T16:30:00.000Z');

    await publish({
      id: 'outbox-deleted-1',
      aggregateId: 'version-123',
      eventType: 'catalog.version.deleted',
      payload: {
        versionId: 'version-123',
        packageId: 'com.yucp.avatar-tools',
        version: '1.2.3',
        previousState: 'READY',
        state: 'DELETED',
        reason: 'creator-request',
      },
      createdAt,
    });

    expect(mutation).toHaveBeenCalledTimes(1);
    const [reference, args] = mutation.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(getFunctionName(reference as never)).toBe(
      getFunctionName(api.packageVersions.markVersionDeleted)
    );
    expect(args).toMatchObject({
      apiSecret: config.convexApiSecret,
      versionId: 'version-123',
      deletedAt: createdAt.getTime(),
    });
  });

  it('does not call Convex for other outbox events', async () => {
    const mutation = mock(async (_reference: unknown, _args: unknown) => undefined);
    const createClient = mock(() => ({ mutation }));
    const publish = createConvexCatalogPublish(config, {
      createClient,
    });

    await publish({
      id: 'outbox-assembled-1',
      aggregateId: 'version-123',
      eventType: 'catalog.version.assembled',
      payload: {},
      createdAt: new Date('2026-07-17T15:00:00.000Z'),
    });

    expect(createClient).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  it('rejects a hung Convex publish within the configured timeout', async () => {
    const mutation = mock(() => new Promise<never>(() => undefined));
    const publish = createConvexCatalogPublish(
      { ...config, publishTimeoutMs: 10 },
      { createClient: () => ({ mutation }) }
    );
    const event: CatalogOutboxEvent = {
      id: 'outbox-ready-hung',
      aggregateId: 'version-hung',
      eventType: 'catalog.version.ready',
      payload: {
        versionId: 'version-hung',
        packageId: 'com.yucp.hung',
        editionId: 'standard',
        version: '1.0.0',
        activeContentDigest: '55'.repeat(32),
        activePolicyVersion: 'active-content-policy-v1',
        bindingRoot: '22'.repeat(32),
        commonRoot: '66'.repeat(32),
        logicalBytes: 1,
        logicalFiles: 1,
        manifestSha256: '33'.repeat(32),
        protectedFiles: [],
        protectedSourceRoot: '77'.repeat(32),
        protectionPolicyDigest: '88'.repeat(32),
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        releaseRoot: '44'.repeat(32),
        vpmDependencies: {},
        vpmRepositories: {},
      },
      createdAt: new Date('2026-07-17T15:30:00.000Z'),
    };
    const testGuard = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('test guard expired')), 250);
    });

    await expect(Promise.race([publish(event), testGuard])).rejects.toThrow(
      'Convex catalog publish timed out after 10ms'
    );
    expect(mutation).toHaveBeenCalledTimes(1);
  });
});

describe('createConvexPackageCreatorResolver', () => {
  it('resolves the protected-content deduplication owner through the package registry', async () => {
    const query = mock(async (_reference: unknown, _args: unknown) => ({
      creatorAuthUserId: 'creator-auth-user',
    }));
    const resolveCreatorId = createConvexPackageCreatorResolver(config, {
      createClient: () => ({ query }),
    });

    await expect(resolveCreatorId({ packageId: 'com.yucp.avatar-tools' })).resolves.toBe(
      'creator-auth-user'
    );

    const [reference, args] = query.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(getFunctionName(reference as never)).toBe(
      getFunctionName(api.packageRegistry.getBuyerAccessContextByPackageId)
    );
    expect(args).toMatchObject({
      apiSecret: config.convexApiSecret,
      packageId: 'com.yucp.avatar-tools',
    });
    await expect(
      verifyApiActorBinding(
        args.actor as { payload: string; signature: string },
        config.internalServiceAuthSecret
      )
    ).resolves.toMatchObject({
      kind: 'service',
      service: 'catalog-legacy-migrator',
      scopes: ['downloads:service'],
    });
  });

  it('rejects a legacy package without an authoritative creator mapping', async () => {
    const resolveCreatorId = createConvexPackageCreatorResolver(config, {
      createClient: () => ({ query: async () => null }),
    });

    await expect(resolveCreatorId({ packageId: 'com.yucp.orphaned' })).rejects.toThrow(
      'Package com.yucp.orphaned has no active creator mapping'
    );
  });
});
