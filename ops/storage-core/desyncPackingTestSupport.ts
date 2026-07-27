import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { type Zippable, zipSync } from 'fflate';
import { commandPathEnv, runCommand } from './process';

const CHUNK_FILE_NAME_RE = /^([0-9a-f]{64})(\.cacnk)?$/;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH_BYTES = 65_557;

export const DEFAULT_EVALUATION_PACK_BYTES = 64 * 1024 * 1024;

export type DesyncEvaluationStore = {
  configPath: string;
  storePath: string;
  uncompressed: boolean;
};

export type InspectedChunk = {
  id: string;
  size: number;
};

export type PackedChunkLocation = {
  chunkId: string;
  dataOffset: number;
  entryName: string;
  packBytes: number;
  packPath: string;
  packSha256: string;
  storedBytes: number;
};

export type PackMeasurement = {
  chunks: number;
  packBytes: number;
  packPath: string;
  packSha256: string;
  payloadBytes: number;
};

export type PackedStore = {
  locations: Map<string, PackedChunkLocation>;
  packs: PackMeasurement[];
};

type ChunkFile = {
  bytes: number;
  chunkId: string;
  entryName: string;
  path: string;
};

type StoredZipEntry = {
  dataOffset: number;
  name: string;
  storedBytes: number;
};

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function measureDirectory(
  directoryPath: string
): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;

  async function visit(currentPath: string): Promise<void> {
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      const entryPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        bytes += (await stat(entryPath)).size;
        files += 1;
      } else {
        throw new Error(`Evaluation tree contains a non-file entry: ${entryPath}`);
      }
    }
  }

  await visit(resolve(directoryPath));
  return { bytes, files };
}

