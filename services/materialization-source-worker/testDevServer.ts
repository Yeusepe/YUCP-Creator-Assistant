import { resolve } from 'node:path';
import { startLocalWranglerWorker } from '../../ops/testing/localWranglerWorker';

// Storage is served by the r2_buckets bindings in wrangler.jsonc (local R2
// simulation under wrangler dev); only non-storage vars are injected here.
const VARIABLE_NAMES = [
  'COMMON_CHUNK_PREFIX',
  'DELIVERY_GRANT_ISSUER',
  'DELIVERY_GRANT_KEY_ID',
  'DELIVERY_GRANT_PUBLIC_KEY',
  'MATERIALIZATION_SOURCE_AUDIENCE',
  'METADATA_INDEX_PREFIX',
  'PROTECTED_CHUNK_PREFIX',
  'STORAGE_FORMAT_VERSION',
] as const;

function requiredVariable(name: (typeof VARIABLE_NAMES)[number]): string {
  const value = process.env[`MATERIALIZATION_SOURCE_WORKER_${name}`]?.trim();
  if (!value) {
    throw new Error(`Missing local materialization source Worker variable: ${name}`);
  }
  return value;
}

function configuredPort(): number {
  const value = process.env.MATERIALIZATION_SOURCE_WORKER_PORT?.trim() ?? '3005';
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Invalid local materialization source Worker port');
  }
  return port;
}

async function main(): Promise<void> {
  const port = configuredPort();
  const worker = await startLocalWranglerWorker({
    config: resolve('services/materialization-source-worker/wrangler.jsonc'),
    entrypoint: resolve('services/materialization-source-worker/src/index.ts'),
    port,
    vars: Object.fromEntries(VARIABLE_NAMES.map((name) => [name, requiredVariable(name)])),
  });

  try {
    process.stdout.write(`MATERIALIZATION_SOURCE_WORKER_READY ${new URL(worker.baseUrl).port}\n`);
    await new Promise<void>((resolveStop) => {
      if (process.env.MATERIALIZATION_SOURCE_WORKER_KEEP_ALIVE !== '1') {
        process.stdin.resume();
        process.stdin.once('end', resolveStop);
      }
      process.once('SIGINT', resolveStop);
      process.once('SIGTERM', resolveStop);
    });
  } finally {
    await worker.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
