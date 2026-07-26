import { describe, expect, test } from 'bun:test';
import { loadPackageInstallerTufRepositoryConfig } from './packageInstallerTufRepository';

const production = {
  NODE_ENV: 'production' as const,
  PACKAGE_INSTALLER_TUF_CATALOG_DATABASE_URL: 'postgres://reader:secret@catalog.example.test/yucp',
  PACKAGE_INSTALLER_TUF_REPOSITORY_ID: 'package-installer',
  PACKAGE_INSTALLER_TUF_S3_ACCESS_KEY_ID: 'reader',
  PACKAGE_INSTALLER_TUF_S3_BUCKET: 'metadata',
  PACKAGE_INSTALLER_TUF_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  PACKAGE_INSTALLER_TUF_S3_REGION: 'us-west-004',
  PACKAGE_INSTALLER_TUF_S3_SECRET_ACCESS_KEY: 'secret',
};

describe('package installer TUF repository configuration', () => {
  test('requires the exact storage-backed repository in production', () => {
    expect(loadPackageInstallerTufRepositoryConfig(production)).toMatchObject({
      kind: 'exact-storage',
      repositoryId: 'package-installer',
    });
  });

  test('rejects a local filesystem repository in production', () => {
    expect(() =>
      loadPackageInstallerTufRepositoryConfig({
        ...production,
        PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT: '/srv/tuf',
      })
    ).toThrow('filesystem TUF repository cannot run in production');
  });

  test('rejects partial exact-storage production configuration', () => {
    expect(() =>
      loadPackageInstallerTufRepositoryConfig({
        NODE_ENV: 'production',
        PACKAGE_INSTALLER_TUF_REPOSITORY_ID: 'package-installer',
      })
    ).toThrow('must be configured together');
  });

  test('keeps the filesystem adapter limited to local development', () => {
    expect(
      loadPackageInstallerTufRepositoryConfig({
        NODE_ENV: 'development',
        PACKAGE_INSTALLER_TUF_REPOSITORY_ROOT: 'C:\\local\\tuf',
      })
    ).toEqual({
      kind: 'filesystem',
      root: 'C:\\local\\tuf',
    });
  });
});
