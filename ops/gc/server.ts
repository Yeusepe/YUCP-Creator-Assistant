import { SpanKind, trace } from '@opentelemetry/api';
import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { setActiveSpanAttributes, withObservedSpan } from '@yucp/shared/observability';
import { initBunServerObservability } from '@yucp/shared/serverObservability';
import {
  type CatalogDatabase,
  openCatalogDatabase,
  runCatalogMigrations,
  StorageGcCatalog,
} from '../catalog';
import {
  type CasConfig,
  type FetchInfisicalSecrets,
  hydrateStorageServiceEnv,
  isLocalStorageProfile,
  loadStorageRoleConfig,
  requireInfisicalBootstrap,
  STORAGE_ROLE_PREFIXES,
} from '../storage-core/config';
import { type ExactStoragePort, S3ExactStoragePort } from '../storage-core/exactStorage';
import {
  type ExactVersionGarbageCollectionResult,
  runExactVersionGarbageCollection,
} from './exactVersionGc';
import { runQuarantineGarbageCollection } from './quarantineGc';

const DEFAULT_DELETION_LIMIT = 100;
const DEFAULT_INTERVAL_MS = 60_000;
const MAX_DELETION_LIMIT = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MIN_INTERVAL_MS = 1_000;
const tracer = trace.getTracer('yucp-storage-gc');

export const STORAGE_GC_INFISICAL_KEYS = [
  'CATALOG_DATABASE_URL',
  'COMMON_S3_ENDPOINT',
  'COMMON_S3_REGION',
  'COMMON_S3_BUCKET',
  'COMMON_S3_ACCESS_KEY_ID',
  'COMMON_S3_SECRET_ACCESS_KEY',
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_BUCKET',
  'METADATA_S3_ACCESS_KEY_ID',
  'METADATA_S3_SECRET_ACCESS_KEY',
  'PROTECTED_S3_ENDPOINT',
  'PROTECTED_S3_REGION',
  'PROTECTED_S3_BUCKET',
  'PROTECTED_S3_ACCESS_KEY_ID',
  'PROTECTED_S3_SECRET_ACCESS_KEY',
  'QUARANTINE_S3_ENDPOINT',
  'QUARANTINE_S3_REGION',
  'QUARANTINE_S3_BUCKET',
  'QUARANTINE_S3_ACCESS_KEY_ID',
  'QUARANTINE_S3_SECRET_ACCESS_KEY',
] as const;

export interface StorageGcRuntimeEnv {
  catalogDatabaseUrl: string;
  common: CasConfig;
  deletionLimit: number;
  intervalMs: number;
  metadata: CasConfig;
  protected: CasConfig;
  quarantine: CasConfig;
}

export interface StorageGcJanitor {
  runOnce(now?: Date): Promise<ExactVersionGarbageCollectionResult>;
  start(): void;
  stop(): Promise<void>;
}

export interface StorageGcRuntime {
  database: CatalogDatabase;
  janitor: StorageGcJanitor;
}

type StorageGcLogger = Pick<Console, 'error' | 'info'>;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown_error';
}

