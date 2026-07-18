import { describe, expect, it } from 'bun:test';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, statfs, writeFile } from 'node:fs/promises';
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
import { runCommand } from '../storage-core/process';
import { createS3Bucket, listS3Objects } from '../storage-core/s3Control';
import { waitForMinioReady } from '../testing/minioReadiness';
import { waitForPostgres } from '../testing/postgresReadiness';
import { ingestVersion, promoteVersion, retrieveVersion } from './ingestPipeline';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const DEFAULT_ACCEPT_SIZE_BYTES = 5 * GIB;
// This is 20% of the 7.5 GiB host target and remains below a 2 GiB reduced fixture. It allows
// runtime overhead while still catching accidental whole-artifact buffering in the orchestrator.
const MAX_ORCHESTRATOR_RSS_BYTES = 1536 * MIB;
const POSTGRES_IMAGE = 'postgres:17-alpine';
const MINIO_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z';
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
  casConfig?: CasConfig;
  catalog?: Catalog;
  containers: Set<string>;
  scratchPath?: string;
  sql?: CatalogDatabase;
  store?: S3CasStore;
  volumes: Set<string>;
};

type AcceptanceMetrics = {
  canonicalBytes: number;
  inputArtifactBytes: number;
  v1ChunkBytes: number;
  v2DeltaBytes: number;
  v2DeltaChunks: number;
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
  resources.casConfig = undefined;
  resources.store = undefined;

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
  resources.casConfig = loadCasConfig({
    CAS_S3_ENDPOINT: minioEndpoint,
    CAS_S3_REGION: 'us-east-1',
    CAS_S3_BUCKET: `pipeline-accept-5gb-${runId}`,
    CAS_S3_ACCESS_KEY_ID: accessKeyId,
    CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
  });
  await createS3Bucket(resources.casConfig);
  resources.store = s3CasStore(resources.casConfig);
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
  await runCommand(
    'tar',
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
    { env: canonicalizerChildEnv() }
  );
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
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
  sizeBytes: number
): Promise<AcceptanceMetrics> {
  const scratchPath = requireResource(resources.scratchPath, 'scratch path');
  const catalog = requireResource(resources.catalog, 'catalog');
  const sql = requireResource(resources.sql, 'database');
  const config = requireResource(resources.casConfig, 'CAS config');
  const store = requireResource(resources.store, 'CAS store');
  const fixturePath = join(scratchPath, 'fixture');
  const rawV1Path = join(scratchPath, 'artifact-v1.unitypackage');
  const rawV2Path = join(scratchPath, 'artifact-v2.unitypackage');

  await mkdir(fixturePath);
  const versionedAssetPath = await createFixtureTree(fixturePath, sizeBytes);
  await createUnityPackage(fixturePath, rawV1Path);
  await writeFile(versionedAssetPath, 'version=0002\n');
  await createUnityPackage(fixturePath, rawV2Path);
  await rm(fixturePath, { force: true, recursive: true });
  const inputArtifactBytes = (await stat(rawV1Path)).size;

  const assembledV1 = await ingestWithoutFalseBomb(
    {
      catalog,
      inputPath: rawV1Path,
      packageId: 'pipeline-accept-5gb',
      store,
      version: '1.0.0',
    },
    inputArtifactBytes
  );
  await rm(rawV1Path, { force: true });
  expect(assembledV1.state).toBe('ASSEMBLED');
  const v1CanonicalSha256 = assembledV1.canonicalSha256;
  if (!v1CanonicalSha256) {
    throw new Error('Assembled v1 did not persist its canonical SHA-256');
  }
  expect(v1CanonicalSha256).toMatch(/^[0-9a-f]{64}$/);

  const afterV1 = await listS3Objects(config, config.chunkPrefix);
  const v1ChunkBytes = afterV1.reduce((total, object) => total + object.size, 0);
  expect(afterV1.length).toBeGreaterThan(1);
  const readyV1 = await promoteVersion({ catalog, store, versionId: assembledV1.id });
  expect(readyV1.state).toBe('READY');
  expect(await eventTypes(sql, readyV1.id)).toEqual([
    'catalog.version.created',
    'catalog.version.uploading',
    'catalog.version.assembled',
    'catalog.version.promoting',
    'catalog.version.ready',
  ]);

  const retrievedV1Path = await retrieveVersion({
    catalog,
    outputPath: join(scratchPath, 'retrieved-v1.unitypackage'),
    store,
    versionId: readyV1.id,
  });
  expect(await sha256File(retrievedV1Path)).toBe(v1CanonicalSha256);
  const canonicalBytes = (await stat(retrievedV1Path)).size;
  await rm(retrievedV1Path, { force: true });

  const assembledV2 = await ingestWithoutFalseBomb(
    {
      catalog,
      inputPath: rawV2Path,
      packageId: 'pipeline-accept-5gb',
      store,
      version: '2.0.0',
    },
    (await stat(rawV2Path)).size
  );
  await rm(rawV2Path, { force: true });
  expect(assembledV2.state).toBe('ASSEMBLED');
  const v2CanonicalSha256 = assembledV2.canonicalSha256;
  if (!v2CanonicalSha256) {
    throw new Error('Assembled v2 did not persist its canonical SHA-256');
  }
  expect(v2CanonicalSha256).not.toBe(v1CanonicalSha256);

  const afterV2 = await listS3Objects(config, config.chunkPrefix);
  const v2ChunkBytes = afterV2.reduce((total, object) => total + object.size, 0);
  const v2DeltaBytes = v2ChunkBytes - v1ChunkBytes;
  const v2DeltaChunks = afterV2.length - afterV1.length;
  expect(v2DeltaBytes).toBeGreaterThan(0);
  expect(v2DeltaBytes).toBeLessThan(v1ChunkBytes / 10);
  expect(v2DeltaChunks).toBeGreaterThan(0);

  const readyV2 = await promoteVersion({ catalog, store, versionId: assembledV2.id });
  expect(readyV2.state).toBe('READY');
  expect(await eventTypes(sql, readyV2.id)).toEqual([
    'catalog.version.created',
    'catalog.version.uploading',
    'catalog.version.assembled',
    'catalog.version.promoting',
    'catalog.version.ready',
  ]);
  const retrievedV2Path = await retrieveVersion({
    catalog,
    outputPath: join(scratchPath, 'retrieved-v2.unitypackage'),
    store,
    versionId: readyV2.id,
  });
  expect(await sha256File(retrievedV2Path)).toBe(v2CanonicalSha256);
  await rm(retrievedV2Path, { force: true });

  return { canonicalBytes, inputArtifactBytes, v1ChunkBytes, v2DeltaBytes, v2DeltaChunks };
}

