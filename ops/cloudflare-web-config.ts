import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import { buildWranglerCommand } from './cli-utils';

export const WEB_APP_DIR = resolve(import.meta.dir, '..', 'apps', 'web');
export const REPO_ROOT_DIR = resolve(import.meta.dir, '..');
export const DELIVERY_WORKER_WRANGLER_CONFIG_PATH = resolve(
  REPO_ROOT_DIR,
  'services',
  'delivery-worker',
  'wrangler.jsonc'
);
export const MATERIALIZATION_SOURCE_WORKER_WRANGLER_CONFIG_PATH = resolve(
  REPO_ROOT_DIR,
  'services',
  'materialization-source-worker',
  'wrangler.jsonc'
);
export const REPO_ROOT_ENV_LOCAL_PATH = resolve(REPO_ROOT_DIR, '.env.local');
export const WEB_WRANGLER_CONFIG_PATH = resolve(WEB_APP_DIR, 'wrangler.jsonc');
export const WEB_DIST_SERVER_DIR = resolve(WEB_APP_DIR, 'dist', 'server');
export const WEB_GENERATED_WRANGLER_CONFIG_PATH = resolve(WEB_DIST_SERVER_DIR, 'wrangler.json');

export function resolveWebLocalEnvPath(env: Record<string, string | undefined> = process.env) {
  const configuredPath = normalizeOptional(env.WEB_LOCAL_ENV_PATH);
  return configuredPath ? resolve(configuredPath) : resolve(WEB_APP_DIR, '.dev.vars');
}

export const WEB_LOCAL_ENV_PATH = resolveWebLocalEnvPath();

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
  'YUCP_ENABLE_AUTOMATIC_SETUP',
  'YUCP_ENABLE_PRIVATE_VPM',
] as const;

export const WEB_SECRET_KEYS = [
  'HYPERDX_API_KEY',
  'INTERNAL_RPC_SHARED_SECRET',
  'OTEL_EXPORTER_OTLP_HEADERS',
] as const;

export const DELIVERY_WORKER_BINDING_KEYS = [
  'COMMON_S3_ENDPOINT',
  'COMMON_S3_REGION',
  'COMMON_S3_BUCKET',
  'COMMON_S3_READONLY_ACCESS_KEY_ID',
  'COMMON_S3_READONLY_SECRET_ACCESS_KEY',
  'COMMON_CHUNK_PREFIX',
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_BUCKET',
  'METADATA_S3_READONLY_ACCESS_KEY_ID',
  'METADATA_S3_READONLY_SECRET_ACCESS_KEY',
  'METADATA_INDEX_PREFIX',
  'PACKAGE_DELIVERY_AUDIENCE',
  'PACKAGE_INSTALL_ISSUER',
  'PACKAGE_INSTALL_SIGNING_KEY_ID',
  'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY',
  'STORAGE_FORMAT_VERSION',
] as const;

export const MATERIALIZATION_SOURCE_WORKER_BINDING_KEYS = [
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_BUCKET',
  'METADATA_S3_READONLY_ACCESS_KEY_ID',
  'METADATA_S3_READONLY_SECRET_ACCESS_KEY',
  'METADATA_INDEX_PREFIX',
  'PROTECTED_S3_ENDPOINT',
  'PROTECTED_S3_REGION',
  'PROTECTED_S3_BUCKET',
  'PROTECTED_S3_READONLY_ACCESS_KEY_ID',
  'PROTECTED_S3_READONLY_SECRET_ACCESS_KEY',
  'PROTECTED_CHUNK_PREFIX',
  'STORAGE_FORMAT_VERSION',
  'DELIVERY_GRANT_KEY_ID',
  'DELIVERY_GRANT_ISSUER',
  'DELIVERY_GRANT_PUBLIC_KEY',
  'MATERIALIZATION_SOURCE_AUDIENCE',
] as const;

