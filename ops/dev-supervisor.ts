import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseDotenv } from 'dotenv';

const execFileAsync = promisify(execFile);
const ROOT_DIR = process.cwd();
const DEV_FRONTEND_URL = 'http://localhost:3000';
const DEV_CDNGINE_API_BASE_URL = 'http://localhost:4000';
const DEV_CDNGINE_ACCESS_TOKEN = 'local-public-runtime-token';
const DEV_HYPERDX_APP_URL = 'http://localhost:8080';
const DEV_HYPERDX_OTLP_HTTP_URL = 'http://localhost:4318';
const DEV_HYPERDX_OTLP_GRPC_URL = 'localhost:4317';
const DEV_HYPERDX_USE_REMOTE_FLAG = 'HYPERDX_DEV_USE_REMOTE';
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
export type CdngineStartMode = 'stack' | 'server' | 'demo';

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

const COUPLING_SERVICE_DIR = path.join(ROOT_DIR, 'Verify', 'Native', 'coupling-service');

const DEFAULT_COMMANDS: readonly DevCommandSpec[] = [
  { name: 'convex', color: 'blue', command: 'npx convex dev' },
  { name: 'api', color: 'magenta', command: 'bun run dev:api' },
  { name: 'bot', color: 'green', command: 'bun run dev:bot' },
  { name: 'web', color: 'yellow', command: 'bun run dev:web' },
  { name: 'hyperdx', color: 'cyan', command: 'bun run dev:hyperdx' },
  { name: 'coupling', color: 'red', command: 'bun run dev', cwd: COUPLING_SERVICE_DIR },
];

const INFISICAL_COMMANDS: readonly DevCommandSpec[] = [
  { name: 'convex', color: 'blue', command: 'npx convex dev' },
  { name: 'api', color: 'magenta', command: 'bun run dev:api:infisical' },
  { name: 'bot', color: 'green', command: 'bun run dev:bot:infisical' },
  { name: 'web', color: 'yellow', command: 'bun run dev:web:infisical' },
  { name: 'hyperdx', color: 'cyan', command: 'bun run dev:hyperdx:infisical' },
  { name: 'coupling', color: 'red', command: 'bun run dev:infisical', cwd: COUPLING_SERVICE_DIR },
];

const TUNNEL_COMMAND: DevCommandSpec = {
  name: 'tunnel',
  color: 'cyan',
  command: 'tailscale funnel 3001',
  required: false,
};

export function getCdngineDir(baseEnv: NodeJS.ProcessEnv = process.env): string | null {
  const configured = baseEnv.CDNGINE_DIR?.trim();
  if (!configured) {
    return null;
  }

  if (!existsSync(configured)) {
    throw new Error(`CDNGINE_DIR does not exist: ${configured}`);
  }

  return configured;
}

export function getCdngineStartMode(baseEnv: NodeJS.ProcessEnv = process.env): CdngineStartMode {
  const configured = baseEnv.CDNGINE_START_MODE?.trim().toLowerCase();
  if (!configured) {
    return 'server';
  }

  if (configured === 'stack' || configured === 'server' || configured === 'demo') {
    return configured;
  }

  throw new Error(`CDNGINE_START_MODE must be "stack", "server", or "demo", got: ${configured}`);
}

function buildCdngineCommand(startMode: CdngineStartMode): string {
  switch (startMode) {
    case 'stack':
      return 'npm start';
    case 'server':
      return [
        'npm start',
        'npm run build -w @cdngine/auth',
        'npm run build -w @cdngine/api',
        'npm run build -w @cdngine/workflows',
        'node ./apps/demo/scripts/start-public-runtime.mjs',
      ].join(' && ');
    case 'demo':
      return 'npm start && npm run demo:start';
  }
}

export function describeCdngineStartup(baseEnv: NodeJS.ProcessEnv = process.env): string {
  const cdngineDir = getCdngineDir(baseEnv);
  if (!cdngineDir) {
    return 'cdngine disabled. Set CDNGINE_DIR in .env.local or .env.infisical to launch it.';
  }

  const startMode = getCdngineStartMode(baseEnv);
  return `cdngine enabled via CDNGINE_DIR: ${cdngineDir} (mode: ${startMode})`;
}

export function buildDevCommands(
  baseEnv: NodeJS.ProcessEnv = process.env,
  infisical = false
): readonly DevCommandSpec[] {
  const commands = [...(infisical ? INFISICAL_COMMANDS : DEFAULT_COMMANDS)];
  const cdngineDir = getCdngineDir(baseEnv);
  if (cdngineDir) {
    const cdngineStartMode = getCdngineStartMode(baseEnv);
    commands.push({
      name: 'cdngine',
      color: 'cyan',
      command: buildCdngineCommand(cdngineStartMode),
      cwd: cdngineDir,
      required: false,
    });
  }
  commands.push(TUNNEL_COMMAND);
  return commands;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGINT'
): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', `${pid}`, '/t', '/f'], {
        windowsHide: true,
      });
    } catch (error) {
      if (!isProcessAlive(pid) || isMissingProcessError(error)) {
        return;
      }
      throw error;
    }
    await waitForProcessExit(pid, 5_000);
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
  const hasCdngineDir = Boolean(baseEnv.CDNGINE_DIR?.trim());
  const hasCdngineBaseUrl = Boolean(
    baseEnv.CDNGINE_API_BASE_URL?.trim() || baseEnv.CDNGINE_PUBLIC_API_BASE_URL?.trim()
  );
  const hasCdngineAccessToken = Boolean(
    baseEnv.CDNGINE_ACCESS_TOKEN?.trim() || baseEnv.CDNGINE_API_TOKEN?.trim()
  );
  return {
    ...baseEnv,
    ...(hasCdngineDir && !hasCdngineBaseUrl
      ? { CDNGINE_API_BASE_URL: DEV_CDNGINE_API_BASE_URL }
      : {}),
    ...(hasCdngineDir && !hasCdngineAccessToken
      ? { CDNGINE_ACCESS_TOKEN: DEV_CDNGINE_ACCESS_TOKEN }
      : {}),
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

async function loadInfisicalEnv(): Promise<NodeJS.ProcessEnv> {
  const envFilePath = path.join(ROOT_DIR, '.env.infisical');
  const envFile = existsSync(envFilePath) ? await readFile(envFilePath, 'utf8') : '';
  return applyLocalDevDefaults({
    ...process.env,
    ...parseDotenv(envFile),
  });
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
  const env = infisical ? await loadInfisicalEnv() : await loadLocalEnv();
  process.stdout.write(`${buildPrefix('dev', 'magenta')}${describeCdngineStartup(env)}\n`);
  const supervisor = new DevSupervisor(buildDevCommands(env, infisical), env, {
    prefixOutput: true,
  });

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
    process.exit(signalExitCode(signal));
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const exitCode = await supervisor.waitForExit();
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[dev]', error);
    process.exit(1);
  });
}
