import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Catalog, type PackageVersion, PackageVersionNotFoundError } from '../catalog';
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
  packageId: string;
  version: string;
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

export async function assembleVersion(input: AssembleVersionInput): Promise<PackageVersion> {
  let scratchPath: string | undefined;

  try {
    try {
      scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-'));
      const canonical = await canonicalizeArtifact({
        inputPath: input.inputPath,
        outputPath: join(scratchPath, 'artifact.canonical'),
      });
      const canonicalSha256 = await sha256File(canonical.path);
      const storage = resolveAssemblyStorage(input, canonicalSha256, input.versionId);

      await storeArtifactToStore({
        artifactPath: canonical.path,
        indexId: storage.indexId,
        store: storage.store,
      });
      const deliveryMetadata = createDeliveryAssemblyMetadata({
        versionId: input.versionId,
        contentType: deliveryContentType(input.inputPath, input.contentType),
      });
      await writeCasIndexObject({
        body: JSON.stringify(deliveryMetadata),
        contentType: 'application/json',
        indexId: storage.deliveryMetadataId,
        store: storage.store,
      });

      return await input.catalog.transition(input.versionId, 'ASSEMBLED', {
        fields: {
          formatTag: canonical.formatTag,
          canonicalSha256,
          casIndexId: storage.indexId,
        },
        event: { type: 'catalog.version.assembled' },
      });
    } finally {
      if (scratchPath) {
        await rm(scratchPath, { force: true, recursive: true });
      }
    }
  } catch (error) {
    await input.catalog.markFailed(input.versionId, errorMessage(error));
    throw error;
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

export async function promoteVersion(input: PromoteVersionInput): Promise<PackageVersion> {
  const promoting = await input.catalog.transition(input.versionId, 'PROMOTING', {
    event: { type: 'catalog.version.promoting' },
  });
  let scratchPath: string | undefined;

  try {
    if (!promoting.casIndexId || !promoting.canonicalSha256) {
      throw new Error(`Package version ${promoting.id} has incomplete CAS assembly metadata`);
    }
    const deliveryMetadataId = siblingIndexObjectId(
      input.store,
      promoting.casIndexId,
      deliveryAssemblyMetadataObjectId(promoting.id)
    );
    const deliveryMetadata = parseDeliveryAssemblyMetadata(
      JSON.parse(await readCasIndexObject({ indexId: deliveryMetadataId, store: input.store }))
    );
    if (deliveryMetadata.versionId !== promoting.id) {
      throw new Error(`Delivery assembly metadata does not match package version ${promoting.id}`);
    }

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-promote-'));
    const stagedPath = join(scratchPath, 'artifact.reassembled');
    const chunks = await inspectDesyncIndex({
      indexId: promoting.casIndexId,
      store: input.store,
    });
    const expectedByteLength = chunks.reduce((total, chunk) => total + chunk.size, 0);

    await reconstructArtifactFromStore({
      indexId: promoting.casIndexId,
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

    const manifestId = siblingIndexObjectId(
      input.store,
      promoting.casIndexId,
      deliveryManifestObjectId(promoting.id)
    );
    const manifest = createDeliveryManifest({
      storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
      versionId: promoting.id,
      totalSize: byteLength,
      contentType: deliveryMetadata.contentType,
      chunkAvgKib: DESYNC_CHUNK_AVG_KIB,
      chunks,
    });
    await writeCasIndexObject({
      body: JSON.stringify(manifest),
      contentType: 'application/json',
      indexId: manifestId,
      store: input.store,
    });
    await deleteCasIndexObject({ indexId: deliveryMetadataId, store: input.store });

    return await input.catalog.transition(promoting.id, 'READY', {
      event: {
        type: 'catalog.version.ready',
        payload: { byteLength, verification: 'full-reassembly' },
      },
    });
  } catch (error) {
    let failure = error;
    if (promoting.casIndexId) {
      // ponytail: Full orphan-chunk GC is a separate future task.
      const cleanupErrors: unknown[] = [];
      for (const objectId of [
        deliveryManifestObjectId(promoting.id),
        deliveryAssemblyMetadataObjectId(promoting.id),
      ]) {
        try {
          await deleteCasIndexObject({
            indexId: siblingIndexObjectId(input.store, promoting.casIndexId, objectId),
            store: input.store,
          });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        failure = new AggregateError(
          [error, ...cleanupErrors],
          `Promotion failed and cleanup was incomplete for package version ${promoting.id}`
        );
      }
    }
    await input.catalog.markFailed(promoting.id, errorMessage(failure));
    throw failure;
  } finally {
    if (scratchPath) {
      await rm(scratchPath, { force: true, recursive: true });
    }
  }
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
  await reconstructArtifactFromStore({
    indexId: version.casIndexId,
    outputPath,
    store,
  });
  const reconstructedSha256 = await sha256File(outputPath);
  if (reconstructedSha256 !== version.canonicalSha256) {
    throw new Error(
      `Reconstructed SHA-256 mismatch for package version ${version.id}: expected ${version.canonicalSha256}, received ${reconstructedSha256}`
    );
  }

  return outputPath;
}
