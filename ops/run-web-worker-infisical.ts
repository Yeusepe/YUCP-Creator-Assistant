import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT_DIR = resolve(import.meta.dir, '..');
const DEFAULT_COMMAND = ['bun', 'run', '--filter', '@yucp/web', 'worker:dev'] as const;

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveInfisicalExecutable(): string {
  if (process.platform !== 'win32') {
    return 'infisical';
  }

  const appData = normalizeOptional(process.env.APPDATA);
  if (appData) {
    const bundledCli = join(
      appData,
      'npm',
      'node_modules',
      '@infisical',
      'cli',
      'bin',
      'infisical.exe'
    );
    if (existsSync(bundledCli)) {
      return bundledCli;
    }
  }

  return 'infisical.exe';
}

function withResolvedInfisicalExecutable(args: string[]): string[] {
  return [resolveInfisicalExecutable(), ...args.slice(1)];
}

export interface InfisicalRunConfig {
  projectId: string;
  environment: string;
  path: string;
  token?: string;
  host?: string;
  clientId?: string;
  clientSecret?: string;
}

export function resolveInfisicalRunConfig(
  env: NodeJS.ProcessEnv = process.env
): InfisicalRunConfig {
  const projectId = normalizeOptional(env.INFISICAL_PROJECT_ID);
  if (!projectId) {
    throw new Error(
      'INFISICAL_PROJECT_ID is required to run the local web Worker with Infisical watch mode.'
    );
  }

  const token = normalizeOptional(env.INFISICAL_TOKEN);
  const clientId = normalizeOptional(env.INFISICAL_CLIENT_ID ?? env.INFISICAL_MACHINE_IDENTITY_ID);
  const clientSecret = normalizeOptional(
    env.INFISICAL_CLIENT_SECRET ?? env.INFISICAL_MACHINE_IDENTITY_SECRET
  );

  if (!token && (!clientId || !clientSecret)) {
    throw new Error(
      'Set INFISICAL_TOKEN or provide INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET for local Infisical watch mode.'
    );
  }

  return {
    projectId,
    environment: normalizeOptional(env.INFISICAL_ENV) ?? 'dev',
    path: normalizeOptional(env.INFISICAL_WEB_SECRETS_PATH) ?? '/',
    token,
    host: normalizeOptional(env.INFISICAL_URL),
    clientId,
    clientSecret,
  };
}

// Infisical CLI docs:
// - https://infisical.com/docs/cli/commands/run
// - https://infisical.com/docs/documentation/platform/identities/universal-auth
export function buildInfisicalLoginArgs(config: InfisicalRunConfig): string[] {
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      'INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET are required when INFISICAL_TOKEN is absent.'
    );
  }

  return [
    'infisical',
    'login',
    '--method=universal-auth',
    ...(config.host ? [`--host=${config.host}`] : []),
    '--plain',
    '--silent',
  ];
}

export function buildInfisicalRunArgs(
  config: Pick<InfisicalRunConfig, 'projectId' | 'environment' | 'path'>,
  command: readonly string[] = DEFAULT_COMMAND
): string[] {
  return [
    'infisical',
    'run',
    '--watch',
    `--projectId=${config.projectId}`,
    `--env=${config.environment}`,
    `--path=${config.path}`,
    '--',
    ...command,
  ];
}

async function readProcessOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }

  return new Response(stream).text();
}

async function resolveInfisicalToken(
  config: InfisicalRunConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (config.token) {
    return config.token;
  }

  const proc = Bun.spawn({
    cmd: withResolvedInfisicalExecutable(buildInfisicalLoginArgs(config)),
    cwd: ROOT_DIR,
    env: {
      ...env,
      INFISICAL_DISABLE_UPDATE_CHECK: 'true',
      INFISICAL_CLIENT_ID: config.clientId,
      INFISICAL_CLIENT_SECRET: config.clientSecret,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessOutput(proc.stdout),
    readProcessOutput(proc.stderr),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    throw new Error(details || `infisical login failed with exit code ${exitCode}`);
  }

  const token = normalizeOptional(stdout);
  if (!token) {
    throw new Error('infisical login returned no access token.');
  }

  return token;
}

async function main(): Promise<void> {
  const config = resolveInfisicalRunConfig();
  const token = await resolveInfisicalToken(config);
  const child = Bun.spawn({
    cmd: withResolvedInfisicalExecutable(
      buildInfisicalRunArgs({
        projectId: config.projectId,
        environment: config.environment,
        path: config.path,
      })
    ),
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      INFISICAL_DISABLE_UPDATE_CHECK: 'true',
      INFISICAL_TOKEN: token,
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const stopChild = () => {
    try {
      child.kill();
    } catch {
      // Ignore shutdown races when the watched command already exited.
    }
  };

  process.on('SIGINT', stopChild);
  process.on('SIGTERM', stopChild);

  const exitCode = await child.exited;
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('run-web-worker-infisical:', error);
    process.exit(1);
  });
}
