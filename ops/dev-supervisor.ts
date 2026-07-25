import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseDotenv } from 'dotenv';
import * as ed25519 from '@noble/ed25519';
import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';
import { DESYNC_STORAGE_FORMAT_VERSION } from './storage-core/deliveryManifest';
import {
  type DisposableStorageHarness,
  startDisposableStorageHarness,
} from './testing/disposableStorageHarness';

const execFileAsync = promisify(execFile);
const ROOT_DIR = process.cwd();
const DEV_FRONTEND_URL = 'http://localhost:3000';
const DEV_HYPERDX_APP_URL = 'http://localhost:8080';
const DEV_HYPERDX_OTLP_HTTP_URL = 'http://localhost:4318';
const DEV_HYPERDX_OTLP_GRPC_URL = 'localhost:4317';
const DEV_HYPERDX_USE_REMOTE_FLAG = 'HYPERDX_DEV_USE_REMOTE';
const DEV_INGEST_TUS_URL = 'http://localhost:3002';
const DEV_API_URL = 'http://127.0.0.1:3001';
const DEV_DELIVERY_URL = 'http://127.0.0.1:3003';
const DEV_DELIVERY_PORT = '3003';
const DEV_PUBLIC_VPM_URL = 'http://127.0.0.1:3004';
const DEV_PUBLIC_VPM_PORT = '3004';
const DEV_MATERIALIZATION_SOURCE_URL = 'http://127.0.0.1:3005';
const DEV_MATERIALIZATION_SOURCE_PORT = '3005';
const DEV_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const PREFIX_RESET = '\u001B[0m';
const PREFIX_COLORS = {
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
  red: '\u001B[31m',
} as const;

export type PrefixColor = keyof typeof PREFIX_COLORS;

export interface DevCommandSpec {
  name: string;
  color: PrefixColor;
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  required?: boolean;
}

interface DevSupervisorOptions {
  prefixOutput?: boolean;
}

const DEFAULT_COMMANDS: readonly DevCommandSpec[] = [
  {
    name: 'convex',
    color: 'blue',
    command:
      'bunx convex dev --run seedYucpOAuthClient:seedUnityOAuthClient',
  },
  { name: 'api', color: 'magenta', command: 'bun run dev:api' },
  { name: 'bot', color: 'green', command: 'bun run dev:bot' },
  { name: 'web', color: 'yellow', command: 'bun run dev:web' },
  { name: 'hyperdx', color: 'cyan', command: 'bun run dev:hyperdx' },
  {
    name: 'ingest-tus',
    color: 'cyan',
    command: 'bun run --watch ops/ingest-tus/server.ts',
    env: { PORT: '3002' },
  },
  { name: 'scheduler', color: 'blue', command: 'bun run ops/scheduler/server.ts' },
  {
    name: 'materialization-control',
    color: 'red',
    command: 'bun run --watch ops/materialization/server.ts',
  },
];

const INFISICAL_COMMANDS: readonly DevCommandSpec[] = [
  {
    name: 'convex',
    color: 'blue',
    command:
      'bunx convex dev --run seedYucpOAuthClient:seedUnityOAuthClient',
  },
  { name: 'api', color: 'magenta', command: 'bun run dev:api:infisical' },
  { name: 'bot', color: 'green', command: 'bun run dev:bot:infisical' },
  { name: 'web', color: 'yellow', command: 'bun run dev:web:infisical' },
  { name: 'hyperdx', color: 'cyan', command: 'bun run dev:hyperdx:infisical' },
  {
    name: 'ingest-tus',
    color: 'cyan',
    command: 'bun run --watch ops/ingest-tus/server.ts',
    env: { PORT: '3002' },
  },
  { name: 'scheduler', color: 'blue', command: 'bun run ops/scheduler/server.ts' },
  {
    name: 'materialization-control',
    color: 'red',
    command: 'bun run --watch ops/materialization/server.ts',
  },
];

const TUNNEL_COMMAND: DevCommandSpec = {
  name: 'tunnel',
  color: 'cyan',
  command: 'tailscale funnel 3001',
  required: false,
};
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_POWERSHELL_KILL_TIMEOUT_MS = 5_000;

