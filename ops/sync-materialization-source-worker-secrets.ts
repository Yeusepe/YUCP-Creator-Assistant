import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { readFlag } from './cli-utils';
import {
  getMaterializationSourceWorkerBindingValues,
  MATERIALIZATION_SOURCE_WORKER_BINDING_KEYS,
  MATERIALIZATION_SOURCE_WORKER_SOURCE_KEYS,
  MATERIALIZATION_SOURCE_WORKER_WRANGLER_CONFIG_PATH,
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
  const missing = MATERIALIZATION_SOURCE_WORKER_SOURCE_KEYS.filter((key) => !source[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required materialization source Worker Infisical secrets: ${missing.join(', ')}`
    );
  }
  const bindingValues = getMaterializationSourceWorkerBindingValues(source);
  const missingBindings = MATERIALIZATION_SOURCE_WORKER_BINDING_KEYS.filter(
    (key) => !bindingValues[key]
  );
  if (missingBindings.length > 0) {
    throw new Error(
      `Failed to derive materialization source Worker bindings: ${missingBindings.join(', ')}`
    );
  }

  await runWranglerDeployWithSecrets(
    bindingValues,
    workerEnvName,
    MATERIALIZATION_SOURCE_WORKER_WRANGLER_CONFIG_PATH
  );
  console.log(
    `sync-materialization-source-worker-secrets: deployed with ${Object.keys(bindingValues).length} encrypted bindings to Cloudflare${workerEnvName ? ` env ${workerEnvName}` : ''}`
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `sync-materialization-source-worker-secrets: ${
        error instanceof Error ? error.name : 'unknown_error'
      }`
    );
    process.exit(1);
  });
}
