import { resolve } from 'node:path';
import { unstable_dev } from 'wrangler';

const VAR_NAMES = [
  'CAS_S3_ENDPOINT',
  'CAS_S3_REGION',
  'CAS_S3_BUCKET',
  'CAS_S3_READONLY_ACCESS_KEY_ID',
  'CAS_S3_READONLY_SECRET_ACCESS_KEY',
  'CAS_INDEX_PREFIX',
  'CAS_CHUNK_PREFIX',
  'DELIVERY_HMAC_KEY',
  'STORAGE_FORMAT_VERSION',
] as const;

function requiredVariable(name: (typeof VAR_NAMES)[number]): string {
  const value = process.env[`BUYER_FLOW_${name}`]?.trim();
  if (!value) {
    throw new Error(`Missing buyer flow delivery Worker variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const vars = Object.fromEntries(VAR_NAMES.map((name) => [name, requiredVariable(name)]));
  const worker = await unstable_dev(resolve('services/delivery-worker/src/index.ts'), {
    config: resolve('services/delivery-worker/wrangler.toml'),
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      forceLocal: true,
      testMode: true,
      watch: false,
    },
    inspect: false,
    ip: '127.0.0.1',
    local: true,
    logLevel: 'none',
    persist: false,
    vars,
  });

  process.stdout.write(`DELIVERY_WORKER_READY ${worker.port}\n`);
  await new Promise<void>((resolveStop) => {
    process.stdin.resume();
    process.stdin.once('end', resolveStop);
    process.once('SIGINT', resolveStop);
    process.once('SIGTERM', resolveStop);
  });
  await worker.stop();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
