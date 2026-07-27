import { describe, expect, it } from 'bun:test';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  Catalog,
  type CatalogDatabase,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../catalog';
import {
  canonicalizerChildEnv,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
} from '../storage-core/canonicalizer';
import { type CasConfig, loadCasConfig } from '../storage-core/config';
import { type S3CasStore, s3CasStore, verifyDesyncCli } from '../storage-core/desyncCas';
import { sha256File } from '../storage-core/desyncPackingTestSupport';
import { prepareInstallablePackageTree } from '../storage-core/installablePackageTree';
import { normalizePackageArtifact } from '../storage-core/packageNormalizer';
import { resolveGnuArchiveTools, runCommand } from '../storage-core/process';
import {
  ACTIVE_PROTECTION_POLICY_ID,
  type ClassifiedPackageFile,
  classifyPackageFiles,
} from '../storage-core/protectionPolicy';
import { createLogicalReleaseRootV4 } from '../storage-core/releasePublication';
import { createS3Bucket, listS3Objects, listS3ObjectVersions } from '../storage-core/s3Control';
import {
  createPeakMeasurementLifecycle,
  type PeakMeasurementLifecycle,
  runMeasuredResourceLifecycle,
} from '../testing/measuredResourceLifecycle';
import { waitForMinioReady } from '../testing/minioReadiness';
import { waitForPostgres } from '../testing/postgresReadiness';
import { ingestVersion, promoteVersion, retrieveVersion } from './ingestPipeline';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const DEFAULT_ACCEPT_SIZE_BYTES = 5 * GIB;
// This is 20% of the 7.5 GiB host target and remains below a 2 GiB reduced fixture. It allows
// runtime overhead while still catching accidental whole-artifact buffering in the orchestrator.
const MAX_ORCHESTRATOR_RSS_BYTES = 1536 * MIB;
const MAX_JOB_SCRATCH_BYTES = 32 * GIB;
const SCRATCH_SAMPLE_INTERVAL_MS = 500;
const POSTGRES_IMAGE =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'; // postgres:17-alpine
const MINIO_IMAGE =
  'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e'; // minio/minio:RELEASE.2025-09-07T16-13-09Z
const databaseName = 'pipeline_accept_5gb';
const databasePassword = 'pipeline-accept-5gb-password';
const runId = randomBytes(6).toString('hex');
const postgresContainerName = `yucp-accept-5gb-pg-${runId}`;
const minioContainerName = `yucp-accept-5gb-s3-${runId}`;
const minioVolumeName = `yucp-accept-5gb-s3-${runId}`;

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type TestResources = {
  casConfigs?: {
    common: CasConfig;
    metadata: CasConfig;
    protected: CasConfig;
  };
  catalog?: Catalog;
  containers: Set<string>;
  scratchPath?: string;
  sql?: CatalogDatabase;
  stores?: {
    commonStore: S3CasStore;
    metadataStore: S3CasStore;
    protectedStore: S3CasStore;
  };
  volumes: Set<string>;
};

type AcceptanceMetrics = {
  canonicalBytes: number;
  inputArtifactBytes: number;
  v1CommonChunkBytes: number;
  v1CommonChunkVersions: number;
  v1ChunkBytes: number;
  v1ProtectedChunkBytes: number;
  v1ProtectedChunkVersions: number;
  v2DeltaBytes: number;
  v2DeltaChunks: number;
};

type PreparedAcceptanceTree = {
  commonPaths: readonly string[];
  files: ReadonlyArray<Omit<ClassifiedPackageFile, 'path'>>;
  protectedPaths: readonly string[];
};

function acceptSizeBytes(): number {
  const configured = process.env.ACCEPT_SIZE_BYTES;
  const value = configured === undefined ? DEFAULT_ACCEPT_SIZE_BYTES : Number(configured);
  if (!Number.isSafeInteger(value) || value < 64 * MIB) {
    throw new Error('ACCEPT_SIZE_BYTES must be a safe integer of at least 67108864 bytes');
  }
  return value;
}

function formatGib(bytes: number): string {
  return (bytes / GIB).toFixed(3);
}

