import { describe, expect, test } from 'bun:test';
import {
  createControlPlanePackageInstallerTufRepository,
  loadPackageInstallerTufRepositoryConfig,
} from './packageInstallerTufRepository';

const production = {
  MATERIALIZATION_API_SHARED_SECRET: 'test-api-shared-secret-that-is-long',
  MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL: 'https://materialization.example.test',
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
  test('routes production reads through the storage-side control plane', () => {
    expect(loadPackageInstallerTufRepositoryConfig(production)).toMatchObject({
      baseUrl: 'https://materialization.example.test',
      kind: 'control-plane',
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

  test('rejects partial control-plane production configuration', () => {
    expect(() =>
      loadPackageInstallerTufRepositoryConfig({
        NODE_ENV: 'production',
        MATERIALIZATION_CONTROL_PLANE_INTERNAL_BASE_URL: 'https://materialization.example.test',
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

  test('authenticates bounded reads and propagates trace context', async () => {
    const requests: Request[] = [];
    const repository = createControlPlanePackageInstallerTufRepository({
      baseUrl: 'https://materialization.example.test/',
      fetch: async (request) => {
        requests.push(request);
        return new Response('{"signed":"timestamp"}', {
          headers: {
            'content-length': '22',
            'content-type': 'application/json',
          },
        });
      },
      sharedSecret: 'test-api-shared-secret-that-is-long',
    });

    const object = await repository.read('metadata', 'timestamp.json', {
      traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    });

    expect(new TextDecoder().decode(object?.body)).toBe('{"signed":"timestamp"}');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://materialization.example.test/v2/internal/package-installer/tuf/metadata/timestamp.json'
    );
    expect(requests[0]?.headers.get('authorization')).toBe(
      'Bearer test-api-shared-secret-that-is-long'
    );
    expect(requests[0]?.headers.get('traceparent')).toBe(
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
    );
  });

  test('distinguishes missing objects from control-plane failures', async () => {
    const missing = createControlPlanePackageInstallerTufRepository({
      baseUrl: 'https://materialization.example.test',
      fetch: async () => new Response('Not found', { status: 404 }),
      sharedSecret: 'test-api-shared-secret-that-is-long',
    });
    expect(await missing.read('metadata', 'timestamp.json')).toBeNull();

    const unavailable = createControlPlanePackageInstallerTufRepository({
      baseUrl: 'https://materialization.example.test',
      fetch: async () => new Response('Unavailable', { status: 503 }),
      sharedSecret: 'test-api-shared-secret-that-is-long',
    });
    await expect(unavailable.read('metadata', 'timestamp.json')).rejects.toThrow(
      'control plane returned 503'
    );
  });
});
