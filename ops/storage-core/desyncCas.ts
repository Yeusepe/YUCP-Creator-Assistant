import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  LOGICAL_FILE_CHUNK_MAX_BYTES,
  mapBoundedOrdered,
  withChunkIoPermit,
} from './boundedOrderedBatch';
import type { CasConfig } from './config';
import type { DeliveryManifestChunk } from './deliveryManifest';
import type { DurableExactStorage } from './durableExactStorage';
import type { StorageRole } from './exactStorage';
import { commandPathEnv, runCommand } from './process';
import {
  deleteS3Objects,
  getS3Object,
  putS3ObjectImmutable,
  putS3ObjectVersioned,
} from './s3Control';

const REQUIRED_DESYNC_COMMANDS = ['make', 'extract', 'chop', 'cat', 'inspect-chunks'] as const;
const DESYNC_CHUNK_PROFILE = '64:256:1024';

export type LocalStoreMeasurement = {
  bytes: number;
  chunks: number;
};

export type LocalCasStore = {
  kind: 'local';
  storePath: string;
};

export type S3CasStore = {
  kind: 's3';
  config: CasConfig;
  durableStorage?: DurableExactStorage;
  storageRole?: Extract<StorageRole, 'common' | 'metadata' | 'protected'>;
};

export type CasStore = LocalCasStore | S3CasStore;

export function localCasStore(storePath: string): LocalCasStore {
  return { kind: 'local', storePath };
}

export function s3CasStore(
  config: CasConfig,
  options: {
    durableStorage?: DurableExactStorage;
    storageRole?: Extract<StorageRole, 'common' | 'metadata' | 'protected'>;
  } = {}
): S3CasStore {
  return { kind: 's3', config, ...options };
}

async function runDesyncWithUncompressedStore(
  storeLocation: string,
  args: string[],
  options: Parameters<typeof runCommand>[2] = {}
): Promise<Awaited<ReturnType<typeof runCommand>>> {
  const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-desync-config-'));
  const configPath = join(scratchPath, 'config.json');

  try {
    await writeFile(
      configPath,
      `${JSON.stringify({ 'store-options': { [storeLocation]: { uncompressed: true } } })}\n`,
      { mode: 0o600 }
    );
    return await runCommand('desync', ['--config', configPath, '--digest', 'sha256', ...args], {
      ...options,
      env: options.env ?? commandPathEnv(),
    });
  } finally {
    await rm(scratchPath, { force: true, recursive: true });
  }
}

function encodeStorePath(value: string): string {
  const encoded = value
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return value.endsWith('/') ? `${encoded}/` : encoded;
}

/**
 * desync S3 URL contract: https://github.com/folbricht/desync#s3-store-urls
 */
export function buildDesyncS3StoreUrl(config: CasConfig, prefix = config.chunkPrefix): string {
  const endpoint = new URL(config.endpoint);
  const storePath = encodeStorePath(`${config.bucket}/${prefix}`);
  return `s3+${endpoint.protocol}//${endpoint.host}/${storePath}`;
}

function assertRemoteIndexId(indexId: string): void {
  const segments = indexId.split('/');
  if (
    !indexId ||
    indexId.startsWith('/') ||
    indexId.includes('\\') ||
    indexId.includes('?') ||
    indexId.includes('#') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('S3 CAS index ID must be a safe relative object key');
  }
}

function buildDesyncS3IndexUrl(config: CasConfig, indexId: string): string {
  assertRemoteIndexId(indexId);
  return buildDesyncS3StoreUrl(config, `${config.indexPrefix}${indexId}`);
}

/**
 * desync credential contract: https://github.com/folbricht/desync#environment-variables
 * The endpoint is encoded in the store URL. Credentials and region are scoped to one child only.
 */
export function desyncS3ChildEnv(config: CasConfig): NodeJS.ProcessEnv {
  return {
    ...commandPathEnv(),
    AWS_ACCESS_KEY_ID: config.accessKeyId,
    AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
    AWS_REGION: config.region,
    AWS_DEFAULT_REGION: config.region,
    S3_REGION: config.region,
  };
}

export async function verifyDesyncCli(): Promise<void> {
  const { stdout } = await runCommand('desync', ['--help'], { env: commandPathEnv() });
  for (const command of REQUIRED_DESYNC_COMMANDS) {
    if (!new RegExp(`^\\s+${command}\\s`, 'm').test(stdout)) {
      throw new Error(`desync --help does not advertise the required ${command} subcommand.`);
    }
  }
}