function requiredValue(env: NodeJS.ProcessEnv, key: 'CATALOG_DATABASE_URL'): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required storage GC environment variable: ${key}`);
  }
  return value;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  maximum?: number
): number {
  const value = Number(env[key]?.trim() || fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    throw new Error(
      `${key} must be a positive safe integer${maximum ? ` at most ${maximum}` : ''}`
    );
  }
  return value;
}

function boundedInterval(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key]?.trim() || fallback);
  if (!Number.isSafeInteger(value) || value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS) {
    throw new Error(
      `${key} must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} milliseconds`
    );
  }
  return value;
}

function waitForNextCycle(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

class FixedCapacityStorageGcJanitor implements StorageGcJanitor {
  readonly #catalog: StorageGcCatalog;
  readonly #deletionLimit: number;
  readonly #intervalMs: number;
  readonly #logger: StorageGcLogger;
  readonly #storage: ExactStoragePort;
  readonly #quarantine: { config: CasConfig; database: CatalogDatabase } | undefined;
  #controller: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(input: {
    catalog: StorageGcCatalog;
    deletionLimit: number;
    intervalMs: number;
    logger: StorageGcLogger;
    quarantine?: { config: CasConfig; database: CatalogDatabase };
    storage: ExactStoragePort;
  }) {
    this.#catalog = input.catalog;
    this.#deletionLimit = input.deletionLimit;
    this.#intervalMs = input.intervalMs;
    this.#logger = input.logger;
    this.#quarantine = input.quarantine;
    this.#storage = input.storage;
  }

  async runOnce(now?: Date): Promise<ExactVersionGarbageCollectionResult> {
    return withObservedSpan(
      tracer,
      'storage_gc.collect',
      {
        'storage.gc.batch.limit': this.#deletionLimit,
      },
      async () => {
        const result = await runExactVersionGarbageCollection({
          catalog: this.#catalog,
          deletionLimit: this.#deletionLimit,
          now,
          storage: this.#storage,
        });
        if (this.#quarantine) {
          const quarantine = await runQuarantineGarbageCollection({
            config: this.#quarantine.config,
            deletionLimit: this.#deletionLimit,
            sql: this.#quarantine.database,
          });
          if (
            quarantine.releasedRows > 0 ||
            quarantine.deletedOrphans > 0 ||
            quarantine.failedObjects > 0
          ) {
            this.#logger.info(
              JSON.stringify({
                event: 'storage_gc.quarantine_swept',
                ...quarantine,
              })
            );
          }
        }
        setActiveSpanAttributes({
          'storage.gc.candidates.observed': result.candidatesObserved,
          'storage.gc.deleted.bytes': result.deletedBytes,
          'storage.gc.deleted.objects': result.deletedObjects,
          'storage.gc.failed.objects': result.failedObjects,
          'storage.gc.generation.id': result.generationId,
          'storage.gc.recovered.deletions': result.recoveredDeletions,
          'storage.gc.retention_blocked.bytes': result.retentionBlockedBytes,
          'storage.gc.retention_blocked.objects': result.retentionBlockedObjects,
        });
        return result;
      },
      SpanKind.CONSUMER
    );
  }

  start(): void {
    if (this.#loop) {
      return;
    }
    const controller = new AbortController();
    this.#controller = controller;
    this.#loop = this.#run(controller.signal);
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#loop;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const startedAt = performance.now();
      try {
        const result = await this.runOnce();
        this.#logger.info(
          JSON.stringify({
            candidatesObserved: result.candidatesObserved,
            deletedBytes: result.deletedBytes,
            deletedObjects: result.deletedObjects,
            elapsedMs: Math.round(performance.now() - startedAt),
            event: 'storage_gc.batch_completed',
            failedObjects: result.failedObjects,
            generationId: result.generationId,
            recoveredDeletions: result.recoveredDeletions,
            retentionBlockedBytes: result.retentionBlockedBytes,
            retentionBlockedObjects: result.retentionBlockedObjects,
            saturated:
              result.deletedObjects + result.failedObjects + result.retentionBlockedObjects >=
              this.#deletionLimit,
          })
        );
      } catch (error) {
        this.#logger.error(
          JSON.stringify({
            elapsedMs: Math.round(performance.now() - startedAt),
            event: 'storage_gc.batch_failed',
            reason: errorName(error),
          })
        );
      }
      await waitForNextCycle(this.#intervalMs, signal);
    }
  }
}

export async function loadStorageGcRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchSecrets: FetchInfisicalSecrets = fetchInfisicalSecrets
): Promise<StorageGcRuntimeEnv> {
  if (!isLocalStorageProfile(env)) {
    requireInfisicalBootstrap(env);
  }
  const runtimeEnv = await hydrateStorageServiceEnv(env, STORAGE_GC_INFISICAL_KEYS, fetchSecrets);
  return {
    catalogDatabaseUrl: requiredValue(runtimeEnv, 'CATALOG_DATABASE_URL'),
    common: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.common),
    deletionLimit: positiveInteger(
      runtimeEnv,
      'STORAGE_GC_DELETION_LIMIT',
      DEFAULT_DELETION_LIMIT,
      MAX_DELETION_LIMIT
    ),
    intervalMs: boundedInterval(runtimeEnv, 'STORAGE_GC_INTERVAL_MS', DEFAULT_INTERVAL_MS),
    metadata: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.metadata),
    protected: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.protected),
    quarantine: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.quarantine),
  };
}

export function createStorageGcJanitor(input: {
  catalog: StorageGcCatalog;
  deletionLimit: number;
  intervalMs: number;
  logger?: StorageGcLogger;
  quarantine?: { config: CasConfig; database: CatalogDatabase };
  storage: ExactStoragePort;
}): StorageGcJanitor {
  return new FixedCapacityStorageGcJanitor({
    ...input,
    logger: input.logger ?? console,
  });
}

export async function buildStorageGcRuntime(
  env: NodeJS.ProcessEnv = process.env,
  fetchSecrets: FetchInfisicalSecrets = fetchInfisicalSecrets
): Promise<StorageGcRuntime> {
  const runtimeEnv = await loadStorageGcRuntimeEnv(env, fetchSecrets);
  const database = openCatalogDatabase(runtimeEnv.catalogDatabaseUrl);
  try {
    await runCatalogMigrations(database);
    return {
      database,
      janitor: createStorageGcJanitor({
        catalog: new StorageGcCatalog(database),
        deletionLimit: runtimeEnv.deletionLimit,
        intervalMs: runtimeEnv.intervalMs,
        quarantine: { config: runtimeEnv.quarantine, database },
        storage: new S3ExactStoragePort({
          common: runtimeEnv.common,
          metadata: runtimeEnv.metadata,
          protected: runtimeEnv.protected,
        }),
      }),
    };
  } catch (error) {
    await database.end({ timeout: 0 });
    throw error;
  }
}

async function main(): Promise<void> {
  initBunServerObservability({
    env: process.env,
    serviceName: 'yucp-storage-gc',
    resourceAttributes: {
      'service.instance.capacity': 1,
      'service.instance.mode': 'fixed',
    },
  });
  const runtime = await buildStorageGcRuntime();
  runtime.janitor.start();
  console.info(JSON.stringify({ event: 'storage_gc.started', workerCount: 1 }));

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await runtime.janitor.stop();
    await runtime.database.end({ timeout: 5 });
  };

  const stopOnSignal = (): void => {
    stop().catch((error) => {
      console.error(JSON.stringify({ event: 'storage_gc.stop_failed', reason: errorName(error) }));
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'storage_gc.start_failed', reason: errorName(error) }));
    process.exitCode = 1;
  });
}
