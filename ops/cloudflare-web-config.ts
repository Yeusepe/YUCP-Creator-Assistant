import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import { buildBunToolCommand } from './cli-utils';

export const WEB_APP_DIR = resolve(import.meta.dir, '..', 'apps', 'web');
export const REPO_ROOT_DIR = resolve(import.meta.dir, '..');
export const REPO_ROOT_ENV_LOCAL_PATH = resolve(REPO_ROOT_DIR, '.env.local');
export const WEB_WRANGLER_CONFIG_PATH = resolve(WEB_APP_DIR, 'wrangler.jsonc');
export const WEB_LOCAL_ENV_PATH = resolve(WEB_APP_DIR, '.dev.vars');

export const WEB_BUILD_ENV_KEYS = [
  'BUILD_ID',
  'CONVEX_URL',
  'HYPERDX_API_KEY',
  'HYPERDX_APP_URL',
  'HYPERDX_OTLP_HTTP_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'SITE_URL',
] as const;

export const WEB_RUNTIME_VAR_KEYS = [
  'API_BASE_URL',
  'BUILD_ID',
  'CONVEX_SITE_URL',
  'CONVEX_URL',
  'FRONTEND_URL',
  'HYPERDX_APP_URL',
  'HYPERDX_OTLP_GRPC_URL',
  'HYPERDX_OTLP_HTTP_URL',
  'NODE_ENV',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'SITE_URL',
] as const;

export const WEB_SECRET_KEYS = [
  'HYPERDX_API_KEY',
  'INTERNAL_RPC_SHARED_SECRET',
  'OTEL_EXPORTER_OTLP_HEADERS',
] as const;

const WEB_LOCAL_ENV_KEYS = [
  ...new Set([...WEB_BUILD_ENV_KEYS, ...WEB_RUNTIME_VAR_KEYS, ...WEB_SECRET_KEYS]),
] as const;

type WebKeyList = readonly string[];

export interface FetchWebEnvOptions {
  prod: boolean;
  infisicalPath?: string;
  projectId?: string;
  env?: NodeJS.ProcessEnv;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readProcessOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return Promise.resolve('');
  }
  return new Response(stream).text();
}

function parseJsonMap(input: string): Record<string, string> {
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Infisical export did not return a JSON object');
  }

  return Object.fromEntries(
    Object.entries(parsed)
      .map(
        ([key, value]) =>
          [key, typeof value === 'string' ? normalizeOptional(value) : undefined] as const
      )
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  );
}

