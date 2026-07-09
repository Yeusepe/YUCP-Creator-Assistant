import { spawn } from 'node:child_process';
import path from 'node:path';

const FORCE_KILL_TIMEOUT_MS = 5_000;

interface KillableChild {
  kill(signal: NodeJS.Signals): boolean;
}

export function stopChildWithFallback(
  child: KillableChild,
  signal: NodeJS.Signals,
  timeoutMs = FORCE_KILL_TIMEOUT_MS
): () => void {
  let cancelled = false;
  child.kill(signal);

  const fallback = setTimeout(() => {
    if (!cancelled) {
      child.kill('SIGKILL');
    }
  }, timeoutMs);

  return () => {
    cancelled = true;
    clearTimeout(fallback);
  };
}

export async function startApiFromCwd(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const targetCwd = env.YUCP_TEST_CWD?.trim();

  if (!targetCwd) {
    throw new Error('YUCP_TEST_CWD must be set');
  }

  const apiEntry = path.resolve(import.meta.dir, '../../src/index.ts');
  const apiProcess = spawn(process.execPath, ['run', apiEntry], {
    cwd: targetCwd,
    env,
    stdio: 'inherit',
  });

  let stopping = false;
  let cancelFallback: (() => void) | undefined;

  function stop(signal: NodeJS.Signals) {
    if (stopping) {
      return;
    }
    stopping = true;
    cancelFallback = stopChildWithFallback(apiProcess, signal);
  }

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const exitCode = await new Promise<number>((resolve, reject) => {
    apiProcess.on('error', reject);
    apiProcess.on('exit', (code, signal) => {
      cancelFallback?.();
      if (signal) {
        resolve(stopping ? 0 : 1);
        return;
      }
      resolve(code ?? 0);
    });
  });

  return exitCode;
}

if (import.meta.main) {
  process.exit(await startApiFromCwd());
}
