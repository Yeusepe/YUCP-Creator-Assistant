import { SpanKind, trace } from '@opentelemetry/api';
import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { setActiveSpanAttributes, withObservedSpan } from '@yucp/shared/observability';
import { initBunServerObservability } from '@yucp/shared/serverObservability';
import { createStatusHeartbeatReporter } from '@yucp/shared/statusHeartbeat';
import {
  Catalog,
  type CatalogDatabase,
  DEFAULT_MAX_ATTEMPTS,
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
import {
  createExactVersionDeletionPort,
  type ExactVersionDeletionPort,
} from '../storage-core/exactVersionDeletion';
import {
  type ExactVersionGarbageCollectionResult,
  runExactVersionGarbageCollection,
} from './exactVersionGc';
import { runQuarantineGarbageCollection } from './quarantineGc';

const DEFAULT_DELETION_LIMIT = 100;
const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_INTERVAL_MS = 60_000;
const MAX_DELETION_LIMIT = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MIN_INTERVAL_MS = 1_000;
const tracer = trace.getTracer('yucp-storage-gc');

export const STORAGE_GC_INFISICAL_KEYS = [
  'CATALOG_FAILED_RETENTION_MS',
  'CATALOG_MAX_ATTEMPTS',
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
  'STORAGE_GC_STATUS_HEARTBEAT_URL',
] as const;

export interface StorageGcRuntimeEnv {
  catalogMaxAttempts: number;
  catalogDatabaseUrl: string;
  common: CasConfig;
  deletionLimit: number;
  failedRetentionMs: number;
  intervalMs: number;
  metadata: CasConfig;
  protected: CasConfig;
  quarantine: CasConfig;
  statusHeartbeatUrl?: string;
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

function requiredValue(
  env: NodeJS.ProcessEnv,
  key: 'CATALOG_DATABASE_URL' | 'STORAGE_GC_STATUS_HEARTBEAT_URL'
): string {
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
  readonly #deletionStorage: ExactVersionDeletionPort;
  readonly #deletionLimit: number;
  readonly #failedRetentionMs: number;
  readonly #intervalMs: number;
  readonly #lifecycleCatalog: Pick<Catalog, 'expireTerminalFailedVersions'>;
  readonly #logger: StorageGcLogger;
  readonly #onCycleSucceeded: (() => Promise<void> | void) | undefined;
  readonly #quarantine: { config: CasConfig; database: CatalogDatabase } | undefined;
  #controller: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(input: {
    catalog: StorageGcCatalog;
    deletionStorage: ExactVersionDeletionPort;
    deletionLimit: number;
    failedRetentionMs: number;
    intervalMs: number;
    lifecycleCatalog: Pick<Catalog, 'expireTerminalFailedVersions'>;
    logger: StorageGcLogger;
    onCycleSucceeded?: () => Promise<void> | void;
    quarantine?: { config: CasConfig; database: CatalogDatabase };
  }) {
    this.#catalog = input.catalog;
    this.#deletionStorage = input.deletionStorage;
    this.#deletionLimit = input.deletionLimit;
    this.#failedRetentionMs = input.failedRetentionMs;
    this.#intervalMs = input.intervalMs;
    this.#lifecycleCatalog = input.lifecycleCatalog;
    this.#logger = input.logger;
    this.#onCycleSucceeded = input.onCycleSucceeded;
    this.#quarantine = input.quarantine;
  }

  async runOnce(now?: Date): Promise<ExactVersionGarbageCollectionResult> {
    return withObservedSpan(
      tracer,
      'storage_gc.collect',
      {
        'storage.gc.batch.limit': this.#deletionLimit,
      },
      async () => {
        const expiredFailures = await this.#lifecycleCatalog.expireTerminalFailedVersions({
          limit: this.#deletionLimit,
          now,
          retentionMs: this.#failedRetentionMs,
        });
        if (expiredFailures.length > 0) {
          this.#logger.info(
            JSON.stringify({
              event: 'storage_gc.terminal_failures_expired',
              expiredVersions: expiredFailures.length,
              retentionMs: this.#failedRetentionMs,
            })
          );
        }
        const result = await runExactVersionGarbageCollection({
          catalog: this.#catalog,
          deletionStorage: this.#deletionStorage,
          deletionLimit: this.#deletionLimit,
          now,
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
          'storage.gc.expired.failed_versions': expiredFailures.length,
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
        try {
          await this.#onCycleSucceeded?.();
        } catch (error) {
          this.#logger.error(
            JSON.stringify({
              event: 'storage_gc.health_signal_failed',
              reason: errorName(error),
            })
          );
        }
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
  const localProfile = isLocalStorageProfile(env);
  if (!localProfile) {
    requireInfisicalBootstrap(env);
  }
  const requiredKeys = localProfile
    ? STORAGE_GC_INFISICAL_KEYS.filter((key) => key !== 'STORAGE_GC_STATUS_HEARTBEAT_URL')
    : STORAGE_GC_INFISICAL_KEYS;
  const runtimeEnv = await hydrateStorageServiceEnv(env, requiredKeys, fetchSecrets);
  return {
    catalogMaxAttempts: positiveInteger(runtimeEnv, 'CATALOG_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
    catalogDatabaseUrl: requiredValue(runtimeEnv, 'CATALOG_DATABASE_URL'),
    common: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.common),
    deletionLimit: positiveInteger(
      runtimeEnv,
      'STORAGE_GC_DELETION_LIMIT',
      DEFAULT_DELETION_LIMIT,
      MAX_DELETION_LIMIT
    ),
    failedRetentionMs: positiveInteger(
      runtimeEnv,
      'CATALOG_FAILED_RETENTION_MS',
      DEFAULT_FAILED_RETENTION_MS
    ),
    intervalMs: boundedInterval(runtimeEnv, 'STORAGE_GC_INTERVAL_MS', DEFAULT_INTERVAL_MS),
    metadata: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.metadata),
    protected: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.protected),
    quarantine: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.quarantine),
    ...(localProfile
      ? {}
      : {
          statusHeartbeatUrl: requiredValue(runtimeEnv, 'STORAGE_GC_STATUS_HEARTBEAT_URL'),
        }),
  };
}