export async function createDesyncEvaluationStore(input: {
  rootPath: string;
  uncompressed: boolean;
}): Promise<DesyncEvaluationStore> {
  const rootPath = resolve(input.rootPath);
  const storePath = join(rootPath, 'chunks');
  const configPath = join(rootPath, 'desync-config.json');
  await mkdir(storePath, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ 'store-options': { [storePath]: { uncompressed: input.uncompressed } } })}\n`,
    { mode: 0o600 }
  );
  return { configPath, storePath, uncompressed: input.uncompressed };
}

export async function makeDesyncIndex(input: {
  artifactPath: string;
  chunkSize?: string;
  indexPath: string;
  store: DesyncEvaluationStore;
}): Promise<void> {
  await mkdir(dirname(resolve(input.indexPath)), { recursive: true });
  await runCommand(
    'desync',
    [
      '--config',
      input.store.configPath,
      '--digest',
      'sha256',
      'make',
      ...(input.chunkSize ? ['--chunk-size', input.chunkSize] : []),
      '--store',
      input.store.storePath,
      '--',
      resolve(input.indexPath),
      resolve(input.artifactPath),
    ],
    { env: commandPathEnv() }
  );
}

export async function makeDesyncTreeIndex(input: {
  chunkSize?: string;
  indexPath: string;
  sourcePath: string;
  store: DesyncEvaluationStore;
}): Promise<void> {
  await mkdir(dirname(resolve(input.indexPath)), { recursive: true });
  await runCommand(
    'desync',
    [
      '--config',
      input.store.configPath,
      '--digest',
      'sha512-256',
      'tar',
      '--index',
      '--no-time',
      ...(input.chunkSize ? ['--chunk-size', input.chunkSize] : []),
      '--store',
      input.store.storePath,
      '--',
      resolve(input.indexPath),
      resolve(input.sourcePath),
    ],
    { env: commandPathEnv() }
  );
}

export async function inspectDesyncIndexToFile(input: {
  digest?: 'sha256' | 'sha512-256';
  indexPath: string;
  outputPath: string;
  store: DesyncEvaluationStore;
}): Promise<InspectedChunk[]> {
  await mkdir(dirname(resolve(input.outputPath)), { recursive: true });
  await runCommand(
    'desync',
    [
      '--config',
      input.store.configPath,
      '--digest',
      input.digest ?? 'sha256',
      'inspect-chunks',
      '--store',
      input.store.storePath,
      '--',
      resolve(input.indexPath),
    ],
    { env: commandPathEnv(), stdoutPath: resolve(input.outputPath) }
  );
  const parsed: unknown = JSON.parse(await readFile(resolve(input.outputPath), 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('desync inspect-chunks did not return an array');
  }
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`Invalid desync chunk record at ${index}`);
    }
    const id = Reflect.get(value, 'id');
    const size = Reflect.get(value, 'uncompressed_size');
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
      throw new Error(`Invalid desync chunk ID at ${index}`);
    }
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      throw new Error(`Invalid desync chunk size at ${index}`);
    }
    return { id, size: size as number };
  });
}

export async function extractDesyncArtifact(input: {
  indexPath: string;
  outputPath: string;
  store: DesyncEvaluationStore;
}): Promise<void> {
  await mkdir(dirname(resolve(input.outputPath)), { recursive: true });
  await runCommand(
    'desync',
    [
      '--config',
      input.store.configPath,
      '--digest',
      'sha256',
      'extract',
      '--store',
      input.store.storePath,
      '--',
      resolve(input.indexPath),
      resolve(input.outputPath),
    ],
    { env: commandPathEnv() }
  );
}

export async function extractDesyncTree(input: {
  digest?: 'sha256' | 'sha512-256';
  indexPath: string;
  outputPath: string;
  store: DesyncEvaluationStore;
}): Promise<void> {
  await mkdir(resolve(input.outputPath), { recursive: true });
  await runCommand(
    'desync',
    [
      '--config',
      input.store.configPath,
      '--digest',
      input.digest ?? 'sha512-256',
      'untar',
      '--index',
      '--no-same-owner',
      '--store',
      input.store.storePath,
      '--',
      resolve(input.indexPath),
      resolve(input.outputPath),
    ],
    { env: commandPathEnv() }
  );
}

export async function verifyDesyncEvaluationStore(
  store: DesyncEvaluationStore,
  digest: 'sha256' | 'sha512-256' = 'sha256'
): Promise<void> {
  await runCommand(
    'desync',
    ['--config', store.configPath, '--digest', digest, 'verify', '--store', store.storePath],
    { env: commandPathEnv() }
  );
}

async function listChunkFiles(storePath: string): Promise<ChunkFile[]> {
  const chunkFiles: ChunkFile[] = [];

  async function visit(currentPath: string): Promise<void> {
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      const entryPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Desync store contains a non-file entry: ${entryPath}`);
      }
      const match = CHUNK_FILE_NAME_RE.exec(entry.name);
      if (!match) {
        throw new Error(`Unexpected desync chunk filename: ${entryPath}`);
      }
      const chunkId = match[1];
      if (basename(dirname(entryPath)) !== chunkId.slice(0, 4)) {
        throw new Error(`Desync chunk is outside its digest prefix: ${entryPath}`);
      }
      chunkFiles.push({
        bytes: (await stat(entryPath)).size,
        chunkId,
        entryName: entry.name,
        path: entryPath,
      });
    }
  }

  await visit(resolve(storePath));
  return chunkFiles.sort((left, right) => left.chunkId.localeCompare(right.chunkId));
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - MAX_EOCD_SEARCH_BYTES);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('ZIP end-of-central-directory record was not found');
}