function startRssSampler(): { stop: () => number } {
  let peakRssBytes = 0;
  const sample = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  sample();
  const timer = setInterval(sample, 100);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return peakRssBytes;
    },
  };
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(entryPath);
      continue;
    }
    if (entry.isFile()) {
      try {
        total += (await stat(entryPath)).size;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
      continue;
    }
    throw new Error(`Acceptance scratch contains an unsupported entry: ${entryPath}`);
  }
  return total;
}

function startScratchSampler(path: string): { stop: () => Promise<number> } {
  let peakBytes = 0;
  let sampleFailure: unknown;
  let samplePromise: Promise<void> | undefined;
  const sample = async () => {
    if (samplePromise) {
      return;
    }
    samplePromise = (async () => {
      try {
        peakBytes = Math.max(peakBytes, await directoryBytes(path));
      } catch (error) {
        sampleFailure ??= error;
      } finally {
        samplePromise = undefined;
      }
    })();
    await samplePromise;
  };
  void sample();
  const timer = setInterval(() => void sample(), SCRATCH_SAMPLE_INTERVAL_MS);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await samplePromise;
      await sample();
      if (sampleFailure !== undefined) {
        throw new Error('Acceptance scratch measurement failed', { cause: sampleFailure });
      }
      return peakBytes;
    },
  };
}

