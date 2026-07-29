import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { redactForLogging } from '@yucp/shared/logging/redaction';
import { initBunServerObservability } from '@yucp/shared/serverObservability';
import { createStatusHeartbeatReporter } from '@yucp/shared/statusHeartbeat';
import {
  Catalog,
  type CatalogDatabase,
  type ConvexCatalogPublishConfig,
  createConvexCatalogPublish,
  createConvexPackageCreatorResolver,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RECONCILE_BATCH_LIMIT,
  ExactStorageCatalog,
  loadConvexCatalogPublishConfig,
  openCatalogDatabase,
  runCatalogMigrations,
  withCatalogHeartbeat,
} from '../catalog';
import { assembleVersion, promoteVersion } from '../ingest-pipeline';
import { createS3QuarantineStorage, withRestoredCompletedUpload } from '../ingest-tus/quarantine';
import {
  type CasConfig,
  type FetchInfisicalSecrets,
  hydrateStorageServiceEnv,
  isLocalStorageProfile,
  loadStorageRoleConfig,
  requireInfisicalBootstrap,
  STORAGE_ROLE_PREFIXES,
} from '../storage-core/config';
import { s3CasStore } from '../storage-core/desyncCas';
import { DurableExactStorage } from '../storage-core/durableExactStorage';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import { isProtectionPolicyId } from '../storage-core/protectionPolicyId';
import { createIngestScheduler, type IngestScheduler } from './scheduler';

const DEFAULT_SCHEDULER_INTERVAL_MS = 5_000;
const DEFAULT_SCHEDULER_STUCK_THRESHOLD_MS = 5 * 60 * 1_000;

export const SCHEDULER_INFISICAL_KEYS = [
  'CONVEX_API_SECRET',
  'CONVEX_URL',
  'INTERNAL_SERVICE_AUTH_SECRET',
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
  'SCHEDULER_STATUS_HEARTBEAT_URL',
] as const;

export interface SchedulerRuntimeEnv {
  common: CasConfig;
  metadata: CasConfig;
  protected: CasConfig;
  quarantine: CasConfig;
  catalogMaxAttempts: number;
  catalogDatabaseUrl: string;
  publish: ConvexCatalogPublishConfig;
  scratchRoot: string;
  statusHeartbeatUrl?: string;
}

export interface SchedulerRuntime {
  database: CatalogDatabase;
  scheduler: IngestScheduler;
}

function requiredValue(
  env: NodeJS.ProcessEnv,
  key: 'CATALOG_DATABASE_URL' | 'INGEST_SCRATCH_DIR' | 'SCHEDULER_STATUS_HEARTBEAT_URL'
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required scheduler environment variable: ${key}`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key]?.trim() || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive safe integer`);
  }
  return value;
}

export async function loadSchedulerRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchSecrets: FetchInfisicalSecrets = fetchInfisicalSecrets
): Promise<SchedulerRuntimeEnv> {
  const localProfile = isLocalStorageProfile(env);
  if (!localProfile) {
    requireInfisicalBootstrap(env);
  }
  const requiredKeys = localProfile
    ? SCHEDULER_INFISICAL_KEYS.filter((key) => key !== 'SCHEDULER_STATUS_HEARTBEAT_URL')
    : SCHEDULER_INFISICAL_KEYS;
  const runtimeEnv = await hydrateStorageServiceEnv(env, requiredKeys, fetchSecrets);

  return {
    common: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.common),
    catalogMaxAttempts: positiveInteger(runtimeEnv, 'CATALOG_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
    metadata: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.metadata),
    protected: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.protected),
    quarantine: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.quarantine),
    catalogDatabaseUrl: requiredValue(runtimeEnv, 'CATALOG_DATABASE_URL'),
    publish: loadConvexCatalogPublishConfig(runtimeEnv),
    scratchRoot: requiredValue(runtimeEnv, 'INGEST_SCRATCH_DIR'),
    ...(localProfile
      ? {}
      : {
          statusHeartbeatUrl: requiredValue(runtimeEnv, 'SCHEDULER_STATUS_HEARTBEAT_URL'),
        }),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown_error';
}

export function schedulerErrorDiagnostic(error: unknown): {
  errorMessage: string;
  reason: string;
} {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const withoutUrlCredentials = rawMessage.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/giu,
    '$1[REDACTED]@'
  );
  const errorMessage = String(redactForLogging(withoutUrlCredentials))
    .replace(/\[AUTH_REDACTED\]\[TOKEN_REDACTED\]/gu, '[AUTH_REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
  return {
    errorMessage: errorMessage || 'Unknown scheduler failure',
    reason: errorName(error),
  };
}

