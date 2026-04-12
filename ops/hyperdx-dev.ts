/**
 * Local HyperDX runner.
 *
 * Docs:
 * - https://github.com/hyperdxio/hyperdx?tab=readme-ov-file#spinning-up-hyperdx
 * - https://clickhouse.com/docs/use-cases/observability/clickstack/deployment
 *
 * We use HyperDX's supported all-in-one image for local development so `bun run dev`
 * brings up a working UI plus OTLP collector without requiring a separate compose stack.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_HYPERDX_IMAGE = 'clickhouse/clickstack-all-in-one:latest';
const DEFAULT_CONTAINER_NAME = 'yucp-hyperdx-dev';
const DEFAULT_APP_PORT = '8080';
const DEFAULT_OTLP_GRPC_PORT = '4317';
const DEFAULT_OTLP_HTTP_PORT = '4318';
const DEFAULT_USAGE_STATS_ENABLED = 'false';
const DOCKER_UNAVAILABLE_SNIPPETS = [
  'failed to connect to the docker api',
  'the system cannot find the file specified',
  'error during connect',
  'dockerdesktoplinuxengine',
  'is the docker daemon running',
  'cannot connect to the docker daemon',
  'docker daemon',
  'not found',
] as const;

export interface HyperdxDevConfig {
  image: string;
  containerName: string;
  appPort: string;
  otlpGrpcPort: string;
  otlpHttpPort: string;
  usageStatsEnabled: string;
}

function readConfig(env: NodeJS.ProcessEnv = process.env): HyperdxDevConfig {
  return {
    image: env.HYPERDX_DEV_IMAGE ?? DEFAULT_HYPERDX_IMAGE,
    containerName: env.HYPERDX_DEV_CONTAINER_NAME ?? DEFAULT_CONTAINER_NAME,
    appPort: env.HYPERDX_APP_PORT ?? DEFAULT_APP_PORT,
    otlpGrpcPort: env.HYPERDX_OTLP_GRPC_PORT ?? DEFAULT_OTLP_GRPC_PORT,
    otlpHttpPort: env.HYPERDX_OTLP_HTTP_PORT ?? DEFAULT_OTLP_HTTP_PORT,
    usageStatsEnabled: env.HYPERDX_USAGE_STATS_ENABLED ?? DEFAULT_USAGE_STATS_ENABLED,
  };
}

export function buildHyperdxDockerArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = readConfig(env);
  const volumesDir = path.join(process.cwd(), '.volumes', 'hyperdx');
  return [
    'run',
    '--rm',
    '--name',
    config.containerName,
    '-p',
    `${config.appPort}:8080`,
    '-p',
    `${config.otlpGrpcPort}:4317`,
    '-p',
    `${config.otlpHttpPort}:4318`,
    '-v',
    `${path.join(volumesDir, 'db')}:/data/db`,
    '-v',
    `${path.join(volumesDir, 'ch_data')}:/var/lib/clickhouse`,
    '-v',
    `${path.join(volumesDir, 'ch_logs')}:/var/log/clickhouse-server`,
    '-e',
    `USAGE_STATS_ENABLED=${config.usageStatsEnabled}`,
    config.image,
  ];
}

export function isDockerUnavailable(details: string): boolean {
  const normalized = details.toLowerCase();
  return DOCKER_UNAVAILABLE_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function hyperdxFailureIsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HYPERDX_DEV_REQUIRED === 'true';
}

async function ensureDockerAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ['docker', 'info'],
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const [stderrText, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode === 0) {
    return true;
  }

  const details = stderrText.trim() || `docker info failed with exit code ${exitCode}`;
  if (hyperdxFailureIsRequired(env)) {
    throw new Error(details);
  }

  if (isDockerUnavailable(details)) {
    console.warn(
      '[hyperdx] Docker Desktop is not running, so HyperDX was skipped. Start Docker Desktop and rerun if you want the local HyperDX UI.'
    );
    return false;
  }

  throw new Error(details);
}

async function removeExistingContainer(containerName: string) {
  const proc = Bun.spawn({
    cmd: ['docker', 'rm', '-f', containerName],
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const [stderrText, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode === 0) {
    return;
  }

  const normalized = stderrText.toLowerCase();
  if (
    normalized.includes('no such container') ||
    normalized.includes('cannot remove container') ||
    normalized.includes('is not running')
  ) {
    return;
  }

  throw new Error(
    stderrText.trim() || `docker rm -f ${containerName} failed with exit code ${exitCode}`
  );
}

async function main() {
  const config = readConfig();
  const dockerAvailable = await ensureDockerAvailable(process.env);
  if (!dockerAvailable) {
    process.exit(0);
  }

  const volumesDir = path.join(process.cwd(), '.volumes', 'hyperdx');
  await Promise.all([
    mkdir(path.join(volumesDir, 'db'), { recursive: true }),
    mkdir(path.join(volumesDir, 'ch_data'), { recursive: true }),
    mkdir(path.join(volumesDir, 'ch_logs'), { recursive: true }),
  ]);

  await removeExistingContainer(config.containerName);

  console.log(
    `[hyperdx] Starting ClickStack at http://localhost:${config.appPort} with OTLP on grpc:${config.otlpGrpcPort} http:${config.otlpHttpPort}`
  );

  const proc = Bun.spawn({
    cmd: ['docker', ...buildHyperdxDockerArgs(process.env)],
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[hyperdx]', error);
    process.exit(1);
  });
}