async function runDocker(args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(['docker', ...args], {
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
}

async function requireDocker(args: string[]): Promise<string> {
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed with exit code ${result.exitCode}\n${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

async function publishedPort(containerName: string, containerPort: string): Promise<string> {
  const output = await requireDocker(['port', containerName, `${containerPort}/tcp`]);
  const match = output.match(/127\.0\.0\.1:(\d+)$/m);
  if (!match?.[1]) {
    throw new Error(`Could not determine ${containerName} published port from: ${output}`);
  }
  return match[1];
}

function assertScratchPath(path: string): void {
  const relativePath = relative(resolve(tmpdir()), resolve(path));
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`Refusing to clean scratch path outside the system temp directory: ${path}`);
  }
}

async function cleanup(resources: TestResources): Promise<void> {
  const failures: Error[] = [];
  const activeSql = resources.sql;
  resources.sql = undefined;
  resources.catalog = undefined;
  resources.casConfigs = undefined;
  resources.stores = undefined;

  try {
    await activeSql?.end({ timeout: 1 });
  } catch (error) {
    failures.push(new Error('Failed to close the acceptance PostgreSQL client', { cause: error }));
  }

  for (const name of resources.containers) {
    try {
      const result = await runDocker(['rm', '--force', name]);
      if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
        throw new Error(result.stderr || result.stdout);
      }
    } catch (error) {
      failures.push(new Error(`Failed to remove Docker container ${name}`, { cause: error }));
    }
  }
  resources.containers.clear();

  for (const name of resources.volumes) {
    try {
      const result = await runDocker(['volume', 'rm', '--force', name]);
      if (result.exitCode !== 0 && !result.stderr.includes('No such volume')) {
        throw new Error(result.stderr || result.stdout);
      }
    } catch (error) {
      failures.push(new Error(`Failed to remove Docker volume ${name}`, { cause: error }));
    }
  }
  resources.volumes.clear();

  if (resources.scratchPath) {
    const scratchPath = resources.scratchPath;
    resources.scratchPath = undefined;
    try {
      assertScratchPath(scratchPath);
      await rm(scratchPath, { force: true, recursive: true });
    } catch (error) {
      failures.push(
        new Error(`Failed to remove acceptance scratch directory ${scratchPath}`, { cause: error })
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Acceptance cleanup did not complete');
  }
}

async function setup(resources: TestResources, sizeBytes: number): Promise<void> {
  await verifyDesyncCli();
  await requireDocker(['version']);

  const scratchRoot = resolve(tmpdir());
  const fileSystem = await statfs(scratchRoot);
  const availableBytes = fileSystem.bavail * fileSystem.bsize;
  // Ingest canonicalization temporarily has the raw v1 and v2 archives plus source tar,
  // extraction tree, canonical tar, compressed scratch output, and final canonical copy.
  const requiredBytes = sizeBytes * 8 + 2 * GIB;
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Insufficient scratch disk: need ${formatGib(requiredBytes)} GiB, have ${formatGib(availableBytes)} GiB at ${scratchRoot}`
    );
  }

  resources.scratchPath = await mkdtemp(join(scratchRoot, 'yucp-accept-5gb-'));
  await requireDocker(['volume', 'create', minioVolumeName]);
  resources.volumes.add(minioVolumeName);

  await requireDocker([
    'run',
    '--detach',
    '--rm',
    '--name',
    postgresContainerName,
    '--env',
    `POSTGRES_PASSWORD=${databasePassword}`,
    '--env',
    `POSTGRES_DB=${databaseName}`,
    '--publish',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql/data',
    POSTGRES_IMAGE,
  ]);
  resources.containers.add(postgresContainerName);

  const accessKeyId = `test-${randomBytes(12).toString('hex')}`;
  const secretAccessKey = randomBytes(32).toString('hex');
  await requireDocker([
    'run',
    '--detach',
    '--rm',
    '--name',
    minioContainerName,
    '--publish',
    '127.0.0.1::9000',
    '--env',
    `MINIO_ROOT_USER=${accessKeyId}`,
    '--env',
    `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
    '--mount',
    `type=volume,source=${minioVolumeName},target=/data`,
    MINIO_IMAGE,
    'server',
    '/data',
    '--address',
    ':9000',
  ]);
  resources.containers.add(minioContainerName);

  await waitForPostgres({ containerName: postgresContainerName, databaseName, runDocker });
  const postgresPort = await publishedPort(postgresContainerName, '5432');
  const minioPort = await publishedPort(minioContainerName, '9000');
  const minioEndpoint = `http://127.0.0.1:${minioPort}`;
  await waitForMinioReady({ endpoint: minioEndpoint });

  resources.sql = openCatalogDatabase(
    `postgres://postgres:${databasePassword}@127.0.0.1:${postgresPort}/${databaseName}`
  );
  await runCatalogMigrations(resources.sql);
  resources.catalog = new Catalog(resources.sql);
  const createRoleConfig = (role: 'common' | 'metadata' | 'protected') =>
    loadCasConfig({
      CAS_S3_ENDPOINT: minioEndpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: `pipeline-accept-5gb-${runId}-${role}`,
      CAS_S3_ACCESS_KEY_ID: accessKeyId,
      CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
    });
  resources.casConfigs = {
    common: createRoleConfig('common'),
    metadata: createRoleConfig('metadata'),
    protected: createRoleConfig('protected'),
  };
  for (const config of Object.values(resources.casConfigs)) {
    await createS3Bucket(config);
  }
  resources.stores = {
    commonStore: s3CasStore(resources.casConfigs.common),
    metadataStore: s3CasStore(resources.casConfigs.metadata),
    protectedStore: s3CasStore(resources.casConfigs.protected),
  };
}

function* zeroChunks(byteLength: number): Generator<Buffer> {
  const zeros = Buffer.alloc(MIB);
  let remaining = byteLength;
  while (remaining > 0) {
    const chunkLength = Math.min(remaining, zeros.byteLength);
    yield chunkLength === zeros.byteLength ? zeros : zeros.subarray(0, chunkLength);
    remaining -= chunkLength;
  }
}

async function writeDeterministicBlob(
  path: string,
  seed: string,
  byteLength: number
): Promise<void> {
  const key = createHash('sha256').update(seed).digest();
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16));
  await pipeline(Readable.from(zeroChunks(byteLength)), cipher, createWriteStream(path));
}

const largeAssets = [
  ['0123456789abcdef0123456789abcdef', 'Assets/Models/Environment.fbx'],
  ['123456789abcdef0123456789abcdef0', 'Assets/Textures/Environment.ktx2'],
  ['23456789abcdef0123456789abcdef01', 'Assets/Audio/Ambience.bank'],
  ['3456789abcdef0123456789abcdef012', 'Assets/Scenes/WorldLighting.asset'],
] as const;
const versionedAssetDirectory = 'ffffffffffffffffffffffffffffffff';

