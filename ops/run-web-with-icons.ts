import { resolve } from 'node:path';

const REPO_ROOT_DIR = resolve(import.meta.dir, '..');
const WEB_APP_DIR = resolve(REPO_ROOT_DIR, 'apps/web');
const BUN_EXECUTABLE = process.execPath;

const WEB_ENTRYPOINT_COMMANDS = {
  build: [[BUN_EXECUTABLE, 'x', 'vite', 'build']],
  dev: [[BUN_EXECUTABLE, 'x', 'vite', 'dev']],
  preview: [[BUN_EXECUTABLE, 'x', 'vite', 'preview']],
  test: [[BUN_EXECUTABLE, 'x', 'vitest', 'run', '--config', 'vitest.config.ts']],
  'worker:dev': [
    [BUN_EXECUTABLE, 'run', '../../ops/prepare-web-worker-env.ts'],
    [BUN_EXECUTABLE, 'x', 'vite', 'dev'],
  ],
  'worker:preview': [
    [BUN_EXECUTABLE, 'run', '../../ops/prepare-web-worker-env.ts'],
    [BUN_EXECUTABLE, 'x', 'wrangler', 'dev', '--config', 'wrangler.jsonc', '--local'],
  ],
} as const;

type WebEntrypoint = keyof typeof WEB_ENTRYPOINT_COMMANDS;

function isWebEntrypoint(value: string | undefined): value is WebEntrypoint {
  return value !== undefined && value in WEB_ENTRYPOINT_COMMANDS;
}

async function runCommand(command: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`);
  }
}

async function runLicensedIconSync(): Promise<void> {
  await runCommand([BUN_EXECUTABLE, 'run', 'icons:sync'], REPO_ROOT_DIR);
}

async function runCommands(
  commands: ReadonlyArray<readonly string[]>,
  passthroughArgs: readonly string[]
): Promise<void> {
  for (const [index, command] of commands.entries()) {
    const isFinalCommand = index === commands.length - 1;
    await runCommand(isFinalCommand ? [...command, ...passthroughArgs] : command, WEB_APP_DIR);
  }
}

async function main(): Promise<void> {
  const [entrypoint, ...passthroughArgs] = process.argv.slice(2);
  if (!isWebEntrypoint(entrypoint)) {
    throw new Error(
      `Unknown web entrypoint ${JSON.stringify(entrypoint)}. Expected one of: ${Object.keys(
        WEB_ENTRYPOINT_COMMANDS
      ).join(', ')}`
    );
  }

  await runLicensedIconSync();
  await runCommands(WEB_ENTRYPOINT_COMMANDS[entrypoint], passthroughArgs);
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-web-with-icons: ${message}`);
    process.exit(1);
  });
}
