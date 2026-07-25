import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { LocalTcpBridge, type LocalTcpBridgeRoute } from './localTcpBridge';

const execFileAsync = promisify(execFile);
const DEFAULT_DISTRIBUTION = 'YUCP-Materializer';
const LINUX_SERVICE_ROOT = '/home/yucp/ca-coupling';
const LINUX_ENTRYPOINT = '/home/yucp/ca-coupling/deploy/run-local-wsl-materializer.sh';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

type LocalMaterializerNetwork = {
  windowsHostIp: string;
  wslIp: string;
};

type WslEnvironmentInput = {
  baseEnv: NodeJS.ProcessEnv;
  dpopPrivateKey: string;
  windowsHostIp: string;
};

const WSL_ENVIRONMENT_NAMES = [
  'DOCKER_HOST',
  'MATERIALIZATION_CONTROL_PLANE_BASE_URL',
  'MATERIALIZATION_DPOP_PRIVATE_KEY_PKCS8',
  'MATERIALIZATION_HEALTH_HOST',
  'MATERIALIZATION_HEALTH_PORT',
  'MATERIALIZATION_KEY_BROKER_SHARED_SECRET',
  'MATERIALIZATION_KEY_EPOCH',
  'MATERIALIZATION_LANE',
  'MATERIALIZATION_LEASE_DURATION_MS',
  'MATERIALIZATION_MATERIALIZER_SHARED_SECRET',
  'MATERIALIZATION_POLL_INTERVAL_MS',
  'MATERIALIZATION_RUNTIME_LIBRARY_PATH',
  'MATERIALIZATION_SERVICE_ID',
  'MATERIALIZATION_WORK_ROOT',
  'NODE_ENV',
  'XDG_RUNTIME_DIR',
  'YUCP_COUPLING_SERVICE_SHARED_SECRET',
  'YUCP_WINDOWS_HOST_IP',
] as const;

function requireEnvironment(env: NodeJS.ProcessEnv, name: string, minimumBytes = 1): string {
  const value = env[name]?.trim();
  if (!value || Buffer.byteLength(value, 'utf8') < minimumBytes) {
    throw new Error(`${name} is required for the local Linux materializer`);
  }
  return value;
}

function requireIpv4(value: string, name: string): string {
  if (isIP(value) !== 4 || value === '0.0.0.0') {
    throw new Error(`${name} must be one specific IPv4 address`);
  }
  return value;
}

function appendWslEnvironmentNames(
  existingValue: string | undefined,
  names: readonly string[]
): string {
  const existing = (existingValue ?? '')
    .split(':')
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set([...existing, ...names])].join(':');
}

export function requireLoopbackEndpointPort(value: string): number {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('The local rendition endpoint must use loopback HTTP');
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('The local rendition endpoint must contain a valid port');
  }
  return port;
}

export function buildLocalMaterializerBridgeRoutes(input: {
  windowsHostIp: string;
  wslIp: string;
}): LocalTcpBridgeRoute[] {
  const windowsHostIp = requireIpv4(input.windowsHostIp, 'Windows WSL host address');
  const wslIp = requireIpv4(input.wslIp, 'WSL materializer address');
  return [
    {
      listenHost: windowsHostIp,
      listenPort: 3_005,
      targetHost: '127.0.0.1',
      targetPort: 3_005,
    },
    {
      listenHost: windowsHostIp,
      listenPort: 3_012,
      targetHost: '127.0.0.1',
      targetPort: 3_012,
    },
    {
      listenHost: '127.0.0.1',
      listenPort: 8_788,
      targetHost: wslIp,
      targetPort: 8_788,
    },
  ];
}

export function buildWslEnvironment(input: WslEnvironmentInput): NodeJS.ProcessEnv {
  return {
    ...input.baseEnv,
    DOCKER_HOST: 'unix:///run/user/1001/docker.sock',
    MATERIALIZATION_CONTROL_PLANE_BASE_URL: 'http://127.0.0.1:3012',
    MATERIALIZATION_DPOP_PRIVATE_KEY_PKCS8: input.dpopPrivateKey,
    MATERIALIZATION_HEALTH_HOST: '0.0.0.0',
    MATERIALIZATION_HEALTH_PORT: '8788',
    MATERIALIZATION_KEY_BROKER_SHARED_SECRET: requireEnvironment(
      input.baseEnv,
      'MATERIALIZATION_KEY_BROKER_SHARED_SECRET',
      24
    ),
    MATERIALIZATION_KEY_EPOCH: input.baseEnv.MATERIALIZATION_KEY_EPOCH?.trim() || '1',
    MATERIALIZATION_LANE: 'large',
    MATERIALIZATION_LEASE_DURATION_MS: '600000',
    MATERIALIZATION_MATERIALIZER_SHARED_SECRET: requireEnvironment(
      input.baseEnv,
      'MATERIALIZATION_MATERIALIZER_SHARED_SECRET',
      24
    ),
    MATERIALIZATION_POLL_INTERVAL_MS: '1000',
    MATERIALIZATION_RUNTIME_LIBRARY_PATH: `${LINUX_SERVICE_ROOT}/yucp_coupling/out/linux-x64/Release/yucp_coupling.so`,
    MATERIALIZATION_SERVICE_ID: 'local-materializer-large-01',
    MATERIALIZATION_WORK_ROOT: '/home/yucp/.local/share/yucp-materializer',
    NODE_ENV: 'development',
    WSLENV: appendWslEnvironmentNames(input.baseEnv.WSLENV, WSL_ENVIRONMENT_NAMES),
    XDG_RUNTIME_DIR: '/run/user/1001',
    YUCP_COUPLING_SERVICE_SHARED_SECRET: requireEnvironment(
      input.baseEnv,
      'YUCP_COUPLING_SERVICE_SHARED_SECRET',
      24
    ),
    YUCP_WINDOWS_HOST_IP: requireIpv4(input.windowsHostIp, 'Windows WSL host address'),
  };
}

