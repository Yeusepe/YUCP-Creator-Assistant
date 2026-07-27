import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import {
  Catalog,
  type CatalogDatabase,
  type ConvexCatalogPublishConfig,
  createConvexCatalogPublish,
  DEFAULT_RECONCILE_BATCH_LIMIT,
  ExactStorageCatalog,
  loadConvexCatalogPublishConfig,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../catalog';
import { promoteVersion } from '../ingest-pipeline';
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
import { createIngestScheduler, type IngestScheduler } from './scheduler';

const DEFAULT_SCHEDULER_INTERVAL_MS = 5_000;
const DEFAULT_SCHEDULER_STUCK_THRESHOLD_MS = 5 * 60 * 1_000;

export const SCHEDULER_INFISICAL_KEYS = [
  'CONVEX_API_SECRET',
  'CONVEX_URL',
  'INTERNAL_SERVICE_AUTH_SECRET',
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
] as const;

export interface SchedulerRuntimeEnv {
  common: CasConfig;
  metadata: CasConfig;
  protected: CasConfig;
  catalogDatabaseUrl: string;
  publish: ConvexCatalogPublishConfig;
  scratchRoot: string;
}

export interface SchedulerRuntime {
  database: CatalogDatabase;
  scheduler: IngestScheduler;
}

function requiredValue(
  env: NodeJS.ProcessEnv,
  key: 'CATALOG_DATABASE_URL' | 'INGEST_SCRATCH_DIR'
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
  if (!isLocalStorageProfile(env)) {
    requireInfisicalBootstrap(env);
  }
  const runtimeEnv = await hydrateStorageServiceEnv(env, SCHEDULER_INFISICAL_KEYS, fetchSecrets);

  return {
    common: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.common),
    metadata: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.metadata),
    protected: loadStorageRoleConfig(runtimeEnv, STORAGE_ROLE_PREFIXES.protected),
    catalogDatabaseUrl: requiredValue(runtimeEnv, 'CATALOG_DATABASE_URL'),
    publish: loadConvexCatalogPublishConfig(runtimeEnv),
    scratchRoot: requiredValue(runtimeEnv, 'INGEST_SCRATCH_DIR'),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown_error';
}

export async function buildSchedulerRuntime(
  env: NodeJS.ProcessEnv = process.env,
  fetchSecrets: FetchInfisicalSecrets = fetchInfisicalSecrets
): Promise<SchedulerRuntime> {
  const runtimeEnv = await loadSchedulerRuntimeEnv(env, fetchSecrets);
  const database = openCatalogDatabase(runtimeEnv.catalogDatabaseUrl);
  try {
    await runCatalogMigrations(database);
    const catalog = new Catalog(database);
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
    const scheduler = createIngestScheduler({
      batchLimit: positiveInteger(env, 'SCHEDULER_BATCH_LIMIT', DEFAULT_RECONCILE_BATCH_LIMIT),
      catalog,
      commonStore,
      database,
      metadataStore,
      intervalMs: positiveInteger(env, 'SCHEDULER_INTERVAL_MS', DEFAULT_SCHEDULER_INTERVAL_MS),
      onError(error) {
        console.error(
          JSON.stringify({ event: 'ingest_scheduler.tick_failed', reason: errorName(error) })
        );
      },
      publish: createConvexCatalogPublish(runtimeEnv.publish),
      redrive: async ({ version }) => {
        const { releaseRoot, assemblyObjectId, sourceFormat } = version;
        if (!assemblyObjectId || !releaseRoot) {
          throw new Error(`Automatic redrive requires re-uploading catalog version ${version.id}`);
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
        await promoteVersion({
          catalog,
          commonStore,
          metadataStore,
          protectedStore,
          scratchRoot: runtimeEnv.scratchRoot,
          versionId: version.id,
        });
      },
      protectedStore,
      scratchRoot: runtimeEnv.scratchRoot,
      stuckThresholdMs: positiveInteger(
        env,
        'SCHEDULER_STUCK_THRESHOLD_MS',
        DEFAULT_SCHEDULER_STUCK_THRESHOLD_MS
      ),
    });

    return { database, scheduler };
  } catch (error) {
    await database.end({ timeout: 0 });
    throw error;
  }
}

async function main(): Promise<void> {
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
        JSON.stringify({ event: 'ingest_scheduler.stop_failed', reason: errorName(error) })
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
      JSON.stringify({ event: 'ingest_scheduler.start_failed', reason: errorName(error) })
    );
    process.exitCode = 1;
  });
}
