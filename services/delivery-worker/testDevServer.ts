import { resolve } from 'node:path';
import { unstable_dev } from 'wrangler';
import { startLocalDeliveryProxy } from './localDevProxy';

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

function configuredPort(): number | undefined {
  const configured = process.env.BUYER_FLOW_DELIVERY_PORT?.trim();
  if (!configured) {
    return undefined;
  }
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Invalid buyer flow delivery Worker port');
  }
  return port;
}

async function main(): Promise<void> {
  const vars = Object.fromEntries(VAR_NAMES.map((name) => [name, requiredVariable(name)]));
  const port = configuredPort();
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
  const proxy =
    port === undefined
      ? undefined
      : await startLocalDeliveryProxy({
          port,
          upstreamBaseUrl: `http://127.0.0.1:${worker.port}`,
        });

  process.stdout.write(`DELIVERY_WORKER_READY ${proxy?.port ?? worker.port}\n`);
  await new Promise<void>((resolveStop) => {
    if (process.env.BUYER_FLOW_KEEP_ALIVE !== '1') {
      process.stdin.resume();
      process.stdin.once('end', resolveStop);
    }
    process.once('SIGINT', resolveStop);
    process.once('SIGTERM', resolveStop);
  });
  await proxy?.stop();
  await worker.stop();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