export function windowsPathToWslPath(windowsPath: string): string {
  const normalized = path.win32.normalize(windowsPath);
  const match = normalized.match(/^([A-Za-z]):\\(.+)$/);
  if (!match?.[1] || !match[2]) {
    throw new Error('The coupling source path must use a local Windows drive');
  }
  const relative = match[2].replaceAll('\\', '/');
  if (relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('The coupling source path contains an invalid segment');
  }
  return `/mnt/${match[1].toLowerCase()}/${relative}`;
}

async function resolveWslNetwork(distribution: string): Promise<LocalMaterializerNetwork> {
  const script = 'ip -4 route show default; hostname -I';
  const result = await execFileAsync(
    'wsl.exe',
    ['-d', distribution, '--', '/bin/bash', '-lc', script],
    { timeout: 10_000, windowsHide: true }
  );
  return parseWslNetworkProbe(result.stdout);
}

export function parseWslNetworkProbe(value: string): LocalMaterializerNetwork {
  const lines = value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const gatewayMatch = lines[0]?.match(/^default via (\d+\.\d+\.\d+\.\d+)(?:\s|$)/);
  const wslIp = lines
    .at(-1)
    ?.split(/\s+/)
    .find((entry) => isIP(entry) === 4);
  return {
    windowsHostIp: requireIpv4(gatewayMatch?.[1] ?? '', 'Windows WSL host address'),
    wslIp: requireIpv4(wslIp ?? '', 'WSL materializer address'),
  };
}

export async function waitForLocalMaterializerDependencies(
  options: {
    fetchImplementation?: (input: string, init?: RequestInit) => Promise<Response>;
    retryIntervalMs?: number;
    timeoutMs?: number;
  } = {}
): Promise<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const retryIntervalMs = options.retryIntervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (
    !Number.isSafeInteger(retryIntervalMs) ||
    retryIntervalMs < 1 ||
    retryIntervalMs > 5_000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  ) {
    throw new Error('Local materializer dependency wait configuration is invalid');
  }
  const pending = new Set(['http://127.0.0.1:3005/', 'http://127.0.0.1:3012/']);
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const endpoint of pending) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        const response = await fetchImplementation(endpoint, {
          signal: AbortSignal.timeout(Math.min(2_000, remainingMs)),
        });
        await response.body?.cancel().catch(() => undefined);
        pending.delete(endpoint);
      } catch {
        // The bounded loop retries until both fixed local listeners are ready.
      }
    }
    if (pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    }
  }
  if (pending.size > 0) {
    throw new Error('Local materializer dependencies did not become ready');
  }
}

async function runPreparation(distribution: string, linuxSourceRoot: string): Promise<void> {
  await execFileAsync('wsl.exe', buildPreparationArguments(distribution, linuxSourceRoot), {
    timeout: 120_000,
    windowsHide: true,
  });
}

export function buildPreparationArguments(distribution: string, linuxSourceRoot: string): string[] {
  if (!linuxSourceRoot.startsWith('/mnt/')) {
    throw new Error('The coupling source path is unavailable inside WSL');
  }
  return [
    '-d',
    distribution,
    '--',
    '/bin/bash',
    `${linuxSourceRoot}/deploy/prepare-local-wsl-materializer.sh`,
    linuxSourceRoot,
  ];
}

function createDpopPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  return Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('base64url');
}

export async function startLocalWslMaterializer(
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (process.platform !== 'win32') {
    throw new Error('The local WSL materializer requires Windows');
  }
  const distribution = baseEnv.YUCP_MATERIALIZER_WSL_DISTRIBUTION?.trim() ?? DEFAULT_DISTRIBUTION;
  const sourceRoot =
    baseEnv.YUCP_COUPLING_SOURCE_ROOT?.trim() ?? path.resolve(process.cwd(), '..', 'ca-coupling');
  if (!existsSync(sourceRoot)) {
    throw new Error('The proprietary coupling source repository is unavailable');
  }
  const renditionEndpoint = requireEnvironment(baseEnv, 'RENDITION_S3_ENDPOINT');
  requireLoopbackEndpointPort(renditionEndpoint);
  const linuxSourceRoot = windowsPathToWslPath(sourceRoot);
  const network = await resolveWslNetwork(distribution);
  await runPreparation(distribution, linuxSourceRoot);
  await waitForLocalMaterializerDependencies();
  const bridge = new LocalTcpBridge(
    buildLocalMaterializerBridgeRoutes({
      ...network,
    })
  );
  await bridge.start();
  const child = spawn(
    'wsl.exe',
    ['-d', distribution, '--', '/bin/bash', '-lc', `exec /bin/bash ${LINUX_ENTRYPOINT}`],
    {
      env: buildWslEnvironment({
        baseEnv,
        dpopPrivateKey: createDpopPrivateKey(),
        windowsHostIp: network.windowsHostIp,
      }),
      stdio: 'inherit',
      windowsHide: true,
    }
  );
  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    child.kill();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const [exitCode] = await once(child, 'close');
    return typeof exitCode === 'number' ? exitCode : 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await bridge.close();
  }
}

if (import.meta.main) {
  process.exitCode = await startLocalWslMaterializer();
}
