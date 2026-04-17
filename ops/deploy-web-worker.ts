import {
  createWebDeployEnvironment,
  resolveWebEnvValues,
  WEB_WRANGLER_CONFIG_PATH,
  runWranglerDeploy,
} from './cloudflare-web-config';

function readFlag(name: string): string | undefined {
  const prefixed = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefixed))?.slice(prefixed.length);
}

const knownFlags = new Set(['--prod']);
const passthroughArgs = process.argv.slice(2).filter((arg) => {
  if (knownFlags.has(arg)) {
    return false;
  }

  return (
    !arg.startsWith('--worker-env=') &&
    !arg.startsWith('--path=') &&
    !arg.startsWith('--projectId=')
  );
});

const isProd = process.argv.includes('--prod');

async function main(): Promise<void> {
  const workerEnvName = readFlag('--worker-env');
  const resolved = resolveWebEnvValues({}, { prod: isProd });

  await runWranglerDeploy(
    WEB_WRANGLER_CONFIG_PATH,
    createWebDeployEnvironment(resolved),
    ['--keep-vars', ...passthroughArgs],
    workerEnvName
  );

  console.log(
    `deploy-web-worker: deployed apps/web to Cloudflare${workerEnvName ? ` env ${workerEnvName}` : ''} using Cloudflare-managed bindings`
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('deploy-web-worker:', error);
    process.exit(1);
  });
}