export async function storeArtifact(input: {
  artifactPath: string;
  indexPath: string;
  storePath: string;
}): Promise<void> {
  await storeArtifactToStore({
    artifactPath: input.artifactPath,
    indexId: input.indexPath,
    store: localCasStore(input.storePath),
  });
}

export async function reconstructArtifact(input: {
  indexPath: string;
  outputPath: string;
  storePath: string;
}): Promise<void> {
  await reconstructArtifactFromStore({
    indexId: input.indexPath,
    outputPath: input.outputPath,
    store: localCasStore(input.storePath),
  });
}

export async function storeArtifactToStore(input: {
  artifactPath: string;
  indexId: string;
  store: CasStore;
}): Promise<void> {
  const artifactPath = resolve(input.artifactPath);
  if (input.store.kind === 'local') {
    const indexPath = resolve(input.indexId);
    const storePath = resolve(input.store.storePath);
    await mkdir(dirname(indexPath), { recursive: true });
    await mkdir(storePath, { recursive: true });
    await runDesyncWithUncompressedStore(storePath, [
      'make',
      '--chunk-size',
      DESYNC_CHUNK_PROFILE,
      '--store',
      storePath,
      '--',
      indexPath,
      artifactPath,
    ]);
    return;
  }

  const storeUrl = buildDesyncS3StoreUrl(input.store.config);
  assertRemoteIndexId(input.indexId);
  const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-desync-index-'));
  const indexPath = join(scratchPath, 'artifact.caibx');
  try {
    await runDesyncWithUncompressedStore(
      storeUrl,
      [
        'make',
        '--chunk-size',
        DESYNC_CHUNK_PROFILE,
        '--store',
        storeUrl,
        '--',
        indexPath,
        artifactPath,
      ],
      {
        env: desyncS3ChildEnv(input.store.config),
      }
    );
    await putS3ObjectImmutable({
      body: await readFile(indexPath),
      config: input.store.config,
      contentType: 'application/octet-stream',
      key: `${input.store.config.indexPrefix}${input.indexId}`,
    });
  } finally {
    await rm(scratchPath, { force: true, recursive: true });
  }
}

/**
 * Chops one file into its CDC chunk store on local disk and hands the ordered chunk list
 * plus a bounded chunk reader to the callback. The scratch store lives for the duration
 * of the callback only, so chunk bodies are read on demand instead of being buffered.
 */
export async function withFileChunks<T>(
  artifactPath: string,
  process: (
    chunks: DeliveryManifestChunk[],
    readChunk: (chunk: DeliveryManifestChunk) => Promise<Uint8Array>
  ) => Promise<T>
): Promise<T> {
  const resolvedArtifactPath = resolve(artifactPath);
  const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-desync-file-recipe-'));
  const indexPath = join(scratchPath, 'file.caibx');
  const storePath = join(scratchPath, 'chunks');
  try {
    await mkdir(storePath, { recursive: true });
    await runDesyncWithUncompressedStore(storePath, [
      'make',
      '--chunk-size',
      DESYNC_CHUNK_PROFILE,
      '--store',
      storePath,
      '--',
      indexPath,
      resolvedArtifactPath,
    ]);
    const inspected = await inspectDesyncIndex({
      indexId: indexPath,
      store: localCasStore(scratchPath),
    });
    for (const chunk of inspected) {
      if (chunk.size > LOGICAL_FILE_CHUNK_MAX_BYTES) {
        throw new Error('desync chunk exceeds the configured maximum size');
      }
    }
    return await process(inspected, async (chunk) => {
      const bytes = new Uint8Array(await readFile(join(storePath, chunk.id.slice(0, 4), chunk.id)));
      if (bytes.byteLength !== chunk.size) {
        throw new Error('desync chunk length changed after inspection');
      }
      return bytes;
    });
  } finally {
    await rm(scratchPath, { force: true, recursive: true });
  }
}

export async function produceFileChunks(input: {
  artifactPath: string;
  onChunk: (chunk: {
    bytes: Uint8Array;
    sha256: string;
    size: number;
  }) => Promise<DeliveryManifestChunk>;
}): Promise<DeliveryManifestChunk[]> {
  return withFileChunks(input.artifactPath, (chunks, readChunk) =>
    mapBoundedOrdered(chunks, (chunk) =>
      // The permit covers the read and the write, so at most pool-width chunk bodies are
      // in memory across every file processed concurrently.
      withChunkIoPermit(async () =>
        input.onChunk({
          bytes: await readChunk(chunk),
          sha256: chunk.id,
          size: chunk.size,
        })
      )
    )
  );
}

