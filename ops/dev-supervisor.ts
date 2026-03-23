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
const PREFIX_RESET = '\u001B[0m';
const PREFIX_COLORS = {
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
} as const;

export type PrefixColor = keyof typeof PREFIX_COLORS;

export interface DevCommandSpec {
  name: string;
  color: PrefixColor;
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface DevSupervisorOptions {
  prefixOutput?: boolean;
}

const DEFAULT_COMMANDS: readonly DevCommandSpec[] = [
  { name: 'convex', color: 'blue', command: 'npx convex dev' },
  { name: 'api', color: 'magenta', command: 'bun run dev:api' },
  { name: 'bot', color: 'green', command: 'bun run dev:bot' },
  { name: 'web', color: 'yellow', command: 'bun run dev:web' },
  { name: 'tunnel', color: 'cyan', command: 'tailscale funnel 3001' },
];

const INFISICAL_COMMANDS: readonly DevCommandSpec[] = [
  { name: 'convex', color: 'blue', command: 'npx convex dev' },
  { name: 'api', color: 'magenta', command: 'bun run dev:api:infisical' },
  { name: 'bot', color: 'green', command: 'bun run dev:bot:infisical' },
  { name: 'web', color: 'yellow', command: 'bun run dev:web:infisical' },
  { name: 'tunnel', color: 'cyan', command: 'tailscale funnel 3001' },
];

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
    const firstExit = await Promise.race(
      this.managed.map(async (command) => ({
        command,
        code: await command.closePromise,
      }))
    );

    if (!this.shutdownPromise) {
      const prefix = buildPrefix('dev', 'magenta');
      const exitCode = firstExit.code ?? 0;
      process.stderr.write(
        `${prefix}${firstExit.command.spec.name} exited with code ${exitCode}. Shutting down the remaining dev processes.\n`
      );
      await this.shutdown(exitCode === 0 ? 'SIGTERM' : 'SIGINT');
    }

    return firstExit.code ?? 0;
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

async function loadInfisicalEnv(): Promise<NodeJS.ProcessEnv> {
  const envFilePath = path.join(ROOT_DIR, '.env.infisical');
  const envFile = existsSync(envFilePath) ? await readFile(envFilePath, 'utf8') : '';
  return {
    ...process.env,
    ...parseDotenv(envFile),
    FRONTEND_URL: process.env.FRONTEND_URL ?? DEV_FRONTEND_URL,
  };
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const infisical = argv.includes('--infisical');
  const env = infisical ? await loadInfisicalEnv() : process.env;
  const supervisor = new DevSupervisor(infisical ? INFISICAL_COMMANDS : DEFAULT_COMMANDS, env, {
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
