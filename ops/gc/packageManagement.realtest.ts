import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import {
  Catalog,
  type CatalogDatabase,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../catalog';
import {
  ingestVersion,
  promoteVersion,
  resolvePipelineCasIndexId,
  retrieveVersion,
} from '../ingest-pipeline';
import { canonicalizeArtifact } from '../storage-core/canonicalizer';
import {
  inspectDesyncIndex,
  type S3CasStore,
  s3CasStore,
  verifyDesyncCli,
} from '../storage-core/desyncCas';
import { resolveGnuArchiveTools, runCommand } from '../storage-core/process';
import { listS3Objects, listS3ObjectVersions, type S3Object } from '../storage-core/s3Control';
import {
  type DisposableStorageHarness,
  startDisposableStorageHarness,
} from '../testing/disposableStorageHarness';
import { runChunkGarbageCollection } from './chunkGc';

const TEXT_ASSET_EXTENSIONS = new Set(['.anim', '.asset', '.controller', '.mat', '.shader']);

let harness: DisposableStorageHarness | undefined;
let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let store: S3CasStore | undefined;

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

function requireStore(): S3CasStore {
  if (!store) {
    throw new Error('Real package-management CAS was not initialized');
  }
  return store;
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
  for (const entry of (await readdir(entriesRoot, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
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

function chunkMap(chunks: Array<{ id: string; size: number }>): Map<string, number> {
  return new Map(chunks.map((chunk) => [chunk.id, chunk.size]));
}

function reusedBytes(left: Map<string, number>, right: Map<string, number>): number {
  let total = 0;
  for (const [id, size] of left) {
    if (right.has(id)) {
      total += size;
    }
  }
  return total;
}

function sumObjectBytes(objects: S3Object[]): number {
  return objects.reduce((total, object) => total + object.size, 0);
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
  store = s3CasStore(harness.buckets.common);
});

afterAll(async () => {
  const activeSql = sql;
  const activeHarness = harness;
  sql = undefined;
  catalog = undefined;
  store = undefined;
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
    const activeStore = requireStore();
    const config = activeHarness.buckets.common;
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
    const readyVersions = [];
    for (const [index, inputPath] of inputPaths.entries()) {
      const assembled = await ingestVersion({
        catalog: activeCatalog,
        store: activeStore,
        packageId: 'com.yucp.druffle-management',
        version: `0.1.${15 + index}`,
        inputPath,
      });
      readyVersions.push(
        await promoteVersion({
          catalog: activeCatalog,
          store: activeStore,
          versionId: assembled.id,
        })
      );
    }
    const unrelated = await promoteVersion({
      catalog: activeCatalog,
      store: activeStore,
      versionId: (
        await ingestVersion({
          catalog: activeCatalog,
          store: activeStore,
          packageId: 'com.yucp.unrelated-retained',
          version: '1.0.0',
          inputPath: unrelatedPath,
        })
      ).id,
    });
    if (readyVersions.some((version) => !version.casIndexId) || !unrelated.casIndexId) {
      throw new Error('The real READY versions must have CAS index identifiers');
    }

    for (const [index, ready] of readyVersions.entries()) {
      expect(ready.canonicalSha256).toBe(await sha256File(inputPaths[index]));
    }
    expect(unrelated.canonicalSha256).toBe(await sha256File(unrelatedPath));

    const chunkMaps: Array<Map<string, number>> = [];
    for (const ready of readyVersions) {
      chunkMaps.push(
        chunkMap(
          await inspectDesyncIndex({
            indexId: resolvePipelineCasIndexId(activeStore, ready.casIndexId as string),
            store: activeStore,
          })
        )
      );
    }
    const unrelatedChunkMap = chunkMap(
      await inspectDesyncIndex({
        indexId: resolvePipelineCasIndexId(activeStore, unrelated.casIndexId),
        store: activeStore,
      })
    );
    expect(new Set(unrelatedChunkMap.keys())).toEqual(new Set(chunkMaps[1].keys()));

    const v1V2ReusedBytes = reusedBytes(chunkMaps[0], chunkMaps[1]);
    const v2V3ReusedBytes = reusedBytes(chunkMaps[1], chunkMaps[2]);
    expect(v1V2ReusedBytes).toBeGreaterThan(0);
    expect(v2V3ReusedBytes).toBeGreaterThan(0);
    const managedReferences = chunkMaps.reduce((total, chunks) => total + chunks.size, 0);
    const managedDistinctIds = new Set(chunkMaps.flatMap((chunks) => [...chunks.keys()]));
    expect(managedDistinctIds.size).toBeLessThan(managedReferences);

    const physicalVersionsBeforeDeletion = (await listS3ObjectVersions(config)).filter(
      (version) => !version.deleteMarker
    );
    expect(new Set(physicalVersionsBeforeDeletion.map((version) => version.key)).size).toBe(
      physicalVersionsBeforeDeletion.length
    );
    const objectsBeforeDeletion = await listS3Objects(config);
    const storedBytesBeforeDeletion = sumObjectBytes(objectsBeforeDeletion);
    const inputBytes = (
      await Promise.all(inputPaths.map(async (inputPath) => (await stat(inputPath)).size))
    ).reduce((total, size) => total + size, 0);
    expect(storedBytesBeforeDeletion).toBeLessThan(inputBytes);

    const [base, updateTwo, updateThree] = readyVersions;
    if (!base || !updateTwo || !updateThree) {
      throw new Error('The real package-management test did not create three versions');
    }
    const baseOnlyIds = new Set(
      [...chunkMaps[0].keys()].filter(
        (id) => !chunkMaps[1].has(id) && !chunkMaps[2].has(id) && !unrelatedChunkMap.has(id)
      )
    );
    expect(baseOnlyIds.size).toBeGreaterThan(0);

    await activeCatalog.deleteVersion(base.id, { reason: 'creator-request' });
    await runChunkGarbageCollection({
      sql: requireSql(),
      store: activeStore,
      gracePeriodMs: 0,
      batchSize: 100,
    });
    const afterBaseDeletion = new Set(
      (await listS3Objects(config))
        .filter((object) => object.key.startsWith(config.chunkPrefix))
        .map((object) => object.key.split('/').at(-1))
    );
    for (const id of baseOnlyIds) {
      expect(afterBaseDeletion.has(id)).toBeFalse();
    }
    for (const [index, ready] of [updateTwo, updateThree].entries()) {
      const outputPath = await retrieveVersion({
        catalog: activeCatalog,
        store: activeStore,
        versionId: ready.id,
        outputPath: join(root, `retrieved-update-${index + 2}.unitypackage`),
      });
      expect(await sha256File(outputPath)).toBe(await sha256File(inputPaths[index + 1]));
    }

    const deletedUpdates = await activeCatalog.deletePackageVersions(
      'com.yucp.druffle-management',
      { reason: 'creator-request' }
    );
    expect(deletedUpdates.map((version) => version.id)).toEqual([updateTwo.id, updateThree.id]);
    await runChunkGarbageCollection({
      sql: requireSql(),
      store: activeStore,
      gracePeriodMs: 0,
      batchSize: 100,
    });
    expect(await activeCatalog.listVersions('com.yucp.druffle-management')).toEqual([]);
    expect(await activeCatalog.listVersions('com.yucp.unrelated-retained')).toEqual([unrelated]);

    const unrelatedOutput = await retrieveVersion({
      catalog: activeCatalog,
      store: activeStore,
      versionId: unrelated.id,
      outputPath: join(root, 'retrieved-unrelated.unitypackage'),
    });
    expect(await sha256File(unrelatedOutput)).toBe(await sha256File(unrelatedPath));
    const remainingPhysicalVersions = await listS3ObjectVersions(config);
    expect(remainingPhysicalVersions.some((version) => version.deleteMarker)).toBeFalse();
    const remainingChunkIds = new Set(
      remainingPhysicalVersions
        .filter((version) => version.key.startsWith(config.chunkPrefix))
        .map((version) => version.key.split('/').at(-1))
    );
    expect(remainingChunkIds).toEqual(new Set(unrelatedChunkMap.keys()));

    const remainingStoredBytes = sumObjectBytes(await listS3Objects(config));
    console.log(
      `REAL_PACKAGE_MANAGEMENT_RESULT fixtureSha256=${await sha256File(fixturePath)} fixtureBytes=${(await stat(fixturePath)).size} editedAsset=${editedAsset.logicalPath} versions=3 managedReferences=${managedReferences} managedDistinctChunks=${managedDistinctIds.size} v1V2ReusedBytes=${v1V2ReusedBytes} v2V3ReusedBytes=${v2V3ReusedBytes} storedBytesBeforeDeletion=${storedBytesBeforeDeletion} remainingStoredBytes=${remainingStoredBytes} baseOnlyChunksDeleted=${baseOnlyIds.size} updatesRetrievableAfterBaseDeletion=yes unrelatedRetrievableAfterPackageDeletion=yes hiddenVersionsAfterGc=0`
    );
  }, 1_800_000);
});
