import { MAX_PACKAGE_INSTALLER_HELPER_BYTES } from '@yucp/shared/packageInstallerLimits';
import {
  type CatalogDatabase,
  openCatalogDatabase,
  TufRepositoryCatalog,
} from '../../../../ops/catalog';
import { loadCasConfig } from '../../../../ops/storage-core/config';
import { S3ExactStoragePort } from '../../../../ops/storage-core/exactStorage';
import { normalizeTufRepositoryPath } from '../../../../ops/storage-core/tufRepositoryPath';
import { ExactTufRepositoryReader } from '../../../../ops/storage-core/tufRepositoryReader';
import {
  createFileSystemPackageInstallerTufRepository,
  type PackageInstallerTufRepository,
} from '../routes/packageInstallerTuf';

const EXACT_STORAGE_KEYS = [
  'PACKAGE_INSTALLER_TUF_CATALOG_DATABASE_URL',
  'PACKAGE_INSTALLER_TUF_REPOSITORY_ID',
  'PACKAGE_INSTALLER_TUF_S3_ACCESS_KEY_ID',
  'PACKAGE_INSTALLER_TUF_S3_BUCKET',
  'PACKAGE_INSTALLER_TUF_S3_ENDPOINT',
  'PACKAGE_INSTALLER_TUF_S3_REGION',
  'PACKAGE_INSTALLER_TUF_S3_SECRET_ACCESS_KEY',
] as const;
const CONTROL_PLANE_KEYS = [
  'MATERIALIZATION_API_SHARED_SECRET',
  'MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL',
] as const;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export type PackageInstallerTufRepositoryEnvironment = {
  MATERIALIZATION_API_SHARED_SECRET?: string;
  MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL?: string;
  NODE_ENV?: 'development' | 'production' | 'test';
  PACKAGE_INSTALLER_TUF_CATALOG_DATABASE_URL?: string;
  PACKAGE_INSTALLER_TUF_REPOSITORY_ID?: string;
  PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT?: string;
  PACKAGE_INSTALLER_TUF_S3_ACCESS_KEY_ID?: string;
  PACKAGE_INSTALLER_TUF_S3_BUCKET?: string;
  PACKAGE_INSTALLER_TUF_S3_ENDPOINT?: string;
  PACKAGE_INSTALLER_TUF_S3_REGION?: string;
  PACKAGE_INSTALLER_TUF_S3_REQUEST_TIMEOUT_MS?: string;
  PACKAGE_INSTALLER_TUF_S3_SECRET_ACCESS_KEY?: string;
};

export type PackageInstallerTufRepositoryConfig =
  | {
      baseUrl: string;
      kind: 'control-plane';
      sharedSecret: string;
    }
  | {
      kind: 'exact-storage';
      catalogDatabaseUrl: string;
      repositoryId: string;
      storage: ReturnType<typeof loadCasConfig>;
    }
  | {
      kind: 'filesystem';
      root: string;
    };

export type PackageInstallerTufRepositoryRuntime = {
  close?: () => Promise<void>;
  repository: PackageInstallerTufRepository;
};

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function requireExactValue(
  env: PackageInstallerTufRepositoryEnvironment,
  key: (typeof EXACT_STORAGE_KEYS)[number]
): string {
  const value = normalized(env[key]);
  if (!value) {
    throw new Error('Package installer TUF exact-storage settings must be configured together');
  }
  return value;
}

function requireControlPlaneValue(
  env: PackageInstallerTufRepositoryEnvironment,
  key: (typeof CONTROL_PLANE_KEYS)[number]
): string {
  const value = normalized(env[key]);
  if (!value) {
    throw new Error('Package installer TUF control-plane settings must be configured together');
  }
  return value;
}

function normalizeControlPlaneBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Package installer TUF control-plane URL is invalid');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('Package installer TUF control-plane URL is invalid');
  }
  return parsed.origin;
}

