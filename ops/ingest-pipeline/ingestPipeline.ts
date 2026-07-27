import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  Catalog,
  type PackageVersion,
  PackageVersionNotFoundError,
  withCatalogHeartbeat,
} from '../catalog';
import {
  ACTIVE_CONTENT_POLICY_VERSION,
  createActiveContentInventory,
} from '../storage-core/activeContentInventory';
import {
  createDeliveryManifest,
  DESYNC_CHUNK_AVG_KIB,
  DESYNC_STORAGE_FORMAT_VERSION,
  type DeliveryManifest,
  deliveryAssemblyObjectId,
  deliveryManifestObjectId,
  parseDeliveryManifest,
} from '../storage-core/deliveryManifest';
import {
  type CasStore,
  deleteCasIndexObject,
  type LocalCasStore,
  readCasIndexObject,
  type S3CasStore,
  writeCasIndexObject,
} from '../storage-core/desyncCas';
import { prepareInstallablePackageTree } from '../storage-core/installablePackageTree';
import { reconstructLogicalFile, storeLogicalFile } from '../storage-core/logicalFileCas';
import { normalizePackageArtifact } from '../storage-core/packageNormalizer';
import {
  classifyPackageFiles,
  type ProtectionPolicyId,
  protectionMaterializationPolicy,
} from '../storage-core/protectionPolicy';
import {
  createLogicalReleasePublicationV4,
  createLogicalReleaseRootV4,
} from '../storage-core/releasePublication';
import {
  normalizeVpmBootstrapMedia,
  type VpmBootstrapMediaObject,
} from '../storage-core/vpmBootstrapMedia';
import { createPipelineScratchDirectory } from './pipelineScratch';

export type PipelineStorage = {
  commonStore: LocalCasStore | S3CasStore;
  metadataStore: LocalCasStore | S3CasStore;
  protectedStore: LocalCasStore | S3CasStore;
};

type ArtifactInput = {
  contentType?: string;
  inputPath: string;
};

export type IngestVersionInput = PipelineStorage &
  ArtifactInput & {
    catalog: Catalog;
    creatorId: string;
    packageId: string;
    protectionPolicyId: ProtectionPolicyId;
    scratchRoot: string;
    version: string;
  };

export interface BeginVersionInput {
  catalog: Catalog;
  catalogProductId?: string;
  editionId?: string;
  packageId: string;
  version: string;
  versionId?: string;
}

export type AssembleVersionInput = PipelineStorage &
  ArtifactInput & {
    catalog: Catalog;
    creatorId: string;
    protectionPolicyId: ProtectionPolicyId;
    scratchRoot: string;
    versionId: string;
  };

export type RetrieveVersionInput = {
  catalog: Catalog;
  commonStore: CasStore;
  metadataStore: CasStore;
  outputPath: string;
  protectedStore: CasStore;
  versionId: string;
};

export interface PromoteVersionInput {
  catalog: Catalog;
  commonStore: CasStore;
  metadataStore: CasStore;
  protectedStore: CasStore;
  scratchRoot: string;
  versionId: string;
}

export function protectedMaterializationFiles(input: {
  files: readonly DeliveryManifest['files'][number][];
  protectionPolicyId: string;
}) {
  protectionMaterializationPolicy(input.protectionPolicyId);
  return input.files
    .filter((file) => file.classification === 'protected')
    .map((file) => {
      if (!file.materializerType) {
        throw new Error(`Protected file ${file.normalizedPath} has no materializer type`);
      }
      return {
        materializerType: file.materializerType,
        normalizedPath: file.normalizedPath,
        required: false,
        sourceSha256: file.sha256,
      };
    });
}

type ResolvedAssemblyStorage = {
  assemblyId: string;
  store: CasStore;
};

export function tagPipelineCasIndexId(store: CasStore, indexId: string): string {
  if (!indexId) {
    throw new Error('CAS object ID must not be empty');
  }
  return `${store.kind}:${indexId}`;
}

export function resolvePipelineCasIndexId(store: CasStore, assemblyObjectId: string): string {
  const separator = assemblyObjectId.indexOf(':');
  const kind = assemblyObjectId.slice(0, separator);
  const indexId = assemblyObjectId.slice(separator + 1);
  if ((kind !== 'local' && kind !== 's3') || !indexId) {
    throw new Error('CAS object ID is missing a valid store-kind tag');
  }
  if (kind !== store.kind) {
    throw new Error(`CAS object store kind ${kind} does not match ${store.kind} store`);
  }
  return indexId;
}

