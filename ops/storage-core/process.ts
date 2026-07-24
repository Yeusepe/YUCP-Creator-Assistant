import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export type CommandResult = {
  stderr: string;
  stdout: string;
};

export const DEFAULT_COMMAND_TIMEOUT_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  stdoutPath?: string;
  timeoutMs?: number;
};

export function commandPathEnv(): NodeJS.ProcessEnv {
  return process.env.PATH ? { PATH: process.env.PATH } : {};
}

export type GnuArchiveTools = {
  env: NodeJS.ProcessEnv;
  gzipCommand: string;
  tarCommand: string;
};

let resolvedGnuArchiveTools: Promise<GnuArchiveTools> | undefined;

function uniqueCommands(commands: Array<string | undefined>): string[] {
  return [...new Set(commands.filter((command): command is string => Boolean(command)))];
}

async function findCommand(
  candidates: string[],
  args: string[],
  expectedOutput: string,
  label: string
): Promise<string> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    if (candidate.includes('\\') && !existsSync(candidate)) {
      failures.push(`${candidate}: file not found`);
      continue;
    }
    try {
      const result = await runCommand(candidate, args, { env: commandPathEnv() });
      if (`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
        return candidate;
      }
      failures.push(`${candidate}: required ${label} feature not found`);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`GNU ${label} is required.\n${failures.join('\n')}`);
}

export async function resolveGnuArchiveTools(): Promise<GnuArchiveTools> {
  resolvedGnuArchiveTools ??= (async () => {
    const gitToolsPath =
      process.platform === 'win32'
        ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin')
        : undefined;
    const tarCommand = await findCommand(
      uniqueCommands([
        process.env.YUCP_GNU_TAR_PATH?.trim(),
        'tar',
        gitToolsPath ? join(gitToolsPath, 'tar.exe') : undefined,
      ]),
      ['--version'],
      'GNU tar',
      'tar'
    );
    const gzipCommand = await findCommand(
      uniqueCommands([
        process.env.YUCP_GZIP_PATH?.trim(),
        'gzip',
        gitToolsPath ? join(gitToolsPath, 'gzip.exe') : undefined,
      ]),
      ['--help'],
      '--rsyncable',
      'gzip'
    );
    const toolDirectories = uniqueCommands(
      [tarCommand, gzipCommand].map((command) =>
        isAbsolute(command) ? dirname(command) : undefined
      )
    );
    const currentPath = process.env.PATH?.trim();
    const path = [...toolDirectories, ...(currentPath ? [currentPath] : [])].join(delimiter);
    return {
      env: path ? { PATH: path } : {},
      gzipCommand,
      tarCommand,
    };
  })();
  return await resolvedGnuArchiveTools;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Command timeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError('Command maxOutputBytes must be a positive safe integer');
  }
  const stdoutFile = options.stdoutPath ? openSync(options.stdoutPath, 'w') : undefined;

  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', stdoutFile ?? 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stderrChunks: Buffer[] = [];
      const stdoutChunks: Buffer[] = [];
      let stderrBytes = 0;
      let stdoutBytes = 0;
      let settled = false;
      let timedOut = false;
      const capture = (chunks: Buffer[], bytes: number, chunk: Buffer | string): number => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxOutputBytes - bytes;
        if (remaining > 0) {
          const captured = buffer.subarray(0, remaining);
          chunks.push(captured);
          return bytes + captured.byteLength;
        }
        return bytes;
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer | string) => {
          stdoutBytes = capture(stdoutChunks, stdoutBytes, chunk);
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderrBytes = capture(stderrChunks, stderrBytes, chunk);
        });
      }
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to start ${command}: ${error.message}`, { cause: error }));
        }
      });
      child.on('close', (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
        if (timedOut) {
          reject(new Error(`${command} timed out after ${timeoutMs}ms`));
          return;
        }
        if (code === 0) {
          resolve({ stderr, stdout });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || `signal ${signal ?? 'unknown'}`;
        reject(new Error(`${command} exited with code ${code ?? 'unknown'}: ${detail}`));
      });
    });
  } finally {
    if (stdoutFile !== undefined) {
      closeSync(stdoutFile);
    }
  }
}