export async function buildSchedulerRuntime(
  env: NodeJS.ProcessEnv = process.env,
  fetchSecrets: FetchInfisicalSecrets = fetchInfisicalSecrets
): Promise<SchedulerRuntime> {
  const runtimeEnv = await loadSchedulerRuntimeEnv(env, fetchSecrets);
  const statusHeartbeat = createStatusHeartbeatReporter({
    serviceName: 'yucp-ingest-scheduler',
    url: runtimeEnv.statusHeartbeatUrl,
  });
  const database = openCatalogDatabase(runtimeEnv.catalogDatabaseUrl);
  const shutdown = new AbortController();
  try {
    await runCatalogMigrations(database);
    const catalog = new Catalog(database, { maxAttempts: runtimeEnv.catalogMaxAttempts });
    const durableStorage = new DurableExactStorage(
      new ExactStorageCatalog(database),
      new S3ExactStoragePort({
        common: runtimeEnv.common,
        metadata: runtimeEnv.metadata,
        protected: runtimeEnv.protected,
      })
    );
    const commonStore = s3CasStore(runtimeEnv.common, {
      durableStorage,
      storageRole: 'common',
    });
    const metadataStore = s3CasStore(runtimeEnv.metadata, {
      durableStorage,
      storageRole: 'metadata',
    });
    const protectedStore = s3CasStore(runtimeEnv.protected, {
      durableStorage,
      storageRole: 'protected',
    });
    const quarantineStorage = createS3QuarantineStorage(runtimeEnv.quarantine);
    const scheduler = createIngestScheduler({
      batchLimit: positiveInteger(env, 'SCHEDULER_BATCH_LIMIT', DEFAULT_RECONCILE_BATCH_LIMIT),
      catalog,
      commonStore,
      database,
      metadataStore,
      intervalMs: positiveInteger(env, 'SCHEDULER_INTERVAL_MS', DEFAULT_SCHEDULER_INTERVAL_MS),
      maxAttempts: runtimeEnv.catalogMaxAttempts,
      onError(error, context) {
        console.error(
          JSON.stringify({
            event: 'ingest_scheduler.tick_failed',
            ...context,
            ...schedulerErrorDiagnostic(error),
          })
        );
      },
      ...(statusHeartbeat
        ? {
            onTickSucceeded: async () => {
              await statusHeartbeat.signal();
            },
          }
        : {}),
      publish: createConvexCatalogPublish(runtimeEnv.publish),
      redrive: async ({ version }) => {
        const { releaseRoot, assemblyObjectId, sourceFormat } = version;
        if (!assemblyObjectId || !releaseRoot) {
          const checkpoint = await catalog.getQuarantineObject(version.id);
          if (
            !checkpoint ||
            checkpoint.state !== 'COMMITTED' ||
            !checkpoint.fileIdentifier ||
            !checkpoint.providerVersion
          ) {
            throw new Error(
              `Automatic redrive found no committed quarantine checkpoint for catalog version ${version.id}`
            );
          }
          const protectionPolicyId = checkpoint.protectionPolicyId;
          if (!isProtectionPolicyId(protectionPolicyId)) {
            throw new Error(
              `Catalog version ${version.id} has an invalid checkpoint protection policy`
            );
          }
          const creatorId = checkpoint.creatorId.trim();
          if (!creatorId) {
            throw new Error(`Catalog version ${version.id} has no checkpoint creator identity`);
          }
          const current = await catalog.getVersion(version.id);
          if (!current) {
            throw new Error(`Catalog version ${version.id} was not found during automatic redrive`);
          }
          if (current.state === 'READY' || current.state === 'ASSEMBLED') {
            return;
          }
          if (current.state !== 'FAILED') {
            throw new Error(
              `Automatic quarantine redrive cannot resume catalog version ${version.id} from ${current.state}`
            );
          }
          await catalog.advanceVersion(version.id, 'UPLOADING', {
            event: { type: 'catalog.version.retrying' },
          });
          console.info(
            JSON.stringify({
              event: 'ingest_scheduler.quarantine_redrive_started',
              versionId: version.id,
            })
          );
          try {
            await withCatalogHeartbeat({
              catalog,
              state: 'UPLOADING',
              versionId: version.id,
              onHeartbeatError(error) {
                console.error(
                  JSON.stringify({
                    event: 'ingest_scheduler.quarantine_redrive_heartbeat_failed',
                    versionId: version.id,
                    ...schedulerErrorDiagnostic(error),
                  })
                );
              },
              operation: (heartbeatSignal) => {
                const signal = AbortSignal.any([heartbeatSignal, shutdown.signal]);
                return withRestoredCompletedUpload({
                  checkpoint,
                  scratchRoot: runtimeEnv.scratchRoot,
                  signal,
                  storage: quarantineStorage,
                  operation: (inputPath) =>
                    assembleVersion(
                      {
                        catalog,
                        commonStore,
                        creatorId,
                        inputPath,
                        metadataStore,
                        protectedStore,
                        protectionPolicyId,
                        scratchRoot: runtimeEnv.scratchRoot,
                        versionId: version.id,
                      },
                      signal
                    ),
                });
              },
            });
          } catch (error) {
            const failed = await catalog.getVersion(version.id);
            if (failed?.state === 'UPLOADING') {
              await catalog.markFailed(
                version.id,
                shutdown.signal.aborted
                  ? 'Interrupted by service shutdown'
                  : schedulerErrorDiagnostic(error).errorMessage,
                undefined,
                shutdown.signal.aborted ? { requeue: true } : {}
              );
            }
            throw error;
          }
          console.info(
            JSON.stringify({
              event: 'ingest_scheduler.quarantine_redrive_completed',
              versionId: version.id,
            })
          );
          return;
        }
        if (!sourceFormat) {
          throw new Error(`Catalog version ${version.id} has incomplete CAS assembly metadata`);
        }

        let current = await catalog.getVersion(version.id);
        if (!current) {
          throw new Error(`Catalog version ${version.id} was not found during automatic redrive`);
        }
        if (current.state === 'READY') {
          return;
        }
        if (current.state === 'FAILED') {
          current = await catalog.advanceVersion(version.id, 'UPLOADING', {
            event: { type: 'catalog.version.retrying' },
          });
        }
        if (current.state === 'UPLOADING') {
          current = await catalog.advanceVersion(version.id, 'ASSEMBLED', {
            fields: { releaseRoot, assemblyObjectId, sourceFormat },
            event: { type: 'catalog.version.assembled' },
          });
        }
        if (current.state !== 'ASSEMBLED') {
          throw new Error(
            `Automatic redrive cannot resume catalog version ${version.id} from ${current.state}`
          );
        }
        try {
          await promoteVersion(
            {
              catalog,
              commonStore,
              metadataStore,
              protectedStore,
              scratchRoot: runtimeEnv.scratchRoot,
              versionId: version.id,
            },
            shutdown.signal
          );
        } catch (error) {
          if (shutdown.signal.aborted) {
            const interrupted = await catalog.getVersion(version.id);
            if (interrupted && ['PROMOTING', 'UPLOADING'].includes(interrupted.state)) {
              await catalog.markFailed(version.id, 'Interrupted by service shutdown', undefined, {
                requeue: true,
              });
            }
          }
          throw error;
        }
      },
      protectedStore,
      resolveCreatorId: createConvexPackageCreatorResolver(runtimeEnv.publish),
      scratchRoot: runtimeEnv.scratchRoot,
      shutdownSignal: shutdown.signal,
      stuckThresholdMs: positiveInteger(
        env,
        'SCHEDULER_STUCK_THRESHOLD_MS',
        DEFAULT_SCHEDULER_STUCK_THRESHOLD_MS
      ),
    });

    return {
      database,
      scheduler: {
        start: () => scheduler.start(),
        // Abort in-flight promotion and redrive work first so live versions are
        // requeued (no attempt burned) before the pod is torn down.
        stop: async () => {
          shutdown.abort();
          await scheduler.stop();
        },
      },
    };
  } catch (error) {
    await database.end({ timeout: 0 });
    throw error;
  }
}

async function main(): Promise<void> {
  initBunServerObservability({
    env: process.env,
    serviceName: 'yucp-ingest-scheduler',
    resourceAttributes: {
      'service.instance.capacity': 1,
      'service.instance.mode': 'fixed',
    },
  });
  const runtime = await buildSchedulerRuntime();
  runtime.scheduler.start();
  console.info(JSON.stringify({ event: 'ingest_scheduler.started' }));

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await runtime.scheduler.stop();
    await runtime.database.end({ timeout: 5 });
  };

  const stopOnSignal = (): void => {
    stop().catch((error) => {
      console.error(
        JSON.stringify({
          event: 'ingest_scheduler.stop_failed',
          ...schedulerErrorDiagnostic(error),
        })
      );
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'ingest_scheduler.start_failed',
        ...schedulerErrorDiagnostic(error),
      })
    );
    process.exitCode = 1;
  });
}
