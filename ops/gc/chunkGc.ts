import type { CatalogDatabase } from '../catalog';
import { type CatalogState, resolveRetryPolicy } from '../catalog';
import {
  deliveryAssemblyMetadataObjectId,
  deliveryManifestObjectId,
  parseDeliveryManifest,
} from '../storage-core/deliveryManifest';
import { inspectDesyncIndex, type S3CasStore } from '../storage-core/desyncCas';
import {
  deleteS3Objects,
  getS3Object,
  listS3ObjectPage,
  type S3ObjectMetadata,
} from '../storage-core/s3Control';

export const DEFAULT_GC_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GC_BATCH_SIZE = 500;

export const GC_ALWAYS_KEPT_STATES = [
  'CREATED',
  'UPLOADING',
  'ASSEMBLED',
  'PROMOTING',
  'READY',
] as const satisfies readonly CatalogState[];

interface KeptVersionRow {
  id: string;
  state: CatalogState;
  attempts: number;
  cas_index_id: string | null;
}

interface GcKeepSet {
  chunkIds: Set<string>;
  indexKeys: Set<string>;
  versions: number;
}

export interface ChunkGarbageCollectionOptions {
  batchSize?: number;
  dryRun?: boolean;
  gracePeriodMs?: number;
  log?: (message: string) => void;
  maxAttempts?: number;
  sql: CatalogDatabase;
  store: S3CasStore;
}

export interface ChunkGarbageCollectionResult {
  candidateBytes: number;
  candidateObjects: number;
  deletedBytes: number;
  deletedObjects: number;
  dryRun: boolean;
  graceProtectedBytes: number;
  graceProtectedObjects: number;
  keepSetChunkIds: number;
  keepSetIndexObjects: number;
  keptBytes: number;
  keptObjects: number;
  keptVersions: number;
  scannedBytes: number;
  scannedObjects: number;
  unrecognizedObjects: number;
}

type SweepKind = 'chunk' | 'index';

const CHUNK_ID_PATTERN = /^[0-9a-f]{64}$/;
const MANAGED_INDEX_SUFFIXES = ['.caibx', '.delivery.json', '.delivery-meta.json'] as const;

function validateNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function validateBatchSize(batchSize: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 1000) {
    throw new RangeError('batchSize must be an integer from 1 through 1000');
  }
}

function validateDisjointPrefixes(chunkPrefix: string, indexPrefix: string): void {
  if (chunkPrefix.startsWith(indexPrefix) || indexPrefix.startsWith(chunkPrefix)) {
    throw new Error('CAS chunk and index prefixes must not overlap for garbage collection');
  }
}

function resolveS3IndexId(casIndexId: string): string | null {
  const separator = casIndexId.indexOf(':');
  const kind = casIndexId.slice(0, separator);
  const indexId = casIndexId.slice(separator + 1);
  if ((kind !== 'local' && kind !== 's3') || !indexId) {
    throw new Error('Kept catalog version has an invalid store-kind-tagged CAS index ID');
  }
  if (kind === 'local') {
    return null;
  }

  const segments = indexId.split('/');
  if (
    indexId.startsWith('/') ||
    indexId.includes('\\') ||
    indexId.includes('?') ||
    indexId.includes('#') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Kept catalog version has an unsafe S3 CAS index ID');
  }
  return indexId;
}

function addChunkIds(keepSet: Set<string>, chunks: { id: string }[]): void {
  for (const chunk of chunks) {
    if (!CHUNK_ID_PATTERN.test(chunk.id)) {
      throw new Error('Kept CAS index or manifest contains an invalid chunk ID');
    }
    keepSet.add(chunk.id);
  }
}

async function readReadyManifest(
  row: KeptVersionRow,
  store: S3CasStore
): Promise<{ id: string }[]> {
  const manifestKey = `${store.config.indexPrefix}${deliveryManifestObjectId(row.id)}`;
  const response = await getS3Object(store.config, manifestKey);
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch (error) {
    throw new Error(`Kept READY version ${row.id} has an unreadable delivery manifest`, {
      cause: error,
    });
  }
  const manifest = parseDeliveryManifest(value);
  if (manifest.versionId !== row.id) {
    throw new Error(`Kept READY version ${row.id} has a mismatched delivery manifest`);
  }
  return manifest.chunks;
}

async function buildKeepSet(
  sql: CatalogDatabase,
  store: S3CasStore,
  maxAttempts: number
): Promise<GcKeepSet> {
  let rows: KeptVersionRow[];
  try {
    rows = await sql<KeptVersionRow[]>`
      SELECT id, state, attempts, cas_index_id
      FROM package_versions
      WHERE
        state IN ${sql(GC_ALWAYS_KEPT_STATES)}
        OR (state = 'FAILED' AND attempts < ${maxAttempts})
      ORDER BY id
    `;
  } catch (error) {
    throw new Error('Chunk GC aborted because the catalog keep-set read failed', { cause: error });
  }

  const chunkIds = new Set<string>();
  const indexKeys = new Set<string>();
  const inspectedIndexes = new Map<string, { id: string }[]>();

  for (const row of rows) {
    indexKeys.add(`${store.config.indexPrefix}${deliveryManifestObjectId(row.id)}`);
    indexKeys.add(`${store.config.indexPrefix}${deliveryAssemblyMetadataObjectId(row.id)}`);
    if (!row.cas_index_id) {
      continue;
    }

    const indexId = resolveS3IndexId(row.cas_index_id);
    if (indexId === null) {
      continue;
    }
    indexKeys.add(`${store.config.indexPrefix}${indexId}`);

    let chunks = inspectedIndexes.get(indexId);
    if (!chunks) {
      try {
        chunks = await inspectDesyncIndex({ indexId, store });
      } catch (error) {
        throw new Error(
          `Chunk GC aborted because kept version ${row.id} has an unreadable CAS index`,
          { cause: error }
        );
      }
      inspectedIndexes.set(indexId, chunks);
    }
    addChunkIds(chunkIds, chunks);

    if (row.state === 'READY') {
      let manifestChunks: { id: string }[];
      try {
        manifestChunks = await readReadyManifest(row, store);
      } catch (error) {
        throw new Error(
          `Chunk GC aborted because kept READY version ${row.id} has an incomplete manifest`,
          { cause: error }
        );
      }
      addChunkIds(chunkIds, manifestChunks);
    }
  }

  return { chunkIds, indexKeys, versions: rows.length };
}

