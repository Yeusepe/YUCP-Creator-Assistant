import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  LOGICAL_FILE_INGEST_CONCURRENCY,
  mapBoundedOrdered,
} from '../storage-core/boundedOrderedBatch';
import {
  type CouplingPlan,
  createFbxCouplingPlan,
  createPngBandCouplingPlan,
  createPngWholeCouplingPlan,
  readPngGeometry,
} from '../storage-core/couplingPlan';
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
  reconstructArtifactFromStore,
  type S3CasStore,
  writeCasIndexObject,
} from '../storage-core/desyncCas';
import { prepareInstallablePackageTree } from '../storage-core/installablePackageTree';
import { reconstructLogicalFile, storeLogicalFile } from '../storage-core/logicalFileCas';
import { normalizePackageArtifact } from '../storage-core/packageNormalizer';
import {
  type BandedPng,
  type BandPlacement,
  normalizePngForBanding,
  PngBandError,
  parsePng,
  placeBand,
  planBand,
} from '../storage-core/pngBanding';
import {
  type ClassifiedPackageFile,
  classifiablePath,
  classifyPackageFiles,
  COUPLING_MIN_PNG_BLOCKS,
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

export type MigrateLegacyReadyVersionInput = PipelineStorage & {
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
        couplingPlan: file.couplingPlan,
        materializerType: file.materializerType,
        normalizedPath: file.normalizedPath,
        required: true,
        sourceSha256: file.sha256,
      };
    });
}

