import {
  type CatalogDatabase,
  openCatalogDatabase,
  TufRepositoryCatalog,
} from '../../../../ops/catalog';
import { loadCasConfig } from '../../../../ops/storage-core/config';
import { S3ExactStoragePort } from '../../../../ops/storage-core/exactStorage';
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

export type PackageInstallerTufRepositoryEnvironment = {
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

export function loadPackageInstallerTufRepositoryConfig(
  env: PackageInstallerTufRepositoryEnvironment
): PackageInstallerTufRepositoryConfig | null {
  const root = normalized(env.PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT);
  const configuredExactKeys = EXACT_STORAGE_KEYS.filter((key) => normalized(env[key]));
  if (env.NODE_ENV === 'production' && root) {
    throw new Error('The filesystem TUF repository cannot run in production');
  }
  if (root && configuredExactKeys.length > 0) {
    throw new Error('Configure one package installer TUF repository adapter');
  }
  if (root) {
    return { kind: 'filesystem', root };
  }
  if (configuredExactKeys.length === 0) {
    if (env.NODE_ENV === 'production') {
      throw new Error('Package installer TUF exact-storage settings must be configured together');
    }
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

export function buildPackageInstallerTufRepository(
  config: PackageInstallerTufRepositoryConfig | null
): PackageInstallerTufRepositoryRuntime | null {
  if (!config) {
    return null;
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