async function createFixtureTree(root: string, sizeBytes: number): Promise<string> {
  const bytesPerAsset = Math.floor(sizeBytes / largeAssets.length);
  let remaining = sizeBytes;
  for (const [index, [guid, pathname]] of largeAssets.entries()) {
    const directory = join(root, guid);
    await mkdir(directory, { recursive: true });
    const byteLength = index === largeAssets.length - 1 ? remaining : bytesPerAsset;
    await writeDeterministicBlob(join(directory, 'asset'), `accept-5gb-${guid}`, byteLength);
    remaining -= byteLength;
    await writeFile(join(directory, 'asset.meta'), `fileFormatVersion: 2\nguid: ${guid}\n`);
    await writeFile(join(directory, 'pathname'), `${pathname}\n`);
  }

  const sharedTextDirectory = join(root, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  await mkdir(sharedTextDirectory, { recursive: true });
  await writeFile(
    join(sharedTextDirectory, 'asset'),
    'using UnityEngine;\npublic sealed class AcceptanceFixture : MonoBehaviour {}\n'
  );
  await writeFile(
    join(sharedTextDirectory, 'asset.meta'),
    'fileFormatVersion: 2\nguid: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n'
  );
  await writeFile(join(sharedTextDirectory, 'pathname'), 'Assets/Scripts/AcceptanceFixture.cs\n');

  const versionedDirectory = join(root, versionedAssetDirectory);
  await mkdir(versionedDirectory, { recursive: true });
  await writeFile(
    join(versionedDirectory, 'asset.meta'),
    `fileFormatVersion: 2\nguid: ${versionedAssetDirectory}\n`
  );
  await writeFile(join(versionedDirectory, 'pathname'), 'Assets/Acceptance/version.txt\n');
  const versionedAssetPath = join(versionedDirectory, 'asset');
  await writeFile(versionedAssetPath, 'version=0001\n');
  return versionedAssetPath;
}

async function createUnityPackage(sourcePath: string, outputPath: string): Promise<void> {
  const archiveTools = await resolveGnuArchiveTools();
  await runCommand(
    archiveTools.tarCommand,
    [
      '--force-local',
      '--create',
      '--gzip',
      '--file',
      outputPath,
      '--format=gnu',
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--mode=a-x,a=r,u+w,a+X',
      '--directory',
      sourcePath,
      '.',
    ],
    { env: canonicalizerChildEnv(archiveTools.env) }
  );
}

async function exactChunkInventory(config: CasConfig): Promise<{
  bytes: number;
  keys: Set<string>;
  objects: number;
  versions: number;
}> {
  const [objects, versions] = await Promise.all([
    listS3Objects(config, config.chunkPrefix),
    listS3ObjectVersions(config, config.chunkPrefix),
  ]);
  const physicalVersions = versions.filter((version) => !version.deleteMarker);
  expect(objects.length).toBeGreaterThan(0);
  expect(physicalVersions.length).toBe(objects.length);
  expect(new Set(physicalVersions.map((version) => version.key)).size).toBe(
    physicalVersions.length
  );
  expect(
    physicalVersions.every(
      (version) => version.versionId.trim() && version.versionId.trim() !== 'null'
    )
  ).toBeTrue();
  expect(objects.map((object) => object.key).sort()).toEqual(
    physicalVersions.map((version) => version.key).sort()
  );
  return {
    bytes: objects.reduce((total, object) => total + object.size, 0),
    keys: new Set(objects.map((object) => object.key)),
    objects: objects.length,
    versions: physicalVersions.length,
  };
}

async function prepareExpectedTree(input: {
  inputPath: string;
  outputRoot: string;
  packageId: string;
}): Promise<PreparedAcceptanceTree> {
  const normalized = await normalizePackageArtifact(input);
  const prepared = await prepareInstallablePackageTree(normalized.files);
  const classified = classifyPackageFiles({
    files: prepared.files,
    policyId: ACTIVE_PROTECTION_POLICY_ID,
  });
  const files = classified.files.map(
    ({ bytes, classification, materializerType, normalizedPath, sha256 }) => ({
      bytes,
      classification,
      ...(materializerType ? { materializerType } : {}),
      normalizedPath,
      sha256,
    })
  );
  const commonPaths = files
    .filter((file) => file.classification === 'common')
    .map((file) => file.normalizedPath);
  const protectedPaths = files
    .filter((file) => file.classification === 'protected')
    .map((file) => file.normalizedPath);
  const protectedPathSet = new Set(protectedPaths);
  expect(commonPaths.length).toBeGreaterThan(0);
  expect(protectedPaths.length).toBeGreaterThan(0);
  expect(commonPaths.filter((path) => protectedPathSet.has(path))).toEqual([]);
  return Object.freeze({
    commonPaths: Object.freeze(commonPaths),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    protectedPaths: Object.freeze(protectedPaths),
  });
}

async function releaseScratchResources(input: {
  measurement: PeakMeasurementLifecycle;
  paths: readonly string[];
  scratchRoot: string;
}): Promise<void> {
  const scratchRoot = resolve(input.scratchRoot);
  const paths = input.paths.map((path) => {
    const resolved = resolve(path);
    const relativePath = relative(scratchRoot, resolved);
    if (
      !relativePath ||
      relativePath === '..' ||
      relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      throw new Error(`Refusing to release a phase resource outside scratch: ${resolved}`);
    }
    return resolved;
  });
  await input.measurement.releaseResources(async () => {
    for (const path of paths) {
      await rm(path, { force: true, recursive: true });
    }
  });
}

async function logicalTreePaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        paths.push(relative(root, entryPath).replaceAll('\\', '/'));
      } else {
        throw new Error(`Reconstructed logical tree contains an unsupported entry: ${entryPath}`);
      }
    }
  }
  await visit(root);
  return paths.sort();
}