export function buildDevCommands(
  baseEnv: NodeJS.ProcessEnv = process.env,
  infisical = false
): readonly DevCommandSpec[] {
  const commands = [...(infisical ? INFISICAL_COMMANDS : DEFAULT_COMMANDS)];
  commands.push(
    {
      name: 'delivery',
      color: 'magenta',
      command: 'bun x tsx watch services/delivery-worker/testDevServer.ts',
      env: {
        BUYER_FLOW_COMMON_CHUNK_PREFIX: baseEnv.COMMON_CHUNK_PREFIX ?? 'chunks/',
        BUYER_FLOW_COMMON_S3_BUCKET: baseEnv.COMMON_S3_BUCKET,
        BUYER_FLOW_COMMON_S3_ENDPOINT: baseEnv.COMMON_S3_ENDPOINT,
        BUYER_FLOW_COMMON_S3_READONLY_ACCESS_KEY_ID: baseEnv.COMMON_S3_ACCESS_KEY_ID,
        BUYER_FLOW_COMMON_S3_READONLY_SECRET_ACCESS_KEY:
          baseEnv.COMMON_S3_SECRET_ACCESS_KEY,
        BUYER_FLOW_COMMON_S3_REGION: baseEnv.COMMON_S3_REGION,
        BUYER_FLOW_METADATA_INDEX_PREFIX: baseEnv.METADATA_INDEX_PREFIX ?? 'indexes/',
        BUYER_FLOW_METADATA_S3_BUCKET: baseEnv.METADATA_S3_BUCKET,
        BUYER_FLOW_METADATA_S3_ENDPOINT: baseEnv.METADATA_S3_ENDPOINT,
        BUYER_FLOW_METADATA_S3_READONLY_ACCESS_KEY_ID:
          baseEnv.METADATA_S3_ACCESS_KEY_ID,
        BUYER_FLOW_METADATA_S3_READONLY_SECRET_ACCESS_KEY:
          baseEnv.METADATA_S3_SECRET_ACCESS_KEY,
        BUYER_FLOW_METADATA_S3_REGION: baseEnv.METADATA_S3_REGION,
        BUYER_FLOW_PACKAGE_DELIVERY_AUDIENCE: baseEnv.PACKAGE_DELIVERY_AUDIENCE,
        BUYER_FLOW_PACKAGE_INSTALL_ISSUER: baseEnv.PACKAGE_INSTALL_ISSUER,
        BUYER_FLOW_PACKAGE_INSTALL_SIGNING_KEY_ID: baseEnv.PACKAGE_INSTALL_SIGNING_KEY_ID,
        BUYER_FLOW_PACKAGE_INSTALL_SIGNING_PUBLIC_KEY:
          baseEnv.PACKAGE_INSTALL_SIGNING_PUBLIC_KEY,
        BUYER_FLOW_RENDITION_PACKAGE_DELIVERY_AUDIENCE:
          baseEnv.PACKAGE_DELIVERY_AUDIENCE,
        BUYER_FLOW_RENDITION_PACKAGE_INSTALL_ISSUER:
          baseEnv.PACKAGE_INSTALL_ISSUER,
        BUYER_FLOW_RENDITION_PACKAGE_INSTALL_SIGNING_KEY_ID:
          baseEnv.PACKAGE_INSTALL_SIGNING_KEY_ID,
        BUYER_FLOW_RENDITION_PACKAGE_INSTALL_SIGNING_PUBLIC_KEY:
          baseEnv.PACKAGE_INSTALL_SIGNING_PUBLIC_KEY,
        BUYER_FLOW_RENDITION_RENDITION_RECEIPT_KEY_ID:
          baseEnv.MATERIALIZATION_RECEIPT_KEY_ID,
        BUYER_FLOW_RENDITION_RENDITION_RECEIPT_PUBLIC_KEY:
          baseEnv.MATERIALIZATION_RECEIPT_PUBLIC_KEY,
        BUYER_FLOW_RENDITION_RENDITION_S3_BUCKET:
          baseEnv.RENDITION_S3_BUCKET,
        BUYER_FLOW_RENDITION_RENDITION_S3_ENDPOINT:
          baseEnv.RENDITION_S3_ENDPOINT,
        BUYER_FLOW_RENDITION_RENDITION_S3_READONLY_ACCESS_KEY_ID:
          baseEnv.RENDITION_S3_ACCESS_KEY_ID,
        BUYER_FLOW_RENDITION_RENDITION_S3_READONLY_SECRET_ACCESS_KEY:
          baseEnv.RENDITION_S3_SECRET_ACCESS_KEY,
        BUYER_FLOW_RENDITION_RENDITION_S3_REGION:
          baseEnv.RENDITION_S3_REGION,
        BUYER_FLOW_DELIVERY_PORT: DEV_DELIVERY_PORT,
        BUYER_FLOW_KEEP_ALIVE: '1',
        BUYER_FLOW_STORAGE_FORMAT_VERSION: DESYNC_STORAGE_FORMAT_VERSION,
      },
    },
    {
      name: 'vpm-public',
      color: 'green',
      command: 'bun run ops/importer/localVpmServer.ts',
      env: { PORT: DEV_PUBLIC_VPM_PORT },
    },
    {
      name: 'materialization-source',
      color: 'red',
      command:
        'bun x tsx watch services/materialization-source-worker/testDevServer.ts',
      env: {
        MATERIALIZATION_SOURCE_WORKER_DELIVERY_GRANT_ISSUER:
          baseEnv.MATERIALIZATION_SOURCE_GRANT_ISSUER,
        MATERIALIZATION_SOURCE_WORKER_DELIVERY_GRANT_KEY_ID:
          baseEnv.MATERIALIZATION_SOURCE_GRANT_KEY_ID,
        MATERIALIZATION_SOURCE_WORKER_DELIVERY_GRANT_PUBLIC_KEY:
          baseEnv.MATERIALIZATION_SOURCE_GRANT_PUBLIC_KEY,
        MATERIALIZATION_SOURCE_WORKER_KEEP_ALIVE: '1',
        MATERIALIZATION_SOURCE_WORKER_MATERIALIZATION_SOURCE_AUDIENCE:
          baseEnv.MATERIALIZATION_SOURCE_GRANT_AUDIENCE,
        MATERIALIZATION_SOURCE_WORKER_METADATA_INDEX_PREFIX:
          baseEnv.METADATA_INDEX_PREFIX ?? 'indexes/',
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_BUCKET:
          baseEnv.METADATA_S3_BUCKET,
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_ENDPOINT:
          baseEnv.METADATA_S3_ENDPOINT,
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_READONLY_ACCESS_KEY_ID:
          baseEnv.METADATA_S3_ACCESS_KEY_ID,
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_READONLY_SECRET_ACCESS_KEY:
          baseEnv.METADATA_S3_SECRET_ACCESS_KEY,
        MATERIALIZATION_SOURCE_WORKER_METADATA_S3_REGION:
          baseEnv.METADATA_S3_REGION,
        MATERIALIZATION_SOURCE_WORKER_PORT:
          DEV_MATERIALIZATION_SOURCE_PORT,
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_CHUNK_PREFIX:
          baseEnv.PROTECTED_CHUNK_PREFIX ?? 'chunks/',
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_BUCKET:
          baseEnv.PROTECTED_S3_BUCKET,
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_ENDPOINT:
          baseEnv.PROTECTED_S3_ENDPOINT,
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_READONLY_ACCESS_KEY_ID:
          baseEnv.PROTECTED_S3_ACCESS_KEY_ID,
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_READONLY_SECRET_ACCESS_KEY:
          baseEnv.PROTECTED_S3_SECRET_ACCESS_KEY,
        MATERIALIZATION_SOURCE_WORKER_PROTECTED_S3_REGION:
          baseEnv.PROTECTED_S3_REGION,
        MATERIALIZATION_SOURCE_WORKER_STORAGE_FORMAT_VERSION:
          DESYNC_STORAGE_FORMAT_VERSION,
      },
    }
  );
  commands.push({
    name: 'materializer-linux',
    color: 'red',
    command: 'bun run ops/materialization/localWslMaterializer.ts',
  });
  commands.push(TUNNEL_COMMAND);
  return commands;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateLocalTufRepository(input: {
  baseEnv: NodeJS.ProcessEnv;
  installKeyId: string;
  installPublicKey: string;
  outputRoot: string;
  receiptKeyId: string;
  receiptPublicKey: string;
}): Promise<void> {
  const configuredGo = input.baseEnv.YUCP_GO_EXECUTABLE?.trim();
  const workspaceGo = 'E:\\YUCPTools\\go-1.26.5\\go\\bin\\go.exe';
  const goExecutable =
    configuredGo || (existsSync(workspaceGo) ? workspaceGo : 'go');
  const helperRoot = path.join(ROOT_DIR, 'Verify', 'Native', 'transfer-helper');
  const pinnedRoot = path.join(
    helperRoot,
    'internal',
    'tufclient',
    'testdata',
    '1.root.json'
  );
  const helperExecutable = path.join(
    path.dirname(input.outputRoot),
    'yucp-transfer-helper.exe'
  );
  const runGo = async (args: string[], failureLabel: string): Promise<void> => {
    const child = spawn(goExecutable, args, {
      cwd: helperRoot,
      env: input.baseEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const [exitCode] = await once(child, 'close');
    if (exitCode !== 0) {
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      throw new Error(
        `${failureLabel} failed with exit code ${String(exitCode)}${
          detail ? `: ${detail}` : ''
        }`
      );
    }
  };
  await runGo(
    [
      'build',
      '-trimpath',
      '-ldflags=-s -w',
      '-o',
      helperExecutable,
      './cmd/yucp-transfer-helper',
    ],
    'Local transfer-helper build'
  );
  await runGo(
    [
      'run',
      './cmd/yucp-local-tuf-repository',
      '--output',
      input.outputRoot,
      '--root',
      pinnedRoot,
      '--helper',
      helperExecutable,
      '--install-key-id',
      input.installKeyId,
      '--install-public-key',
      input.installPublicKey,
      '--receipt-key-id',
      input.receiptKeyId,
      '--receipt-public-key',
      input.receiptPublicKey,
    ],
    'Local TUF repository generation'
  );
}

function buildShellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }

  return {
    file: '/bin/sh',
    args: ['-lc', command],
  };
}

function buildPrefix(name: string, color: PrefixColor): string {
  return `${PREFIX_COLORS[color]}[${name}]${PREFIX_RESET} `;
}

function isCommandRequired(spec: DevCommandSpec): boolean {
  return spec.required ?? true;
}

function forwardPrefixedOutput(
  stream: NodeJS.ReadableStream | null,
  writer: NodeJS.WritableStream,
  prefix: string
): void {
  if (!stream) {
    return;
  }

  const readable = stream as NodeJS.ReadableStream & {
    setEncoding?(encoding: BufferEncoding): void;
  };
  readable.setEncoding?.('utf8');

  let buffer = '';
  readable.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      writer.write(`${prefix}${line}\n`);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  });
  readable.on('end', () => {
    const trailing = buffer.replace(/\r$/, '');
    if (trailing.length > 0) {
      writer.write(`${prefix}${trailing}\n`);
    }
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'EINVAL')
    ) {
      return false;
    }
    return true;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }

  return !isProcessAlive(pid);
}