export function parseStoredZipEntries(bytes: Uint8Array): StoredZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder();
  const entries: StoredZipEntry[] = [];
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid ZIP central-directory signature at entry ${index}`);
    }
    const compressionMethod = view.getUint16(cursor + 10, true);
    const storedBytes = view.getUint32(cursor + 20, true);
    const uncompressedBytes = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (compressionMethod !== 0 || storedBytes !== uncompressedBytes) {
      throw new Error(`ZIP entry is not stored verbatim: ${name}`);
    }
    if (view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_SIGNATURE) {
      throw new Error(`Invalid ZIP local-file signature for ${name}`);
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + storedBytes > bytes.byteLength) {
      throw new Error(`ZIP entry data exceeds the pack boundary: ${name}`);
    }
    entries.push({ dataOffset, name, storedBytes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function packDesyncStore(input: {
  maxPayloadBytes?: number;
  outputPath: string;
  storePath: string;
}): Promise<PackedStore> {
  const maxPayloadBytes = input.maxPayloadBytes ?? DEFAULT_EVALUATION_PACK_BYTES;
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    throw new RangeError('maxPayloadBytes must be a positive safe integer');
  }
  const outputPath = resolve(input.outputPath);
  await mkdir(outputPath, { recursive: true });
  const chunkFiles = await listChunkFiles(input.storePath);
  const groups: ChunkFile[][] = [];
  let group: ChunkFile[] = [];
  let groupBytes = 0;
  for (const file of chunkFiles) {
    if (group.length > 0 && groupBytes + file.bytes > maxPayloadBytes) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(file);
    groupBytes += file.bytes;
  }
  if (group.length > 0) {
    groups.push(group);
  }

  const locations = new Map<string, PackedChunkLocation>();
  const packs: PackMeasurement[] = [];
  for (const [packIndex, files] of groups.entries()) {
    const entries: Zippable = {};
    let payloadBytes = 0;
    for (const file of files) {
      entries[file.entryName] = [new Uint8Array(await readFile(file.path)), { level: 0 }];
      payloadBytes += file.bytes;
    }
    const packBytes = zipSync(entries, { level: 0 });
    const packSha256 = createHash('sha256').update(packBytes).digest('hex');
    const packPath = join(outputPath, `${packIndex.toString().padStart(6, '0')}-${packSha256}.zip`);
    await writeFile(packPath, packBytes);
    const storedEntries = parseStoredZipEntries(packBytes);
    if (storedEntries.length !== files.length) {
      throw new Error(`ZIP pack entry count mismatch for ${packPath}`);
    }
    for (const entry of storedEntries) {
      const match = CHUNK_FILE_NAME_RE.exec(entry.name);
      if (!match) {
        throw new Error(`ZIP pack contains an invalid chunk entry: ${entry.name}`);
      }
      const chunkId = match[1];
      if (locations.has(chunkId)) {
        throw new Error(`Chunk appears in more than one pack: ${chunkId}`);
      }
      locations.set(chunkId, {
        chunkId,
        dataOffset: entry.dataOffset,
        entryName: entry.name,
        packBytes: packBytes.byteLength,
        packPath,
        packSha256,
        storedBytes: entry.storedBytes,
      });
    }
    packs.push({
      chunks: files.length,
      packBytes: packBytes.byteLength,
      packPath,
      packSha256,
      payloadBytes,
    });
  }
  return { locations, packs };
}

export async function rebuildDesyncStoreFromPackedRanges(input: {
  locations: Iterable<PackedChunkLocation>;
  targetStorePath: string;
}): Promise<void> {
  const targetStorePath = resolve(input.targetStorePath);
  const locationsByPack = new Map<string, PackedChunkLocation[]>();
  for (const location of input.locations) {
    const group = locationsByPack.get(location.packPath) ?? [];
    group.push(location);
    locationsByPack.set(location.packPath, group);
  }
  for (const [packPath, locations] of locationsByPack) {
    const packBytes = new Uint8Array(await readFile(packPath));
    for (const location of locations) {
      const chunkBytes = packBytes.subarray(
        location.dataOffset,
        location.dataOffset + location.storedBytes
      );
      if (chunkBytes.byteLength !== location.storedBytes) {
        throw new Error(`Packed range is incomplete for chunk ${location.chunkId}`);
      }
      const destination = join(targetStorePath, location.chunkId.slice(0, 4), location.entryName);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, chunkBytes);
    }
  }
}

export function distinctPackCount(
  chunks: Iterable<InspectedChunk>,
  locations: ReadonlyMap<string, PackedChunkLocation>
): number {
  const packHashes = new Set<string>();
  for (const chunk of chunks) {
    const location = locations.get(chunk.id);
    if (!location) {
      throw new Error(`No packed location exists for chunk ${chunk.id}`);
    }
    packHashes.add(location.packSha256);
  }
  return packHashes.size;
}
