import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { CasConfig } from './config';
import { runCommand } from './process';

const REQUIRED_DESYNC_COMMANDS = ['make', 'extract', 'chop', 'cat'] as const;

export type LocalStoreMeasurement = {
  bytes: number;
  chunks: number;
};

export type LocalCasStore = {
  kind: 'local';
  storePath: string;
};

export type S3CasStore = {
  kind: 's3';
  config: CasConfig;
};

export type CasStore = LocalCasStore | S3CasStore;

export function localCasStore(storePath: string): LocalCasStore {
  return { kind: 'local', storePath };
}

export function s3CasStore(config: CasConfig): S3CasStore {
  return { kind: 's3', config };
}

function encodeStorePath(value: string): string {
  const encoded = value
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return value.endsWith('/') ? `${encoded}/` : encoded;
}

/**
 * desync S3 URL contract: https://github.com/folbricht/desync#s3-store-urls
 */
export function buildDesyncS3StoreUrl(config: CasConfig, prefix = config.chunkPrefix): string {
  const endpoint = new URL(config.endpoint);
  const storePath = encodeStorePath(`${config.bucket}/${prefix}`);
  return `s3+${endpoint.protocol}//${endpoint.host}/${storePath}`;
}

function assertRemoteIndexId(indexId: string): void {
  const segments = indexId.split('/');
  if (
    !indexId ||
    indexId.startsWith('/') ||
    indexId.includes('\\') ||
    indexId.includes('?') ||
    indexId.includes('#') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('S3 CAS index ID must be a safe relative object key');
  }
}

function buildDesyncS3IndexUrl(config: CasConfig, indexId: string): string {
  assertRemoteIndexId(indexId);
  return buildDesyncS3StoreUrl(config, `${config.indexPrefix}${indexId}`);
}

/**
 * desync credential contract: https://github.com/folbricht/desync#environment-variables
 * The endpoint is encoded in the store URL. Credentials and region are scoped to one child only.
 */
export function desyncS3ChildEnv(config: CasConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.S3_ACCESS_KEY;
  delete env.S3_SECRET_KEY;
  delete env.S3_SESSION_TOKEN;
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_SECURITY_TOKEN;
  env.AWS_ACCESS_KEY_ID = config.accessKeyId;
  env.AWS_SECRET_ACCESS_KEY = config.secretAccessKey;
  env.AWS_REGION = config.region;
  env.AWS_DEFAULT_REGION = config.region;
  env.S3_REGION = config.region;
  return env;
}

export async function verifyDesyncCli(): Promise<void> {
  const { stdout } = await runCommand('desync', ['--help']);
  for (const command of REQUIRED_DESYNC_COMMANDS) {
    if (!new RegExp(`^\\s+${command}\\s`, 'm').test(stdout)) {
      throw new Error(`desync --help does not advertise the required ${command} subcommand.`);
    }
  }
}

export async function storeArtifact(input: {
  artifactPath: string;
  indexPath: string;
  storePath: string;
}): Promise<void> {
  await storeArtifactToStore({
    artifactPath: input.artifactPath,
    indexId: input.indexPath,
    store: localCasStore(input.storePath),
  });
}

export async function reconstructArtifact(input: {
  indexPath: string;
  outputPath: string;
  storePath: string;
}): Promise<void> {
  await reconstructArtifactFromStore({
    indexId: input.indexPath,
    outputPath: input.outputPath,
    store: localCasStore(input.storePath),
  });
}

export async function storeArtifactToStore(input: {
  artifactPath: string;
  indexId: string;
  store: CasStore;
}): Promise<void> {
  const artifactPath = resolve(input.artifactPath);
  if (input.store.kind === 'local') {
    const indexPath = resolve(input.indexId);
    const storePath = resolve(input.store.storePath);
    await mkdir(dirname(indexPath), { recursive: true });
    await mkdir(storePath, { recursive: true });
    await runCommand('desync', ['make', '--store', storePath, indexPath, artifactPath]);
    return;
  }

  const storeUrl = buildDesyncS3StoreUrl(input.store.config);
  const indexUrl = buildDesyncS3IndexUrl(input.store.config, input.indexId);
  await runCommand('desync', ['make', '--store', storeUrl, indexUrl, artifactPath], {
    env: desyncS3ChildEnv(input.store.config),
  });
}

export async function reconstructArtifactFromStore(input: {
  indexId: string;
  outputPath: string;
  store: CasStore;
}): Promise<void> {
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });

  if (input.store.kind === 'local') {
    await runCommand('desync', [
      'extract',
      '--store',
      resolve(input.store.storePath),
      resolve(input.indexId),
      outputPath,
    ]);
    return;
  }

  const storeUrl = buildDesyncS3StoreUrl(input.store.config);
  const indexUrl = buildDesyncS3IndexUrl(input.store.config, input.indexId);
  await runCommand('desync', ['extract', '--store', storeUrl, indexUrl, outputPath], {
    env: desyncS3ChildEnv(input.store.config),
  });
}

export async function measureLocalStore(storePath: string): Promise<LocalStoreMeasurement> {
  let bytes = 0;
  let chunks = 0;

  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        bytes += (await stat(entryPath)).size;
        chunks += 1;
      } else {
        throw new Error(`Unexpected non-file entry in desync store: ${entryPath}`);
      }
    }
  }

  await visit(resolve(storePath));
  return { bytes, chunks };
}