export function loadPackageInstallerTufRepositoryConfig(
  env: PackageInstallerTufRepositoryEnvironment
): PackageInstallerTufRepositoryConfig | null {
  const root = normalized(env.PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT);
  const configuredExactKeys = EXACT_STORAGE_KEYS.filter((key) => normalized(env[key]));
  const configuredControlPlaneKeys = CONTROL_PLANE_KEYS.filter((key) => normalized(env[key]));
  if (env.NODE_ENV === 'production' && root) {
    throw new Error('The filesystem TUF repository cannot run in production');
  }
  if (env.NODE_ENV === 'production') {
    if (configuredControlPlaneKeys.length !== CONTROL_PLANE_KEYS.length) {
      throw new Error('Package installer TUF control-plane settings must be configured together');
    }
    return {
      baseUrl: normalizeControlPlaneBaseUrl(
        requireControlPlaneValue(env, 'MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL')
      ),
      kind: 'control-plane',
      sharedSecret: requireControlPlaneValue(env, 'MATERIALIZATION_API_SHARED_SECRET'),
    };
  }
  if (root && (configuredExactKeys.length > 0 || configuredControlPlaneKeys.length > 0)) {
    throw new Error('Configure one package installer TUF repository adapter');
  }
  if (root) {
    return { kind: 'filesystem', root };
  }
  if (configuredControlPlaneKeys.length > 0) {
    if (configuredControlPlaneKeys.length !== CONTROL_PLANE_KEYS.length) {
      throw new Error('Package installer TUF control-plane settings must be configured together');
    }
    if (configuredExactKeys.length > 0) {
      throw new Error('Configure one package installer TUF repository adapter');
    }
    return {
      baseUrl: normalizeControlPlaneBaseUrl(
        requireControlPlaneValue(env, 'MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL')
      ),
      kind: 'control-plane',
      sharedSecret: requireControlPlaneValue(env, 'MATERIALIZATION_API_SHARED_SECRET'),
    };
  }
  if (configuredExactKeys.length === 0) {
    return null;
  }
  if (configuredExactKeys.length !== EXACT_STORAGE_KEYS.length) {
    throw new Error('Package installer TUF exact-storage settings must be configured together');
  }
  return {
    catalogDatabaseUrl: requireExactValue(env, 'PACKAGE_INSTALLER_TUF_CATALOG_DATABASE_URL'),
    kind: 'exact-storage',
    repositoryId: requireExactValue(env, 'PACKAGE_INSTALLER_TUF_REPOSITORY_ID'),
    storage: loadCasConfig({
      CAS_S3_ACCESS_KEY_ID: requireExactValue(env, 'PACKAGE_INSTALLER_TUF_S3_ACCESS_KEY_ID'),
      CAS_S3_BUCKET: requireExactValue(env, 'PACKAGE_INSTALLER_TUF_S3_BUCKET'),
      CAS_S3_ENDPOINT: requireExactValue(env, 'PACKAGE_INSTALLER_TUF_S3_ENDPOINT'),
      CAS_S3_REGION: requireExactValue(env, 'PACKAGE_INSTALLER_TUF_S3_REGION'),
      CAS_S3_REQUEST_TIMEOUT_MS: env.PACKAGE_INSTALLER_TUF_S3_REQUEST_TIMEOUT_MS,
      CAS_S3_SECRET_ACCESS_KEY: requireExactValue(
        env,
        'PACKAGE_INSTALLER_TUF_S3_SECRET_ACCESS_KEY'
      ),
    }),
  };
}

type PackageInstallerTufFetch = (request: Request) => Promise<Response>;

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<Uint8Array> {
  if (!body) {
    throw new Error('Package installer TUF control plane returned an empty body');
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error('Package installer TUF control-plane body is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function createControlPlanePackageInstallerTufRepository(input: {
  baseUrl: string;
  fetch?: PackageInstallerTufFetch;
  sharedSecret: string;
}): PackageInstallerTufRepository {
  const baseUrl = normalizeControlPlaneBaseUrl(input.baseUrl);
  const sharedSecret = input.sharedSecret.trim();
  if (Buffer.byteLength(sharedSecret, 'utf8') < 24) {
    throw new Error('Package installer TUF control-plane secret is invalid');
  }
  const fetchRequest = input.fetch ?? fetch;
  return {
    async read(role, repositoryPath, context) {
      const safePath = normalizeTufRepositoryPath(repositoryPath);
      if (!safePath) {
        throw new Error('Package installer TUF repository path is invalid');
      }
      const headers = new Headers({
        accept: role === 'metadata' ? 'application/json' : 'application/octet-stream',
        authorization: `Bearer ${sharedSecret}`,
      });
      const traceparent = context?.traceparent?.trim();
      if (traceparent && TRACEPARENT.test(traceparent)) {
        headers.set('traceparent', traceparent);
      }
      const response = await fetchRequest(
        new Request(`${baseUrl}/v2/internal/package-installer/tuf/${role}/${safePath}`, { headers })
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Package installer TUF control plane returned ${response.status}`);
      }
      const limit = role === 'metadata' ? MAX_METADATA_BYTES : MAX_PACKAGE_INSTALLER_HELPER_BYTES;
      const declaredLength = response.headers.get('content-length');
      if (
        declaredLength &&
        (!/^\d+$/.test(declaredLength) ||
          Number(declaredLength) < 1 ||
          Number(declaredLength) > limit)
      ) {
        throw new Error('Package installer TUF control-plane content length is invalid');
      }
      const body = await readBoundedBody(response.body, limit);
      if (body.byteLength < 1 || (declaredLength && body.byteLength !== Number(declaredLength))) {
        throw new Error('Package installer TUF control-plane body length is invalid');
      }
      const contentType = response.headers.get('content-type')?.trim();
      if (!contentType) {
        throw new Error('Package installer TUF control-plane content type is missing');
      }
      return { body, contentType };
    },
  };
}

export function buildPackageInstallerTufRepository(
  config: PackageInstallerTufRepositoryConfig | null
): PackageInstallerTufRepositoryRuntime | null {
  if (!config) {
    return null;
  }
  if (config.kind === 'control-plane') {
    return {
      repository: createControlPlanePackageInstallerTufRepository(config),
    };
  }
  if (config.kind === 'filesystem') {
    return {
      repository: createFileSystemPackageInstallerTufRepository(config.root),
    };
  }
  const database: CatalogDatabase = openCatalogDatabase(config.catalogDatabaseUrl);
  const storage = new S3ExactStoragePort({ metadata: config.storage });
  return {
    async close() {
      await database.end({ timeout: 5 });
    },
    repository: new ExactTufRepositoryReader({
      catalog: new TufRepositoryCatalog(database),
      repositoryId: config.repositoryId,
      storage,
    }),
  };
}
