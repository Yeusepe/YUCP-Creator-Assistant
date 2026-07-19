import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  Catalog,
  type PackageVersion,
  PackageVersionNotFoundError,
  withCatalogHeartbeat,
} from '../catalog';
import { canonicalizeArtifact } from '../storage-core/canonicalizer';
import {
  createDeliveryAssemblyMetadata,
  createDeliveryManifest,
  DESYNC_CHUNK_AVG_KIB,
  DESYNC_STORAGE_FORMAT_VERSION,
  deliveryAssemblyMetadataObjectId,
  deliveryManifestObjectId,
  parseDeliveryAssemblyMetadata,
} from '../storage-core/deliveryManifest';
import {
  type CasStore,
  deleteCasIndexObject,
  inspectDesyncIndex,
  type LocalCasStore,
  localCasStore,
  readCasIndexObject,
  reconstructArtifactFromStore,
  type S3CasStore,
  storeArtifactToStore,
  writeCasIndexObject,
} from '../storage-core/desyncCas';

type LocalPipelineStorage = {
  indexDir: string;
  store: LocalCasStore;
  storePath?: never;
};

type LegacyLocalPipelineStorage = {
  indexDir: string;
  store?: never;
  storePath: string;
};

type S3PipelineStorage = {
  indexDir?: never;
  store: S3CasStore;
  storePath?: never;
};

type PipelineStorage = LocalPipelineStorage | LegacyLocalPipelineStorage | S3PipelineStorage;

type ArtifactInput = {
  contentType?: string;
  inputPath: string;
};

export type IngestVersionInput = PipelineStorage &
  ArtifactInput & {
    catalog: Catalog;
    packageId: string;
    version: string;
  };

export interface BeginVersionInput {
  catalog: Catalog;
  catalogProductId?: string;
  packageId: string;
  version: string;
  versionId?: string;
}

export type AssembleVersionInput = PipelineStorage &
  ArtifactInput & {
    catalog: Catalog;
    versionId: string;
  };

export type RetrieveVersionInput =
  | {
      catalog: Catalog;
      outputPath: string;
      store: CasStore;
      storePath?: never;
      versionId: string;
    }
  | {
      catalog: Catalog;
      outputPath: string;
      store?: never;
      storePath: string;
      versionId: string;
    };

export interface PromoteVersionInput {
  catalog: Catalog;
  store: CasStore;
  versionId: string;
}

type ResolvedAssemblyStorage = {
  deliveryMetadataId: string;
  indexId: string;
  store: CasStore;
};

export function tagPipelineCasIndexId(store: CasStore, indexId: string): string {
  if (!indexId) {
    throw new Error('CAS index ID must not be empty');
  }
  return `${store.kind}:${indexId}`;
}

export function resolvePipelineCasIndexId(store: CasStore, casIndexId: string): string {
  const separator = casIndexId.indexOf(':');
  const kind = casIndexId.slice(0, separator);
  const indexId = casIndexId.slice(separator + 1);
  if ((kind !== 'local' && kind !== 's3') || !indexId) {
    throw new Error('CAS index ID is missing a valid store-kind tag');
  }
  if (kind !== store.kind) {
    throw new Error(`CAS index store kind ${kind} does not match ${store.kind} store`);
  }
  return indexId;
}

function resolveAssemblyStorage(
  input: PipelineStorage,
  canonicalSha256: string,
  versionId: string
): ResolvedAssemblyStorage {
  if (input.store?.kind === 's3') {
    return {
      deliveryMetadataId: deliveryAssemblyMetadataObjectId(versionId),
      indexId: `${canonicalSha256}.caibx`,
      store: input.store,
    };
  }

  const localStore = input.store ?? (input.storePath ? localCasStore(input.storePath) : undefined);
  if (!input.indexDir || !localStore) {
    throw new Error('Local pipeline storage requires an index directory and CAS store');
  }

  return {
    deliveryMetadataId: resolve(input.indexDir, deliveryAssemblyMetadataObjectId(versionId)),
    indexId: resolve(input.indexDir, `${canonicalSha256}.caibx`),
    store: localStore,
  };
}

function siblingIndexObjectId(store: CasStore, indexId: string, objectId: string): string {
  return store.kind === 's3' ? objectId : resolve(dirname(indexId), objectId);
}

function deliveryContentType(inputPath: string, configuredContentType?: string): string {
  if (configuredContentType !== undefined) {
    return configuredContentType;
  }
  const lowerPath = inputPath.toLowerCase();
  if (lowerPath.endsWith('.zip')) {
    return 'application/zip';
  }
  if (lowerPath.endsWith('.tar.gz')) {
    return 'application/gzip';
  }
  return 'application/octet-stream';
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const message = String(error).trim();
  return message || 'Unknown ingest failure';
}