function isMissingProcessError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const details = [
    'stdout' in error ? error.stdout : '',
    'stderr' in error ? error.stderr : '',
    'message' in error ? error.message : '',
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();

  return (
    details.includes('not found') ||
    details.includes('no running instance') ||
    details.includes('no process found')
  );
}

async function killWindowsProcessTreeWithPowershell(pid: number): Promise<void> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$rootPid = ${pid}
$processes = Get-Process
function Stop-ProcessTree([int]$currentPid) {
  foreach ($child in $processes) {
    try {
      if ($null -ne $child.Parent -and $child.Parent.Id -eq $currentPid) {
        Stop-ProcessTree $child.Id
      }
    } catch {
    }
  }
  Stop-Process -Id $currentPid -Force -ErrorAction SilentlyContinue
}
Stop-ProcessTree $rootPid
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: WINDOWS_POWERSHELL_KILL_TIMEOUT_MS,
    windowsHide: true,
  });
}

export async function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGINT'
): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  if (process.platform === 'win32') {
    let taskkillError: unknown;
    try {
      await execFileAsync('taskkill', ['/pid', `${pid}`, '/t', '/f'], {
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (error) {
      if (!isProcessAlive(pid) || isMissingProcessError(error)) {
        return;
      }
      taskkillError = error;
      try {
        await killWindowsProcessTreeWithPowershell(pid);
      } catch (fallbackError) {
        if (!isProcessAlive(pid) || isMissingProcessError(fallbackError)) {
          return;
        }
        throw fallbackError;
      }
    }
    if (await waitForProcessExit(pid, 5_000)) {
      return;
    }
    if (taskkillError) {
      throw taskkillError;
    }
    return;
  }

  const targets = [-pid, pid];
  for (const currentSignal of [signal, 'SIGTERM', 'SIGKILL'] as const) {
    for (const target of targets) {
      try {
        process.kill(target, currentSignal);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'ESRCH' || error.code === 'EINVAL')
        ) {
          // The process or group is already gone. Keep checking the remaining targets.
        }
      }
    }

    if (await waitForProcessExit(pid, currentSignal === 'SIGKILL' ? 1_000 : 2_000)) {
      return;
    }
  }
}

