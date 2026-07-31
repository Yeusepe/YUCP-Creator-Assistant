import { readFlag } from './cli-utils';
import {
  createWebDeployEnvironment,
  resolveWebEnvValues,
  runWranglerVersionsUpload,
  WEB_GENERATED_WRANGLER_CONFIG_PATH,
} from './cloudflare-web-config';
import { runWebBuild, uploadWebSourceMaps } from './deploy-web-worker';

const passthroughArgs = process.argv
  .slice(2)
  .filter(
    (arg) =>
      !arg.startsWith('--worker-env=') &&
      !arg.startsWith('--path=') &&
      !arg.startsWith('--projectId=')
  );

export function getWebVersionUploadArgs(
  extraArgs: readonly string[],
  workerEnvName?: string
): string[] {
  const args = ['versions', 'upload', '--config', WEB_GENERATED_WRANGLER_CONFIG_PATH];
  if (workerEnvName) {
    args.push('--env', workerEnvName);
  }
  args.push(...extraArgs);
  return args;
}

async function main(): Promise<void> {
  const workerEnvName = readFlag('--worker-env');
  const resolved = resolveWebEnvValues({}, { prod: false });
  const releaseId = resolved.BUILD_ID ?? 'dev';

  await runWebBuild();
  await uploadWebSourceMaps(releaseId);
  await runWranglerVersionsUpload(
    WEB_GENERATED_WRANGLER_CONFIG_PATH,
    createWebDeployEnvironment({ ...resolved, BUILD_ID: releaseId }),
    passthroughArgs,
    workerEnvName
  );

  console.log(
    `upload-web-worker-version: uploaded preview version for apps/web${workerEnvName ? ` env ${workerEnvName}` : ''}`
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('upload-web-worker-version:', error);
    process.exit(1);
  });
}
