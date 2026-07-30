import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { readFlag } from './cli-utils';
import {
  getRenditionWorkerBindingValues,
  RENDITION_WORKER_BINDING_KEYS,
  RENDITION_WORKER_WRANGLER_CONFIG_PATH,
  runWranglerDeployWithSecrets,
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
  const bindingValues = getRenditionWorkerBindingValues(source);
  const missing = RENDITION_WORKER_BINDING_KEYS.filter((key) => !bindingValues[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required rendition Worker Infisical values: ${missing.join(', ')}`);
  }

  await runWranglerDeployWithSecrets(
    bindingValues,
    workerEnvName,
    RENDITION_WORKER_WRANGLER_CONFIG_PATH
  );
  console.log(
    `sync-rendition-worker-secrets: deployed with ${
      Object.keys(bindingValues).length
    } encrypted bindings to Cloudflare${workerEnvName ? ` env ${workerEnvName}` : ''}`
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `sync-rendition-worker-secrets: ${error instanceof Error ? error.name : 'unknown_error'}`
    );
    process.exit(1);
  });
}
