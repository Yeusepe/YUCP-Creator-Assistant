import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import {
  Catalog,
  type CatalogDatabase,
  ExactStorageCatalog,
  openCatalogDatabase,
  runCatalogMigrations,
  StorageGcCatalog,
} from '../catalog';
import { ingestVersion, promoteVersion, retrieveVersion } from '../ingest-pipeline';
import { canonicalizeArtifact } from '../storage-core/canonicalizer';
import { type S3CasStore, s3CasStore, verifyDesyncCli } from '../storage-core/desyncCas';
import { DurableExactStorage } from '../storage-core/durableExactStorage';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import { prepareInstallablePackageTree } from '../storage-core/installablePackageTree';
import { normalizePackageArtifact } from '../storage-core/packageNormalizer';
import { resolveGnuArchiveTools, runCommand } from '../storage-core/process';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicy';
import { listS3Objects, listS3ObjectVersions } from '../storage-core/s3Control';
import {
  type DisposableStorageHarness,
  startDisposableStorageHarness,
} from '../testing/disposableStorageHarness';
import { runExactVersionGarbageCollection } from './exactVersionGc';

const TEXT_ASSET_EXTENSIONS = new Set(['.anim', '.asset', '.controller', '.mat', '.shader']);

type RoleStores = {
  commonStore: S3CasStore;
  metadataStore: S3CasStore;
  protectedStore: S3CasStore;
};

type ClosureObject = {
  bytes: number;
  id: string;
  storageRole: 'common' | 'metadata' | 'protected';
};

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
let catalog: Catalog | undefined;
let stores: RoleStores | undefined;
let storage: ExpiredRetentionStorage | undefined;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function requiredFixturePath(): string {
  const fixturePath = process.env.YUCP_PACKAGE_MANAGEMENT_FIXTURE?.trim();
  if (!fixturePath) {
    throw new Error('YUCP_PACKAGE_MANAGEMENT_FIXTURE is required');
  }
  return resolve(fixturePath);
}

function requireHarness(): DisposableStorageHarness {
  if (!harness) {
    throw new Error('Real package-management harness was not initialized');
  }
  return harness;
}

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('Real package-management database was not initialized');
  }
  return sql;
}

function requireCatalog(): Catalog {
  if (!catalog) {
    throw new Error('Real package-management catalog was not initialized');
  }
  return catalog;
}

function requireStores(): RoleStores {
  if (!stores) {
    throw new Error('Real package-management role stores were not initialized');
  }
  return stores;
}

function requireStorage(): ExpiredRetentionStorage {
  if (!storage) {
    throw new Error('Real package-management exact storage was not initialized');
  }
  return storage;
}

async function createCanonicalUnityPackage(input: {
  entriesRoot: string;
  outputPath: string;
  tarPath: string;
}): Promise<void> {
  const tools = await resolveGnuArchiveTools();
  await runCommand(
    tools.tarCommand,
    [
      '--force-local',
      '--create',
      '--file',
      input.tarPath,
      '--format=gnu',
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--mode=a-x,a=r,u+w,a+X',
      '--directory',
      input.entriesRoot,
      '.',
    ],
    { env: tools.env }
  );
  await runCommand(tools.gzipCommand, ['-n', '--rsyncable', '--stdout', '--', input.tarPath], {
    env: tools.env,
    stdoutPath: input.outputPath,
  });
}

async function extractCanonicalUnityPackage(inputPath: string, outputRoot: string): Promise<void> {
  const tools = await resolveGnuArchiveTools();
  await mkdir(outputRoot, { recursive: true });
  await runCommand(
    tools.tarCommand,
    [
      '--force-local',
      '--extract',
      '--gzip',
      '--file',
      inputPath,
      '--directory',
      outputRoot,
      '--no-same-owner',
      '--no-same-permissions',
    ],
    { env: tools.env }
  );
}

