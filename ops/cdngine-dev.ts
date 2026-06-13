import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const DEFAULT_PROJECT_NAME = 'yucp-cdngine-dev';
const DEFAULT_COMPOSE_DIR = path.join(process.cwd(), '.volumes', 'cdngine', 'docker');
const PUBLIC_RUNTIME_BASE_URL = 'http://localhost:4000';
const PUBLIC_RUNTIME_PORT = 4000;
const CDNGINE_HEALTH_CHECK_TIMEOUT_MS = 5_000;
const CDNGINE_COMPOSE_FETCH_TIMEOUT_MS = 30_000;
const DEV_PORT_DEFAULTS = {
  CDNGINE_DEMO_PORT: 15173,
  KOPIA_PORT: 15115,
  OCI_REGISTRY_PORT: 15000,
  POSTGRES_PORT: 15432,
  REDIS_PORT: 16379,
  RUSTFS_API_PORT: 19000,
  RUSTFS_CONSOLE_PORT: 19001,
  TEMPORAL_PORT: 17233,
  TEMPORAL_UI_PORT: 18080,
  TUSD_PORT: 11080,
} as const;

type CdngineStartMode = 'server' | 'demo' | 'stack';
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CdngineDevConfig {
  composeDir: string;
  projectName: string;
  ref: string;
  startMode: CdngineStartMode;
}

interface CdngineComposeArgsInput {
  composeFilePath: string;
  envFilePath: string;
  projectName: string;
  startMode: CdngineStartMode;
}

interface PreparedCompose {
  composeFilePath: string;
  envFilePath: string;
}

function readRequiredDockerRef(env: NodeJS.ProcessEnv): string {
  const ref = env.CDNGINE_DOCKER_REF?.trim();
  if (!ref) {
    throw new Error('CDNGINE_DOCKER_REF is required for managed CDNgine Docker dev.');
  }
  return ref;
}

function readStartMode(env: NodeJS.ProcessEnv): CdngineStartMode {
  const mode = env.CDNGINE_START_MODE?.trim().toLowerCase();
  if (!mode) {
    return 'server';
  }
  if (mode === 'server' || mode === 'demo' || mode === 'stack') {
    return mode;
  }
  throw new Error(`CDNGINE_START_MODE must be "server", "demo", or "stack", got: ${mode}`);
}

export function resolveCdngineDevConfig(env: NodeJS.ProcessEnv = process.env): CdngineDevConfig {
  return {
    composeDir: env.CDNGINE_DOCKER_DIR?.trim() || DEFAULT_COMPOSE_DIR,
    projectName: env.CDNGINE_DOCKER_PROJECT?.trim() || DEFAULT_PROJECT_NAME,
    ref: readRequiredDockerRef(env),
    startMode: readStartMode(env),
  };
}

export function buildCdngineRemoteComposeUrl(ref: string): string {
  return `https://raw.githubusercontent.com/Yeusepe/cdngine/${encodeURIComponent(ref)}/deploy/remote/compose.latest.yaml`;
}

export function buildCdngineComposeFilePath(composeDir: string, ref: string): string {
  const safeRef = ref.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(composeDir, `compose.${safeRef}.yaml`);
}

export function renderCdngineCompose(composeText: string): string {
  const next = composeText.replace(
    /\n(\s*)build:\n\1\s+context:\s*https:\/\/github\.com\/Yeusepe\/cdngine\.git#[^\n]+\n\1\s+dockerfile:\s*Dockerfile/,
    ''
  );
  if (next === composeText) {
    throw new Error('CDNgine remote compose file did not contain the expected GitHub build context.');
  }
  return next;
}

export function buildCdngineDockerImageArgs(ref: string): string[] {
  return [
    'buildx',
    'build',
    '--load',
    '-t',
    'cdngine-latest-instance:latest',
    `https://github.com/Yeusepe/cdngine.git#${ref}`,
  ];
}