export const MATERIALIZATION_SOURCE_WORKER_SOURCE_KEYS = [
  'METADATA_S3_ENDPOINT',
  'METADATA_S3_REGION',
  'METADATA_S3_BUCKET',
  'METADATA_S3_READONLY_ACCESS_KEY_ID',
  'METADATA_S3_READONLY_SECRET_ACCESS_KEY',
  'METADATA_INDEX_PREFIX',
  'PROTECTED_S3_ENDPOINT',
  'PROTECTED_S3_REGION',
  'PROTECTED_S3_BUCKET',
  'PROTECTED_S3_READONLY_ACCESS_KEY_ID',
  'PROTECTED_S3_READONLY_SECRET_ACCESS_KEY',
  'PROTECTED_CHUNK_PREFIX',
  'STORAGE_FORMAT_VERSION',
  'MATERIALIZATION_SOURCE_GRANT_KEY_ID',
  'MATERIALIZATION_SOURCE_GRANT_ISSUER',
  'MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY',
  'MATERIALIZATION_SOURCE_GRANT_AUDIENCE',
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

export function getDeliveryWorkerBindingValues(
  source: Record<string, string>
): Record<string, string> {
  return pickValues(source, DELIVERY_WORKER_BINDING_KEYS);
}

function deriveEd25519PublicKey(privateSeedText: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(privateSeedText)) {
    throw new Error('MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY must use unpadded base64url');
  }
  const seed = Buffer.from(privateSeedText, 'base64url');
  if (seed.byteLength !== 32) {
    seed.fill(0);
    throw new Error('MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY must decode to 32 bytes');
  }
  const privatePrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const privateDer = Buffer.concat([privatePrefix, seed]);
  try {
    const privateKey = createPrivateKey({
      format: 'der',
      key: privateDer,
      type: 'pkcs8',
    });
    const publicDer = createPublicKey(privateKey).export({
      format: 'der',
      type: 'spki',
    });
    const publicPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    if (
      !Buffer.isBuffer(publicDer) ||
      publicDer.byteLength !== publicPrefix.byteLength + 32 ||
      !publicDer.subarray(0, publicPrefix.byteLength).equals(publicPrefix)
    ) {
      throw new Error('Derived materialization source public key is invalid');
    }
    return publicDer.subarray(publicPrefix.byteLength).toString('base64url');
  } finally {
    privateDer.fill(0);
    seed.fill(0);
  }
}

export function getMaterializationSourceWorkerBindingValues(
  source: Record<string, string>
): Record<string, string> {
  const directBindings = pickValues(source, [
    'METADATA_S3_ENDPOINT',
    'METADATA_S3_REGION',
    'METADATA_S3_BUCKET',
    'METADATA_S3_READONLY_ACCESS_KEY_ID',
    'METADATA_S3_READONLY_SECRET_ACCESS_KEY',
    'METADATA_INDEX_PREFIX',
    'PROTECTED_S3_ENDPOINT',
    'PROTECTED_S3_REGION',
    'PROTECTED_S3_BUCKET',
    'PROTECTED_S3_READONLY_ACCESS_KEY_ID',
    'PROTECTED_S3_READONLY_SECRET_ACCESS_KEY',
    'PROTECTED_CHUNK_PREFIX',
    'STORAGE_FORMAT_VERSION',
  ]);
  const privateSeed = normalizeOptional(source.MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY);
  const aliases = {
    ...(normalizeOptional(source.MATERIALIZATION_SOURCE_GRANT_KEY_ID)
      ? { DELIVERY_GRANT_KEY_ID: source.MATERIALIZATION_SOURCE_GRANT_KEY_ID.trim() }
      : {}),
    ...(normalizeOptional(source.MATERIALIZATION_SOURCE_GRANT_ISSUER)
      ? { DELIVERY_GRANT_ISSUER: source.MATERIALIZATION_SOURCE_GRANT_ISSUER.trim() }
      : {}),
    ...(privateSeed ? { DELIVERY_GRANT_PUBLIC_KEY: deriveEd25519PublicKey(privateSeed) } : {}),
    ...(normalizeOptional(source.MATERIALIZATION_SOURCE_GRANT_AUDIENCE)
      ? { MATERIALIZATION_SOURCE_AUDIENCE: source.MATERIALIZATION_SOURCE_GRANT_AUDIENCE.trim() }
      : {}),
  };
  const values = { ...directBindings, ...aliases };
  return Object.fromEntries(
    MATERIALIZATION_SOURCE_WORKER_BINDING_KEYS.flatMap((key) =>
      values[key] ? [[key, values[key]]] : []
    )
  );
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

function loadWranglerConfigFromPath(configPath: string): Record<string, unknown> {
  const text = readFileSync(configPath, 'utf8');
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    const [first] = errors;
    if (!first) {
      throw new Error(`Failed to parse ${configPath}: unknown parse error`);
    }
    throw new Error(
      `Failed to parse ${configPath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${configPath}`);
  }
  return value as Record<string, unknown>;
}

