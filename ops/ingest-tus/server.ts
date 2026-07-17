import { createServer, type RequestListener, type Server } from 'node:http';
import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { Catalog, type CatalogDatabase, openCatalogDatabase } from '../catalog';
import {
  type FetchInfisicalSecrets,
  INGEST_INFISICAL_KEYS,
  loadIngestRuntimeEnv,
  requireInfisicalBootstrap,
} from '../storage-core/config';
import { s3CasStore } from '../storage-core/desyncCas';
import { createIngestTusServer } from './ingestTusServer';

const DEFAULT_INGEST_TUS_PORT = 3002;

export const INGEST_TUS_INFISICAL_KEYS = INGEST_INFISICAL_KEYS;

export interface IngestTusRuntime {
  database: CatalogDatabase;
  handler: RequestListener;
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
  requireInfisicalBootstrap(env);
  const runtimeEnv = await loadIngestRuntimeEnv(env, fetchSecrets);
  const database = openCatalogDatabase(runtimeEnv.catalogDatabaseUrl);
  try {
    const catalog = new Catalog(database);
    const store = s3CasStore(runtimeEnv.cas);

    return {
      database,
      handler: createIngestTusServer({
        allowedOrigin: env.INGEST_ALLOWED_ORIGIN,
        catalog,
        maxBytes: runtimeEnv.ingestMaxBytes,
        store,
        uploadDir: runtimeEnv.ingestUploadDir,
        uploadHmacKey: runtimeEnv.uploadHmacKey,
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
  return error instanceof Error ? error.name : 'unknown_error';
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
    await runtime.database.end({ timeout: 5 });
  };

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'ingest_tus.start_failed', reason: errorName(error) }));
    process.exitCode = 1;
  });
}