export function buildCdngineComposeArgs(input: CdngineComposeArgsInput): string[] {
  const base = [
    'compose',
    '--project-name',
    input.projectName,
    '--env-file',
    input.envFilePath,
    '-f',
    input.composeFilePath,
  ];
  if (input.startMode === 'demo') {
    return [...base, '--profile', 'demo', 'up', '-d', 'cdngine-runtime', 'cdngine-demo'];
  }
  return [...base, 'up', '-d', 'cdngine-runtime'];
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(preferredPort: number): Promise<string> {
  for (let port = preferredPort; port < preferredPort + 200; port += 1) {
    if (await canBindPort(port)) {
      return String(port);
    }
  }
  throw new Error(`No available port found near ${preferredPort}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isCdnginePublicRuntimeReady(
  baseUrl = PUBLIC_RUNTIME_BASE_URL,
  fetchImpl: FetchLike = fetch
): Promise<boolean> {
  try {
    const healthUrl = new URL('/healthz', baseUrl).toString();
    const response = await fetchImpl(healthUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(CDNGINE_HEALTH_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as {
      service?: unknown;
      status?: unknown;
    };
    if (payload.service !== '@cdngine/api' || payload.status !== 'ok') {
      return false;
    }

    const uploadProbeUrl = new URL('/uploads/yucp-readiness-probe', baseUrl).toString();
    const uploadResponse = await fetchImpl(uploadProbeUrl, {
      cache: 'no-store',
      headers: {
        Origin: 'http://localhost:3000',
        'Tus-Resumable': '1.0.0',
      },
      method: 'HEAD',
      signal: AbortSignal.timeout(CDNGINE_HEALTH_CHECK_TIMEOUT_MS),
    });
    const uploadCorsOrigin = uploadResponse.headers.get('access-control-allow-origin');
    return (
      (uploadResponse.status === 404 || uploadResponse.status === 204) &&
      Boolean(uploadCorsOrigin)
    );
  } catch {
    return false;
  }
}

export async function monitorExistingCdnginePublicRuntime(
  baseUrl = PUBLIC_RUNTIME_BASE_URL,
  pollMs = 5_000,
  fetchImpl: FetchLike = fetch
): Promise<never> {
  if (!(await isCdnginePublicRuntimeReady(baseUrl, fetchImpl))) {
    throw new Error(`Existing CDNgine public runtime at ${baseUrl} is not healthy.`);
  }
  console.log(`[cdngine] Reusing healthy CDNgine public runtime at ${baseUrl}`);
  for (;;) {
    await sleep(pollMs);
    if (!(await isCdnginePublicRuntimeReady(baseUrl, fetchImpl))) {
      throw new Error(`Existing CDNgine public runtime at ${baseUrl} stopped responding.`);
    }
  }
}

async function run(command: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const proc = Bun.spawn({
    cmd: [...command],
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
  }
}

async function applyCdngineDockerDefaults(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const next = {
    ...env,
  };
  if (!next.PATH && next.Path) {
    next.PATH = next.Path;
  }
  if (!next.Path && next.PATH) {
    next.Path = next.PATH;
  }
  if (!next.CDNGINE_PUBLIC_RUNTIME_PORT?.trim()) {
    next.CDNGINE_PUBLIC_RUNTIME_PORT = String(PUBLIC_RUNTIME_PORT);
  }
  for (const [key, value] of Object.entries(DEV_PORT_DEFAULTS)) {
    if (!next[key]?.trim()) {
      next[key] = await findAvailablePort(value);
    }
  }
  return next;
}

function renderEnvFile(env: NodeJS.ProcessEnv): string {
  const keys = [
    'CDNGINE_DEMO_PORT',
    'CDNGINE_PUBLIC_RUNTIME_PORT',
    'KOPIA_PORT',
    'OCI_REGISTRY_PORT',
    'POSTGRES_PORT',
    'REDIS_PORT',
    'RUSTFS_API_PORT',
    'RUSTFS_CONSOLE_PORT',
    'TEMPORAL_PORT',
    'TEMPORAL_UI_PORT',
    'TUSD_PORT',
  ];
  return `${keys.map((key) => `${key}=${env[key] ?? ''}`).join('\n')}\n`;
}

export async function prepareDockerCompose(
  config: CdngineDevConfig,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike = fetch
): Promise<PreparedCompose> {
  await mkdir(config.composeDir, { recursive: true });
  const composeUrl = buildCdngineRemoteComposeUrl(config.ref);
  const response = await fetchImpl(composeUrl, {
    cache: 'no-store',
    signal: AbortSignal.timeout(CDNGINE_COMPOSE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch CDNgine Docker Compose from ${composeUrl}: ${response.status}`);
  }
  const composeText = renderCdngineCompose(await response.text());
  const composeFilePath = buildCdngineComposeFilePath(config.composeDir, config.ref);
  const envFilePath = path.join(config.composeDir, 'dev.env');
  await Promise.all([
    writeFile(composeFilePath, composeText, 'utf8'),
    writeFile(envFilePath, renderEnvFile(env), 'utf8'),
  ]);
  return {
    composeFilePath,
    envFilePath,
  };
}

async function waitForCdnginePublicRuntime(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdnginePublicRuntimeReady(PUBLIC_RUNTIME_BASE_URL)) {
      return;
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for CDNgine public runtime at ${PUBLIC_RUNTIME_BASE_URL}.`);
}

async function main(): Promise<void> {
  const config = resolveCdngineDevConfig();
  const runtimeEnv = await applyCdngineDockerDefaults(process.env);
  if (await isCdnginePublicRuntimeReady(PUBLIC_RUNTIME_BASE_URL)) {
    await monitorExistingCdnginePublicRuntime(PUBLIC_RUNTIME_BASE_URL);
    return;
  }

  console.log(`[cdngine] Starting Docker runtime from Yeusepe/cdngine @ ${config.ref}`);
  const prepared = await prepareDockerCompose(config, runtimeEnv);
  await run(['docker', ...buildCdngineDockerImageArgs(config.ref)], runtimeEnv);
  await run(
    [
      'docker',
      ...buildCdngineComposeArgs({
        ...prepared,
        projectName: config.projectName,
        startMode: config.startMode,
      }),
    ],
    runtimeEnv
  );
  await waitForCdnginePublicRuntime();
  await monitorExistingCdnginePublicRuntime(PUBLIC_RUNTIME_BASE_URL);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[cdngine]', error);
    process.exit(1);
  });
}
