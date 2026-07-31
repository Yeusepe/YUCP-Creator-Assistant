import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readFlag } from './cli-utils';
import {
  createWebDeployEnvironment,
  REPO_ROOT_DIR,
  resolveWebEnvValues,
  runWranglerDeploy,
  WEB_GENERATED_WRANGLER_CONFIG_PATH,
} from './cloudflare-web-config';

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
export const SOURCE_MAP_UPLOAD_TIMEOUT_MS = 120_000;

const HYPERDX_CLI_RUNTIME_ENV_KEYS = [
  'APPDATA',
  'BUN_INSTALL',
  'HOME',
  'LOCALAPPDATA',
  'Path',
  'PATH',
  'TEMP',
  'TMP',
  'USERPROFILE',
] as const;

export function getHyperdxCliEnvironment(
  serviceKey: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    HYPERDX_SERVICE_KEY: serviceKey,
    ...Object.fromEntries(
      HYPERDX_CLI_RUNTIME_ENV_KEYS.flatMap((key) =>
        sourceEnv[key] === undefined ? [] : [[key, sourceEnv[key]]]
      )
    ),
  };
}

export function removePublicSourceMaps(root: string): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      removePublicSourceMaps(path);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.map')) {
      unlinkSync(path);
    }
  }
}

export function getWebBuildCommand(): string[] {
  return ['bun', 'run', '--filter', '@yucp/web', 'build'];
}

export async function runWebBuild(): Promise<void> {
  const proc = Bun.spawn({
    cmd: getWebBuildCommand(),
    cwd: REPO_ROOT_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`web build failed with exit code ${exitCode}`);
  }
}

export async function uploadWebSourceMaps(releaseId: string): Promise<void> {
  const serviceKey = process.env.HYPERDX_SERVICE_KEY?.trim();
  if (!serviceKey) {
    throw new Error('HYPERDX_SERVICE_KEY is required to upload web source maps');
  }

  const apiUrl =
    process.env.HYPERDX_API_URL?.trim() || process.env.HYPERDX_APP_URL?.trim() || undefined;
  const args = [
    'x',
    '@hyperdx/cli',
    'upload-sourcemaps',
    '--path',
    'apps/web/dist',
    '--releaseId',
    releaseId,
  ];
  if (apiUrl) {
    args.push('--apiUrl', apiUrl);
  }

  const proc = Bun.spawn({
    cmd: [process.execPath, ...args],
    cwd: REPO_ROOT_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    env: getHyperdxCliEnvironment(serviceKey),
    timeout: SOURCE_MAP_UPLOAD_TIMEOUT_MS,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`web source-map upload failed with exit code ${exitCode}`);
  }
  removePublicSourceMaps(join(REPO_ROOT_DIR, 'apps', 'web', 'dist'));
}

async function main(): Promise<void> {
  const workerEnvName = readFlag('--worker-env');
  const resolved = resolveWebEnvValues({}, { prod: isProd });
  const releaseId = resolved.BUILD_ID ?? 'dev';

  await runWebBuild();
  await uploadWebSourceMaps(releaseId);

  await runWranglerDeploy(
    WEB_GENERATED_WRANGLER_CONFIG_PATH,
    createWebDeployEnvironment({ ...resolved, BUILD_ID: releaseId }),
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
