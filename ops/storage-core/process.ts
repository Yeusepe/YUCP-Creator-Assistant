import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

export type CommandResult = {
  stderr: string;
  stdout: string;
};

export function commandPathEnv(): NodeJS.ProcessEnv {
  return process.env.PATH ? { PATH: process.env.PATH } : {};
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdoutPath?: string;
  } = {}
): Promise<CommandResult> {
  const stdoutFile = options.stdoutPath ? openSync(options.stdoutPath, 'w') : undefined;

  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', stdoutFile ?? 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      let stdout = '';
      let settled = false;

      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
      }
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to start ${command}: ${error.message}`, { cause: error }));
        }
      });
      child.on('close', (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
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
