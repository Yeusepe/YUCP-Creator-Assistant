import { resolve } from 'node:path';
import { startLocalWranglerWorker } from '../../ops/testing/localWranglerWorker';

const VARIABLE_NAMES = [
  'COMMON_CHUNK_PREFIX',
  'COMMON_S3_BUCKET',
  'COMMON_S3_ENDPOINT',
  'COMMON_S3_READONLY_ACCESS_KEY_ID',
  'COMMON_S3_READONLY_SECRET_ACCESS_KEY',
  'COMMON_S3_REGION',
  'DELIVERY_GRANT_ISSUER',
  'DELIVERY_GRANT_KEY_ID',
  'DELIVERY_GRANT_PUBLIC_KEY',
  'MATERIALIZATION_SOURCE_AUDIENCE',
  'METADATA_INDEX_PREFIX',
  'METADATA_S3_BUCKET',
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_READONLY_ACCESS_KEY_ID',
  'METADATA_S3_READONLY_SECRET_ACCESS_KEY',
  'METADATA_S3_REGION',
  'PROTECTED_CHUNK_PREFIX',
  'PROTECTED_S3_BUCKET',
  'PROTECTED_S3_ENDPOINT',
  'PROTECTED_S3_READONLY_ACCESS_KEY_ID',
  'PROTECTED_S3_READONLY_SECRET_ACCESS_KEY',
  'PROTECTED_S3_REGION',
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