async function findTextAsset(entriesRoot: string): Promise<{
  assetPath: string;
  logicalPath: string;
}> {
  const entries = (await readdir(entriesRoot, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryRoot = join(entriesRoot, entry.name);
    const pathnamePath = join(entryRoot, 'pathname');
    const assetPath = join(entryRoot, 'asset');
    const [pathnameStats, assetStats] = await Promise.all([
      stat(pathnamePath).catch(() => null),
      stat(assetPath).catch(() => null),
    ]);
    if (!pathnameStats?.isFile() || !assetStats?.isFile() || assetStats.size > 1024 * 1024) {
      continue;
    }
    const logicalPath = (await readFile(pathnamePath, 'utf8')).trim();
    if (!TEXT_ASSET_EXTENSIONS.has(extname(logicalPath).toLowerCase())) {
      continue;
    }
    const prefix = (await readFile(assetPath)).subarray(0, 32).toString('utf8');
    if (prefix.includes('%YAML')) {
      return { assetPath, logicalPath };
    }
  }
  throw new Error('The Unity package contains no bounded YAML asset for update generation');
}

async function normalizedInventory(input: {
  inputPath: string;
  outputRoot: string;
  packageId: string;
}): Promise<Map<string, string>> {
  const normalized = await normalizePackageArtifact(input);
  const installable = await prepareInstallablePackageTree(normalized.files);
  return new Map(installable.files.map((file) => [file.normalizedPath, file.sha256]));
}

async function retrievedInventory(root: string, relativePath = ''): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const current = relativePath ? join(root, relativePath) : root;
  const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    const child = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      for (const [path, digest] of await retrievedInventory(root, child)) {
        result.set(path, digest);
      }
    } else if (entry.isFile()) {
      result.set(child.replaceAll('\\', '/'), await sha256File(join(root, child)));
    }
  }
  return result;
}

async function closureObjects(versionId: string): Promise<ClosureObject[]> {
  const rows = await requireSql()<
    {
      bytes: number | string;
      id: string;
      storage_role: ClosureObject['storageRole'];
    }[]
  >`
    SELECT DISTINCT
      object.id,
      object.bytes,
      object.storage_role
    FROM package_release_storage_objects release_object
    JOIN storage_object_versions object
      ON object.id = release_object.object_version_id
    WHERE release_object.package_version_id = ${versionId}
    ORDER BY object.storage_role, object.id
  `;
  return rows.map((row) => ({
    bytes: Number(row.bytes),
    id: row.id,
    storageRole: row.storage_role,
  }));
}

function reusedBytes(
  left: ClosureObject[],
  right: ClosureObject[],
  role: ClosureObject['storageRole']
): number {
  const rightIds = new Set(
    right.filter((object) => object.storageRole === role).map((object) => object.id)
  );
  return left
    .filter((object) => object.storageRole === role && rightIds.has(object.id))
    .reduce((total, object) => total + object.bytes, 0);
}

async function drainGarbageCollection(input: {
  catalog: StorageGcCatalog;
  deletionStorage: ExpiredRetentionStorage;
}): Promise<{
  deletedBytes: number;
  deletedObjects: number;
  rounds: number;
}> {
  const totals = {
    deletedBytes: 0,
    deletedObjects: 0,
    rounds: 0,
  };
  for (let round = 1; round <= 10; round += 1) {
    const result = await runExactVersionGarbageCollection({
      ...input,
      deletionLimit: 1_000,
    });
    totals.deletedBytes += result.deletedBytes;
    totals.deletedObjects += result.deletedObjects;
    totals.rounds = round;
    if (
      result.candidatesObserved === 0 &&
      result.deletedObjects === 0 &&
      result.recoveredDeletions === 0
    ) {
      return totals;
    }
  }
  throw new Error('Exact-version GC did not converge within ten bounded rounds');
}

