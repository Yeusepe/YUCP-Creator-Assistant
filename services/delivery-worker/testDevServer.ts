import { resolve } from 'node:path';
import { unstable_dev } from 'wrangler';
import { startLocalDeliveryProxy } from './localDevProxy';

const VAR_NAMES = [
  'COMMON_S3_ENDPOINT',
  'COMMON_S3_REGION',
  'COMMON_S3_BUCKET',
  'COMMON_S3_READONLY_ACCESS_KEY_ID',
  'COMMON_S3_READONLY_SECRET_ACCESS_KEY',
  'COMMON_CHUNK_PREFIX',
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_BUCKET',
  'METADATA_S3_READONLY_ACCESS_KEY_ID',
  'METADATA_S3_READONLY_SECRET_ACCESS_KEY',
  'METADATA_INDEX_PREFIX',
  'PACKAGE_DELIVERY_AUDIENCE',
  'PACKAGE_INSTALL_ISSUER',
  'PACKAGE_INSTALL_SIGNING_KEY_ID',
  'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY',
  'STORAGE_FORMAT_VERSION',
] as const;
const RENDITION_VAR_NAMES = [
  'PACKAGE_DELIVERY_AUDIENCE',
  'PACKAGE_INSTALL_ISSUER',
  'PACKAGE_INSTALL_SIGNING_KEY_ID',
  'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY',
  'RENDITION_RECEIPT_KEY_ID',
  'RENDITION_RECEIPT_PUBLIC_KEY',
  'RENDITION_S3_BUCKET',
  'RENDITION_S3_ENDPOINT',
  'RENDITION_S3_READONLY_ACCESS_KEY_ID',
  'RENDITION_S3_READONLY_SECRET_ACCESS_KEY',
  'RENDITION_S3_REGION',
] as const;

function requiredVariable(name: (typeof VAR_NAMES)[number]): string {
  const value = process.env[`BUYER_FLOW_${name}`]?.trim();
  if (!value) {
    throw new Error(`Missing buyer flow delivery Worker variable: ${name}`);
  }
  return value;
}

function requiredRenditionVariable(name: (typeof RENDITION_VAR_NAMES)[number]): string {
  const value = process.env[`BUYER_FLOW_RENDITION_${name}`]?.trim();
  if (!value) {
    throw new Error(`Missing buyer flow rendition Worker variable: ${name}`);
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
    config: resolve('services/delivery-worker/wrangler.jsonc'),
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
  const renditionWorker = await unstable_dev(resolve('services/rendition-worker/src/index.ts'), {
    config: resolve('services/rendition-worker/wrangler.jsonc'),
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
    vars: Object.fromEntries(
      RENDITION_VAR_NAMES.map((name) => [name, requiredRenditionVariable(name)])
    ),
  });
  const proxy =
    port === undefined
      ? undefined
      : await startLocalDeliveryProxy({
          port,
          renditionUpstreamBaseUrl: `http://127.0.0.1:${renditionWorker.port}`,
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
  await renditionWorker.stop();
  await worker.stop();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
