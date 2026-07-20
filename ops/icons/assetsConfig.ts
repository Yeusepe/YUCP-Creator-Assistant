import type { CasConfig } from '../storage-core/config';
import { hydrateEnvFromInfisical } from '../storage-core/config';

const REQUIRED_ASSET_LOCATION_KEYS = [
  'ASSETS_S3_BUCKET',
  'ASSETS_S3_ENDPOINT',
  'ASSETS_S3_REGION',
] as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function requireValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = normalizeOptional(env[key]);
  if (!value) {
    throw new Error(`Missing required assets environment variable: ${key}`);
  }
  return value;
}

function normalizeAssetsEndpoint(rawEndpoint: string): string {
  const endpointWithScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(rawEndpoint)
    ? rawEndpoint
    : `https://${rawEndpoint}`;

  try {
    const endpoint = new URL(endpointWithScheme);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error('invalid endpoint');
    }
    return endpoint.origin;
  } catch {
    throw new Error('Invalid assets environment variable: ASSETS_S3_ENDPOINT');
  }
}

function resolveCredentialPair(env: NodeJS.ProcessEnv): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  const readonlyAccessKeyId = normalizeOptional(env.ASSETS_S3_READONLY_ACCESS_KEY_ID);
  const readonlySecretAccessKey = normalizeOptional(env.ASSETS_S3_READONLY_SECRET_ACCESS_KEY);

  if (Boolean(readonlyAccessKeyId) !== Boolean(readonlySecretAccessKey)) {
    throw new Error('Incomplete read-only assets credential pair');
  }
  if (readonlyAccessKeyId && readonlySecretAccessKey) {
    return { accessKeyId: readonlyAccessKeyId, secretAccessKey: readonlySecretAccessKey };
  }

  const accessKeyId = normalizeOptional(env.ASSETS_S3_ACCESS_KEY_ID);
  const secretAccessKey = normalizeOptional(env.ASSETS_S3_SECRET_ACCESS_KEY);
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error('Incomplete assets credential pair');
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing assets credentials: provide the read-only pair or the standard access-key pair'
    );
  }
  return { accessKeyId, secretAccessKey };
}

export function loadAssetsConfig(env: NodeJS.ProcessEnv): CasConfig {
  const credentials = resolveCredentialPair(env);
  const bucket = requireValue(env, 'ASSETS_S3_BUCKET');
  if (bucket.includes('/') || bucket.includes('\\')) {
    throw new Error('Invalid assets environment variable: ASSETS_S3_BUCKET');
  }

  return {
    endpoint: normalizeAssetsEndpoint(requireValue(env, 'ASSETS_S3_ENDPOINT')),
    region: requireValue(env, 'ASSETS_S3_REGION'),
    bucket,
    ...credentials,
    chunkPrefix: 'unused-by-icon-sync/',
    indexPrefix: 'unused-by-icon-sync/',
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

export async function resolveAssetsConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<CasConfig> {
  const hydratedEnv = await hydrateEnvFromInfisical(env, REQUIRED_ASSET_LOCATION_KEYS);
  return loadAssetsConfig(hydratedEnv);
}