export function createStorageGcJanitor(input: {
  catalog: StorageGcCatalog;
  deletionStorage: ExactVersionDeletionPort;
  deletionLimit: number;
  failedRetentionMs: number;
  intervalMs: number;
  lifecycleCatalog: Pick<Catalog, 'expireTerminalFailedVersions'>;
  logger?: StorageGcLogger;
  onCycleSucceeded?: () => Promise<void> | void;
  quarantine?: { config: CasConfig; database: CatalogDatabase };
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
  const statusHeartbeat = createStatusHeartbeatReporter({
    serviceName: 'yucp-storage-gc',
    url: runtimeEnv.statusHeartbeatUrl,
  });
  const database = openCatalogDatabase(runtimeEnv.catalogDatabaseUrl);
  try {
    await runCatalogMigrations(database);
    return {
      database,
      janitor: createStorageGcJanitor({
        catalog: new StorageGcCatalog(database),
        deletionStorage: createExactVersionDeletionPort({
          common: runtimeEnv.common,
          metadata: runtimeEnv.metadata,
          protected: runtimeEnv.protected,
        }),
        deletionLimit: runtimeEnv.deletionLimit,
        failedRetentionMs: runtimeEnv.failedRetentionMs,
        intervalMs: runtimeEnv.intervalMs,
        lifecycleCatalog: new Catalog(database, {
          maxAttempts: runtimeEnv.catalogMaxAttempts,
        }),
        ...(statusHeartbeat
          ? {
              onCycleSucceeded: async () => {
                await statusHeartbeat.signal();
              },
            }
          : {}),
        quarantine: { config: runtimeEnv.quarantine, database },
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