function loadWranglerConfig(): Record<string, unknown> {
  return loadWranglerConfigFromPath(WEB_WRANGLER_CONFIG_PATH);
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

    const args = ['secret', 'bulk', secretsFilePath, '--config', configPath];
    if (workerEnvName) {
      args.push('--env', workerEnvName);
    }

    const proc = Bun.spawn({
      cmd: buildWranglerCommand(args),
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

export interface TemporaryDeliveryWorkerDeployArtifacts {
  configPath: string;
  secretsPath: string;
  cleanup: () => void;
}

export function createTemporaryDeliveryWorkerDeployArtifacts(
  secretValues: Record<string, string>,
  workerEnvName?: string,
  sourceConfigPath = DELIVERY_WORKER_WRANGLER_CONFIG_PATH
): TemporaryDeliveryWorkerDeployArtifacts {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'yucp-delivery-worker-deploy-'));
  const configPath = join(temporaryDirectory, 'wrangler.json');
  const secretsPath = join(temporaryDirectory, 'secrets.json');

  try {
    const config = loadWranglerConfigFromPath(sourceConfigPath);
    const configuredMain = normalizeOptional(
      typeof config.main === 'string' ? config.main : undefined
    );
    if (!configuredMain) {
      throw new Error(`Delivery Worker config ${sourceConfigPath} is missing main`);
    }

    config.main = resolve(dirname(sourceConfigPath), configuredMain);
    const required = Object.keys(secretValues);

    if (workerEnvName) {
      const environments =
        typeof config.env === 'object' && config.env && !Array.isArray(config.env)
          ? (config.env as Record<string, Record<string, unknown>>)
          : {};
      const targetEnvironment = { ...(environments[workerEnvName] ?? {}) };
      delete targetEnvironment.vars;
      targetEnvironment.secrets = { required };
      config.env = {
        ...environments,
        [workerEnvName]: targetEnvironment,
      };
    } else {
      delete config.vars;
      config.secrets = { required };
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    writeFileSync(secretsPath, JSON.stringify(secretValues), 'utf8');

    return {
      configPath,
      secretsPath,
      cleanup: () => {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function buildWranglerDeployWithSecretsArgs(
  configPath: string,
  secretsPath: string,
  workerEnvName?: string
): string[] {
  const args = ['deploy', '--config', configPath, '--secrets-file', secretsPath];
  if (workerEnvName) {
    args.push('--env', workerEnvName);
  }
  return args;
}

export async function runWranglerDeployWithSecrets(
  secretValues: Record<string, string>,
  workerEnvName?: string,
  sourceConfigPath = DELIVERY_WORKER_WRANGLER_CONFIG_PATH
): Promise<void> {
  const artifacts = createTemporaryDeliveryWorkerDeployArtifacts(
    secretValues,
    workerEnvName,
    sourceConfigPath
  );

  try {
    const proc = Bun.spawn({
      cmd: buildWranglerCommand(
        buildWranglerDeployWithSecretsArgs(
          artifacts.configPath,
          artifacts.secretsPath,
          workerEnvName
        )
      ),
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`wrangler deploy with secrets failed with exit code ${exitCode}`);
    }
  } finally {
    artifacts.cleanup();
  }
}

export async function runWranglerDeploy(
  configPath: string,
  deployEnv: NodeJS.ProcessEnv,
  extraArgs: string[],
  workerEnvName?: string
): Promise<void> {
  const args = ['deploy', '--config', configPath];
  if (workerEnvName) {
    args.push('--env', workerEnvName);
  }
  args.push(...extraArgs);

  const proc = Bun.spawn({
    cmd: buildWranglerCommand(args),
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

export async function runWranglerVersionsUpload(
  configPath: string,
  deployEnv: NodeJS.ProcessEnv,
  extraArgs: string[],
  workerEnvName?: string
): Promise<void> {
  const args = ['versions', 'upload', '--config', configPath];
  if (workerEnvName) {
    args.push('--env', workerEnvName);
  }
  args.push(...extraArgs);

  const proc = Bun.spawn({
    cmd: buildWranglerCommand(args),
    env: deployEnv,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`wrangler versions upload failed with exit code ${exitCode}`);
  }
}
