import { resolve } from 'node:path';
import {
  type LocalWranglerWorker,
  startLocalWranglerWorker,
} from '../../ops/testing/localWranglerWorker';
import { type LocalDeliveryProxy, startLocalDeliveryProxy } from './localDevProxy';

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
  'MATERIALIZER_ORIGIN_URL',
  'MATERIALIZER_RENDITION_SHARED_SECRET',
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

function writeStructuredLog(log: unknown): void {
  // Preserve Worker denial diagnostics in the supervisor's correlated local log.
  process.stderr.write(`${JSON.stringify(log)}\n`);
}

async function main(): Promise<void> {
  const vars = Object.fromEntries(VAR_NAMES.map((name) => [name, requiredVariable(name)]));
  const port = configuredPort();
  const worker = await startLocalWranglerWorker({
    config: resolve('services/delivery-worker/wrangler.jsonc'),
    entrypoint: resolve('services/delivery-worker/src/index.ts'),
    onStructuredLog: writeStructuredLog,
    port: 0,
    vars,
  });
  let renditionWorker: LocalWranglerWorker | undefined;
  let proxy: LocalDeliveryProxy | undefined;
  try {
    renditionWorker = await startLocalWranglerWorker({
      config: resolve('services/rendition-worker/wrangler.jsonc'),
      entrypoint: resolve('services/rendition-worker/src/index.ts'),
      onStructuredLog: writeStructuredLog,
      port: 0,
      vars: Object.fromEntries(
        RENDITION_VAR_NAMES.map((name) => [name, requiredRenditionVariable(name)])
      ),
    });
    proxy =
      port === undefined
        ? undefined
        : await startLocalDeliveryProxy({
            port,
            renditionUpstreamBaseUrl: renditionWorker.baseUrl,
            renditionUpstreamFetch: renditionWorker.dispatch,
            upstreamBaseUrl: worker.baseUrl,
            upstreamFetch: worker.dispatch,
          });
    process.stdout.write(`DELIVERY_WORKER_READY ${proxy?.port ?? new URL(worker.baseUrl).port}\n`);
    await new Promise<void>((resolveStop) => {
      if (process.env.BUYER_FLOW_KEEP_ALIVE !== '1') {
        process.stdin.resume();
        process.stdin.once('end', resolveStop);
      }
      process.once('SIGINT', resolveStop);
      process.once('SIGTERM', resolveStop);
    });
  } finally {
    await proxy?.stop();
    await renditionWorker?.stop();
    await worker.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