function resolveAssemblyStorage(store: CasStore, versionId: string): ResolvedAssemblyStorage {
  if (store.kind === 's3') {
    return {
      assemblyId: deliveryAssemblyObjectId(versionId),
      store,
    };
  }
  return {
    assemblyId: resolve(store.storePath, deliveryAssemblyObjectId(versionId)),
    store,
  };
}

function siblingIndexObjectId(store: CasStore, objectId: string, siblingId: string): string {
  return store.kind === 's3' ? siblingId : resolve(dirname(objectId), siblingId);
}

async function writePipelineMetadata(input: {
  body: string;
  indexId: string;
  ownerId: string;
  store: CasStore;
}): Promise<string> {
  const sha256 = createHash('sha256').update(input.body, 'utf8').digest('hex');
  if (input.store.kind === 's3' && (input.store.durableStorage || input.store.storageRole)) {
    if (!input.store.durableStorage || input.store.storageRole !== 'metadata') {
      throw new Error('Durable pipeline metadata requires the metadata storage role');
    }
    await input.store.durableStorage.putImmutable({
      body: input.body,
      contentType: 'application/json',
      idempotencyKey: `package-version:${input.ownerId}:metadata:${input.indexId}`,
      objectKey: `${input.store.config.indexPrefix}${input.indexId}`,
      ownerId: input.ownerId,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: sha256,
        logicalKind: 'manifest',
      },
      storageDomain: 'metadata:global:v2',
      storageRole: 'metadata',
    });
    return sha256;
  }
  await writeCasIndexObject({
    body: input.body,
    contentType: 'application/json',
    indexId: input.indexId,
    store: input.store,
  });
  return sha256;
}

export async function storeBootstrapMediaObject(input: {
  body: Uint8Array;
  contentType: 'image/png';
  kind: 'icon';
  ownerId: string;
  sha256: string;
  store: CasStore;
}): Promise<VpmBootstrapMediaObject> {
  if (
    input.store.kind !== 's3' ||
    !input.store.durableStorage ||
    input.store.storageRole !== 'metadata'
  ) {
    throw new Error('Bootstrap media requires exact metadata-role storage');
  }
  const objectKey = `${input.store.config.indexPrefix}bootstrap-media/${input.sha256}.png`;
  const object = await input.store.durableStorage.putImmutable({
    body: input.body,
    contentType: input.contentType,
    idempotencyKey: `package-version:${input.ownerId}:bootstrap-media:${input.sha256}`,
    objectKey,
    ownerId: input.ownerId,
    ownerKind: 'package-version',
    releaseLink: {
      logicalDigest: input.sha256,
      logicalKind: 'bootstrap-media',
    },
    storageDomain: 'metadata:global:v2',
    storageRole: 'metadata',
  });
  if (object.sha256 !== input.sha256 || object.bytes !== input.body.byteLength) {
    throw new Error('Stored bootstrap media does not match normalized metadata');
  }
  return normalizeVpmBootstrapMedia([
    {
      bucketName: object.bucketName,
      byteSize: object.bytes,
      contentType: input.contentType,
      kind: input.kind,
      localPath: `Documentation~/YUCP/${input.kind}.png`,
      objectKey: object.objectKey,
      providerVersion: object.providerVersion,
      sha256: object.sha256,
    },
  ])[0] as VpmBootstrapMediaObject;
}

async function readPipelineMetadata(input: {
  indexId: string;
  logicalDigest: string | null;
  ownerId: string;
  store: CasStore;
}): Promise<string> {
  if (input.store.kind === 's3' && (input.store.durableStorage || input.store.storageRole)) {
    if (
      !input.store.durableStorage ||
      input.store.storageRole !== 'metadata' ||
      !input.logicalDigest
    ) {
      throw new Error('Durable pipeline metadata reads require a digest, role, and exact storage');
    }
    const body = await input.store.durableStorage.readPackageReleaseObject({
      logicalDigest: input.logicalDigest,
      logicalKind: 'manifest',
      objectKey: `${input.store.config.indexPrefix}${input.indexId}`,
      packageVersionId: input.ownerId,
      storageRole: 'metadata',
    });
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  }
  return readCasIndexObject({
    indexId: input.indexId,
    store: input.store,
  });
}