export async function reconstructArtifactFromStore(input: {
  indexId: string;
  outputPath: string;
  store: CasStore;
}): Promise<void> {
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });

  if (input.store.kind === 'local') {
    const storePath = resolve(input.store.storePath);
    await runDesyncWithUncompressedStore(storePath, [
      'extract',
      '--store',
      storePath,
      '--',
      resolve(input.indexId),
      outputPath,
    ]);
    return;
  }

  const storeUrl = buildDesyncS3StoreUrl(input.store.config);
  const indexUrl = buildDesyncS3IndexUrl(input.store.config, input.indexId);
  await runDesyncWithUncompressedStore(
    storeUrl,
    ['extract', '--store', storeUrl, '--', indexUrl, outputPath],
    {
      env: desyncS3ChildEnv(input.store.config),
    }
  );
}

export async function inspectDesyncIndex(input: {
  indexId: string;
  store: CasStore;
}): Promise<DeliveryManifestChunk[]> {
  const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-desync-inspection-'));
  const inspectionPath = join(scratchPath, 'chunks.json');
  const indexLocation =
    input.store.kind === 'local'
      ? resolve(input.indexId)
      : buildDesyncS3IndexUrl(input.store.config, input.indexId);
  try {
    await runCommand('desync', ['--digest', 'sha256', 'inspect-chunks', '--', indexLocation], {
      env: input.store.kind === 's3' ? desyncS3ChildEnv(input.store.config) : commandPathEnv(),
      stdoutPath: inspectionPath,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(inspectionPath, 'utf8'));
    } catch (error) {
      throw new Error('desync inspect-chunks returned invalid JSON', { cause: error });
    }
    if (!Array.isArray(parsed)) {
      throw new Error('desync inspect-chunks did not return a chunk list');
    }

    return parsed.map((value, index) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`desync inspect-chunks returned an invalid chunk at index ${index}`);
      }
      const id = Reflect.get(value, 'id');
      const size = Reflect.get(value, 'uncompressed_size');
      if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
        throw new Error(`desync inspect-chunks returned an invalid chunk ID at index ${index}`);
      }
      if (!Number.isSafeInteger(size) || (size as number) <= 0) {
        throw new Error(`desync inspect-chunks returned an invalid chunk size at index ${index}`);
      }
      return { id, sha256: id, size: size as number };
    });
  } finally {
    await rm(scratchPath, { force: true, recursive: true });
  }
}

export async function writeCasIndexObject(input: {
  body: string;
  contentType: string;
  indexId: string;
  replaceExisting?: boolean;
  store: CasStore;
}): Promise<void> {
  if (input.store.kind === 'local') {
    const indexPath = resolve(input.indexId);
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, input.body, { encoding: 'utf8', mode: 0o600 });
    return;
  }

  assertRemoteIndexId(input.indexId);
  if (input.replaceExisting) {
    await putS3ObjectVersioned({
      body: input.body,
      config: input.store.config,
      contentType: input.contentType,
      key: `${input.store.config.indexPrefix}${input.indexId}`,
    });
    return;
  }
  await putS3ObjectImmutable({
    body: input.body,
    config: input.store.config,
    contentType: input.contentType,
    key: `${input.store.config.indexPrefix}${input.indexId}`,
  });
}

export async function readCasIndexObject(input: {
  indexId: string;
  store: CasStore;
}): Promise<string> {
  if (input.store.kind === 'local') {
    return readFile(resolve(input.indexId), 'utf8');
  }

  assertRemoteIndexId(input.indexId);
  const response = await getS3Object(
    input.store.config,
    `${input.store.config.indexPrefix}${input.indexId}`
  );
  return response.text();
}

export async function deleteCasIndexObject(input: {
  indexId: string;
  store: CasStore;
}): Promise<void> {
  if (input.store.kind === 'local') {
    await rm(resolve(input.indexId), { force: true });
    return;
  }

  assertRemoteIndexId(input.indexId);
  await deleteS3Objects(input.store.config, [`${input.store.config.indexPrefix}${input.indexId}`]);
}

export async function measureLocalStore(storePath: string): Promise<LocalStoreMeasurement> {
  let bytes = 0;
  let chunks = 0;

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        bytes += (await stat(entryPath)).size;
        chunks += 1;
      } else {
        throw new Error(`Unexpected non-file entry in desync store: ${entryPath}`);
      }
    }
  }

  await visit(resolve(storePath));
  return { bytes, chunks };
}
