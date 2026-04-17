import { readFlag } from './cli-utils';
import {
  createTemporaryWranglerConfig,
  fetchWebEnvFromInfisical,
  getWebRuntimeVarValues,
  getWebSecretValues,
  resolveWebEnvValues,
  runWranglerSecretBulk,
} from './cloudflare-web-config';

const isProd = process.argv.includes('--prod');

async function main(): Promise<void> {
  const workerEnvName = readFlag('--worker-env');
  const source = await fetchWebEnvFromInfisical({
    prod: isProd,
    infisicalPath: readFlag('--path'),
    projectId: readFlag('--projectId'),
  });
  const resolved = resolveWebEnvValues(source, { prod: isProd });
  const runtimeVars = getWebRuntimeVarValues(resolved);
  const secretValues = getWebSecretValues(resolved);

  if (Object.keys(secretValues).length === 0) {
    throw new Error('No frontend Worker secrets were returned from Infisical');
  }

  const temporaryConfig = createTemporaryWranglerConfig(runtimeVars, workerEnvName);

  try {
    await runWranglerSecretBulk(secretValues, temporaryConfig.path, workerEnvName);
  } finally {
    temporaryConfig.cleanup();
  }

  console.log(
    `sync-web-worker-secrets: synced ${Object.keys(secretValues).length} secrets to Cloudflare${workerEnvName ? ` env ${workerEnvName}` : ''}`
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('sync-web-worker-secrets:', error);
    process.exit(1);
  });
}