async function cleanupPipelineMetadata(input: { indexId: string; store: CasStore }): Promise<void> {
  if (input.store.kind === 's3' && input.store.durableStorage) {
    return;
  }
  await deleteCasIndexObject(input);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const message = String(error).trim();
  return message || 'Unknown ingest failure';
}

function manifestBody(manifest: DeliveryManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

function assertManifestIdentity(manifest: DeliveryManifest, version: PackageVersion): void {
  if (
    manifest.versionId !== version.id ||
    manifest.packageId !== version.packageId ||
    manifest.version !== version.version ||
    manifest.releaseRoot !== version.releaseRoot
  ) {
    throw new Error(`Logical assembly identity does not match package version ${version.id}`);
  }
  const recomputed = createLogicalReleaseRootV4({
    files: manifest.files,
    packageId: manifest.packageId,
    version: manifest.version,
    versionId: manifest.versionId,
  });
  if (
    recomputed.releaseRoot !== manifest.releaseRoot ||
    recomputed.commonRoot !== manifest.commonRoot ||
    recomputed.protectedSourceRoot !== manifest.protectedSourceRoot
  ) {
    throw new Error(`Logical assembly release root is invalid for package version ${version.id}`);
  }
  const active = createActiveContentInventory(manifest.files);
  if (
    active.digest !== manifest.activeContentDigest ||
    active.policyVersion !== manifest.activePolicyVersion
  ) {
    throw new Error(`Logical assembly active-content inventory is invalid for ${version.id}`);
  }
}

async function reconstructManifestTree(input: {
  commonStore: CasStore;
  manifest: DeliveryManifest;
  outputRoot: string;
  protectedStore: CasStore;
  signal?: AbortSignal;
}): Promise<void> {
  for (const file of input.manifest.files) {
    input.signal?.throwIfAborted();
    await reconstructLogicalFile({
      outputPath: join(input.outputRoot, ...file.normalizedPath.split('/')),
      packageVersionId: input.manifest.versionId,
      recipe: file,
      store: file.classification === 'protected' ? input.protectedStore : input.commonStore,
    });
  }
}

export async function beginVersion(input: BeginVersionInput): Promise<PackageVersion> {
  const created = await input.catalog.createVersion({
    catalogProductId: input.catalogProductId,
    editionId: input.editionId,
    id: input.versionId,
    packageId: input.packageId,
    version: input.version,
  });
  if (created.state === 'UPLOADING') {
    return created;
  }
  if (created.state !== 'CREATED') {
    throw new Error('Package version is immutable after upload completion');
  }

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
    signal?.throwIfAborted();
    const version = await input.catalog.getVersion(input.versionId);
    if (!version) {
      throw new PackageVersionNotFoundError(input.versionId);
    }
    signal?.throwIfAborted();
    scratchPath = await createPipelineScratchDirectory({
      prefix: 'ingest-',
      root: input.scratchRoot,
    });
    const normalized = await normalizePackageArtifact({
      inputPath: input.inputPath,
      outputRoot: join(scratchPath, 'tree'),
      packageId: version.packageId,
    });
    const prepared = await prepareInstallablePackageTree(normalized.files);
    const classified = classifyPackageFiles({
      files: prepared.files,
      policyId: input.protectionPolicyId,
    });
    const bootstrapMetadata = prepared.bootstrapMetadata;
    const bootstrapMedia = await Promise.all(
      normalized.envelopeMetadata.map((media) =>
        storeBootstrapMediaObject({
          body: media.body,
          contentType: media.contentType,
          kind: media.kind,
          ownerId: version.id,
          sha256: media.sha256,
          store: input.metadataStore,
        })
      )
    );
    const release = createLogicalReleaseRootV4({
      files: classified.files,
      packageId: version.packageId,
      version: version.version,
      versionId: version.id,
    });
    const active = createActiveContentInventory(classified.files);
    const files = [];
    const creatorDomain = createHash('sha256')
      .update('yucp:creator-domain:v2\0', 'utf8')
      .update(input.creatorId, 'utf8')
      .digest('hex');
    for (const file of classified.files) {
      signal?.throwIfAborted();
      files.push({
        ...(await storeLogicalFile({
          bytes: file.bytes,
          domain:
            file.classification === 'protected'
              ? `protected:creator:${creatorDomain}:v2`
              : 'common:global:v2',
          path: file.path,
          sha256: file.sha256,
          store: file.classification === 'protected' ? input.protectedStore : input.commonStore,
          ownerId: version.id,
        })),
        classification: file.classification,
        ...(file.materializerType ? { materializerType: file.materializerType } : {}),
        normalizedPath: file.normalizedPath,
      });
    }
    const manifest = createDeliveryManifest({
      activeContentDigest: active.digest,
      activePolicyVersion: ACTIVE_CONTENT_POLICY_VERSION,
      chunkAvgKib: DESYNC_CHUNK_AVG_KIB,
      bootstrapMedia,
      commonRoot: release.commonRoot,
      files,
      normalizationPolicyVersion: prepared.normalizationPolicyVersion,
      packageId: version.packageId,
      protectedSourceRoot: release.protectedSourceRoot,
      protectionPolicyDigest: classified.digest,
      protectionPolicyId: classified.id,
      releaseRoot: release.releaseRoot,
      schemaVersion: 4,
      storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
      version: version.version,
      versionId: version.id,
      ...(bootstrapMetadata.packageMetadata
        ? { packageMetadata: bootstrapMetadata.packageMetadata }
        : {}),
      vpmDependencies: bootstrapMetadata.vpmDependencies,
      vpmRepositories: bootstrapMetadata.vpmRepositories,
    });
    storage = resolveAssemblyStorage(input.metadataStore, version.id);
    signal?.throwIfAborted();
    const manifestSha256 = await writePipelineMetadata({
      body: manifestBody(manifest),
      indexId: storage.assemblyId,
      ownerId: version.id,
      store: storage.store,
    });

    signal?.throwIfAborted();
    return await input.catalog.transition(version.id, 'ASSEMBLED', {
      fields: {
        sourceFormat: normalized.format,
        releaseRoot: release.releaseRoot,
        assemblyObjectId: tagPipelineCasIndexId(storage.store, storage.assemblyId),
        manifestSha256,
      },
      event: {
        type: 'catalog.version.assembled',
        payload: {
          activeContentDigest: active.digest,
          activePolicyVersion: active.policyVersion,
          logicalBytes: classified.files.reduce((total, file) => total + file.bytes, 0),
          logicalFiles: classified.files.length,
          normalizationExcludedFiles: prepared.excludedFiles.length,
          normalizationPolicyVersion: prepared.normalizationPolicyVersion,
          protectionPolicyDigest: classified.digest,
          protectionPolicyId: classified.id,
          protectedFiles: classified.files.filter((file) => file.classification === 'protected')
            .length,
          bootstrapMedia,
          ...(bootstrapMetadata.packageMetadata
            ? { packageMetadata: bootstrapMetadata.packageMetadata }
            : {}),
          vpmDependencies: bootstrapMetadata.vpmDependencies,
          vpmRepositories: bootstrapMetadata.vpmRepositories,
        },
      },
    });
  } catch (error) {
    signal?.throwIfAborted();
    let failure = error;
    if (storage) {
      try {
        await cleanupPipelineMetadata({
          indexId: storage.assemblyId,
          store: storage.store,
        });
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          `Assembly failed and cleanup was incomplete for package version ${input.versionId}`
        );
      }
    }
    signal?.throwIfAborted();
    await input.catalog.markFailed(input.versionId, errorMessage(failure));
    throw failure;
  } finally {
    if (scratchPath) {
      await rm(scratchPath, { force: true, recursive: true });
    }
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
  let manifestId: string | undefined;
  let assemblyId: string | undefined;

  try {
    signal.throwIfAborted();
    if (!promoting.assemblyObjectId || !promoting.releaseRoot) {
      throw new Error(`Package version ${promoting.id} has incomplete logical assembly metadata`);
    }
    assemblyId = resolvePipelineCasIndexId(input.metadataStore, promoting.assemblyObjectId);
    manifestId = siblingIndexObjectId(
      input.metadataStore,
      assemblyId,
      deliveryManifestObjectId(promoting.id)
    );
    const assemblyBody = await readPipelineMetadata({
      indexId: assemblyId,
      logicalDigest: promoting.manifestSha256,
      ownerId: promoting.id,
      store: input.metadataStore,
    });
    const manifest = parseDeliveryManifest(JSON.parse(assemblyBody));
    assertManifestIdentity(manifest, promoting);

    signal.throwIfAborted();
    scratchPath = await createPipelineScratchDirectory({
      prefix: 'promote-',
      root: input.scratchRoot,
    });
    await reconstructManifestTree({
      manifest,
      outputRoot: join(scratchPath, 'tree'),
      signal,
      commonStore: input.commonStore,
      protectedStore: input.protectedStore,
    });

    const body = manifestBody(manifest);
    const publication = createLogicalReleasePublicationV4({
      files: manifest.files,
      manifest: new TextEncoder().encode(body),
      packageId: manifest.packageId,
      version: manifest.version,
      versionId: manifest.versionId,
    });
    if (publication.releaseRoot !== promoting.releaseRoot) {
      throw new Error(`Publication release root changed for package version ${promoting.id}`);
    }
    const logicalBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
    const protectedFiles = protectedMaterializationFiles(manifest);

    signal.throwIfAborted();
    const publishedManifestSha256 = await writePipelineMetadata({
      body,
      indexId: manifestId,
      ownerId: promoting.id,
      store: input.metadataStore,
    });
    if (publishedManifestSha256 !== publication.manifestSha256) {
      throw new Error(`Published manifest digest changed for package version ${promoting.id}`);
    }
    signal.throwIfAborted();
    const ready = await input.catalog.transition(promoting.id, 'READY', {
      fields: {
        activeContentDigest: manifest.activeContentDigest,
        activePolicyVersion: manifest.activePolicyVersion,
        bindingRoot: publication.bindingRoot,
        commonRoot: manifest.commonRoot,
        logicalBytes,
        logicalFiles: manifest.files.length,
        manifestSha256: publication.manifestSha256,
        protectedFiles,
        protectedSourceRoot: manifest.protectedSourceRoot,
        protectionPolicyDigest: manifest.protectionPolicyDigest,
        protectionPolicyId: manifest.protectionPolicyId,
        vpmDependencies: manifest.vpmDependencies,
        vpmRepositories: manifest.vpmRepositories,
      },
      event: {
        type: 'catalog.version.ready',
        payload: {
          activeContentDigest: manifest.activeContentDigest,
          activePolicyVersion: manifest.activePolicyVersion,
          bindingRoot: publication.bindingRoot,
          commonRoot: manifest.commonRoot,
          logicalBytes,
          logicalFiles: manifest.files.length,
          manifestSha256: publication.manifestSha256,
          protectedFiles,
          bootstrapMedia: manifest.bootstrapMedia ?? [],
          ...(manifest.packageMetadata ? { packageMetadata: manifest.packageMetadata } : {}),
          protectedSourceRoot: manifest.protectedSourceRoot,
          protectionPolicyDigest: manifest.protectionPolicyDigest,
          protectionPolicyId: manifest.protectionPolicyId,
          releaseRoot: publication.releaseRoot,
          verification: 'logical-tree-full-reassembly',
          vpmDependencies: manifest.vpmDependencies,
          vpmRepositories: manifest.vpmRepositories,
        },
      },
    });
    await cleanupPipelineMetadata({
      indexId: assemblyId,
      store: input.metadataStore,
    });
    return ready;
  } catch (error) {
    signal.throwIfAborted();
    let failure = error;
    if (manifestId) {
      try {
        await cleanupPipelineMetadata({
          indexId: manifestId,
          store: input.metadataStore,
        });
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
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
  if (!retrievableStates.has(version.state) || !version.assemblyObjectId || !version.releaseRoot) {
    throw new Error(`Package version ${version.id} has no retrievable logical tree`);
  }

  const assemblyId = resolvePipelineCasIndexId(input.metadataStore, version.assemblyObjectId);
  const objectId =
    version.state === 'READY'
      ? siblingIndexObjectId(input.metadataStore, assemblyId, deliveryManifestObjectId(version.id))
      : assemblyId;
  const manifest = parseDeliveryManifest(
    JSON.parse(
      await readPipelineMetadata({
        indexId: objectId,
        logicalDigest: version.manifestSha256,
        ownerId: version.id,
        store: input.metadataStore,
      })
    )
  );
  assertManifestIdentity(manifest, version);

  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const scratchPath = await mkdtemp(join(dirname(outputPath), '.yucp-retrieve-tree-'));
  const stagedTree = join(scratchPath, 'tree');
  await mkdir(stagedTree);
  try {
    await reconstructManifestTree({
      manifest,
      outputRoot: stagedTree,
      commonStore: input.commonStore,
      protectedStore: input.protectedStore,
    });
    await rename(stagedTree, outputPath);
    return outputPath;
  } finally {
    await rm(scratchPath, { force: true, recursive: true });
  }
}