async function assertReconstructedTree(
  root: string,
  prepared: PreparedAcceptanceTree
): Promise<number> {
  const expectedPaths = prepared.files.map((file) => file.normalizedPath).sort();
  expect(await logicalTreePaths(root)).toEqual(expectedPaths);
  let bytes = 0;
  for (const file of prepared.files) {
    const reconstructedPath = join(root, ...file.normalizedPath.split('/'));
    expect((await stat(reconstructedPath)).size).toBe(file.bytes);
    expect(await sha256File(reconstructedPath)).toBe(file.sha256);
    bytes += file.bytes;
  }
  return bytes;
}

function requireResource<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Acceptance ${name} was not initialized`);
  }
  return value;
}

async function eventTypes(sql: CatalogDatabase, versionId: string): Promise<string[]> {
  const rows = await sql<{ event_type: string }[]>`
    SELECT event_type
    FROM catalog_outbox
    WHERE aggregate_id = ${versionId}
    ORDER BY created_at, id
  `;
  return rows.map((row) => row.event_type);
}

async function ingestWithoutFalseBomb(
  input: Parameters<typeof ingestVersion>[0],
  sizeBytes: number
): ReturnType<typeof ingestVersion> {
  try {
    return await ingestVersion(input);
  } catch (error) {
    if (error instanceof Error && error.message.includes('decompressed byte budget exceeded')) {
      throw new Error(
        `Default ${DEFAULT_MAX_DECOMPRESSED_BYTES}-byte decompression budget rejected a legitimate ${sizeBytes}-byte fixture; the budget is mis-tuned`,
        { cause: error }
      );
    }
    throw error;
  }
}

async function runAcceptance(
  resources: TestResources,
  sizeBytes: number,
  measurement: PeakMeasurementLifecycle
): Promise<AcceptanceMetrics> {
  const scratchPath = requireResource(resources.scratchPath, 'scratch path');
  const catalog = requireResource(resources.catalog, 'catalog');
  const sql = requireResource(resources.sql, 'database');
  const configs = requireResource(resources.casConfigs, 'CAS configs');
  const stores = {
    ...requireResource(resources.stores, 'CAS stores'),
    scratchRoot: scratchPath,
  };
  const fixtureV1Path = join(scratchPath, 'fixture-v1');
  const fixtureV2Path = join(scratchPath, 'fixture-v2');
  const rawV1Path = join(scratchPath, 'artifact-v1.unitypackage');
  const rawV2Path = join(scratchPath, 'artifact-v2.unitypackage');
  const expectedV1Path = join(scratchPath, 'expected-v1');
  const expectedV2Path = join(scratchPath, 'expected-v2');

  await mkdir(fixtureV1Path);
  await createFixtureTree(fixtureV1Path, sizeBytes);
  await createUnityPackage(fixtureV1Path, rawV1Path);
  await releaseScratchResources({
    measurement,
    paths: [fixtureV1Path],
    scratchRoot: scratchPath,
  });
  const inputArtifactBytes = (await stat(rawV1Path)).size;
  const expectedV1 = await prepareExpectedTree({
    inputPath: rawV1Path,
    outputRoot: expectedV1Path,
    packageId: 'pipeline-accept-5gb',
  });
  await releaseScratchResources({
    measurement,
    paths: [expectedV1Path],
    scratchRoot: scratchPath,
  });

  const assembledV1 = await ingestWithoutFalseBomb(
    {
      catalog,
      creatorId: 'creator-accept-5gb',
      inputPath: rawV1Path,
      packageId: 'pipeline-accept-5gb',
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      ...stores,
      version: '1.0.0',
    },
    inputArtifactBytes
  );
  await releaseScratchResources({
    measurement,
    paths: [rawV1Path],
    scratchRoot: scratchPath,
  });
  expect(assembledV1.state).toBe('ASSEMBLED');
  const v1CanonicalSha256 = assembledV1.releaseRoot;
  if (!v1CanonicalSha256) {
    throw new Error('Assembled v1 did not persist its canonical SHA-256');
  }
  const expectedV1Root = createLogicalReleaseRootV4({
    files: [...expectedV1.files],
    packageId: assembledV1.packageId,
    version: assembledV1.version,
    versionId: assembledV1.id,
  });
  expect(expectedV1Root.releaseRoot).toBe(v1CanonicalSha256);

  const [afterV1Common, afterV1Protected] = await Promise.all([
    exactChunkInventory(configs.common),
    exactChunkInventory(configs.protected),
  ]);
  const v1ChunkBytes = afterV1Common.bytes + afterV1Protected.bytes;
  const v1ChunkObjects = afterV1Common.objects + afterV1Protected.objects;
  expect(afterV1Common.objects).toBeGreaterThan(0);
  expect(afterV1Protected.objects).toBeGreaterThan(0);
  expect(v1ChunkObjects).toBeGreaterThan(1);
  expect([...afterV1Common.keys].filter((key) => afterV1Protected.keys.has(key))).toEqual([]);
  const readyV1 = await promoteVersion({
    catalog,
    ...stores,
    versionId: assembledV1.id,
  });
  expect(readyV1.state).toBe('READY');
  expect(readyV1.releaseRoot).toBe(expectedV1Root.releaseRoot);
  expect(readyV1.commonRoot).toBe(expectedV1Root.commonRoot);
  expect(readyV1.protectedSourceRoot).toBe(expectedV1Root.protectedSourceRoot);
  const readyV1LogicalBytes = readyV1.logicalBytes;
  if (readyV1LogicalBytes === null) {
    throw new Error('Ready v1 did not persist its logical byte count');
  }
  expect(await eventTypes(sql, readyV1.id)).toEqual([
    'catalog.version.created',
    'catalog.version.uploading',
    'catalog.version.assembled',
    'catalog.version.promoting',
    'catalog.version.ready',
  ]);

  const retrievedV1Path = await retrieveVersion({
    catalog,
    outputPath: join(scratchPath, 'retrieved-v1'),
    ...stores,
    versionId: readyV1.id,
  });
  const canonicalBytes = await assertReconstructedTree(retrievedV1Path, expectedV1);
  expect(canonicalBytes).toBe(readyV1LogicalBytes);
  await releaseScratchResources({
    measurement,
    paths: [retrievedV1Path],
    scratchRoot: scratchPath,
  });

  await mkdir(fixtureV2Path);
  const versionedAssetPath = await createFixtureTree(fixtureV2Path, sizeBytes);
  await writeFile(versionedAssetPath, 'version=0002\n');
  await createUnityPackage(fixtureV2Path, rawV2Path);
  await releaseScratchResources({
    measurement,
    paths: [fixtureV2Path],
    scratchRoot: scratchPath,
  });
  const expectedV2 = await prepareExpectedTree({
    inputPath: rawV2Path,
    outputRoot: expectedV2Path,
    packageId: 'pipeline-accept-5gb',
  });
  await releaseScratchResources({
    measurement,
    paths: [expectedV2Path],
    scratchRoot: scratchPath,
  });

  const assembledV2 = await ingestWithoutFalseBomb(
    {
      catalog,
      creatorId: 'creator-accept-5gb',
      inputPath: rawV2Path,
      packageId: 'pipeline-accept-5gb',
      protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
      ...stores,
      version: '2.0.0',
    },
    (await stat(rawV2Path)).size
  );
  await releaseScratchResources({
    measurement,
    paths: [rawV2Path],
    scratchRoot: scratchPath,
  });
  expect(assembledV2.state).toBe('ASSEMBLED');
  const v2CanonicalSha256 = assembledV2.releaseRoot;
  if (!v2CanonicalSha256) {
    throw new Error('Assembled v2 did not persist its canonical SHA-256');
  }
  const expectedV2Root = createLogicalReleaseRootV4({
    files: [...expectedV2.files],
    packageId: assembledV2.packageId,
    version: assembledV2.version,
    versionId: assembledV2.id,
  });
  expect(expectedV2Root.releaseRoot).toBe(v2CanonicalSha256);
  expect(expectedV2Root.releaseRoot).not.toBe(expectedV1Root.releaseRoot);

  const [afterV2Common, afterV2Protected] = await Promise.all([
    exactChunkInventory(configs.common),
    exactChunkInventory(configs.protected),
  ]);
  const v2ChunkBytes = afterV2Common.bytes + afterV2Protected.bytes;
  const v2ChunkObjects = afterV2Common.objects + afterV2Protected.objects;
  expect([...afterV2Common.keys].filter((key) => afterV2Protected.keys.has(key))).toEqual([]);
  const v2DeltaBytes = v2ChunkBytes - v1ChunkBytes;
  const v2DeltaChunks = v2ChunkObjects - v1ChunkObjects;
  expect(v2DeltaBytes).toBeGreaterThan(0);
  expect(v2DeltaBytes).toBeLessThan(v1ChunkBytes / 10);
  expect(v2DeltaChunks).toBeGreaterThan(0);

  const readyV2 = await promoteVersion({
    catalog,
    ...stores,
    versionId: assembledV2.id,
  });
  expect(readyV2.state).toBe('READY');
  expect(readyV2.releaseRoot).toBe(expectedV2Root.releaseRoot);
  expect(readyV2.commonRoot).toBe(expectedV2Root.commonRoot);
  expect(readyV2.protectedSourceRoot).toBe(expectedV2Root.protectedSourceRoot);
  const readyV2LogicalBytes = readyV2.logicalBytes;
  if (readyV2LogicalBytes === null) {
    throw new Error('Ready v2 did not persist its logical byte count');
  }
  expect(await eventTypes(sql, readyV2.id)).toEqual([
    'catalog.version.created',
    'catalog.version.uploading',
    'catalog.version.assembled',
    'catalog.version.promoting',
    'catalog.version.ready',
  ]);
  const retrievedV2Path = await retrieveVersion({
    catalog,
    outputPath: join(scratchPath, 'retrieved-v2'),
    ...stores,
    versionId: readyV2.id,
  });
  expect(await assertReconstructedTree(retrievedV2Path, expectedV2)).toBe(readyV2LogicalBytes);
  await releaseScratchResources({
    measurement,
    paths: [retrievedV2Path],
    scratchRoot: scratchPath,
  });

  return {
    canonicalBytes,
    inputArtifactBytes,
    v1ChunkBytes,
    v1CommonChunkBytes: afterV1Common.bytes,
    v1CommonChunkVersions: afterV1Common.versions,
    v1ProtectedChunkBytes: afterV1Protected.bytes,
    v1ProtectedChunkVersions: afterV1Protected.versions,
    v2DeltaBytes,
    v2DeltaChunks,
  };
}

describe.serial('5 GiB bounded-memory ingest and delivery acceptance', () => {
  it('round-trips two real unitypackages through MinIO and PostgreSQL without whole-file buffering', async () => {
    const sizeBytes = acceptSizeBytes();
    const resources: TestResources = { containers: new Set(), volumes: new Set() };
    const rssSampler = startRssSampler();
    const startedAt = performance.now();
    let scratchMeasurement: PeakMeasurementLifecycle | undefined;
    let lifecycle:
      | {
          measurement: number;
          result: AcceptanceMetrics;
        }
      | undefined;
    let lifecycleError: unknown;

    try {
      lifecycle = await runMeasuredResourceLifecycle({
        cleanup: () => cleanup(resources),
        run: async () => {
          await setup(resources, sizeBytes);
          const scratchPath = requireResource(resources.scratchPath, 'scratch path');
          scratchMeasurement = createPeakMeasurementLifecycle(() =>
            startScratchSampler(scratchPath)
          );
          return runAcceptance(resources, sizeBytes, scratchMeasurement);
        },
        stopMeasurement: async () => (await scratchMeasurement?.stop()) ?? 0,
      });
    } catch (error) {
      lifecycleError = error;
    }

    const peakRssBytes = rssSampler.stop();
    const wallTimeSeconds = (performance.now() - startedAt) / 1000;
    if (lifecycleError !== undefined) {
      throw lifecycleError;
    }
    if (!lifecycle) {
      throw new Error('Acceptance run completed without metrics');
    }
    const metrics = lifecycle.result;
    const peakScratchBytes = lifecycle.measurement;

    expect(peakRssBytes).toBeLessThan(MAX_ORCHESTRATOR_RSS_BYTES);
    expect(peakScratchBytes).toBeGreaterThanOrEqual(metrics.inputArtifactBytes);
    expect(peakScratchBytes).toBeLessThan(MAX_JOB_SCRATCH_BYTES);
    const processUsage = process.resourceUsage();
    console.log(
      `ACCEPT_5GB_RESULT requestedBytes=${sizeBytes} inputArtifactBytes=${metrics.inputArtifactBytes} canonicalBytes=${metrics.canonicalBytes} byte-exact=true protectionPolicy=${ACTIVE_PROTECTION_POLICY_ID} peakRssBytes=${peakRssBytes} peakRssMiB=${(peakRssBytes / MIB).toFixed(1)} memoryBoundBytes=${MAX_ORCHESTRATOR_RSS_BYTES} peakScratchBytes=${peakScratchBytes} peakScratchGiB=${formatGib(peakScratchBytes)} scratchBoundBytes=${MAX_JOB_SCRATCH_BYTES} userCpuMicros=${processUsage.userCPUTime} systemCpuMicros=${processUsage.systemCPUTime} decompression-budget-ok=true decompressionBudgetBytes=${DEFAULT_MAX_DECOMPRESSED_BYTES} v1ChunkBytes=${metrics.v1ChunkBytes} v1CommonChunkBytes=${metrics.v1CommonChunkBytes} v1CommonChunkVersions=${metrics.v1CommonChunkVersions} v1ProtectedChunkBytes=${metrics.v1ProtectedChunkBytes} v1ProtectedChunkVersions=${metrics.v1ProtectedChunkVersions} v2DeltaChunks=${metrics.v2DeltaChunks} v2DedupDeltaBytes=${metrics.v2DeltaBytes} wallTimeSeconds=${wallTimeSeconds.toFixed(1)} cleanup=complete`
    );
  });
});
