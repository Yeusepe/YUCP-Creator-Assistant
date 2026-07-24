import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Catalog, openCatalogDatabase, runCatalogMigrations } from '../catalog';
import { ExactStorageCatalog } from '../catalog/exactStorageCatalog';
import type { CatalogDatabase } from '../catalog/database';
import { StorageGcCatalog } from '../catalog/storageGcCatalog';
import { DurableExactStorage } from '../storage-core/durableExactStorage';
import {
  S3ExactStoragePort,
  type StorageRole,
} from '../storage-core/exactStorage';
import { listS3ObjectVersions } from '../storage-core/s3Control';
import {
  type DisposableStorageHarness,
  startDisposableStorageHarness,
} from '../testing/disposableStorageHarness';
import { runExactVersionGarbageCollection } from './exactVersionGc';

class ExpiredRetentionStorage extends S3ExactStoragePort {
  override async getRetention(): Promise<{
    mode: 'GOVERNANCE';
    retainUntil: Date;
  }> {
    return {
      mode: 'GOVERNANCE',
      retainUntil: new Date('2000-01-01T00:00:00.000Z'),
    };
  }
}

let harness: DisposableStorageHarness | undefined;
let sql: CatalogDatabase | undefined;

function requireHarness(): DisposableStorageHarness {
  if (!harness) {
    throw new Error('Exact-version GC storage harness was not initialized');
  }
  return harness;
}

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('Exact-version GC database was not initialized');
  }
  return sql;
}

beforeAll(async () => {
  harness = await startDisposableStorageHarness();
  sql = openCatalogDatabase(harness.postgres.url);
  await runCatalogMigrations(sql);
});

afterAll(async () => {
  const activeSql = sql;
  const activeHarness = harness;
  sql = undefined;
  harness = undefined;
  try {
    await activeSql?.end({ timeout: 1 });
  } finally {
    await activeHarness?.stop();
  }
});

describe.serial('exact-version garbage collection', () => {
  it('requires two generations and preserves shared and unrelated objects', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const catalog = new Catalog(activeSql);
    const exactCatalog = new ExactStorageCatalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const storage = new ExpiredRetentionStorage({
      common: activeHarness.buckets.common,
      metadata: activeHarness.buckets.metadata,
      protected: activeHarness.buckets.protected,
    });
    const durableStorage = new DurableExactStorage(exactCatalog, storage);
    const v1 = await catalog.createVersion({
      packageId: 'com.yucp.gc-shared',
      version: '1.0.0',
    });
    const v2 = await catalog.createVersion({
      packageId: 'com.yucp.gc-shared',
      version: '2.0.0',
    });
    const unrelated = await catalog.createVersion({
      packageId: 'com.yucp.gc-unrelated',
      version: '1.0.0',
    });
    const sharedBody = 'shared shader bytes';
    const unrelatedBody = 'unrelated package bytes';
    const sharedObject = await durableStorage.putImmutable({
      body: sharedBody,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${v1.id}:shared`,
      objectKey:
        'v2/common/chunks/07/072bdbd3fe06c23e0fa9a0732eb1f189505406df707a598b2e0a5ead617867cb',
      ownerId: v1.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest:
          '072bdbd3fe06c23e0fa9a0732eb1f189505406df707a598b2e0a5ead617867cb',
        logicalKind: 'chunk',
      },
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    const reusedObject = await durableStorage.putImmutable({
      body: sharedBody,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${v2.id}:shared`,
      objectKey: sharedObject.objectKey,
      ownerId: v2.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: sharedObject.sha256,
        logicalKind: 'chunk',
      },
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    const unrelatedObject = await durableStorage.putImmutable({
      body: unrelatedBody,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${unrelated.id}:unrelated`,
      objectKey:
        'v2/common/chunks/a1/a1480e684917cfacd11102a301830ccaae6185dd3ac1dc615664d72e4a9b7888',
      ownerId: unrelated.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest:
          'a1480e684917cfacd11102a301830ccaae6185dd3ac1dc615664d72e4a9b7888',
        logicalKind: 'chunk',
      },
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });

    expect(reusedObject.id).toBe(sharedObject.id);
    await catalog.deleteVersion(v1.id, { reason: 'creator-request' });
    const whileShared = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    expect(whileShared.candidatesObserved).toBe(0);

    await catalog.deleteVersion(v2.id, { reason: 'creator-request' });
    const first = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    expect(first.candidatesObserved).toBe(1);
    expect(first.deletedObjects).toBe(0);
    expect(
      await storage.listExactVersions({
        objectKey: sharedObject.objectKey,
        role: 'common',
      })
    ).toHaveLength(1);

    const second = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    expect(second.deletedObjects).toBe(1);
    expect(
      await storage.listExactVersions({
        objectKey: sharedObject.objectKey,
        role: 'common',
      })
    ).toEqual([]);
    expect(
      await storage.listExactVersions({
        objectKey: unrelatedObject.objectKey,
        role: 'common',
      })
    ).toHaveLength(1);

    const catalogRows = await activeSql<
      { id: string; verification_state: string }[]
    >`
      SELECT id, verification_state
      FROM storage_object_versions
      ORDER BY id
    `;
    expect(catalogRows).toContainEqual({
      id: sharedObject.id,
      verification_state: 'DELETED',
    });
    expect(catalogRows).toContainEqual({
      id: unrelatedObject.id,
      verification_state: 'VERIFIED',
    });
    const remainingVersions = (
      await listS3ObjectVersions(activeHarness.buckets.common)
    ).filter((version) => !version.deleteMarker);
    expect(
      remainingVersions.some(
        (version) =>
          version.key === unrelatedObject.objectKey &&
          version.versionId === unrelatedObject.providerVersion
      )
    ).toBeTrue();
  }, 180_000);

  it('keeps deleted releases while a durable legal-hold pin exists', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const catalog = new Catalog(activeSql);
    const exactCatalog = new ExactStorageCatalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const storage = new ExpiredRetentionStorage({
      protected: activeHarness.buckets.protected,
    });
    const durableStorage = new DurableExactStorage(exactCatalog, storage);
    const version = await catalog.createVersion({
      packageId: 'com.yucp.gc-held',
      version: '1.0.0',
    });
    const body = 'protected source bytes';
    const object = await durableStorage.putImmutable({
      body,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${version.id}:held`,
      objectKey:
        'v2/protected/creator-1/chunks/a2/a28f272dcdbd91446b79a8553eb6694e2847af6860e9e761d7355ffd0f429928',
      ownerId: version.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest:
          'a28f272dcdbd91446b79a8553eb6694e2847af6860e9e761d7355ffd0f429928',
        logicalKind: 'chunk',
      },
      storageDomain: 'protected:creator-1:v2',
      storageRole: 'protected',
    });
    const pin = await gcCatalog.createReleasePin({
      ownerId: 'legal-case-1',
      packageVersionId: version.id,
      pinKind: 'legal-hold',
    });
    await catalog.deleteVersion(version.id, { reason: 'creator-request' });

    await runExactVersionGarbageCollection({ catalog: gcCatalog, storage });
    const held = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    expect(held.deletedObjects).toBe(0);
    expect(
      await storage.listExactVersions({
        objectKey: object.objectKey,
        role: object.storageRole as StorageRole,
      })
    ).toHaveLength(1);

    await gcCatalog.releaseReleasePin(pin.id);
    await runExactVersionGarbageCollection({ catalog: gcCatalog, storage });
    const released = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    expect(released.deletedObjects).toBe(1);
  }, 180_000);
});