describe.serial('5 GiB bounded-memory ingest and delivery acceptance', () => {
  it('round-trips two real unitypackages through MinIO and PostgreSQL without whole-file buffering', async () => {
    const sizeBytes = acceptSizeBytes();
    const resources: TestResources = { containers: new Set(), volumes: new Set() };
    const rssSampler = startRssSampler();
    const startedAt = performance.now();
    let metrics: AcceptanceMetrics | undefined;
    let runError: unknown;
    let cleanupError: unknown;

    try {
      await setup(resources, sizeBytes);
      metrics = await runAcceptance(resources, sizeBytes);
    } catch (error) {
      runError = error;
    }

    try {
      await cleanup(resources);
    } catch (error) {
      cleanupError = error;
    }

    const peakRssBytes = rssSampler.stop();
    const wallTimeSeconds = (performance.now() - startedAt) / 1000;
    if (runError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([runError, cleanupError], 'Acceptance run and cleanup both failed');
    }
    if (runError !== undefined) {
      throw runError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
    if (!metrics) {
      throw new Error('Acceptance run completed without metrics');
    }

    expect(peakRssBytes).toBeLessThan(MAX_ORCHESTRATOR_RSS_BYTES);
    console.log(
      `ACCEPT_5GB_RESULT requestedBytes=${sizeBytes} inputArtifactBytes=${metrics.inputArtifactBytes} canonicalBytes=${metrics.canonicalBytes} byte-exact=true peakRssBytes=${peakRssBytes} peakRssMiB=${(peakRssBytes / MIB).toFixed(1)} memoryBoundBytes=${MAX_ORCHESTRATOR_RSS_BYTES} decompression-budget-ok=true decompressionBudgetBytes=${DEFAULT_MAX_DECOMPRESSED_BYTES} v1ChunkBytes=${metrics.v1ChunkBytes} v2DeltaChunks=${metrics.v2DeltaChunks} v2DedupDeltaBytes=${metrics.v2DeltaBytes} wallTimeSeconds=${wallTimeSeconds.toFixed(1)} cleanup=complete`
    );
  });
});