function pickValues(source: Record<string, string>, keys: WebKeyList): Record<string, string> {
  return Object.fromEntries(
    keys
      .map((key) => [key, normalizeOptional(source[key])] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  );
}

function resolveDefaultBuildId(): string {
  const existing = normalizeOptional(process.env.BUILD_ID);
  if (existing) {
    return existing;
  }

  const proc = Bun.spawnSync({
    cmd: ['git', '--no-pager', 'rev-parse', '--short', 'HEAD'],
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const gitBuildId = normalizeOptional(proc.stdout.toString());
  return gitBuildId ?? 'dev';
}

export function resolveInfisicalCommand(args: string[]): string[] {
  if (process.platform !== 'win32') {
    return ['infisical', ...args];
  }

  const escapeForPowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    'pwsh',
    '-NoLogo',
    '-NoProfile',
    '-Command',
    `& infisical ${args.map(escapeForPowerShell).join(' ')}`,
  ];
}

export function resolveWebEnvValues(
  source: Record<string, string>,
  options: { prod: boolean }
): Record<string, string> {
  const resolved = { ...source };

  if (!resolved.SITE_URL && resolved.FRONTEND_URL) {
    resolved.SITE_URL = resolved.FRONTEND_URL;
  }
  if (!resolved.FRONTEND_URL && resolved.SITE_URL) {
    resolved.FRONTEND_URL = resolved.SITE_URL;
  }
  if (!resolved.HYPERDX_OTLP_HTTP_URL && resolved.OTEL_EXPORTER_OTLP_ENDPOINT) {
    resolved.HYPERDX_OTLP_HTTP_URL = resolved.OTEL_EXPORTER_OTLP_ENDPOINT;
  }
  if (!resolved.OTEL_EXPORTER_OTLP_ENDPOINT && resolved.HYPERDX_OTLP_HTTP_URL) {
    resolved.OTEL_EXPORTER_OTLP_ENDPOINT = resolved.HYPERDX_OTLP_HTTP_URL;
  }

  resolved.BUILD_ID ??= resolveDefaultBuildId();
  resolved.NODE_ENV ??= options.prod ? 'production' : 'development';

  return resolved;
}

export function getWebLocalEnvValues(source: Record<string, string>): Record<string, string> {
  return pickValues(source, WEB_LOCAL_ENV_KEYS);
}

export function getWebRuntimeVarValues(source: Record<string, string>): Record<string, string> {
  return pickValues(source, WEB_RUNTIME_VAR_KEYS);
}

export function getWebSecretValues(source: Record<string, string>): Record<string, string> {
  return pickValues(source, WEB_SECRET_KEYS);
}

export function createWebDeployEnvironment(source: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...getWebLocalEnvValues(source),
  } satisfies NodeJS.ProcessEnv;
}

function escapeDotenvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

export function formatDotenv(values: Record<string, string>): string {
  return `${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${escapeDotenvValue(value)}`)
    .join('\n')}\n`;
}

export function writeDotenvFile(filePath: string, values: Record<string, string>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, formatDotenv(values), 'utf8');
}

export async function fetchWebEnvFromInfisical({
  prod,
  infisicalPath,
  projectId,
  env,
}: FetchWebEnvOptions): Promise<Record<string, string>> {
  const infisicalEnv = env ?? process.env;
  const resolvedProjectId = normalizeOptional(projectId ?? infisicalEnv.INFISICAL_PROJECT_ID);
  const args = [
    'export',
    '--format=json',
    `--env=${prod ? 'prod' : 'dev'}`,
    `--path=${infisicalPath ?? infisicalEnv.INFISICAL_WEB_SECRETS_PATH ?? '/'}`,
  ];

  if (resolvedProjectId) {
    args.push(`--projectId=${resolvedProjectId}`);
  }

  const proc = Bun.spawn({
    cmd: resolveInfisicalCommand(args),
    env: {
      ...infisicalEnv,
      INFISICAL_DISABLE_UPDATE_CHECK: 'true',
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
    throw new Error(details || `infisical export failed with exit code ${exitCode}`);
  }

  if (!stdout.trim()) {
    throw new Error(
      'Infisical export returned no data. Provide --projectId=<id> or INFISICAL_PROJECT_ID when this repo is not linked with .infisical.json, and authenticate the CLI or set INFISICAL_TOKEN.'
    );
  }

  return parseJsonMap(stdout);
}

function loadWranglerConfig(): Record<string, unknown> {
  const text = readFileSync(WEB_WRANGLER_CONFIG_PATH, 'utf8');
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      `Failed to parse ${WEB_WRANGLER_CONFIG_PATH}: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${WEB_WRANGLER_CONFIG_PATH}`);
  }
  return value as Record<string, unknown>;
}

export function createTemporaryWranglerConfig(
  runtimeVars: Record<string, string>,
  workerEnvName?: string
): { path: string; cleanup: () => void } {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'yucp-web-wrangler-'));
  const configPath = join(temporaryDirectory, 'wrangler.jsonc');
  const config = loadWranglerConfig();

  if (workerEnvName) {
    const currentEnvironments =
      typeof config.env === 'object' && config.env && !Array.isArray(config.env)
        ? (config.env as Record<string, Record<string, unknown>>)
        : {};

    config.env = {
      ...currentEnvironments,
      [workerEnvName]: {
        ...(currentEnvironments[workerEnvName] ?? {}),
        vars: runtimeVars,
      },
    };
  } else {
    config.vars = runtimeVars;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  return {
    path: configPath,
    cleanup: () => {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    },
  };
}

export async function runWranglerSecretBulk(
  secretValues: Record<string, string>,
  configPath: string,
  workerEnvName?: string
): Promise<void> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'yucp-web-secrets-'));
  const secretsFilePath = join(temporaryDirectory, 'secrets.json');

  try {
    writeFileSync(secretsFilePath, JSON.stringify(secretValues, null, 2), 'utf8');

    const args = ['wrangler', 'secret', 'bulk', secretsFilePath, '--config', configPath];
    if (workerEnvName) {
      args.push('--env', workerEnvName);
    }

    const proc = Bun.spawn({
      cmd: buildBunToolCommand('wrangler', args),
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'inherit',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessOutput(proc.stdout),
      readProcessOutput(proc.stderr),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      throw new Error(details || `wrangler secret bulk failed with exit code ${exitCode}`);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runWranglerDeploy(
  configPath: string,
  deployEnv: NodeJS.ProcessEnv,
  extraArgs: string[],
  workerEnvName?: string
): Promise<void> {
  const args = ['wrangler', 'deploy', '--config', configPath];
  if (workerEnvName) {
    args.push('--env', workerEnvName);
  }
  args.push(...extraArgs);

  const proc = Bun.spawn({
    cmd: buildBunToolCommand('wrangler', args),
    env: deployEnv,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`wrangler deploy failed with exit code ${exitCode}`);
  }
}
