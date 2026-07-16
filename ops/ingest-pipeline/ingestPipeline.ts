import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Catalog, type PackageVersion, PackageVersionNotFoundError } from '../catalog';
import { canonicalizeArtifact } from '../storage-core/canonicalizer';
import {
  createDeliveryManifest,
  DESYNC_CHUNK_AVG_KIB,
  DESYNC_STORAGE_FORMAT_VERSION,
  deliveryManifestObjectId,
} from '../storage-core/deliveryManifest';
import {
  inspectDesyncIndex,
  localCasStore,
  reconstructArtifactFromStore,
  type S3CasStore,
  storeArtifactToStore,
  writeCasIndexObject,
} from '../storage-core/desyncCas';

type LocalPipelineStorage = {
  indexDir: string;
  store?: never;
  storePath: string;
};

type S3PipelineStorage = {
  indexDir?: never;
  store: S3CasStore;
  storePath?: never;
};

type PipelineStorage = LocalPipelineStorage | S3PipelineStorage;

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
      store: S3CasStore;
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

type ResolvedAssemblyStorage = {
  indexId: string;
  manifestId: string;
  store: ReturnType<typeof localCasStore> | S3CasStore;
};

function resolveAssemblyStorage(
  input: PipelineStorage,
  canonicalSha256: string,
  versionId: string
): ResolvedAssemblyStorage {
  if (input.store) {
    return {
      indexId: `${canonicalSha256}.caibx`,
      manifestId: deliveryManifestObjectId(versionId),
      store: input.store,
    };
  }

  return {
    indexId: resolve(input.indexDir, `${canonicalSha256}.caibx`),
    manifestId: resolve(input.indexDir, deliveryManifestObjectId(versionId)),
    store: localCasStore(input.storePath),
  };
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
      const chunks = await inspectDesyncIndex({
        indexId: storage.indexId,
        store: storage.store,
      });
      const manifest = createDeliveryManifest({
        storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
        versionId: input.versionId,
        totalSize: canonical.byteLength,
        contentType: deliveryContentType(input.inputPath, input.contentType),
        chunkAvgKib: DESYNC_CHUNK_AVG_KIB,
        chunks,
      });
      await writeCasIndexObject({
        body: JSON.stringify(manifest),
        contentType: 'application/json',
        indexId: storage.manifestId,
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
