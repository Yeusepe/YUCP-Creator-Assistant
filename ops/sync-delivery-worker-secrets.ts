import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { readFlag } from './cli-utils';
import {
  DELIVERY_WORKER_BINDING_KEYS,
  DELIVERY_WORKER_WRANGLER_CONFIG_PATH,
  getDeliveryWorkerBindingValues,
  runWranglerSecretBulk,
} from './cloudflare-web-config';

const isProd = process.argv.includes('--prod');

async function main(): Promise<void> {
  const workerEnvName = readFlag('--worker-env');
  const projectId = readFlag('--projectId');
  const environment = readFlag('--env') ?? (isProd ? 'prod' : undefined);
  const source = await fetchInfisicalSecrets({
    ...process.env,
    ...(projectId ? { INFISICAL_PROJECT_ID: projectId } : {}),
    ...(environment ? { INFISICAL_ENV: environment } : {}),
  });
  const bindingValues = getDeliveryWorkerBindingValues(source);
  const missing = DELIVERY_WORKER_BINDING_KEYS.filter((key) => !bindingValues[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required delivery Worker Infisical secrets: ${missing.join(', ')}`);
  }

  await runWranglerSecretBulk(bindingValues, DELIVERY_WORKER_WRANGLER_CONFIG_PATH, workerEnvName);
  console.log(
    `sync-delivery-worker-secrets: synced ${Object.keys(bindingValues).length} bindings to Cloudflare${workerEnvName ? ` env ${workerEnvName}` : ''}`
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `sync-delivery-worker-secrets: ${error instanceof Error ? error.name : 'unknown_error'}`
    );
    process.exit(1);
  });
}