function managedObjectId(object: S3ObjectMetadata, prefix: string, kind: SweepKind): string | null {
  if (!object.key.startsWith(prefix)) {
    throw new Error(`S3 ListObjectsV2 returned an object outside the requested ${kind} prefix`);
  }
  const relativeKey = object.key.slice(prefix.length);
  if (!relativeKey) {
    return null;
  }
  if (kind === 'index') {
    return MANAGED_INDEX_SUFFIXES.some((suffix) => relativeKey.endsWith(suffix))
      ? object.key
      : null;
  }
  const chunkId = relativeKey.split('/').at(-1);
  return chunkId && CHUNK_ID_PATTERN.test(chunkId) ? chunkId : null;
}

function newResult(dryRun: boolean, keepSet: GcKeepSet): ChunkGarbageCollectionResult {
  return {
    candidateBytes: 0,
    candidateObjects: 0,
    deletedBytes: 0,
    deletedObjects: 0,
    dryRun,
    graceProtectedBytes: 0,
    graceProtectedObjects: 0,
    keepSetChunkIds: keepSet.chunkIds.size,
    keepSetIndexObjects: keepSet.indexKeys.size,
    keptBytes: 0,
    keptObjects: 0,
    keptVersions: keepSet.versions,
    scannedBytes: 0,
    scannedObjects: 0,
    unrecognizedObjects: 0,
  };
}

async function sweepPrefix(input: {
  batchSize: number;
  cutoffTimeMs: number;
  dryRun: boolean;
  keepSet: Set<string>;
  kind: SweepKind;
  prefix: string;
  result: ChunkGarbageCollectionResult;
  store: S3CasStore;
}): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const page = await listS3ObjectPage(input.store.config, {
      continuationToken,
      maxKeys: input.batchSize,
      prefix: input.prefix,
    });
    const pendingDelete: S3ObjectMetadata[] = [];

    for (const object of page.objects) {
      input.result.scannedObjects += 1;
      input.result.scannedBytes += object.size;
      const objectId = managedObjectId(object, input.prefix, input.kind);
      if (objectId === null) {
        input.result.unrecognizedObjects += 1;
        input.result.keptObjects += 1;
        input.result.keptBytes += object.size;
        continue;
      }
      if (input.keepSet.has(objectId)) {
        input.result.keptObjects += 1;
        input.result.keptBytes += object.size;
        continue;
      }
      if (object.lastModified.getTime() >= input.cutoffTimeMs) {
        input.result.graceProtectedObjects += 1;
        input.result.graceProtectedBytes += object.size;
        input.result.keptObjects += 1;
        input.result.keptBytes += object.size;
        continue;
      }

      input.result.candidateObjects += 1;
      input.result.candidateBytes += object.size;
      if (!input.dryRun) {
        pendingDelete.push(object);
      }
    }

    if (pendingDelete.length > 0) {
      await deleteS3Objects(
        input.store.config,
        pendingDelete.map(({ key }) => key)
      );
      input.result.deletedObjects += pendingDelete.length;
      input.result.deletedBytes += pendingDelete.reduce((total, object) => total + object.size, 0);
    }
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);
}

export async function runChunkGarbageCollection(
  options: ChunkGarbageCollectionOptions
): Promise<ChunkGarbageCollectionResult> {
  const batchSize = options.batchSize ?? DEFAULT_GC_BATCH_SIZE;
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GC_GRACE_PERIOD_MS;
  const dryRun = options.dryRun ?? false;
  validateBatchSize(batchSize);
  validateNonNegativeSafeInteger(gracePeriodMs, 'gracePeriodMs');
  validateDisjointPrefixes(options.store.config.chunkPrefix, options.store.config.indexPrefix);

  const maxAttempts = resolveRetryPolicy({ maxAttempts: options.maxAttempts }).maxAttempts;
  const keepSet = await buildKeepSet(options.sql, options.store, maxAttempts);
  const result = newResult(dryRun, keepSet);
  const cutoffTimeMs = Date.now() - gracePeriodMs;

  await sweepPrefix({
    batchSize,
    cutoffTimeMs,
    dryRun,
    keepSet: keepSet.chunkIds,
    kind: 'chunk',
    prefix: options.store.config.chunkPrefix,
    result,
    store: options.store,
  });
  await sweepPrefix({
    batchSize,
    cutoffTimeMs,
    dryRun,
    keepSet: keepSet.indexKeys,
    kind: 'index',
    prefix: options.store.config.indexPrefix,
    result,
    store: options.store,
  });

  const log = options.log ?? console.info;
  log(
    `GC_SUMMARY dryRun=${result.dryRun} scanned=${result.scannedObjects} scannedBytes=${result.scannedBytes} kept=${result.keptObjects} keptBytes=${result.keptBytes} candidates=${result.candidateObjects} candidateBytes=${result.candidateBytes} deleted=${result.deletedObjects} deletedBytes=${result.deletedBytes} graceProtected=${result.graceProtectedObjects}`
  );
  return result;
}
