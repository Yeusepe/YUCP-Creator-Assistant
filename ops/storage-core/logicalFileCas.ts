import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  forEachBoundedOrdered,
  LOGICAL_FILE_CHUNK_MAX_BYTES,
  withChunkIoPermit,
} from './boundedOrderedBatch';
import type { DeliveryManifestChunk, DeliveryManifestFile } from './deliveryManifest';
import { type CasStore, produceFileChunks, type S3CasStore, withFileChunks } from './desyncCas';
import { getS3Object, putS3ObjectImmutable } from './s3Control';

export const DIRECT_FILE_CHUNK_LIMIT_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
type LogicalFileRecipe = Pick<DeliveryManifestFile, 'bytes' | 'chunks' | 'sha256'>;

function chunkPath(storePath: string, chunkId: string): string {
  return join(resolve(storePath), chunkId.slice(0, 4), chunkId);
}

function chunkObjectKey(store: Extract<CasStore, { kind: 's3' }>, chunkId: string): string {
  return `${store.config.chunkPrefix}${chunkId.slice(0, 4)}/${chunkId}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertRecipe(input: {
  bytes: number;
  chunks: DeliveryManifestChunk[];
  sha256: string;
}): void {
  if (
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0 ||
    !SHA256_PATTERN.test(input.sha256) ||
    input.chunks.length === 0 ||
    input.chunks.some(
      (chunk) =>
        !SHA256_PATTERN.test(chunk.id) ||
        !SHA256_PATTERN.test(chunk.sha256) ||
        !Number.isSafeInteger(chunk.size) ||
        chunk.size < 0 ||
        chunk.size > LOGICAL_FILE_CHUNK_MAX_BYTES
    ) ||
    input.chunks.reduce((total, chunk) => total + chunk.size, 0) !== input.bytes
  ) {
    throw new Error('Logical file recipe is invalid');
  }
}

async function putLocalChunkImmutable(input: {
  bytes: Uint8Array;
  chunkId: string;
  sha256: string;
  storePath: string;
}): Promise<void> {
  const destination = chunkPath(input.storePath, input.chunkId);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, input.bytes, { flag: 'wx', mode: 0o600 });
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }

  const existing = await readFile(destination);
  if (existing.byteLength !== input.bytes.byteLength || sha256Bytes(existing) !== input.sha256) {
    throw new Error(`Immutable local CAS chunk conflicts with ${input.chunkId}`);
  }
}

async function putDirectChunk(input: {
  bytes: Uint8Array;
  domain: string;
  objectId: string;
  ownerId?: string;
  sha256: string;
  store: CasStore;
}): Promise<void> {
  if (input.store.kind === 'local') {
    await putLocalChunkImmutable({
      bytes: input.bytes,
      chunkId: input.objectId,
      sha256: input.sha256,
      storePath: input.store.storePath,
    });
    return;
  }
  if (input.store.durableStorage || input.store.storageRole) {
    if (!input.store.durableStorage || !input.store.storageRole || !input.ownerId) {
      throw new Error('Durable S3 CAS writes require a role and package owner');
    }
    await input.store.durableStorage.putImmutable({
      body: input.bytes,
      contentType: 'application/octet-stream',
      idempotencyKey:
        `package-version:${input.ownerId}:chunk:` + `${input.store.storageRole}:${input.objectId}`,
      objectKey: chunkObjectKey(input.store, input.objectId),
      ownerId: input.ownerId,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: input.sha256,
        logicalKind: 'chunk',
      },
      storageDomain: input.domain,
      storageRole: input.store.storageRole,
    });
    return;
  }
  await putS3ObjectImmutable({
    body: input.bytes,
    config: input.store.config,
    contentType: 'application/octet-stream',
    key: chunkObjectKey(input.store, input.objectId),
  });
}

function chunkObjectId(domain: string, sha256: string): string {
  if (!domain.trim() || !SHA256_PATTERN.test(sha256)) {
    throw new Error('Chunk domain or SHA-256 is invalid');
  }
  return createHash('sha256')
    .update('yucp:cas-object:v2\0', 'utf8')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(sha256, 'ascii')
    .digest('hex');
}

export async function readVerifiedCasChunk(input: {
  chunk: DeliveryManifestChunk;
  packageVersionId?: string;
  store: CasStore;
}): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (input.store.kind === 'local') {
    bytes = new Uint8Array(await readFile(chunkPath(input.store.storePath, input.chunk.id)));
  } else if (input.store.durableStorage || input.store.storageRole) {
    if (!input.store.durableStorage || !input.store.storageRole || !input.packageVersionId) {
      throw new Error('Durable S3 CAS reads require a role and package owner');
    }
    bytes = await input.store.durableStorage.readPackageReleaseObject({
      logicalDigest: input.chunk.sha256,
      logicalKind: 'chunk',
      objectKey: chunkObjectKey(input.store, input.chunk.id),
      packageVersionId: input.packageVersionId,
      storageRole: input.store.storageRole,
    });
  } else {
    bytes = new Uint8Array(
      await (
        await getS3Object(input.store.config, chunkObjectKey(input.store, input.chunk.id))
      ).arrayBuffer()
    );
  }
  if (bytes.byteLength !== input.chunk.size || sha256Bytes(bytes) !== input.chunk.sha256) {
    throw new Error(`CAS chunk failed verification: ${input.chunk.id}`);
  }
  return bytes;
}

async function storeChunkedFileDurable(input: {
  domain: string;
  ownerId: string;
  path: string;
  store: S3CasStore & { durableStorage: NonNullable<S3CasStore['durableStorage']> } & {
    storageRole: NonNullable<S3CasStore['storageRole']>;
  };
}): Promise<DeliveryManifestChunk[]> {
  return withFileChunks(input.path, async (list, readChunk) => {
    // Identical chunks inside one file share an idempotency key; the batch writes each
    // distinct chunk once and the recipe references it per occurrence.
    const uniqueBySha = new Map<string, DeliveryManifestChunk>();
    for (const chunk of list) {
      if (!uniqueBySha.has(chunk.sha256)) {
        uniqueBySha.set(chunk.sha256, chunk);
      }
    }
    await input.store.durableStorage.putImmutableBatch({
      contentType: 'application/octet-stream',
      items: Array.from(uniqueBySha.values()).map((chunk) => {
        const objectId = chunkObjectId(input.domain, chunk.sha256);
        return {
          bytes: chunk.size,
          idempotencyKey:
            `package-version:${input.ownerId}:chunk:` + `${input.store.storageRole}:${objectId}`,
          loadBody: () => readChunk(chunk),
          objectKey: chunkObjectKey(input.store, objectId),
          releaseLink: {
            logicalDigest: chunk.sha256,
            logicalKind: 'chunk' as const,
          },
          sha256: chunk.sha256,
        };
      }),
      ownerId: input.ownerId,
      ownerKind: 'package-version',
      storageDomain: input.domain,
      storageRole: input.store.storageRole,
    });
    return list.map((chunk) => ({
      id: chunkObjectId(input.domain, chunk.sha256),
      sha256: chunk.sha256,
      size: chunk.size,
    }));
  });
}

export async function storeLogicalFile(input: {
  bytes: number;
  domain: string;
  ownerId?: string;
  path: string;
  /** True when sha256 was already computed from this exact file, skipping the re-hash. */
  precomputedSha256?: boolean;
  sha256: string;
  store: CasStore;
}): Promise<LogicalFileRecipe> {
  const details = await stat(input.path);
  if (
    !details.isFile() ||
    details.size !== input.bytes ||
    !SHA256_PATTERN.test(input.sha256) ||
    (!input.precomputedSha256 && (await sha256File(input.path)) !== input.sha256)
  ) {
    throw new Error('Logical file input failed size or SHA-256 verification');
  }

  let chunks: DeliveryManifestChunk[];
  if (input.bytes < DIRECT_FILE_CHUNK_LIMIT_BYTES) {
    const bytes = new Uint8Array(await readFile(input.path));
    const objectId = chunkObjectId(input.domain, input.sha256);
    await withChunkIoPermit(() =>
      putDirectChunk({
        bytes,
        domain: input.domain,
        objectId,
        ownerId: input.ownerId,
        sha256: input.sha256,
        store: input.store,
      })
    );
    chunks = [{ id: objectId, sha256: input.sha256, size: input.bytes }];
  } else if (input.store.kind === 's3' && (input.store.durableStorage || input.store.storageRole)) {
    if (!input.store.durableStorage || !input.store.storageRole || !input.ownerId) {
      throw new Error('Durable S3 CAS writes require a role and package owner');
    }
    chunks = await storeChunkedFileDurable({
      domain: input.domain,
      ownerId: input.ownerId,
      path: input.path,
      store: input.store as Parameters<typeof storeChunkedFileDurable>[0]['store'],
    });
  } else {
    chunks = await produceFileChunks({
      artifactPath: input.path,
      onChunk: async (chunk) => {
        const objectId = chunkObjectId(input.domain, chunk.sha256);
        await putDirectChunk({
          bytes: chunk.bytes,
          domain: input.domain,
          objectId,
          ownerId: input.ownerId,
          sha256: chunk.sha256,
          store: input.store,
        });
        return { id: objectId, sha256: chunk.sha256, size: chunk.size };
      },
    });
  }
  const recipe = { bytes: input.bytes, chunks, sha256: input.sha256 };
  assertRecipe(recipe);
  return recipe;
}

export async function reconstructLogicalFile(input: {
  outputPath: string;
  packageVersionId?: string;
  recipe: LogicalFileRecipe;
  store: CasStore;
}): Promise<void> {
  assertRecipe(input.recipe);
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytesWritten = 0;
  try {
    try {
      await forEachBoundedOrdered(
        input.recipe.chunks,
        async (chunk) =>
          readVerifiedCasChunk({
            chunk,
            packageVersionId: input.packageVersionId,
            store: input.store,
          }),
        async (bytes) => {
          let offset = 0;
          while (offset < bytes.byteLength) {
            const result = await handle.write(bytes, offset, bytes.byteLength - offset);
            if (result.bytesWritten <= 0) {
              throw new Error('Reconstructed logical file write made no progress');
            }
            offset += result.bytesWritten;
          }
          hash.update(bytes);
          bytesWritten += bytes.byteLength;
        }
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (bytesWritten !== input.recipe.bytes || hash.digest('hex') !== input.recipe.sha256) {
      throw new Error('Reconstructed logical file failed verification');
    }
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }
}