async function readFileHeader(path: string, length: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The band is the embed area, so it needs the same measured capacity margin as
 * a whole image: 4x the 864 coded blocks, <=25% occupancy. Planning the band
 * for the payload alone (864) packed keyed placement to ~85-100% occupancy,
 * where a saturated region deterministically fails a slice of buyer keys
 * (~7.8% at 1024 blocks) — the stuck-"personalizing" incident of 2026-08-03.
 * Shares the whole-image gate constant so the two thresholds cannot drift.
 */
const BAND_BLOCKS = COUPLING_MIN_PNG_BLOCKS;
const BAND_MIN_FRACTION = 0.05;

/**
 * How many images may be banded at once.
 *
 * Banding streams rows through zlib now, so per-image memory is two rows plus
 * the compressed streams, and this bound is about CPU rather than rasters: the
 * unfilter walk and the adler arithmetic run on the event loop, and the same
 * loop serves the status endpoint. Two keeps the loop responsive; the raster
 * arithmetic that used to cap this (796 MB for a 14104x14103 source, which
 * froze the host) no longer exists.
 */
const BAND_CONCURRENCY = 2;

/**
 * Level 6, measured against the alternatives on the production corpus:
 *
 *   level 1    3.3s   +59.5% vs source
 *   level 4    7.3s    +3.2%
 *   level 6   14.1s    +0.2%
 *   level 9  110.8s    -1.9%
 *
 * Level 9 spends 96.7 extra seconds, 7.9x the deflate cost, to save 5.5 MiB
 * across 270 MiB of textures. Publish pays that on every upload; the 2% would
 * be saved on every delivery, but not at that price. Level 6 lands within a
 * rounding error of the source's own size for a seventh of the work.
 */
const BAND_DEFLATE_LEVEL = 6;

/**
 * Re-encodes protected PNGs so a buyer's coupling can replace one band instead
 * of the whole image, and reports where that band landed.
 *
 * Publish pays an inflate and a deflate per protected PNG so that every buyer
 * of every copy stops paying a full decode and re-encode. On a 124-file package
 * that trade is measured at 8x on the couple side.
 *
 * The band is placed from the source's own digest. That is deterministic and
 * spreads placement across a package rather than putting every texture's mark
 * in the same rows, but it is not a secret: Z_FULL_FLUSH leaves an empty stored
 * block in the IDAT, so anyone holding the published file can see where the
 * segment boundaries are. Placement varies the target, it does not hide it.
 *
 * Anything that cannot be banded (palette, interlaced, greyscale, or an image
 * small enough that the band would be the whole thing) is left exactly as it
 * was and couples whole, which is what every file did before this existed.
 */
export async function bandProtectedPngs<T extends ClassifiedPackageFile>(
  files: readonly T[],
  signal?: AbortSignal
): Promise<Array<T & { couplingPlan?: CouplingPlan }>> {
  const passStartedAt = Date.now();
  const results: Array<T & { couplingPlan?: CouplingPlan }> = await mapBoundedOrdered(
    files,
    async (file) => {
      signal?.throwIfAborted();
      if (file.classification !== 'protected') {
        return file;
      }
      if (file.materializerType === 'fbx') {
        return { ...file, couplingPlan: createFbxCouplingPlan(file.bytes) };
      }
      if (file.materializerType !== 'png') {
        throw new Error(
          `Protected materializer type ${file.materializerType ?? 'missing'} is unsupported by v5`
        );
      }
      const startedAt = Date.now();
      const png = new Uint8Array(await readFile(file.path));
      const geometry = readPngGeometry(png);
      if (!geometry) {
        throw new Error('Protected PNG has unsupported or malformed geometry');
      }
      let banded: BandedPng | null = null;
      let placement: BandPlacement | null = null;
      let bandFailure: string | null = null;
      try {
        const { header } = parsePng(png);
        const planned = planBand(header, {
          blocks: BAND_BLOCKS,
          minFraction: BAND_MIN_FRACTION,
        });
        if (!planned) {
          bandFailure = 'band would cover the whole image';
        } else {
          placement = placeBand(header, planned, Buffer.from(file.sha256, 'hex'));
          banded = await normalizePngForBanding({
            band: placement,
            level: BAND_DEFLATE_LEVEL,
            png,
          });
        }
      } catch (error) {
        if (!(error instanceof PngBandError)) {
          throw error;
        }
        bandFailure = error.message;
      }
      if (!banded || !placement) {
        const couplingPlan = createPngWholeCouplingPlan({
          ...geometry,
          fileBytes: file.bytes,
        });
        console.info(
          JSON.stringify({
            bytes: file.bytes,
            couplingStrategy: couplingPlan.strategy,
            event: 'ingest_pipeline.coupling_planned',
            ms: Date.now() - startedAt,
            peakDynamicBytes: couplingPlan.peakDynamicBytes,
            reason: bandFailure,
          })
        );
        return { ...file, couplingPlan };
      }
      await writeFile(file.path, banded.base);
      const band = {
        idatPrefixCrc32: banded.idatPrefixCrc32,
        idatSuffixCrc32: banded.idatSuffixCrc32,
        idatSuffixLength: banded.idatSuffixLength,
        length: banded.bandRange.length,
        offset: banded.bandRange.offset,
        prefixAdler: banded.prefixAdler,
        rows: placement.rows,
        suffixAdler: banded.suffixAdler,
        suffixFilteredLength: banded.suffixFilteredLength,
        y0: placement.y0,
      };
      const couplingPlan = createPngBandCouplingPlan({
        ...geometry,
        band,
        fileBytes: banded.base.byteLength,
      });
      console.info(
        JSON.stringify({
          bandRows: placement.rows,
          bandY0: placement.y0,
          bytesAfter: banded.base.byteLength,
          bytesBefore: file.bytes,
          couplingStrategy: couplingPlan.strategy,
          event: 'ingest_pipeline.coupling_planned',
          ms: Date.now() - startedAt,
          peakDynamicBytes: couplingPlan.peakDynamicBytes,
        })
      );
      return {
        ...file,
        bytes: banded.base.byteLength,
        couplingPlan,
        sha256: createHash('sha256').update(banded.base).digest('hex'),
      };
    },
    BAND_CONCURRENCY
  );
  const banded = results.filter((file) => file.couplingPlan?.strategy === 'png-band-v1').length;
  const eligible = files.filter(
    (file) => file.classification === 'protected' && file.materializerType === 'png'
  ).length;
  console.info(
    JSON.stringify({
      banded,
      event: 'ingest_pipeline.banding_completed',
      ms: Date.now() - passStartedAt,
      skipped: eligible - banded,
      threadpool: process.env.UV_THREADPOOL_SIZE ?? 'default(4)',
    })
  );
  return results;
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

function resolveAssemblyStorage(
  store: CasStore,
  versionId: string,
  contentSha256: string
): ResolvedAssemblyStorage {
  const name = deliveryAssemblyObjectId(versionId, contentSha256);
  return {
    assemblyId: store.kind === 's3' ? name : resolve(store.storePath, name),
    store,
  };
}

function resolveDeliveryManifestId(store: CasStore, versionId: string): string {
  const name = deliveryManifestObjectId(versionId);
  return store.kind === 's3' ? name : resolve(store.storePath, name);
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
  contentType: NonNullable<VpmBootstrapMediaObject['contentType']>;
  kind: VpmBootstrapMediaObject['kind'];
  label?: string;
  localPath: string;
  ordinal?: number;
  ownerId: string;
  sha256: string;
  store: CasStore;
  url?: string;
}): Promise<VpmBootstrapMediaObject> {
  if (
    input.store.kind !== 's3' ||
    !input.store.durableStorage ||
    input.store.storageRole !== 'metadata'
  ) {
    throw new Error('Bootstrap media requires exact metadata-role storage');
  }
  const extension = input.contentType === 'image/png' ? 'png' : 'jpg';
  const objectKey = `${input.store.config.indexPrefix}bootstrap-media/${input.sha256}.${extension}`;
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
      localPath: input.localPath,
      objectKey: object.objectKey,
      ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
      providerVersion: object.providerVersion,
      sha256: object.sha256,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.url === undefined ? {} : { url: input.url }),
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

async function writeReplaceablePipelineMetadata(input: {
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
    await input.store.durableStorage.putVersioned({
      body: input.body,
      contentType: 'application/json',
      idempotencyKey: `package-version:${input.ownerId}:metadata-replaceable:${input.indexId}:${sha256}`,
      objectKey: `${input.store.config.indexPrefix}${input.indexId}`,
      ownerId: input.ownerId,
      ownerKind: 'package-version',
      releaseLink: {
        logicalDigest: sha256,
        logicalKind: 'manifest',
      },
      storageRole: 'metadata',
    });
    return sha256;
  }
  await writeCasIndexObject({
    body: input.body,
    contentType: 'application/json',
    indexId: input.indexId,
    replaceExisting: true,
    store: input.store,
  });
  return sha256;
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function assertManifestIdentity(manifest: DeliveryManifest, version: PackageVersion): void {
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

type PreparedLogicalAssembly = {
  assemblyId: string;
  manifest: DeliveryManifest;
  manifestSha256: string;
  normalizationExcludedFiles: number;
  normalizedFormat: string;
};

async function prepareLogicalAssembly(
  input: PipelineStorage & {
    creatorId: string;
    inputPath: string;
    protectionPolicyId: ProtectionPolicyId;
    scratchTreeRoot: string;
    version: PackageVersion;
  },
  signal?: AbortSignal
): Promise<PreparedLogicalAssembly> {
  const normalized = await normalizePackageArtifact({
    inputPath: input.inputPath,
    outputRoot: input.scratchTreeRoot,
    packageId: input.version.packageId,
  });
  const prepared = await prepareInstallablePackageTree(normalized.files);
  const classified = classifyPackageFiles({
    files: await mapBoundedOrdered(
      prepared.files,
      async (file) => {
        signal?.throwIfAborted();
        if (!classifiablePath(file.normalizedPath).endsWith('.png')) {
          return file;
        }
        const metadata = readPngGeometry(await readFileHeader(file.path, 29));
        return metadata
          ? { ...file, pixelHeight: metadata.height, pixelWidth: metadata.width }
          : file;
      },
      LOGICAL_FILE_INGEST_CONCURRENCY
    ),
    policyId: input.protectionPolicyId,
  });
  const bootstrapMetadata = prepared.bootstrapMetadata;
  const bootstrapMedia = await Promise.all(
    normalized.envelopeMetadata.map((media) => {
      if (!media.body || media.contentType === undefined) {
        // Product links without an image carry no payload to store.
        return Promise.resolve(
          normalizeVpmBootstrapMedia([
            {
              kind: media.kind,
              ...(media.ordinal === undefined ? {} : { ordinal: media.ordinal }),
              ...(media.label === undefined ? {} : { label: media.label }),
              ...(media.url === undefined ? {} : { url: media.url }),
            },
          ])[0] as VpmBootstrapMediaObject
        );
      }
      return storeBootstrapMediaObject({
        body: media.body,
        contentType: media.contentType,
        kind: media.kind,
        localPath: media.localPath as string,
        ...(media.ordinal === undefined ? {} : { ordinal: media.ordinal }),
        ownerId: input.version.id,
        sha256: media.sha256 as string,
        store: input.metadataStore,
        ...(media.label === undefined ? {} : { label: media.label }),
        ...(media.url === undefined ? {} : { url: media.url }),
      });
    })
  );
  // Banding rewrites protected PNGs, so it has to land before everything that
  // addresses a file by the digest of its stored bytes: the release roots, the
  // active-content inventory, and the CAS writes. Computing the roots from the
  // pre-banding files instead leaves a manifest whose recorded releaseRoot does
  // not match its own files[], which promotion recomputes and rejects, and the
  // scheduler then retries forever because nothing about it can improve.
  const classifiedFiles = await bandProtectedPngs(classified.files, signal);
  const release = createLogicalReleaseRootV4({
    files: classifiedFiles,
    packageId: input.version.packageId,
    version: input.version.version,
    versionId: input.version.id,
  });
  const active = createActiveContentInventory(classifiedFiles);
  const creatorDomain = createHash('sha256')
    .update('yucp:creator-domain:v2\0', 'utf8')
    .update(input.creatorId, 'utf8')
    .digest('hex');
  // Files are stored concurrently; mapBoundedOrdered assembles results by input index, so
  // the manifest files[] order is identical to the sequential implementation.
  const files = await mapBoundedOrdered(
    classifiedFiles,
    async (file): Promise<DeliveryManifest['files'][number]> => {
      signal?.throwIfAborted();
      const stored = await storeLogicalFile({
        bytes: file.bytes,
        domain:
          file.classification === 'protected'
            ? `protected:creator:${creatorDomain}:v2`
            : 'common:global:v2',
        path: file.path,
        // The normalizer hashed every logical file while copying it into the tree.
        precomputedSha256: true,
        sha256: file.sha256,
        store: file.classification === 'protected' ? input.protectedStore : input.commonStore,
        ownerId: input.version.id,
      });
      if (file.classification === 'common') {
        return { ...stored, classification: 'common', normalizedPath: file.normalizedPath };
      }
      if (!file.couplingPlan || !file.materializerType) {
        throw new Error(`Protected file ${file.normalizedPath} has no v5 coupling plan`);
      }
      return {
        ...stored,
        classification: 'protected',
        couplingPlan: file.couplingPlan,
        materializerType: file.materializerType,
        normalizedPath: file.normalizedPath,
      };
    },
    LOGICAL_FILE_INGEST_CONCURRENCY
  );
  const manifest = createDeliveryManifest({
    activeContentDigest: active.digest,
    activePolicyVersion: ACTIVE_CONTENT_POLICY_VERSION,
    chunkAvgKib: DESYNC_CHUNK_AVG_KIB,
    bootstrapMedia,
    commonRoot: release.commonRoot,
    files,
    normalizationPolicyVersion: prepared.normalizationPolicyVersion,
    packageId: input.version.packageId,
    protectedSourceRoot: release.protectedSourceRoot,
    protectionPolicyDigest: classified.digest,
    protectionPolicyId: classified.id,
    releaseRoot: release.releaseRoot,
    schemaVersion: 5,
    storageFormatVersion: DESYNC_STORAGE_FORMAT_VERSION,
    version: input.version.version,
    versionId: input.version.id,
    ...(bootstrapMetadata.packageMetadata
      ? { packageMetadata: bootstrapMetadata.packageMetadata }
      : {}),
    vpmDependencies: bootstrapMetadata.vpmDependencies,
    vpmRepositories: bootstrapMetadata.vpmRepositories,
  });
  signal?.throwIfAborted();
  const body = manifestBody(manifest);
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const assemblyStorage = resolveAssemblyStorage(input.metadataStore, input.version.id, bodySha256);
  const manifestSha256 = await writePipelineMetadata({
    body,
    indexId: assemblyStorage.assemblyId,
    ownerId: input.version.id,
    store: assemblyStorage.store,
  });
  return {
    assemblyId: assemblyStorage.assemblyId,
    manifest,
    manifestSha256,
    normalizationExcludedFiles: prepared.excludedFiles.length,
    normalizedFormat: normalized.format,
  };
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
  if (created.state !== 'CREATED' && created.state !== 'FAILED' && created.state !== 'DELETED') {
    throw new Error('Package version is immutable after upload completion');
  }

  try {
    return await input.catalog.transition(created.id, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
      replacesUpload: true,
    });
  } catch (error) {
    if (created.state !== 'DELETED') {
      await input.catalog.markFailed(created.id, errorMessage(error));
    }
    throw error;
  }
}

export async function assembleVersion(
  input: AssembleVersionInput,
  signal?: AbortSignal
): Promise<PackageVersion> {
  let scratchPath: string | undefined;
  let assemblyId: string | undefined;

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
    const prepared = await prepareLogicalAssembly(
      {
        ...input,
        scratchTreeRoot: join(scratchPath, 'tree'),
        version,
      },
      signal
    );
    assemblyId = prepared.assemblyId;
    const { manifest } = prepared;
    const logicalBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);

    signal?.throwIfAborted();
    return await input.catalog.transition(version.id, 'ASSEMBLED', {
      fields: {
        sourceFormat: prepared.normalizedFormat,
        releaseRoot: manifest.releaseRoot,
        assemblyObjectId: tagPipelineCasIndexId(input.metadataStore, prepared.assemblyId),
        manifestSha256: prepared.manifestSha256,
      },
      event: {
        type: 'catalog.version.assembled',
        payload: {
          activeContentDigest: manifest.activeContentDigest,
          activePolicyVersion: manifest.activePolicyVersion,
          logicalBytes,
          logicalFiles: manifest.files.length,
          normalizationExcludedFiles: prepared.normalizationExcludedFiles,
          normalizationPolicyVersion: manifest.normalizationPolicyVersion,
          protectionPolicyDigest: manifest.protectionPolicyDigest,
          protectionPolicyId: manifest.protectionPolicyId,
          protectedFiles: manifest.files.filter((file) => file.classification === 'protected')
            .length,
          bootstrapMedia: manifest.bootstrapMedia ?? [],
          ...(manifest.packageMetadata ? { packageMetadata: manifest.packageMetadata } : {}),
          vpmDependencies: manifest.vpmDependencies,
          vpmRepositories: manifest.vpmRepositories,
        },
      },
    });
  } catch (error) {
    signal?.throwIfAborted();
    let failure = error;
    if (assemblyId) {
      try {
        await cleanupPipelineMetadata({
          indexId: assemblyId,
          store: input.metadataStore,
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

function legacyArtifactFilename(version: PackageVersion): string {
  switch (version.sourceFormat) {
    case 'CANONICAL_TARGZ_V1':
      return 'legacy-source.unitypackage';
    case 'CANONICAL_ZIP_V1':
      return 'legacy-source.zip';
    case 'RAW_OPAQUE_V1':
      return `${version.packageId}.spp`;
    default:
      throw new Error(`Legacy package version ${version.id} has an unsupported source format`);
  }
}

function resolveLegacyArtifactIndexId(store: CasStore, assemblyObjectId: string): string {
  if (assemblyObjectId.startsWith('local:') || assemblyObjectId.startsWith('s3:')) {
    return resolvePipelineCasIndexId(store, assemblyObjectId);
  }
  if (!assemblyObjectId.trim()) {
    throw new Error('Legacy CAS object ID must not be empty');
  }
  return assemblyObjectId;
}

export async function migrateLegacyReadyVersion(
  input: MigrateLegacyReadyVersionInput
): Promise<PackageVersion> {
  const version = await input.catalog.getVersion(input.versionId);
  if (!version) {
    throw new PackageVersionNotFoundError(input.versionId);
  }
  if (version.state !== 'READY' || version.releaseSchemaVersion !== 3) {
    throw new Error(`Package version ${version.id} is not a legacy READY release`);
  }
  if (!version.assemblyObjectId || !version.releaseRoot || !version.sourceFormat) {
    throw new Error(`Legacy package version ${version.id} has incomplete source metadata`);
  }

  const scratchPath = await createPipelineScratchDirectory({
    prefix: 'migrate-legacy-ready-',
    root: input.scratchRoot,
  });
  const manifestId = resolveDeliveryManifestId(input.metadataStore, version.id);
  let manifestWritten = false;
  let migrationCommitted = false;
  try {
    const sourcePath = join(scratchPath, legacyArtifactFilename(version));
    await reconstructArtifactFromStore({
      indexId: resolveLegacyArtifactIndexId(input.commonStore, version.assemblyObjectId),
      outputPath: sourcePath,
      store: input.commonStore,
    });
    if ((await sha256File(sourcePath)) !== version.releaseRoot) {
      throw new Error(`Legacy source digest changed for package version ${version.id}`);
    }

    const prepared = await prepareLogicalAssembly({
      ...input,
      inputPath: sourcePath,
      scratchTreeRoot: join(scratchPath, 'tree'),
      version,
    });
    const body = manifestBody(prepared.manifest);
    const publication = createLogicalReleasePublicationV4({
      files: prepared.manifest.files,
      manifest: new TextEncoder().encode(body),
      packageId: prepared.manifest.packageId,
      version: prepared.manifest.version,
      versionId: prepared.manifest.versionId,
    });
    await reconstructManifestTree({
      commonStore: input.commonStore,
      manifest: prepared.manifest,
      outputRoot: join(scratchPath, 'verified-tree'),
      protectedStore: input.protectedStore,
    });
    const manifestSha256 = await writeReplaceablePipelineMetadata({
      body,
      indexId: manifestId,
      ownerId: version.id,
      store: input.metadataStore,
    });
    manifestWritten = true;
    if (
      manifestSha256 !== prepared.manifestSha256 ||
      manifestSha256 !== publication.manifestSha256
    ) {
      throw new Error(`Published manifest digest changed for package version ${version.id}`);
    }

    const logicalBytes = prepared.manifest.files.reduce((total, file) => total + file.bytes, 0);
    const protectedFiles = protectedMaterializationFiles(prepared.manifest);
    const migrated = await input.catalog.completeLegacyReadyMigration(version.id, {
      fields: {
        activeContentDigest: prepared.manifest.activeContentDigest,
        activePolicyVersion: prepared.manifest.activePolicyVersion,
        assemblyObjectId: tagPipelineCasIndexId(input.metadataStore, prepared.assemblyId),
        bindingRoot: publication.bindingRoot,
        commonRoot: prepared.manifest.commonRoot,
        logicalBytes,
        logicalFiles: prepared.manifest.files.length,
        manifestSha256: publication.manifestSha256,
        protectedFiles,
        protectedSourceRoot: prepared.manifest.protectedSourceRoot,
        protectionPolicyDigest: prepared.manifest.protectionPolicyDigest,
        protectionPolicyId: prepared.manifest.protectionPolicyId,
        releaseRoot: publication.releaseRoot,
        sourceFormat: prepared.normalizedFormat,
        vpmDependencies: prepared.manifest.vpmDependencies,
        vpmRepositories: prepared.manifest.vpmRepositories,
      },
      event: {
        type: 'catalog.version.ready',
        payload: {
          activeContentDigest: prepared.manifest.activeContentDigest,
          activePolicyVersion: prepared.manifest.activePolicyVersion,
          bindingRoot: publication.bindingRoot,
          commonRoot: prepared.manifest.commonRoot,
          logicalBytes,
          logicalFiles: prepared.manifest.files.length,
          manifestSha256: publication.manifestSha256,
          protectedFiles,
          bootstrapMedia: prepared.manifest.bootstrapMedia ?? [],
          ...(prepared.manifest.packageMetadata
            ? { packageMetadata: prepared.manifest.packageMetadata }
            : {}),
          protectedSourceRoot: prepared.manifest.protectedSourceRoot,
          protectionPolicyDigest: prepared.manifest.protectionPolicyDigest,
          protectionPolicyId: prepared.manifest.protectionPolicyId,
          releaseRoot: publication.releaseRoot,
          verification: 'write-time-durable-verification',
          vpmDependencies: prepared.manifest.vpmDependencies,
          vpmRepositories: prepared.manifest.vpmRepositories,
        },
      },
    });
    migrationCommitted = true;
    try {
      await cleanupPipelineMetadata({
        indexId: prepared.assemblyId,
        store: input.metadataStore,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'ingest_pipeline.legacy_assembly_cleanup_failed',
          reason: error instanceof Error ? error.name : 'unknown_error',
          versionId: version.id,
        })
      );
    }
    return migrated;
  } catch (error) {
    if (manifestWritten && !migrationCommitted) {
      await cleanupPipelineMetadata({
        indexId: manifestId,
        store: input.metadataStore,
      });
    }
    throw error;
  } finally {
    await rm(scratchPath, { force: true, recursive: true });
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
  let manifestId: string | undefined;
  let assemblyId: string | undefined;

  try {
    signal.throwIfAborted();
    if (!promoting.assemblyObjectId || !promoting.releaseRoot) {
      throw new Error(`Package version ${promoting.id} has incomplete logical assembly metadata`);
    }
    assemblyId = resolvePipelineCasIndexId(input.metadataStore, promoting.assemblyObjectId);
    manifestId = resolveDeliveryManifestId(input.metadataStore, promoting.id);
    const assemblyBody = await readPipelineMetadata({
      indexId: assemblyId,
      logicalDigest: promoting.manifestSha256,
      ownerId: promoting.id,
      store: input.metadataStore,
    });
    const manifest = parseDeliveryManifest(JSON.parse(assemblyBody));
    assertManifestIdentity(manifest, promoting);

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
    const publishedManifestSha256 = await writeReplaceablePipelineMetadata({
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
          verification: 'write-time-durable-verification',
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
  }
}

export async function promoteVersion(
  input: PromoteVersionInput,
  shutdownSignal?: AbortSignal
): Promise<PackageVersion> {
  shutdownSignal?.throwIfAborted();
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
    operation: (signal) =>
      finishPromotion(
        input,
        promoting,
        shutdownSignal ? AbortSignal.any([signal, shutdownSignal]) : signal
      ),
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
      ? resolveDeliveryManifestId(input.metadataStore, version.id)
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
