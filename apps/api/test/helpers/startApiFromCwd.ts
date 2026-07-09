import { spawn } from 'node:child_process';
import path from 'node:path';

const targetCwd = process.env.YUCP_TEST_CWD?.trim();

if (!targetCwd) {
  throw new Error('YUCP_TEST_CWD must be set');
}

const apiEntry = path.resolve(import.meta.dir, '../../src/index.ts');
const apiProcess = spawn(process.execPath, ['run', apiEntry], {
  cwd: targetCwd,
  env: process.env,
  stdio: 'inherit',
});

let stopping = false;

function stop(signal: NodeJS.Signals) {
  stopping = true;
  apiProcess.kill(signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

const exitCode = await new Promise<number>((resolve, reject) => {
  apiProcess.on('error', reject);
  apiProcess.on('exit', (code, signal) => {
    if (signal) {
      resolve(stopping ? 0 : 1);
      return;
    }
    resolve(code ?? 0);
  });
});

process.exit(exitCode);
