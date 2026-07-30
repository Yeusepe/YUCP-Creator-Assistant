import { createServer, type Server } from 'node:http';
import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import {
  Catalog,
  type CatalogDatabase,
  ExactStorageCatalog,
  openCatalogDatabase,
  runCatalogMigrations,
  StorageGcCatalog,
} from '../catalog';
import {
  type FetchInfisicalSecrets,
  INGEST_INFISICAL_KEYS,
  isLocalStorageProfile,
  loadIngestRuntimeEnv,
  requireInfisicalBootstrap,
} from '../storage-core/config';
import { s3CasStore } from '../storage-core/desyncCas';
import { DurableExactStorage } from '../storage-core/durableExactStorage';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import { createIngestTusServer, type IngestTusRequestListener } from './ingestTusServer';
import { createS3QuarantineStorage } from './quarantine';

const DEFAULT_INGEST_TUS_PORT = 3002;

export const INGEST_TUS_INFISICAL_KEYS = INGEST_INFISICAL_KEYS;

export interface IngestTusRuntime {
  database: CatalogDatabase;
  handler: IngestTusRequestListener;
}

export interface RunningIngestTusServer extends IngestTusRuntime {
  port: number;
  server: Server;
}

function loadPort(env: NodeJS.ProcessEnv): number {
  const port = Number(env.PORT?.trim() || DEFAULT_INGEST_TUS_PORT);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }
  return port;
}

export async function buildIngestTusRuntime(
  env: NodeJS.ProcessEnv = process.env,
  fetchSecrets: FetchInfisicalSecrets = fetchInfisicalSecrets
): Promise<IngestTusRuntime> {
  if (!isLocalStorageProfile(env)) {
    requireInfisicalBootstrap(env);
  }
  const runtimeEnv = await loadIngestRuntimeEnv(env, fetchSecrets);
  const database = openCatalogDatabase(runtimeEnv.catalogDatabaseUrl);
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
    return {
      database,
      handler: createIngestTusServer({
        allowedOrigin: runtimeEnv.ingestAllowedOrigin,
        catalog,
        catalogMaxAttempts: runtimeEnv.catalogMaxAttempts,
        releasePins: new StorageGcCatalog(database),
        commonStore: s3CasStore(runtimeEnv.common, {
          durableStorage,
          storageRole: 'common',
        }),
        maxBytes: runtimeEnv.ingestMaxBytes,
        metadataStore: s3CasStore(runtimeEnv.metadata, {
          durableStorage,
          storageRole: 'metadata',
        }),
        protectedStore: s3CasStore(runtimeEnv.protected, {
          durableStorage,
          storageRole: 'protected',
        }),
        quarantineStorage: createS3QuarantineStorage(runtimeEnv.quarantine),
        scratchRoot: runtimeEnv.ingestScratchDir,
        uploadDir: runtimeEnv.ingestUploadDir,
        uploadHmacKey: runtimeEnv.uploadHmacKey,
        catalogControlSharedSecret: runtimeEnv.catalogControlSharedSecret,
      }),
    };
  } catch (error) {
    await database.end({ timeout: 0 });
    throw error;
  }
}

export async function startIngestTusServer(
  env: NodeJS.ProcessEnv = process.env
): Promise<RunningIngestTusServer> {
  const runtime = await buildIngestTusRuntime(env);
  const port = loadPort(env);
  const server = createServer(runtime.handler);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, resolve);
    });
  } catch (error) {
    await runtime.database.end({ timeout: 0 });
    throw error;
  }

  return { ...runtime, port, server };
}

function errorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown_error';
  }
  // Include the message so startup failures are diagnosable from logs alone,
  // but strip credentials that connection errors embed in URLs.
  const message = error.message.replace(/\/\/[^@\s/]+@/g, '//***@');
  return `${error.name}: ${message}`;
}

async function main(): Promise<void> {
  const runtime = await startIngestTusServer();
  console.info(JSON.stringify({ event: 'ingest_tus.listening', port: runtime.port }));

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await new Promise<void>((resolve, reject) => {
      runtime.server.close((error) => (error ? reject(error) : resolve()));
    });
    // Detached assemblies are still writing to the catalog and the object stores. Ending the
    // database pool under them turns an orderly deploy into CONNECTION_ENDED failures.
    await runtime.handler.drainInFlightAssemblies();
    await runtime.database.end({ timeout: 5 });
  };

  const stopOnSignal = (): void => {
    stop().catch((error) => {
      console.error(JSON.stringify({ event: 'ingest_tus.stop_failed', reason: errorName(error) }));
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'ingest_tus.start_failed', reason: errorName(error) }));
    process.exitCode = 1;
  });
}