class ManagedCommand {
  readonly child: ChildProcess;
  readonly closePromise: Promise<number | null>;

  constructor(
    readonly spec: DevCommandSpec,
    baseEnv: NodeJS.ProcessEnv,
    options: Required<DevSupervisorOptions>
  ) {
    const shell = buildShellCommand(spec.command);
    this.child = spawn(shell.file, shell.args, {
      cwd: spec.cwd ?? ROOT_DIR,
      env: {
        ...baseEnv,
        ...spec.env,
      },
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const prefix = buildPrefix(spec.name, spec.color);
    if (options.prefixOutput) {
      forwardPrefixedOutput(this.child.stdout, process.stdout, prefix);
      forwardPrefixedOutput(this.child.stderr, process.stderr, prefix);
    }

    this.closePromise = new Promise((resolve) => {
      this.child.once('close', (code) => resolve(code));
    });
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    if (this.child.exitCode !== null || this.child.pid == null) {
      return;
    }

    await killProcessTree(this.child.pid, signal);
    await Promise.race([this.closePromise, sleep(5_000)]);
  }
}

export class DevSupervisor {
  private readonly managed: ManagedCommand[] = [];
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly commands: readonly DevCommandSpec[],
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    private readonly options: Required<DevSupervisorOptions> = {
      prefixOutput: true,
    }
  ) {}

  async start(): Promise<void> {
    for (const spec of this.commands) {
      this.managed.push(new ManagedCommand(spec, this.baseEnv, this.options));
    }
  }

  async shutdown(signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownPromise = Promise.all(this.managed.map((command) => command.stop(signal))).then(
      () => undefined
    );
    await this.shutdownPromise;
  }

  async waitForExit(): Promise<number> {
    const remaining = [...this.managed];
    while (remaining.length > 0) {
      const firstExit = await Promise.race(
        remaining.map(async (command) => ({
          command,
          code: await command.closePromise,
        }))
      );
      const exitCode = firstExit.code ?? 0;
      const exitedIndex = remaining.indexOf(firstExit.command);
      if (exitedIndex >= 0) {
        remaining.splice(exitedIndex, 1);
      }

      if (!isCommandRequired(firstExit.command.spec)) {
        if (!this.shutdownPromise) {
          const prefix = buildPrefix('dev', 'yellow');
          process.stderr.write(
            `${prefix}Optional dev helper ${firstExit.command.spec.name} exited with code ${exitCode}. Keeping the main dev processes running.\n`
          );
        }
        continue;
      }

      if (!this.shutdownPromise) {
        const prefix = buildPrefix('dev', 'magenta');
        process.stderr.write(
          `${prefix}${firstExit.command.spec.name} exited with code ${exitCode}. Shutting down the remaining dev processes.\n`
        );
        await this.shutdown(exitCode === 0 ? 'SIGTERM' : 'SIGINT');
      }

      return exitCode;
    }

    return 0;
  }
}

async function runCommandStep(step: DevCommandSpec, env: NodeJS.ProcessEnv): Promise<void> {
  const shell = buildShellCommand(step.command);
  const child = spawn(shell.file, shell.args, {
    cwd: step.cwd ?? ROOT_DIR,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const prefix = buildPrefix(step.name, step.color);
  forwardPrefixedOutput(child.stdout, process.stdout, prefix);
  forwardPrefixedOutput(child.stderr, process.stderr, prefix);

  const [code] = await once(child, 'close');
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`${step.name} exited with code ${code}`);
  }
}

export function applyLocalDevDefaults(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const preferRemoteHyperdx = baseEnv[DEV_HYPERDX_USE_REMOTE_FLAG] === 'true';
  return {
    ...baseEnv,
    FRONTEND_URL: baseEnv.FRONTEND_URL ?? DEV_FRONTEND_URL,
    HYPERDX_APP_URL: preferRemoteHyperdx
      ? (baseEnv.HYPERDX_APP_URL ?? DEV_HYPERDX_APP_URL)
      : DEV_HYPERDX_APP_URL,
    HYPERDX_OTLP_HTTP_URL: preferRemoteHyperdx
      ? (baseEnv.HYPERDX_OTLP_HTTP_URL ?? DEV_HYPERDX_OTLP_HTTP_URL)
      : DEV_HYPERDX_OTLP_HTTP_URL,
    HYPERDX_OTLP_GRPC_URL: preferRemoteHyperdx
      ? (baseEnv.HYPERDX_OTLP_GRPC_URL ?? DEV_HYPERDX_OTLP_GRPC_URL)
      : DEV_HYPERDX_OTLP_GRPC_URL,
    OTEL_EXPORTER_OTLP_ENDPOINT: preferRemoteHyperdx
      ? (baseEnv.OTEL_EXPORTER_OTLP_ENDPOINT ??
        baseEnv.HYPERDX_OTLP_HTTP_URL ??
        DEV_HYPERDX_OTLP_HTTP_URL)
      : DEV_HYPERDX_OTLP_HTTP_URL,
    OTEL_EXPORTER_OTLP_PROTOCOL: baseEnv.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf',
  };
}

export function applyInfisicalDevSecrets(
  bootstrapEnv: NodeJS.ProcessEnv,
  secrets: Record<string, string>
): NodeJS.ProcessEnv {
  return applyLocalDevDefaults({
    ...bootstrapEnv,
    ...secrets,
    FRONTEND_URL: DEV_FRONTEND_URL,
  });
}

export function applyDisposableStorageProfile(
  baseEnv: NodeJS.ProcessEnv,
  storage: DisposableStorageHarness,
  secrets: {
    couplingServiceSharedSecret: string;
    installSigningKeyId: string;
    installSigningPrivateKey: string;
    installSigningPublicKey: string;
    materializationApiSharedSecret: string;
    materializationCapabilityKeyId: string;
    materializationCapabilityPrivateKey: string;
    materializationCapabilityPublicKey: string;
    materializationKeyBrokerSharedSecret: string;
    materializationMaterializerSharedSecret: string;
    materializationReceiptKeyId: string;
    materializationReceiptPrivateKey: string;
    materializationReceiptPublicKey: string;
    materializationSourceGrantKeyId: string;
    materializationSourceGrantPrivateKey: string;
    materializationSourceGrantPublicKey: string;
    uploadHmacKey: string;
    vpmTokenKey: string;
  }
): NodeJS.ProcessEnv {
  const storageRoleEnvironment = Object.fromEntries(
    Object.entries(storage.buckets).flatMap(([role, config]) => {
      const prefix = role === 'renditions' ? 'RENDITION' : role.toUpperCase();
      return [
        [`${prefix}_S3_ACCESS_KEY_ID`, config.accessKeyId],
        [`${prefix}_S3_BUCKET`, config.bucket],
        [`${prefix}_S3_ENDPOINT`, config.endpoint],
        [`${prefix}_S3_REGION`, config.region],
        [`${prefix}_S3_SECRET_ACCESS_KEY`, config.secretAccessKey],
      ];
    })
  );
  return {
    ...baseEnv,
    ...storageRoleEnvironment,
    COMMON_CHUNK_PREFIX: storage.buckets.common.chunkPrefix,
    METADATA_INDEX_PREFIX: storage.buckets.metadata.indexPrefix,
    PROTECTED_CHUNK_PREFIX: storage.buckets.protected.chunkPrefix,
    CATALOG_DATABASE_URL: storage.postgres.url,
    PACKAGE_CATALOG_DATABASE_URL: storage.postgres.url,
    MATERIALIZATION_ALGORITHM_VERSION:
      baseEnv.MATERIALIZATION_ALGORITHM_VERSION ?? 'png-dct-qim-v2',
    MATERIALIZATION_API_SHARED_SECRET:
      secrets.materializationApiSharedSecret,
    MATERIALIZATION_CAPABILITY_KEY_ID:
      secrets.materializationCapabilityKeyId,
    MATERIALIZATION_CAPABILITY_LIFETIME_SECONDS: '300',
    MATERIALIZATION_CAPABILITY_PRIVATE_KEY:
      secrets.materializationCapabilityPrivateKey,
    MATERIALIZATION_CAPABILITY_PUBLIC_KEY:
      secrets.materializationCapabilityPublicKey,
    MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL:
      'http://127.0.0.1:3012',
    MATERIALIZATION_CONTROL_PLANE_PUBLIC_BASE_URL:
      'http://127.0.0.1:3012',
    MATERIALIZATION_KEY_EPOCH:
      baseEnv.MATERIALIZATION_KEY_EPOCH ?? '1',
    MATERIALIZATION_KEY_BROKER_BASE_URL:
      'http://127.0.0.1:8788',
    MATERIALIZATION_KEY_BROKER_SHARED_SECRET:
      secrets.materializationKeyBrokerSharedSecret,
    MATERIALIZATION_MATERIALIZER_SHARED_SECRET:
      baseEnv.MATERIALIZATION_MATERIALIZER_SHARED_SECRET ??
      secrets.materializationMaterializerSharedSecret,
    MATERIALIZATION_PLUGIN_VERSION:
      baseEnv.MATERIALIZATION_PLUGIN_VERSION ?? 'coupling-server-v2',
    MATERIALIZATION_RECEIPT_KEY_ID:
      secrets.materializationReceiptKeyId,
    MATERIALIZATION_RECEIPT_PRIVATE_KEY:
      secrets.materializationReceiptPrivateKey,
    MATERIALIZATION_RECEIPT_PUBLIC_KEY:
      secrets.materializationReceiptPublicKey,
    MATERIALIZATION_SOURCE_DELIVERY_BASE_URL:
      baseEnv.MATERIALIZATION_SOURCE_DELIVERY_BASE_URL ??
      DEV_MATERIALIZATION_SOURCE_URL,
    MATERIALIZATION_SOURCE_GRANT_AUDIENCE:
      baseEnv.MATERIALIZATION_SOURCE_GRANT_AUDIENCE ??
      DEV_MATERIALIZATION_SOURCE_URL,
    MATERIALIZATION_SOURCE_GRANT_ISSUER:
      baseEnv.MATERIALIZATION_SOURCE_GRANT_ISSUER ??
      'http://127.0.0.1:3012',
    MATERIALIZATION_SOURCE_GRANT_KEY_ID:
      secrets.materializationSourceGrantKeyId,
    MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY:
      secrets.materializationSourceGrantPrivateKey,
    MATERIALIZATION_SOURCE_GRANT_PUBLIC_KEY:
      secrets.materializationSourceGrantPublicKey,
    PACKAGE_DELIVERY_AUDIENCE: DEV_DELIVERY_URL,
    PACKAGE_INSTALL_ISSUER: DEV_API_URL,
    PACKAGE_INSTALL_SIGNING_KEY_ID: secrets.installSigningKeyId,
    PACKAGE_INSTALL_SIGNING_PRIVATE_KEY: secrets.installSigningPrivateKey,
    PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: secrets.installSigningPublicKey,
    INGEST_ALLOWED_ORIGIN: DEV_FRONTEND_URL,
    INGEST_MAX_BYTES: String(DEV_MAX_UPLOAD_BYTES),
    INGEST_TUS_URL: DEV_INGEST_TUS_URL,
    INGEST_UPLOAD_DIR: storage.uploadDir,
    NODE_ENV: baseEnv.NODE_ENV ?? 'development',
    UPLOAD_HMAC_KEY: secrets.uploadHmacKey,
    VPM_BASE_URL: DEV_API_URL,
    VPM_PUBLIC_INDEX_URL: `${DEV_PUBLIC_VPM_URL}/index.json`,
    VPM_TOKEN_KEY: secrets.vpmTokenKey,
    VPM_TRUSTED_REPOSITORY_URLS: JSON.stringify([
      'https://vcc.vrcfury.com/',
      'https://vpm.yucp.club/index.json',
    ]),
    YUCP_COUPLING_SERVICE_BASE_URL: 'http://127.0.0.1:8788',
    YUCP_COUPLING_SERVICE_SHARED_SECRET:
      secrets.couplingServiceSharedSecret,
    YUCP_STORAGE_PROFILE: 'disposable',
  };
}

async function loadInfisicalEnv(): Promise<NodeJS.ProcessEnv> {
  const localEnvFilePath = path.join(ROOT_DIR, '.env.local');
  const localEnvFile = existsSync(localEnvFilePath) ? await readFile(localEnvFilePath, 'utf8') : '';
  const envFilePath = path.join(ROOT_DIR, '.env.infisical');
  const envFile = existsSync(envFilePath) ? await readFile(envFilePath, 'utf8') : '';
  const bootstrapEnv = {
    ...process.env,
    ...parseDotenv(localEnvFile),
    ...parseDotenv(envFile),
  };
  const secrets = await fetchInfisicalSecrets(bootstrapEnv);
  if (Object.keys(secrets).length === 0) {
    throw new Error(
      'Infisical returned no secrets for the development supervisor'
    );
  }
  return applyInfisicalDevSecrets(bootstrapEnv, secrets);
}

async function loadLocalEnv(): Promise<NodeJS.ProcessEnv> {
  const envFilePath = path.join(ROOT_DIR, '.env.local');
  const envFile = existsSync(envFilePath) ? await readFile(envFilePath, 'utf8') : '';
  process.stderr.write(
    `${buildPrefix('dev', 'yellow')}Infisical is not enabled for this dev run; using process.env and .env.local fallback values only.\n`
  );
  return applyLocalDevDefaults({
    ...process.env,
    ...parseDotenv(envFile),
  });
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const infisical = argv.includes('--infisical');
  const loadedEnv = infisical ? await loadInfisicalEnv() : await loadLocalEnv();
  const storage = await startDisposableStorageHarness();
  const [
    installSigningPrivateKey,
    materializationCapabilityPrivateKey,
    materializationReceiptPrivateKey,
    materializationSourceGrantPrivateKey,
  ] = Array.from({ length: 4 }, () => randomBytes(32));
  const installSigningKeyId = `local-${storage.runId}`;
  const materializationReceiptKeyId = `local-receipt-${storage.runId}`;
  const installSigningPublicKey = Buffer.from(
    await ed25519.getPublicKeyAsync(installSigningPrivateKey)
  ).toString('base64url');
  const materializationReceiptPublicKey = Buffer.from(
    await ed25519.getPublicKeyAsync(materializationReceiptPrivateKey)
  ).toString('base64url');
  const tufRepositoryRoot = path.join(
    path.dirname(storage.uploadDir),
    'package-installer-tuf'
  );
  await generateLocalTufRepository({
    baseEnv: loadedEnv,
    installKeyId: installSigningKeyId,
    installPublicKey: installSigningPublicKey,
    outputRoot: tufRepositoryRoot,
    receiptKeyId: materializationReceiptKeyId,
    receiptPublicKey: materializationReceiptPublicKey,
  });
  const env = applyDisposableStorageProfile(
    {
      ...loadedEnv,
      PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT: tufRepositoryRoot,
    },
    storage,
    {
    couplingServiceSharedSecret: randomBytes(32).toString('base64url'),
    installSigningKeyId,
    installSigningPrivateKey: installSigningPrivateKey.toString('base64url'),
    installSigningPublicKey,
    materializationApiSharedSecret: randomBytes(32).toString('base64url'),
    materializationCapabilityKeyId: `local-capability-${storage.runId}`,
    materializationCapabilityPrivateKey:
      materializationCapabilityPrivateKey.toString('base64url'),
    materializationCapabilityPublicKey: Buffer.from(
      await ed25519.getPublicKeyAsync(materializationCapabilityPrivateKey)
    ).toString('base64url'),
    materializationKeyBrokerSharedSecret: randomBytes(32).toString(
      'base64url'
    ),
    materializationMaterializerSharedSecret: randomBytes(32).toString(
      'base64url'
    ),
    materializationReceiptKeyId,
    materializationReceiptPrivateKey:
      materializationReceiptPrivateKey.toString('base64url'),
    materializationReceiptPublicKey,
    materializationSourceGrantKeyId:
      `local-source-grant-${storage.runId}`,
    materializationSourceGrantPrivateKey:
      materializationSourceGrantPrivateKey.toString('base64url'),
    materializationSourceGrantPublicKey: Buffer.from(
      await ed25519.getPublicKeyAsync(materializationSourceGrantPrivateKey)
    ).toString('base64url'),
    uploadHmacKey: randomBytes(32).toString('base64url'),
    vpmTokenKey: randomBytes(32).toString('base64url'),
    }
  );
  const supervisor = new DevSupervisor(buildDevCommands(env, infisical), env, {
    prefixOutput: true,
  });

  try {
    process.stderr.write(
      `${buildPrefix('storage', 'cyan')}Disposable PostgreSQL and five-bucket MinIO profile ${storage.runId} is ready.\n`
    );
    if (infisical) {
      await runCommandStep(
        {
          name: 'sync',
          color: 'magenta',
          command: 'bun run sync:convex:env',
        },
        env
      );
    }

    await supervisor.start();

    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      await supervisor.shutdown(signal);
      await storage.stop();
      process.exit(signalExitCode(signal));
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });

    const exitCode = await supervisor.waitForExit();
    await storage.stop();
    process.exit(exitCode);
  } catch (error) {
    await supervisor.shutdown('SIGINT');
    await storage.stop();
    throw error;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error('[dev]', error);
    process.exit(1);
  }
}
