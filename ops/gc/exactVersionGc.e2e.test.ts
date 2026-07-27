import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  Catalog,
  openCatalogDatabase,
  runCatalogMigrations,
  type StorageObjectVersion,
  TufRepositoryCatalog,
} from '../catalog';
import type { CatalogDatabase } from '../catalog/database';
import { ExactStorageCatalog } from '../catalog/exactStorageCatalog';
import { StorageGcCatalog } from '../catalog/storageGcCatalog';
import { DurableExactStorage } from '../storage-core/durableExactStorage';
import { S3ExactStoragePort, type StorageRole } from '../storage-core/exactStorage';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
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

class BlockingDeletionStorage extends ExpiredRetentionStorage {
  readonly deletionStarted: Promise<void>;
  private allowDeletion: (() => void) | undefined;
  private readonly deletionAllowed: Promise<void>;
  private markDeletionStarted: (() => void) | undefined;

  constructor(config: ConstructorParameters<typeof S3ExactStoragePort>[0]) {
    super(config);
    this.deletionStarted = new Promise((resolve) => {
      this.markDeletionStarted = resolve;
    });
    this.deletionAllowed = new Promise((resolve) => {
      this.allowDeletion = resolve;
    });
  }

  releaseDeletion(): void {
    this.allowDeletion?.();
  }

