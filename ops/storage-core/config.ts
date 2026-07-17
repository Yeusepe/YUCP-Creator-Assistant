import { fetchInfisicalSecrets } from '@yucp/shared/infisical/fetchSecrets';

const REQUIRED_CAS_KEYS = [
  'CAS_S3_ENDPOINT',
  'CAS_S3_REGION',
  'CAS_S3_BUCKET',
  'CAS_S3_ACCESS_KEY_ID',
  'CAS_S3_SECRET_ACCESS_KEY',
] as const;

const REQUIRED_INGEST_KEYS = [
  'CATALOG_DATABASE_URL',
  ...REQUIRED_CAS_KEYS,
  'INGEST_UPLOAD_DIR',
  'INGEST_MAX_BYTES',
] as const;

export type CasConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  chunkPrefix: string;
  indexPrefix: string;
  requestTimeoutMs: number;
};

const DEFAULT_S3_REQUEST_TIMEOUT_MS = 30_000;

export type IngestRuntimeEnv = {
  catalogDatabaseUrl: string;
  ingestUploadDir: string;
  ingestMaxBytes: number;
  cas: CasConfig;
};

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function requireValue(env: NodeJS.ProcessEnv, key: (typeof REQUIRED_INGEST_KEYS)[number]): string {
  const value = normalizeOptional(env[key]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function normalizeEndpoint(rawEndpoint: string): string {
  try {
    const endpoint = new URL(rawEndpoint);
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
    throw new Error('Invalid CAS environment variable: CAS_S3_ENDPOINT');
  }
}

function normalizePrefix(
  value: string | undefined,
  fallback: string,
  key: 'CAS_CHUNK_PREFIX' | 'CAS_INDEX_PREFIX'
): string {
  const normalized = normalizeOptional(value) ?? fallback;
  const withoutLeadingSlash = normalized.replace(/^\/+/, '');
  const segments = withoutLeadingSlash.split('/').filter(Boolean);
  if (
    !withoutLeadingSlash ||
    normalized.includes('\\') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid CAS environment variable: ${key}`);
  }
  return `${segments.join('/')}/`;
}

function hasInfisicalBootstrap(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    normalizeOptional(env.INFISICAL_PROJECT_ID) &&
      normalizeOptional(env.INFISICAL_CLIENT_ID ?? env.INFISICAL_MACHINE_IDENTITY_ID) &&
      normalizeOptional(env.INFISICAL_CLIENT_SECRET ?? env.INFISICAL_MACHINE_IDENTITY_SECRET)
  );
}

export function loadCasConfig(env: NodeJS.ProcessEnv = process.env): CasConfig {
  const missing = REQUIRED_CAS_KEYS.filter((key) => !normalizeOptional(env[key]));
  if (missing.length > 0) {
    throw new Error(`Missing required CAS environment variables: ${missing.join(', ')}`);
  }

  const bucket = requireValue(env, 'CAS_S3_BUCKET');
  if (bucket.includes('/') || bucket.includes('\\')) {
    throw new Error('Invalid CAS environment variable: CAS_S3_BUCKET');
  }
  const requestTimeoutMs = Number(
    normalizeOptional(env.CAS_S3_REQUEST_TIMEOUT_MS) ?? DEFAULT_S3_REQUEST_TIMEOUT_MS
  );
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('Invalid CAS environment variable: CAS_S3_REQUEST_TIMEOUT_MS');
  }

  return {
    endpoint: normalizeEndpoint(requireValue(env, 'CAS_S3_ENDPOINT')),
    region: requireValue(env, 'CAS_S3_REGION'),
    bucket,
    accessKeyId: requireValue(env, 'CAS_S3_ACCESS_KEY_ID'),
    secretAccessKey: requireValue(env, 'CAS_S3_SECRET_ACCESS_KEY'),
    chunkPrefix: normalizePrefix(env.CAS_CHUNK_PREFIX, 'chunks/', 'CAS_CHUNK_PREFIX'),
    indexPrefix: normalizePrefix(env.CAS_INDEX_PREFIX, 'indexes/', 'CAS_INDEX_PREFIX'),
    requestTimeoutMs,
  };
}

/**
 * Hydrate the ingest runtime from Infisical when a complete machine-identity bootstrap is present,
 * then validate the whole local runtime contract. Secret values are never logged or included in
 * validation errors.
 */
export async function loadIngestRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<IngestRuntimeEnv> {
  const runtimeEnv = { ...env };
  if (hasInfisicalBootstrap(runtimeEnv)) {
    const secrets = await fetchInfisicalSecrets(runtimeEnv);
    for (const [key, value] of Object.entries(secrets)) {
      if (!normalizeOptional(runtimeEnv[key])) {
        runtimeEnv[key] = value;
      }
    }
  }

  const missing = REQUIRED_INGEST_KEYS.filter((key) => !normalizeOptional(runtimeEnv[key]));
  if (missing.length > 0) {
    throw new Error(`Missing required ingest environment variables: ${missing.join(', ')}`);
  }

  const ingestMaxBytes = Number(requireValue(runtimeEnv, 'INGEST_MAX_BYTES'));
  if (!Number.isSafeInteger(ingestMaxBytes) || ingestMaxBytes <= 0) {
    throw new Error('Invalid ingest environment variable: INGEST_MAX_BYTES');
  }

  return {
    catalogDatabaseUrl: requireValue(runtimeEnv, 'CATALOG_DATABASE_URL'),
    ingestUploadDir: requireValue(runtimeEnv, 'INGEST_UPLOAD_DIR'),
    ingestMaxBytes,
    cas: loadCasConfig(runtimeEnv),
  };
}
