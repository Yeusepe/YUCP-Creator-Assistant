import { resolve } from 'node:path';
import { isLicensedIconGeneratedModuleFresh } from './icons/generatedModuleFreshness';

const REPO_ROOT_DIR = resolve(import.meta.dir, '..');
const WEB_APP_DIR = resolve(REPO_ROOT_DIR, 'apps/web');
const BUN_EXECUTABLE = process.execPath;

const LICENSED_ICON_ENTRYPOINT_DEFINITIONS = {
  build: {
    commands: [[BUN_EXECUTABLE, 'x', 'vite', 'build']],
    workingDirectory: WEB_APP_DIR,
  },
  dev: {
    commands: [[BUN_EXECUTABLE, 'x', 'vite', 'dev']],
    workingDirectory: WEB_APP_DIR,
  },
  preview: {
    commands: [[BUN_EXECUTABLE, 'x', 'vite', 'preview']],
    workingDirectory: WEB_APP_DIR,
  },
  test: {
    commands: [[BUN_EXECUTABLE, 'x', 'vitest', 'run', '--config', 'vitest.config.ts']],
    workingDirectory: WEB_APP_DIR,
  },
  'test:e2e': {
    commands: [[BUN_EXECUTABLE, 'x', 'playwright', 'test', '--config', 'playwright.config.ts']],
    workingDirectory: WEB_APP_DIR,
  },
  'test:e2e:forensics': {
    commands: [
      [BUN_EXECUTABLE, 'x', 'playwright', 'test', '--config', 'playwright.forensics.config.ts'],
    ],
    workingDirectory: WEB_APP_DIR,
  },
  'test:perf': {
    commands: [
      [
        BUN_EXECUTABLE,
        'x',
        'playwright',
        'test',
        '--config',
        'playwright.config.ts',
        'test/performance/',
      ],
    ],
    workingDirectory: WEB_APP_DIR,
  },
  'worker:dev': {
    commands: [
      [BUN_EXECUTABLE, 'run', '../../ops/prepare-web-worker-env.ts'],
      [BUN_EXECUTABLE, 'x', 'vite', 'dev'],
    ],
    workingDirectory: WEB_APP_DIR,
  },
  'worker:preview': {
    commands: [
      [BUN_EXECUTABLE, 'run', '../../ops/prepare-web-worker-env.ts'],
      [BUN_EXECUTABLE, 'x', 'wrangler', 'dev', '--config', 'wrangler.jsonc', '--local'],
    ],
    workingDirectory: WEB_APP_DIR,
  },
  'external-integrations': {
    commands: [[BUN_EXECUTABLE, 'run', 'ops/test-external-integrations.ts']],
    workingDirectory: REPO_ROOT_DIR,
  },
} as const;

type LicensedIconEntrypoint = keyof typeof LICENSED_ICON_ENTRYPOINT_DEFINITIONS;

function isLicensedIconEntrypoint(value: string | undefined): value is LicensedIconEntrypoint {
  return value !== undefined && value in LICENSED_ICON_ENTRYPOINT_DEFINITIONS;
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

async function ensureLicensedIcons(): Promise<void> {
  // generated.tsx is gitignored and excluded from Docker contexts, so CI, Cloudflare, and Docker
  // clean builds always fetch. Fresh reuse only unblocks a local checkout that already synced.
  if (await isLicensedIconGeneratedModuleFresh()) {
    return;
  }

  await runLicensedIconSync();
}

async function runCommands(
  commands: ReadonlyArray<readonly string[]>,
  passthroughArgs: readonly string[],
  workingDirectory: string
): Promise<void> {
  for (const [index, command] of commands.entries()) {
    const isFinalCommand = index === commands.length - 1;
    await runCommand(isFinalCommand ? [...command, ...passthroughArgs] : command, workingDirectory);
  }
}

async function main(): Promise<void> {
  const [entrypoint, ...passthroughArgs] = process.argv.slice(2);
  if (!isLicensedIconEntrypoint(entrypoint)) {
    throw new Error(
      `Unknown web entrypoint ${JSON.stringify(entrypoint)}. Expected one of: ${Object.keys(
        LICENSED_ICON_ENTRYPOINT_DEFINITIONS
      ).join(', ')}`
    );
  }

  const definition = LICENSED_ICON_ENTRYPOINT_DEFINITIONS[entrypoint];
  await ensureLicensedIcons();
  await runCommands(definition.commands, passthroughArgs, definition.workingDirectory);
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-web-with-icons: ${message}`);
    process.exit(1);
  });
}