  override async deleteExactVersion(
    input: Parameters<S3ExactStoragePort['deleteExactVersion']>[0]
  ): Promise<void> {
    this.markDeletionStarted?.();
    await this.deletionAllowed;
    await super.deleteExactVersion(input);
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

async function markVersionReady(
  catalog: Catalog,
  versionId: string,
  digestCharacter: string
): Promise<void> {
  await catalog.advanceVersion(versionId, 'UPLOADING', {
    event: { type: 'catalog.version.uploading' },
  });
  await catalog.advanceVersion(versionId, 'ASSEMBLED', {
    fields: {
      assemblyObjectId: `s3:gc/${versionId}.caibx`,
      releaseRoot: digestCharacter.repeat(64),
      sourceFormat: 'CANONICAL_TARGZ_V1',
    },
    event: { type: 'catalog.version.assembled' },
  });
  await catalog.advanceVersion(versionId, 'PROMOTING', {
    event: { type: 'catalog.version.promoting' },
  });
  await catalog.advanceVersion(versionId, 'READY', {
    fields: {
      activeContentDigest: '1'.repeat(64),
      activePolicyVersion: 'active-content-policy-v1',
      bindingRoot: '2'.repeat(64),
      commonRoot: '3'.repeat(64),
      logicalBytes: 1,
      logicalFiles: 1,
      manifestSha256: '4'.repeat(64),
      protectedFiles: [],
      protectedSourceRoot: '5'.repeat(64),
      protectionPolicyDigest: '6'.repeat(64),
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      releaseRoot: digestCharacter.repeat(64),
      vpmDependencies: {},
      vpmRepositories: {},
    },
    event: { type: 'catalog.version.ready' },
  });
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
  it('holds the object reachability lock through exact-version deletion', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const exactCatalog = new ExactStorageCatalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const storage = new BlockingDeletionStorage({
      common: activeHarness.buckets.common,
    });
    const durableStorage = new DurableExactStorage(exactCatalog, storage);
    const content = new TextEncoder().encode(`deletion fence ${randomUUID()}`);
    const digest = createHash('sha256').update(content).digest('hex');
    const object = await durableStorage.putImmutable({
      body: content,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc-deletion-fence:${randomUUID()}`,
      objectKey: `v2/common/chunks/${digest.slice(0, 2)}/${digest}`,
      ownerId: `gc-deletion-fence:${randomUUID()}`,
      ownerKind: 'maintenance',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    const queuedIntent = await exactCatalog.beginWriteIntent({
      bucketName: storage.bucketName('common'),
      contentType: object.contentType,
      expectedBytes: object.bytes,
      expectedSha256: object.sha256,
      idempotencyKey: `gc-deletion-fence-reference:${randomUUID()}`,
      objectKey: object.objectKey,
      operation: 'PUT',
      ownerId: `gc-deletion-fence-reference:${randomUUID()}`,
      ownerKind: 'maintenance',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });

    const first = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    expect(first.deletedObjects).toBe(0);

    const secondRun = runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    await storage.deletionStarted;
    let competingLockSettled = false;
    const competingReference = activeSql<{ id: string }[]>`
      SELECT id
      FROM storage_object_versions
      WHERE id = ${object.id}
        AND verification_state = 'VERIFIED'
      FOR UPDATE
    `
      .then((rows) => rows.length === 1)
      .finally(() => {
        competingLockSettled = true;
      });
    const queuedCommit = exactCatalog
      .commitVerifiedObject({
        fileIdentifier: object.fileIdentifier,
        intentId: queuedIntent.id,
        providerVersion: object.providerVersion,
      })
      .then(
        () => true,
        () => false
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settledBeforePhysicalDeletion = competingLockSettled;

    storage.releaseDeletion();
    const [second, referenceSawVerifiedObject, queuedCommitSucceeded] = await Promise.all([
      secondRun,
      competingReference,
      queuedCommit,
    ]);

    expect(settledBeforePhysicalDeletion).toBeFalse();
    expect(referenceSawVerifiedObject).toBeFalse();
    expect(queuedCommitSucceeded).toBeFalse();
    expect(second.deletedObjects).toBe(1);
  }, 180_000);

  it('preserves a candidate exact version while an uncertain write retry is claimed', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const exactCatalog = new ExactStorageCatalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const storage = new ExpiredRetentionStorage({
      common: activeHarness.buckets.common,
    });
    const durableStorage = new DurableExactStorage(exactCatalog, storage);
    const content = new TextEncoder().encode(`claimed retry ${randomUUID()}`);
    const digest = createHash('sha256').update(content).digest('hex');
    const objectKey = `v2/common/chunks/${digest}`;
    const object = await durableStorage.putImmutable({
      body: content,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc-retry-source:${randomUUID()}`,
      objectKey,
      ownerId: `gc-retry-source:${randomUUID()}`,
      ownerKind: 'maintenance',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    const retryIntent = await exactCatalog.beginWriteIntent({
      bucketName: storage.bucketName('common'),
      contentType: 'application/octet-stream',
      expectedBytes: content.byteLength,
      expectedSha256: digest,
      idempotencyKey: `gc-retry-claim:${randomUUID()}`,
      objectKey,
      operation: 'PUT',
      ownerId: `gc-retry-claim:${randomUUID()}`,
      ownerKind: 'maintenance',
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    expect(
      await exactCatalog.findVerifiedCanonical({
        bytes: content.byteLength,
        intentId: retryIntent.id,
        sha256: digest,
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      })
    ).toEqual(object);
    await exactCatalog.markWriteIntentUncertain(retryIntent.id);
    expect(
      await exactCatalog.claimUncertainWriteRetry({
        claimDurationMs: 15 * 60 * 1_000,
        intentId: retryIntent.id,
      })
    ).not.toBeNull();

    const first = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    const second = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    const candidates = await activeSql<{ object_version_id: string }[]>`
      SELECT object_version_id
      FROM storage_gc_candidates
      WHERE object_version_id = ${object.id}
    `;

    expect(first.deletedObjects).toBe(0);
    expect(second.deletedObjects).toBe(0);
    expect(Array.from(candidates)).toEqual([]);
    expect(
      await storage.listExactVersions({
        objectKey,
        role: 'common',
      })
    ).toHaveLength(1);
  }, 180_000);

  it('preserves committed immutable VPM alias publications across GC generations', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const exactCatalog = new ExactStorageCatalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const storage = new ExpiredRetentionStorage({
      metadata: activeHarness.buckets.metadata,
    });
    const durableStorage = new DurableExactStorage(exactCatalog, storage);
    const publicationId = '00000000-0000-4000-8000-000000000301';
    const object = await durableStorage.putImmutable({
      body: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      contentType: 'application/zip',
      idempotencyKey: `vpm-alias-publication:${publicationId}:${'a'.repeat(64)}`,
      objectKey: `indexes/vpm/aliases/package/${publicationId}/1.0.0.zip`,
      ownerId: publicationId,
      ownerKind: 'vpm-alias-publication',
      storageRole: 'metadata',
    });

    const first = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    const second = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });

    expect(first.deletedObjects).toBe(0);
    expect(second.deletedObjects).toBe(0);
    expect(
      await storage.listExactVersions({
        objectKey: object.objectKey,
        role: 'metadata',
      })
    ).toHaveLength(1);
  }, 180_000);

  it('preserves every object in a published TUF repository', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const exactCatalog = new ExactStorageCatalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const tufCatalog = new TufRepositoryCatalog(activeSql);
    const storage = new ExpiredRetentionStorage({
      metadata: activeHarness.buckets.metadata,
    });
    const durableStorage = new DurableExactStorage(exactCatalog, storage);
    const publication = await tufCatalog.reservePublication({
      idempotencyKey: `gc-tuf-publication-${randomUUID()}`,
      repositoryId: 'package-installer-gc',
      rootVersion: 1,
      targetPaths: ['targets/yucp-package-broker.exe'],
    });
    const objects: StorageObjectVersion[] = [];

    for (const repositoryPath of publication.expectedPaths) {
      const body = new TextEncoder().encode(`published TUF object ${repositoryPath}`);
      const writeInput = {
        body,
        contentType: 'application/octet-stream',
        idempotencyKey: `gc-tuf:${publication.id}:${repositoryPath}`,
        objectKey: `v2/metadata/tuf/package-installer-gc/${repositoryPath}`,
        ownerId: publication.id,
        ownerKind: 'maintenance' as const,
        storageRole: 'metadata' as const,
      };
      const object =
        repositoryPath === 'metadata/timestamp.json'
          ? await durableStorage.putVersioned(writeInput)
          : await durableStorage.putImmutable(writeInput);
      await tufCatalog.recordObject({
        object,
        publicationId: publication.id,
        repositoryPath,
      });
      objects.push(object);
    }
    await tufCatalog.markPublished({ publicationId: publication.id });

    const first = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    const second = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    const candidates = await activeSql<{ object_version_id: string }[]>`
      SELECT object_version_id
      FROM storage_gc_candidates
      WHERE object_version_id IN ${activeSql(objects.map((object) => object.id))}
    `;

    expect(first.deletedObjects).toBe(0);
    expect(second.deletedObjects).toBe(0);
    expect(Array.from(candidates)).toEqual([]);
    for (const object of objects) {
      expect(
        await storage.listExactVersions({
          objectKey: object.objectKey,
          role: 'metadata',
        })
      ).toHaveLength(1);
    }
  }, 180_000);

  it('revalidates a recovered deletion after TUF reachability changes', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const exactCatalog = new ExactStorageCatalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const tufCatalog = new TufRepositoryCatalog(activeSql);
    const storage = new ExpiredRetentionStorage({
      metadata: activeHarness.buckets.metadata,
    });
    const durableStorage = new DurableExactStorage(exactCatalog, storage);
    const repositoryId = `gc-recovery-${randomUUID().slice(0, 8)}`;
    const publication = await tufCatalog.reservePublication({
      idempotencyKey: `gc-tuf-recovery-${randomUUID()}`,
      repositoryId,
      rootVersion: 1,
      targetPaths: [],
    });
    const repositoryPath =
      publication.expectedPaths.find((candidate) => candidate !== 'metadata/timestamp.json') ??
      publication.expectedPaths[0];
    if (!repositoryPath) {
      throw new Error('TUF recovery fixture has no repository path');
    }
    const object = await durableStorage.putImmutable({
      body: new TextEncoder().encode('TUF object claimed before publication'),
      contentType: 'application/json',
      idempotencyKey: `gc-tuf-recovery:${publication.id}:${repositoryPath}`,
      objectKey: `v2/metadata/tuf/${repositoryId}/${repositoryPath}`,
      ownerId: publication.id,
      ownerKind: 'maintenance',
      storageRole: 'metadata',
    });
    const first = await gcCatalog.observeGeneration(new Date());
    const second = await gcCatalog.observeGeneration(
      new Date(first.generation.completedAt.getTime() + 1)
    );
    const claimed = await gcCatalog.claimDeletionCandidate({
      generationId: second.generation.id,
      now: second.generation.completedAt,
    });
    expect(claimed?.objectVersionId).toBe(object.id);

    await activeSql`
      INSERT INTO tuf_publication_objects (
        publication_id,
        repository_path,
        object_version_id
      )
      VALUES (
        ${publication.id},
        ${repositoryPath},
        ${object.id}
      )
    `;

    const recovered = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      now: new Date(second.generation.completedAt.getTime() + 2),
      storage,
    });
    const states = await activeSql<{ candidate_state: string; journal_state: string }[]>`
      SELECT
        candidate.state AS candidate_state,
        journal.state AS journal_state
      FROM storage_gc_candidates candidate
      JOIN storage_gc_deletion_journal journal
        ON journal.object_version_id = candidate.object_version_id
      WHERE candidate.object_version_id = ${object.id}
    `;