export async function beginVersion(input: BeginVersionInput): Promise<PackageVersion> {
  const created = await input.catalog.createVersion({
    catalogProductId: input.catalogProductId,
    id: input.versionId,
    packageId: input.packageId,
    version: input.version,
  });

  try {
    return await input.catalog.transition(created.id, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
    });
  } catch (error) {
    await input.catalog.markFailed(created.id, errorMessage(error));
    throw error;
  }
}

export async function assembleVersion(
  input: AssembleVersionInput,
  signal?: AbortSignal
): Promise<PackageVersion> {
  let scratchPath: string | undefined;
  let storage: ResolvedAssemblyStorage | undefined;

  try {
    try {
      signal?.throwIfAborted();
      scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-'));
      const canonical = await canonicalizeArtifact({
        inputPath: input.inputPath,
        outputPath: join(scratchPath, 'artifact.canonical'),
      });
      const canonicalSha256 = await sha256File(canonical.path);
      storage = resolveAssemblyStorage(input, canonicalSha256, input.versionId);

      signal?.throwIfAborted();
      await storeArtifactToStore({
        artifactPath: canonical.path,
        indexId: storage.indexId,
        store: storage.store,
      });
      const deliveryMetadata = createDeliveryAssemblyMetadata({
        versionId: input.versionId,
        contentType: deliveryContentType(input.inputPath, input.contentType),
      });
      signal?.throwIfAborted();
      await writeCasIndexObject({
        body: JSON.stringify(deliveryMetadata),
        contentType: 'application/json',
        indexId: storage.deliveryMetadataId,
        store: storage.store,
      });

      signal?.throwIfAborted();
      return await input.catalog.transition(input.versionId, 'ASSEMBLED', {
        fields: {
          formatTag: canonical.formatTag,
          canonicalSha256,
          casIndexId: tagPipelineCasIndexId(storage.store, storage.indexId),
        },
        event: { type: 'catalog.version.assembled' },
      });
    } finally {
      if (scratchPath) {
        await rm(scratchPath, { force: true, recursive: true });
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    let failure = error;
    if (storage) {
      // The shared content-addressed index, like its chunks, remains eligible for normal GC.
      const cleanupErrors: unknown[] = [];
      for (const indexId of [storage.deliveryMetadataId]) {
        signal?.throwIfAborted();
        try {
          await deleteCasIndexObject({ indexId, store: storage.store });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        failure = new AggregateError(
          [error, ...cleanupErrors],
          `Assembly failed and cleanup was incomplete for package version ${input.versionId}`
        );
      }
    }
    signal?.throwIfAborted();
    await input.catalog.markFailed(input.versionId, errorMessage(failure));
    throw failure;
  }
}

export async function ingestVersion(input: IngestVersionInput): Promise<PackageVersion> {
  const uploading = await beginVersion({
    catalog: input.catalog,
    packageId: input.packageId,
    version: input.version,
  });
  return assembleVersion({
    ...input,
    versionId: uploading.id,
  });
}

async function finishPromotion(
  input: PromoteVersionInput,
  promoting: PackageVersion,
  signal: AbortSignal
): Promise<PackageVersion> {
  let scratchPath: string | undefined;
  let indexId: string | undefined;
  let manifestId: string | undefined;
  let publication:
    | {
        deliveryMetadataId: string;
        ready: PackageVersion;
      }
    | undefined;

  try {
    signal.throwIfAborted();
    if (!promoting.casIndexId || !promoting.canonicalSha256) {
      throw new Error(`Package version ${promoting.id} has incomplete CAS assembly metadata`);
    }
    indexId = resolvePipelineCasIndexId(input.store, promoting.casIndexId);
    const deliveryMetadataId = siblingIndexObjectId(
      input.store,
      indexId,
      deliveryAssemblyMetadataObjectId(promoting.id)
    );
    // Resolve the manifest object id up front (it only needs the index id + version), so a failure
    // anywhere in promotion — including during reassembly — still cleans up a stale/partial manifest.
    manifestId = siblingIndexObjectId(input.store, indexId, deliveryManifestObjectId(promoting.id));
    const deliveryMetadata = parseDeliveryAssemblyMetadata(
      JSON.parse(await readCasIndexObject({ indexId: deliveryMetadataId, store: input.store }))
    );
    if (deliveryMetadata.versionId !== promoting.id) {
      throw new Error(`Delivery assembly metadata does not match package version ${promoting.id}`);
    }

    signal.throwIfAborted();
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-promote-'));
    const stagedPath = join(scratchPath, 'artifact.reassembled');
    const chunks = await inspectDesyncIndex({
      indexId,
      store: input.store,
    });
    const expectedByteLength = chunks.reduce((total, chunk) => total + chunk.size, 0);

    signal.throwIfAborted();
    await reconstructArtifactFromStore({
      indexId,
      outputPath: stagedPath,
      store: input.store,
    });
    const byteLength = (await stat(stagedPath)).size;
    if (byteLength !== expectedByteLength) {
      throw new Error(
        `Reassembled byte length mismatch for package version ${promoting.id}: expected ${expectedByteLength}, received ${byteLength}`
      );
    }

    const sha256 = await sha256File(stagedPath);
    if (sha256 !== promoting.canonicalSha256) {
      throw new Error(
        `Reassembled SHA-256 mismatch for package version ${promoting.id}: expected ${promoting.canonicalSha256}, received ${sha256}`
      );
    }

    const manifest = createDeliveryManifest({
      storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
      versionId: promoting.id,
      totalSize: byteLength,
      contentType: deliveryMetadata.contentType,
      chunkAvgKib: DESYNC_CHUNK_AVG_KIB,
      chunks,
    });
    signal.throwIfAborted();
    await writeCasIndexObject({
      body: JSON.stringify(manifest),
      contentType: 'application/json',
      indexId: manifestId,
      store: input.store,
    });
    signal.throwIfAborted();
    const ready = await input.catalog.transition(promoting.id, 'READY', {
      event: {
        type: 'catalog.version.ready',
        payload: {
          byteLength,
          contentType: deliveryMetadata.contentType,
          verification: 'full-reassembly',
        },
      },
    });
    publication = { deliveryMetadataId, ready };
  } catch (error) {
    signal.throwIfAborted();
    let failure = error;
    if (manifestId) {
      const cleanupErrors: unknown[] = [];
      signal.throwIfAborted();
      try {
        await deleteCasIndexObject({ indexId: manifestId, store: input.store });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        failure = new AggregateError(
          [error, ...cleanupErrors],
          `Promotion failed and cleanup was incomplete for package version ${promoting.id}`
        );
      }
    }
    signal.throwIfAborted();
    await input.catalog.markFailed(promoting.id, errorMessage(failure));
    throw failure;
  } finally {
    if (scratchPath) {
      await rm(scratchPath, { force: true, recursive: true });
    }
  }

  if (!publication) {
    throw new Error(`Promotion publication was not prepared for package version ${promoting.id}`);
  }
  signal.throwIfAborted();
  await deleteCasIndexObject({
    indexId: publication.deliveryMetadataId,
    store: input.store,
  });
  return publication.ready;
}

export async function promoteVersion(input: PromoteVersionInput): Promise<PackageVersion> {
  const promoting = await input.catalog.transition(input.versionId, 'PROMOTING', {
    event: { type: 'catalog.version.promoting' },
  });
  return await withCatalogHeartbeat({
    catalog: input.catalog,
    state: 'PROMOTING',
    versionId: promoting.id,
    onHeartbeatError(error) {
      console.error(
        JSON.stringify({
          event: 'ingest_pipeline.promotion_heartbeat_failed',
          versionId: promoting.id,
          reason: error instanceof Error ? error.name : 'unknown_error',
        })
      );
    },
    operation: (signal) => finishPromotion(input, promoting, signal),
  });
}

const retrievableStates = new Set<PackageVersion['state']>(['ASSEMBLED', 'PROMOTING', 'READY']);

export async function retrieveVersion(input: RetrieveVersionInput): Promise<string> {
  const version = await input.catalog.getVersion(input.versionId);
  if (!version) {
    throw new PackageVersionNotFoundError(input.versionId);
  }
  if (!retrievableStates.has(version.state) || !version.casIndexId || !version.canonicalSha256) {
    throw new Error(
      `Package version ${version.id} is not assembled with a CAS index and canonical SHA-256`
    );
  }

  const outputPath = resolve(input.outputPath);
  const store = input.store ?? localCasStore(input.storePath);
  const indexId = resolvePipelineCasIndexId(store, version.casIndexId);
  const outputDirectory = dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const scratchPath = await mkdtemp(join(outputDirectory, '.yucp-retrieve-'));
  const stagedPath = join(scratchPath, 'artifact.reconstructed');

  try {
    const chunks = await inspectDesyncIndex({ indexId, store });
    const expectedByteLength = chunks.reduce((total, chunk) => total + chunk.size, 0);
    if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0) {
      throw new Error('CAS index describes an invalid artifact byte length');
    }
    await reconstructArtifactFromStore({
      indexId,
      outputPath: stagedPath,
      store,
    });
    const reconstructed = await stat(stagedPath);
    if (!reconstructed.isFile() || reconstructed.size !== expectedByteLength) {
      throw new Error(
        `Reconstructed byte length mismatch for package version ${version.id}: expected ${expectedByteLength}, received ${reconstructed.size}`
      );
    }
    const reconstructedSha256 = await sha256File(stagedPath);
    if (reconstructedSha256 !== version.canonicalSha256) {
      throw new Error(
        `Reconstructed SHA-256 mismatch for package version ${version.id}: expected ${version.canonicalSha256}, received ${reconstructedSha256}`
      );
    }

    await rename(stagedPath, outputPath);
    return outputPath;
  } finally {
    await rm(scratchPath, { force: true, recursive: true });
  }
}