async function explainGarbageCollectionClaim(input: {
  catalog: StorageGcCatalog;
  sql: CatalogDatabase;
}): Promise<string> {
  await input.catalog.observeGeneration();
  const second = await input.catalog.observeGeneration();
  await input.sql`
    ANALYZE
      package_release_storage_objects,
      package_versions,
      storage_gc_candidates,
      storage_gc_generations,
      storage_gc_release_pins,
      storage_object_versions,
      storage_write_intents
  `;
  const rows = await input.sql<{ 'QUERY PLAN': string }[]>`
    EXPLAIN (COSTS OFF)
    SELECT
      candidate.object_version_id,
      candidate.last_generation_id AS generation_id,
      object.storage_role,
      object.bucket_name,
      object.object_key,
      object.provider_version,
      object.bytes
    FROM storage_gc_candidates candidate
    JOIN storage_gc_generations generation
      ON generation.id = candidate.last_generation_id
    JOIN LATERAL (
      SELECT
        object.storage_role,
        object.bucket_name,
        object.object_key,
        object.provider_version,
        object.bytes
      FROM storage_object_versions object
      WHERE object.id = candidate.object_version_id
        AND object.verification_state = 'VERIFIED'
        AND NOT EXISTS (
          SELECT 1
          FROM package_release_storage_objects release_object
          JOIN package_versions package_version
            ON package_version.id = release_object.package_version_id
          WHERE release_object.object_version_id = object.id
            AND (
              package_version.state <> 'DELETED'
              OR EXISTS (
                SELECT 1
                FROM storage_gc_release_pins pin
                WHERE pin.package_version_id = package_version.id
                  AND pin.released_at IS NULL
                  AND (
                    pin.expires_at IS NULL
                    OR pin.expires_at > ${second.generation.completedAt}
                  )
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM storage_write_intents intent
          LEFT JOIN package_versions owner_version
            ON intent.owner_kind = 'package-version'
            AND owner_version.id::text = intent.owner_id
          WHERE (
              intent.object_version_id = object.id
              OR intent.candidate_object_version_id = object.id
            )
            AND (
              intent.state IN ('ISSUED', 'RETRYING', 'UNCERTAIN')
              OR (
                intent.state = 'COMMITTED'
                AND intent.owner_kind = 'package-version'
                AND owner_version.state <> 'DELETED'
              )
            )
        )
      FOR UPDATE OF object SKIP LOCKED
    ) object ON true
    WHERE candidate.last_generation_id = ${second.generation.id}
      AND candidate.consecutive_generations >= 2
      AND candidate.state IN ('FAILED', 'OBSERVED', 'RETENTION_BLOCKED')
      AND (
        candidate.retention_until IS NULL
        OR candidate.retention_until <= ${second.generation.completedAt}
      )
      AND generation.state = 'COMPLETED'
    ORDER BY candidate.last_observed_at, candidate.object_version_id
    FOR UPDATE OF candidate SKIP LOCKED
    LIMIT 1
  `;
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

beforeAll(async () => {
  await verifyDesyncCli();
  const fixture = requiredFixturePath();
  const fixtureStats = await stat(fixture);
  if (!fixtureStats.isFile() || !fixture.toLowerCase().endsWith('.unitypackage')) {
    throw new Error('YUCP_PACKAGE_MANAGEMENT_FIXTURE must identify a Unity package file');
  }

  harness = await startDisposableStorageHarness();
  sql = openCatalogDatabase(harness.postgres.url);
  await runCatalogMigrations(sql);
  catalog = new Catalog(sql);
  storage = new ExpiredRetentionStorage({
    common: harness.buckets.common,
    metadata: harness.buckets.metadata,
    protected: harness.buckets.protected,
  });
  const durableStorage = new DurableExactStorage(new ExactStorageCatalog(sql), storage);
  stores = {
    commonStore: s3CasStore(harness.buckets.common, {
      durableStorage,
      storageRole: 'common',
    }),
    metadataStore: s3CasStore(harness.buckets.metadata, {
      durableStorage,
      storageRole: 'metadata',
    }),
    protectedStore: s3CasStore(harness.buckets.protected, {
      durableStorage,
      storageRole: 'protected',
    }),
  };
});

afterAll(async () => {
  const activeSql = sql;
  const activeHarness = harness;
  sql = undefined;
  catalog = undefined;
  stores = undefined;
  storage = undefined;
  harness = undefined;
  try {
    await activeSql?.end({ timeout: 1 });
  } finally {
    await activeHarness?.stop();
  }
});

describe.serial('real Unity package management', () => {
  it('deduplicates updates and safely collects deleted package versions', async () => {
    const fixturePath = requiredFixturePath();
    const activeHarness = requireHarness();
    const activeCatalog = requireCatalog();
    const activeStores = {
      ...requireStores(),
      scratchRoot: activeHarness.scratchRoot,
    };
    const exactStorage = requireStorage();
    const gcCatalog = new StorageGcCatalog(requireSql());
    const root = activeHarness.uploadDir;
    const canonicalV1Path = join(root, 'druffle-v1.unitypackage');
    const entriesRoot = join(root, 'druffle-entries');
    const v2Path = join(root, 'druffle-v2.unitypackage');
    const v3Path = join(root, 'druffle-v3.unitypackage');
    const unrelatedPath = join(root, 'unrelated-v1.unitypackage');

    await canonicalizeArtifact({
      inputPath: fixturePath,
      outputPath: canonicalV1Path,
    });
    await extractCanonicalUnityPackage(canonicalV1Path, entriesRoot);
    const editedAsset = await findTextAsset(entriesRoot);
    await appendFile(editedAsset.assetPath, '\n# YUCP package-management update 2\n', 'utf8');
    await createCanonicalUnityPackage({
      entriesRoot,
      outputPath: v2Path,
      tarPath: join(root, 'druffle-v2.tar'),
    });
    await appendFile(editedAsset.assetPath, '# YUCP package-management update 3\n', 'utf8');
    await createCanonicalUnityPackage({
      entriesRoot,
      outputPath: v3Path,
      tarPath: join(root, 'druffle-v3.tar'),
    });
    await copyFile(v2Path, unrelatedPath);

    const inputPaths = [canonicalV1Path, v2Path, v3Path];
    const expectedTrees = [];
    for (const [index, inputPath] of inputPaths.entries()) {
      expectedTrees.push(
        await normalizedInventory({
          inputPath,
          outputRoot: join(root, `expected-tree-${index + 1}`),
          packageId: 'com.yucp.druffle-management',
        })
      );
    }
    const unrelatedTree = await normalizedInventory({
      inputPath: unrelatedPath,
      outputRoot: join(root, 'expected-tree-unrelated'),
      packageId: 'com.yucp.unrelated-retained',
    });

    const readyVersions = [];
    for (const [index, inputPath] of inputPaths.entries()) {
      const assembled = await ingestVersion({
        catalog: activeCatalog,
        creatorId: 'creator-druffle',
        packageId: 'com.yucp.druffle-management',
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        ...activeStores,
        version: `0.1.${15 + index}`,
        inputPath,
      });
      readyVersions.push(
        await promoteVersion({
          catalog: activeCatalog,
          ...activeStores,
          versionId: assembled.id,
        })
      );
    }
    const unrelated = await promoteVersion({
      catalog: activeCatalog,
      ...activeStores,
      versionId: (
        await ingestVersion({
          catalog: activeCatalog,
          creatorId: 'creator-unrelated',
          packageId: 'com.yucp.unrelated-retained',
          protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
          ...activeStores,
          version: '1.0.0',
          inputPath: unrelatedPath,
        })
      ).id,
    });

    const closures = [];
    for (const version of readyVersions) {
      closures.push(await closureObjects(version.id));
    }
    const unrelatedClosure = await closureObjects(unrelated.id);
    const v1V2ReusedBytes = reusedBytes(closures[0] ?? [], closures[1] ?? [], 'common');
    const v2V3ReusedBytes = reusedBytes(closures[1] ?? [], closures[2] ?? [], 'common');
    const v1V2ProtectedReusedBytes = reusedBytes(closures[0] ?? [], closures[1] ?? [], 'protected');
    const v2V3ProtectedReusedBytes = reusedBytes(closures[1] ?? [], closures[2] ?? [], 'protected');
    expect(v1V2ReusedBytes).toBeGreaterThan(0);
    expect(v2V3ReusedBytes).toBeGreaterThan(0);
    expect(v1V2ProtectedReusedBytes).toBeGreaterThan(0);
    expect(v2V3ProtectedReusedBytes).toBeGreaterThan(0);
    const managedReferences = closures.reduce((total, closure) => total + closure.length, 0);
    const managedDistinctObjects = new Set(
      closures.flatMap((closure) => closure.map((object) => object.id))
    );
    expect(managedDistinctObjects.size).toBeLessThan(managedReferences);
    expect(reusedBytes(closures[1] ?? [], unrelatedClosure, 'common')).toBeGreaterThan(0);
    expect(reusedBytes(closures[1] ?? [], unrelatedClosure, 'protected')).toBe(0);

    const [base, updateTwo, updateThree] = readyVersions;
    if (!base || !updateTwo || !updateThree) {
      throw new Error('The real package-management test did not create three versions');
    }
    const laterObjectIds = new Set(
      [...(closures[1] ?? []), ...(closures[2] ?? []), ...unrelatedClosure].map(
        (object) => object.id
      )
    );
    const baseOnlyObjects = (closures[0] ?? []).filter((object) => !laterObjectIds.has(object.id));
    expect(baseOnlyObjects.length).toBeGreaterThan(0);

    await activeCatalog.deleteVersion(base.id, {
      editionId: base.editionId,
      packageId: base.packageId,
      reason: 'creator-request',
    });
    const baseGc = await drainGarbageCollection({
      catalog: gcCatalog,
      deletionStorage: exactStorage,
    });
    const deletedBaseObjects = await requireSql()<{ id: string; verification_state: string }[]>`
      SELECT id, verification_state
      FROM storage_object_versions
      WHERE id IN ${requireSql()(baseOnlyObjects.map((object) => object.id))}
    `;
    expect(
      deletedBaseObjects.every((object) => object.verification_state === 'DELETED')
    ).toBeTrue();

    for (const [index, ready] of [updateTwo, updateThree].entries()) {
      const outputPath = await retrieveVersion({
        catalog: activeCatalog,
        ...activeStores,
        versionId: ready.id,
        outputPath: join(root, `retrieved-update-${index + 2}`),
      });
      expect(await retrievedInventory(outputPath)).toEqual(expectedTrees[index + 1]);
    }

    const deletedUpdates = await activeCatalog.deletePackageVersions(
      'com.yucp.druffle-management',
      { reason: 'creator-request' }
    );
    expect(deletedUpdates.map((version) => version.id)).toEqual([updateTwo.id, updateThree.id]);
    const gcClaimPlan = await explainGarbageCollectionClaim({
      catalog: gcCatalog,
      sql: requireSql(),
    });
    expect(gcClaimPlan).toContain('package_release_storage_objects_object_idx');
    expect(gcClaimPlan).toContain('storage_write_intents_candidate_object_idx');
    expect(gcClaimPlan).toContain('storage_write_intents_object_state_idx');
    expect(gcClaimPlan).toContain('BitmapOr');
    expect(gcClaimPlan).not.toContain('Seq Scan on package_release_storage_objects');
    expect(gcClaimPlan).not.toContain('Seq Scan on storage_write_intents');
    const packageGc = await drainGarbageCollection({
      catalog: gcCatalog,
      deletionStorage: exactStorage,
    });
    expect(await activeCatalog.listVersions('com.yucp.druffle-management')).toEqual([]);
    expect(await activeCatalog.listVersions('com.yucp.unrelated-retained')).toEqual([unrelated]);

    const unrelatedOutput = await retrieveVersion({
      catalog: activeCatalog,
      ...activeStores,
      versionId: unrelated.id,
      outputPath: join(root, 'retrieved-unrelated'),
    });
    expect(await retrievedInventory(unrelatedOutput)).toEqual(unrelatedTree);
    const remainingVerified = await requireSql()<{ id: string }[]>`
      SELECT id
      FROM storage_object_versions
      WHERE verification_state = 'VERIFIED'
      ORDER BY id
    `;
    expect(new Set(remainingVerified.map((object) => object.id))).toEqual(
      new Set(unrelatedClosure.map((object) => object.id))
    );

    const roleObjects = await Promise.all(
      (
        [
          ['common', activeHarness.buckets.common],
          ['metadata', activeHarness.buckets.metadata],
          ['protected', activeHarness.buckets.protected],
        ] as const
      ).map(async ([role, config]) => ({
        bytes: (await listS3Objects(config)).reduce((total, object) => total + object.size, 0),
        role,
        versions: (await listS3ObjectVersions(config)).filter((version) => !version.deleteMarker),
      }))
    );
    expect(
      roleObjects.flatMap((entry) => entry.versions).every((version) => !version.deleteMarker)
    ).toBeTrue();
    const remainingStoredBytes = roleObjects.reduce((total, role) => total + role.bytes, 0);
    console.log(
      JSON.stringify({
        event: 'package_management.real.completed',
        baseOnlyObjectsDeleted: baseOnlyObjects.length,
        baseGc,
        editedAsset: editedAsset.logicalPath,
        fixtureBytes: (await stat(fixturePath)).size,
        fixtureSha256: await sha256File(fixturePath),
        gcClaimPlan,
        managedDistinctObjects: managedDistinctObjects.size,
        managedReferences,
        packageGc,
        remainingStoredBytes,
        unrelatedRetrievableAfterPackageDeletion: true,
        updatesRetrievableAfterBaseDeletion: true,
        v1V2ReusedBytes,
        v1V2ProtectedReusedBytes,
        v2V3ReusedBytes,
        v2V3ProtectedReusedBytes,
        versions: 3,
      })
    );
  }, 1_800_000);
});