    expect(recovered.deletedObjects).toBe(0);
    expect(recovered.recoveredDeletions).toBe(1);
    expect(Array.from(states)).toEqual([
      {
        candidate_state: 'FAILED',
        journal_state: 'FAILED',
      },
    ]);
    expect(
      await storage.listExactVersions({
        objectKey: object.objectKey,
        role: 'metadata',
      })
    ).toHaveLength(1);
  }, 180_000);

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
        logicalDigest: '072bdbd3fe06c23e0fa9a0732eb1f189505406df707a598b2e0a5ead617867cb',
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
        logicalDigest: 'a1480e684917cfacd11102a301830ccaae6185dd3ac1dc615664d72e4a9b7888',
        logicalKind: 'chunk',
      },
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });

    await markVersionReady(catalog, v1.id, 'a');
    await markVersionReady(catalog, v2.id, 'b');
    await markVersionReady(catalog, unrelated.id, 'c');
    expect(reusedObject.id).toBe(sharedObject.id);
    await catalog.deleteVersion(v1.id, {
      editionId: v1.editionId,
      packageId: v1.packageId,
      reason: 'creator-request',
    });
    const whileShared = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    expect(whileShared.candidatesObserved).toBe(0);

    await catalog.deleteVersion(v2.id, {
      editionId: v2.editionId,
      packageId: v2.packageId,
      reason: 'creator-request',
    });
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

    const catalogRows = await activeSql<{ id: string; verification_state: string }[]>`
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
    const remainingVersions = (await listS3ObjectVersions(activeHarness.buckets.common)).filter(
      (version) => !version.deleteMarker
    );
    expect(
      remainingVersions.some(
        (version) =>
          version.key === unrelatedObject.objectKey &&
          version.versionId === unrelatedObject.providerVersion
      )
    ).toBeTrue();
  }, 180_000);

  it('reconstructs 2.1.12 after 2.1.11 deletion and collects only last-release objects', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const catalog = new Catalog(activeSql);
    const exactCatalog = new ExactStorageCatalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const storage = new ExpiredRetentionStorage({
      common: activeHarness.buckets.common,
    });
    const durableStorage = new DurableExactStorage(exactCatalog, storage);
    const release211 = await catalog.createVersion({
      packageId: 'com.yucp.jammr-gc-lifecycle',
      version: '2.1.11',
    });
    const release212 = await catalog.createVersion({
      packageId: 'com.yucp.jammr-gc-lifecycle',
      version: '2.1.12',
    });
    const unrelated = await catalog.createVersion({
      packageId: 'com.yucp.gc-lifecycle-unrelated',
      version: '1.0.0',
    });
    const crossPackageBody = 'shader bytes reused by JAMMR and another package';
    const jammrOnlyBody = 'JAMMR bytes reused by 2.1.11 and 2.1.12';
    const unrelatedOnlyBody = 'unrelated package bytes retained after JAMMR deletion';
    const crossPackageDigest = createHash('sha256').update(crossPackageBody).digest('hex');
    const jammrOnlyDigest = createHash('sha256').update(jammrOnlyBody).digest('hex');
    const unrelatedOnlyDigest = createHash('sha256').update(unrelatedOnlyBody).digest('hex');
    const crossPackageKey = `v2/common/chunks/${crossPackageDigest.slice(
      0,
      2
    )}/${crossPackageDigest}`;
    const jammrOnlyKey = `v2/common/chunks/${jammrOnlyDigest.slice(0, 2)}/${jammrOnlyDigest}`;
    const unrelatedOnlyKey = `v2/common/chunks/${unrelatedOnlyDigest.slice(
      0,
      2
    )}/${unrelatedOnlyDigest}`;

    const crossPackageObject = await durableStorage.putImmutable({
      body: crossPackageBody,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${release211.id}:cross-package`,
      objectKey: crossPackageKey,
      ownerId: release211.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: crossPackageDigest,
        logicalKind: 'chunk',
      },
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    const jammrOnlyObject = await durableStorage.putImmutable({
      body: jammrOnlyBody,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${release211.id}:jammr-only`,
      objectKey: jammrOnlyKey,
      ownerId: release211.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: jammrOnlyDigest,
        logicalKind: 'chunk',
      },
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    const reusedBy212 = await Promise.all([
      durableStorage.putImmutable({
        body: crossPackageBody,
        contentType: 'application/octet-stream',
        idempotencyKey: `gc:${release212.id}:cross-package`,
        objectKey: crossPackageKey,
        ownerId: release212.id,
        ownerKind: 'package-version',
        releaseLink: {
          logicalDigest: crossPackageDigest,
          logicalKind: 'chunk',
        },
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      }),
      durableStorage.putImmutable({
        body: jammrOnlyBody,
        contentType: 'application/octet-stream',
        idempotencyKey: `gc:${release212.id}:jammr-only`,
        objectKey: jammrOnlyKey,
        ownerId: release212.id,
        ownerKind: 'package-version',
        releaseLink: {
          logicalDigest: jammrOnlyDigest,
          logicalKind: 'chunk',
        },
        storageDomain: 'common:global:v2',
        storageRole: 'common',
      }),
    ]);
    const reusedByUnrelated = await durableStorage.putImmutable({
      body: crossPackageBody,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${unrelated.id}:cross-package`,
      objectKey: crossPackageKey,
      ownerId: unrelated.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: crossPackageDigest,
        logicalKind: 'chunk',
      },
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });
    const unrelatedOnlyObject = await durableStorage.putImmutable({
      body: unrelatedOnlyBody,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${unrelated.id}:unrelated-only`,
      objectKey: unrelatedOnlyKey,
      ownerId: unrelated.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: unrelatedOnlyDigest,
        logicalKind: 'chunk',
      },
      storageDomain: 'common:global:v2',
      storageRole: 'common',
    });

    await markVersionReady(catalog, release211.id, '7');
    await markVersionReady(catalog, release212.id, '8');
    await markVersionReady(catalog, unrelated.id, '9');
    expect(reusedBy212.map((object) => object.id)).toEqual([
      crossPackageObject.id,
      jammrOnlyObject.id,
    ]);
    expect(reusedByUnrelated.id).toBe(crossPackageObject.id);

    await catalog.deleteVersion(release211.id, {
      editionId: release211.editionId,
      packageId: release211.packageId,
      reason: 'creator-request',
    });
    await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    const candidatesAfter211 = await activeSql<{ object_version_id: string }[]>`
      SELECT object_version_id
      FROM storage_gc_candidates
      WHERE object_version_id IN ${activeSql([
        crossPackageObject.id,
        jammrOnlyObject.id,
        unrelatedOnlyObject.id,
      ])}
      ORDER BY object_version_id
    `;
    expect(Array.from(candidatesAfter211)).toEqual([]);
    const reconstructedCrossPackage = await durableStorage.readPackageReleaseObject({
      logicalDigest: crossPackageDigest,
      logicalKind: 'chunk',
      objectKey: crossPackageKey,
      packageVersionId: release212.id,
      storageRole: 'common',
    });
    expect(reconstructedCrossPackage).toEqual(Uint8Array.from(Buffer.from(crossPackageBody)));
    const reconstructedJammrOnly = await durableStorage.readPackageReleaseObject({
      logicalDigest: jammrOnlyDigest,
      logicalKind: 'chunk',
      objectKey: jammrOnlyKey,
      packageVersionId: release212.id,
      storageRole: 'common',
    });
    expect(reconstructedJammrOnly).toEqual(Uint8Array.from(Buffer.from(jammrOnlyBody)));

    await catalog.deleteVersion(release212.id, {
      editionId: release212.editionId,
      packageId: release212.packageId,
      reason: 'creator-request',
    });
    const first = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    expect(first.deletedObjects).toBe(0);
    const candidatesAfterLastRelease = await activeSql<
      { object_version_id: string; state: string }[]
    >`
      SELECT object_version_id, state
      FROM storage_gc_candidates
      WHERE object_version_id IN ${activeSql([
        crossPackageObject.id,
        jammrOnlyObject.id,
        unrelatedOnlyObject.id,
      ])}
      ORDER BY object_version_id
    `;
    expect(Array.from(candidatesAfterLastRelease)).toEqual([
      {
        object_version_id: jammrOnlyObject.id,
        state: 'OBSERVED',
      },
    ]);

    const second = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      storage,
    });
    expect(second.deletedObjects).toBe(1);
    const packageStates = await activeSql<{ id: string; state: string }[]>`
      SELECT id, state
      FROM package_versions
      WHERE id IN ${activeSql([release211.id, release212.id, unrelated.id])}
      ORDER BY id
    `;
    expect(Object.fromEntries(packageStates.map((version) => [version.id, version.state]))).toEqual(
      {
        [release211.id]: 'DELETED',
        [release212.id]: 'DELETED',
        [unrelated.id]: 'READY',
      }
    );
    const objectStates = await activeSql<{ id: string; verification_state: string }[]>`
      SELECT id, verification_state
      FROM storage_object_versions
      WHERE id IN ${activeSql([crossPackageObject.id, jammrOnlyObject.id, unrelatedOnlyObject.id])}
      ORDER BY id
    `;
    expect(
      Object.fromEntries(objectStates.map((object) => [object.id, object.verification_state]))
    ).toEqual({
      [crossPackageObject.id]: 'VERIFIED',
      [jammrOnlyObject.id]: 'DELETED',
      [unrelatedOnlyObject.id]: 'VERIFIED',
    });
    expect(
      await storage.listExactVersions({
        objectKey: jammrOnlyObject.objectKey,
        role: 'common',
      })
    ).toEqual([]);
    expect(
      await storage.listExactVersions({
        objectKey: crossPackageObject.objectKey,
        role: 'common',
      })
    ).toHaveLength(1);
    expect(
      await storage.listExactVersions({
        objectKey: unrelatedOnlyObject.objectKey,
        role: 'common',
      })
    ).toHaveLength(1);
    await expect(
      durableStorage.readPackageReleaseObject({
        logicalDigest: crossPackageDigest,
        logicalKind: 'chunk',
        objectKey: crossPackageKey,
        packageVersionId: unrelated.id,
        storageRole: 'common',
      })
    ).resolves.toEqual(Uint8Array.from(Buffer.from(crossPackageBody)));
    await expect(
      durableStorage.readPackageReleaseObject({
        logicalDigest: unrelatedOnlyDigest,
        logicalKind: 'chunk',
        objectKey: unrelatedOnlyKey,
        packageVersionId: unrelated.id,
        storageRole: 'common',
      })
    ).resolves.toEqual(Uint8Array.from(Buffer.from(unrelatedOnlyBody)));
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
        logicalDigest: 'a28f272dcdbd91446b79a8553eb6694e2847af6860e9e761d7355ffd0f429928',
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
    await markVersionReady(catalog, version.id, 'd');
    await catalog.deleteVersion(version.id, {
      editionId: version.editionId,
      packageId: version.packageId,
      reason: 'creator-request',
    });

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

  it('rechecks a materialization pin acquired after observation before claiming deletion', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const catalog = new Catalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const storage = new ExpiredRetentionStorage({
      protected: activeHarness.buckets.protected,
    });
    const durableStorage = new DurableExactStorage(new ExactStorageCatalog(activeSql), storage);
    const version = await catalog.createVersion({
      packageId: 'com.yucp.gc-claim-race',
      version: '1.0.0',
    });
    const body = 'claim-time materialization source bytes';
    const digest = createHash('sha256').update(body).digest('hex');
    const object = await durableStorage.putImmutable({
      body,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${version.id}:claim-race`,
      objectKey: `v2/protected/creator-claim/chunks/${digest.slice(0, 2)}/${digest}`,
      ownerId: version.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: digest,
        logicalKind: 'chunk',
      },
      storageDomain: 'protected:creator-claim:v2',
      storageRole: 'protected',
    });
    await markVersionReady(catalog, version.id, '7');
    await catalog.deleteVersion(version.id, {
      editionId: version.editionId,
      packageId: version.packageId,
      reason: 'creator-request',
    });
    const first = await gcCatalog.observeGeneration(new Date());
    const second = await gcCatalog.observeGeneration(
      new Date(first.generation.completedAt.getTime() + 1)
    );
    const pin = await gcCatalog.createReleasePin({
      expiresAt: new Date(Date.now() + 60_000),
      ownerId: 'materialization-claim-race',
      packageVersionId: version.id,
      pinKind: 'materialization-job',
    });

    expect(
      await gcCatalog.claimDeletionCandidate({
        generationId: second.generation.id,
        now: second.generation.completedAt,
      })
    ).toBeNull();
    expect(
      await storage.listExactVersions({
        objectKey: object.objectKey,
        role: 'protected',
      })
    ).toHaveLength(1);

    await gcCatalog.releaseReleasePin(pin.id);
    const released = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      now: new Date(second.generation.completedAt.getTime() + 2),
      storage,
    });
    expect(released.deletedObjects).toBe(1);
  }, 180_000);

  it('collects an abandoned materialization pin only after its durable expiry', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const catalog = new Catalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const storage = new ExpiredRetentionStorage({
      protected: activeHarness.buckets.protected,
    });
    const durableStorage = new DurableExactStorage(new ExactStorageCatalog(activeSql), storage);
    const version = await catalog.createVersion({
      packageId: 'com.yucp.gc-expired-materialization',
      version: '1.0.0',
    });
    const body = 'expired materialization source bytes';
    const digest = createHash('sha256').update(body).digest('hex');
    await durableStorage.putImmutable({
      body,
      contentType: 'application/octet-stream',
      idempotencyKey: `gc:${version.id}:expired-materialization`,
      objectKey: `v2/protected/creator-expired/chunks/${digest.slice(0, 2)}/${digest}`,
      ownerId: version.id,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: digest,
        logicalKind: 'chunk',
      },
      storageDomain: 'protected:creator-expired:v2',
      storageRole: 'protected',
    });
    await markVersionReady(catalog, version.id, '8');
    const expiresAt = new Date(Date.now() + 60_000);
    await gcCatalog.createReleasePin({
      expiresAt,
      ownerId: 'materialization-abandoned',
      packageVersionId: version.id,
      pinKind: 'materialization-job',
    });
    await catalog.deleteVersion(version.id, {
      editionId: version.editionId,
      packageId: version.packageId,
      reason: 'creator-request',
    });

    const whilePinned = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      now: new Date(expiresAt.getTime() - 1),
      storage,
    });
    expect(whilePinned.candidatesObserved).toBe(0);
    const firstExpired = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      now: new Date(expiresAt.getTime() + 1),
      storage,
    });
    expect(firstExpired.deletedObjects).toBe(0);
    const secondExpired = await runExactVersionGarbageCollection({
      catalog: gcCatalog,
      now: new Date(expiresAt.getTime() + 2),
      storage,
    });
    expect(secondExpired.deletedObjects).toBe(1);
  }, 180_000);

  it('skips a concurrently locked candidate and claims the next eligible object', async () => {
    const activeHarness = requireHarness();
    const activeSql = requireSql();
    const catalog = new Catalog(activeSql);
    const gcCatalog = new StorageGcCatalog(activeSql);
    const durableStorage = new DurableExactStorage(
      new ExactStorageCatalog(activeSql),
      new ExpiredRetentionStorage({
        common: activeHarness.buckets.common,
      })
    );
    const versions = await Promise.all(
      ['a', 'b'].map((suffix) =>
        catalog.createVersion({
          packageId: `com.yucp.gc-concurrent-${suffix}`,
          version: '1.0.0',
        })
      )
    );
    const objects = [];
    for (const [index, version] of versions.entries()) {
      const body = `concurrent GC object ${index}`;
      const digest = createHash('sha256').update(body).digest('hex');
      objects.push(
        await durableStorage.putImmutable({
          body,
          contentType: 'application/octet-stream',
          idempotencyKey: `gc:${version.id}:concurrent`,
          objectKey: `v2/common/chunks/${digest.slice(0, 2)}/${digest}`,
          ownerId: version.id,
          ownerKind: 'package-version',
          releaseLink: {
            logicalDigest: digest,
            logicalKind: 'chunk',
          },
          storageDomain: 'common:global:v2',
          storageRole: 'common',
        })
      );
      await markVersionReady(catalog, version.id, index === 0 ? 'e' : 'f');
      await catalog.deleteVersion(version.id, {
        editionId: version.editionId,
        packageId: version.packageId,
        reason: 'creator-request',
      });
    }

    const firstGeneration = await gcCatalog.observeGeneration(new Date());
    const secondGeneration = await gcCatalog.observeGeneration(
      new Date(firstGeneration.generation.completedAt.getTime() + 1)
    );
    let releaseLock: (() => void) | undefined;
    let signalLockHeld: ((objectVersionId: string) => void) | undefined;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockHeld = new Promise<string>((resolve) => {
      signalLockHeld = resolve;
    });
    const blocker = activeSql.begin(async (transaction) => {
      const rows = await transaction<{ object_version_id: string }[]>`
        SELECT object_version_id
        FROM storage_gc_candidates
        WHERE last_generation_id = ${secondGeneration.generation.id}
          AND consecutive_generations >= 2
          AND state = 'OBSERVED'
        ORDER BY last_observed_at, object_version_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const objectVersionId = rows[0]?.object_version_id;
      if (!objectVersionId) {
        throw new Error('The concurrent GC test found no candidate to lock');
      }
      signalLockHeld?.(objectVersionId);
      await lockReleased;
    });
    const lockedObjectVersionId = await lockHeld;

    try {
      const claimWhileLocked = await gcCatalog.claimDeletionCandidate({
        generationId: secondGeneration.generation.id,
        now: secondGeneration.generation.completedAt,
      });
      expect(claimWhileLocked).not.toBeNull();
      expect(claimWhileLocked?.objectVersionId).not.toBe(lockedObjectVersionId);

      releaseLock?.();
      await blocker;
      const claimAfterRelease = await gcCatalog.claimDeletionCandidate({
        generationId: secondGeneration.generation.id,
        now: secondGeneration.generation.completedAt,
      });
      expect(claimAfterRelease?.objectVersionId).toBe(lockedObjectVersionId);
      expect(
        new Set([claimWhileLocked?.objectVersionId, claimAfterRelease?.objectVersionId])
      ).toEqual(new Set(objects.map((object) => object.id)));
    } finally {
      releaseLock?.();
      await blocker;
    }
  }, 180_000);
});
