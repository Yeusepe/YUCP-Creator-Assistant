import { describe, expect, it, mock } from 'bun:test';
import {
  loadSchedulerRuntimeEnv,
  SCHEDULER_INFISICAL_KEYS,
  schedulerErrorDiagnostic,
} from './server';

const COMPLETE_RAW_ENV = {
  INFISICAL_PROJECT_ID: 'placeholder-project-id',
  INFISICAL_CLIENT_ID: 'placeholder-client-id',
  INFISICAL_CLIENT_SECRET: 'placeholder-client-secret',
  CONVEX_API_SECRET: 'placeholder-raw-convex-api-secret',
  CONVEX_URL: 'https://raw-convex.invalid',
  INTERNAL_SERVICE_AUTH_SECRET: 'placeholder-raw-internal-auth-secret',
  CATALOG_MAX_ATTEMPTS: '5',
  CATALOG_DATABASE_URL: 'postgresql://raw.invalid/catalog',
  INGEST_SCRATCH_DIR: 'C:/tmp/yucp-scheduler-scratch',
  COMMON_S3_ENDPOINT: 'https://raw-common.invalid',
  COMMON_S3_REGION: 'raw-region',
  COMMON_S3_BUCKET: 'raw-common',
  COMMON_S3_ACCESS_KEY_ID: 'placeholder-raw-common-key-id',
  COMMON_S3_SECRET_ACCESS_KEY: 'placeholder-raw-common-key-secret',
  METADATA_S3_ENDPOINT: 'https://raw-metadata.invalid',
  METADATA_S3_REGION: 'raw-region',
  METADATA_S3_BUCKET: 'raw-metadata',
  METADATA_S3_ACCESS_KEY_ID: 'placeholder-raw-metadata-key-id',
  METADATA_S3_SECRET_ACCESS_KEY: 'placeholder-raw-metadata-key-secret',
  PROTECTED_S3_ENDPOINT: 'https://raw-protected.invalid',
  PROTECTED_S3_REGION: 'raw-region',
  PROTECTED_S3_BUCKET: 'raw-protected',
  PROTECTED_S3_ACCESS_KEY_ID: 'placeholder-raw-protected-key-id',
  PROTECTED_S3_SECRET_ACCESS_KEY: 'placeholder-raw-protected-key-secret',
} satisfies NodeJS.ProcessEnv;

const FETCHED_SCHEDULER_SECRETS = {
  CATALOG_MAX_ATTEMPTS: '7',
  CONVEX_API_SECRET: 'placeholder-fetched-convex-api-secret',
  CONVEX_URL: 'https://fetched-convex.invalid',
  INTERNAL_SERVICE_AUTH_SECRET: 'placeholder-fetched-internal-auth-secret',
  CATALOG_DATABASE_URL: 'postgresql://fetched.invalid/catalog',
  COMMON_S3_ENDPOINT: 'https://fetched-common.invalid',
  COMMON_S3_REGION: 'fetched-region',
  COMMON_S3_BUCKET: 'fetched-common',
  COMMON_S3_ACCESS_KEY_ID: 'placeholder-fetched-common-key-id',
  COMMON_S3_SECRET_ACCESS_KEY: 'placeholder-fetched-common-key-secret',
  METADATA_S3_ENDPOINT: 'https://fetched-metadata.invalid',
  METADATA_S3_REGION: 'fetched-region',
  METADATA_S3_BUCKET: 'fetched-metadata',
  METADATA_S3_ACCESS_KEY_ID: 'placeholder-fetched-metadata-key-id',
  METADATA_S3_SECRET_ACCESS_KEY: 'placeholder-fetched-metadata-key-secret',
  PROTECTED_S3_ENDPOINT: 'https://fetched-protected.invalid',
  PROTECTED_S3_REGION: 'fetched-region',
  PROTECTED_S3_BUCKET: 'fetched-protected',
  PROTECTED_S3_ACCESS_KEY_ID: 'placeholder-fetched-protected-key-id',
  PROTECTED_S3_SECRET_ACCESS_KEY: 'placeholder-fetched-protected-key-secret',
} as const;

describe('scheduler production runtime environment', () => {
  it('preserves actionable upstream request IDs while redacting credentials', () => {
    expect(
      schedulerErrorDiagnostic(new Error('[Request ID: 117d71b32c8b4ff3] Server Error'))
    ).toEqual({
      errorMessage: '[Request ID: 117d71b32c8b4ff3] Server Error',
      reason: 'Error',
    });
    expect(
      schedulerErrorDiagnostic(
        new Error(
          'postgresql://catalog-user:database-password@db.internal/catalog authorization: Bearer abc.def.ghi'
        )
      )
    ).toEqual({
      errorMessage: 'postgresql://[REDACTED]@db.internal/catalog authorization: [AUTH_REDACTED]',
      reason: 'Error',
    });
  });

  it('hydrates the catalog publisher and storage config before reading them', async () => {
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => FETCHED_SCHEDULER_SECRETS);

    expect(SCHEDULER_INFISICAL_KEYS).toEqual([
      'CONVEX_API_SECRET',
      'CONVEX_URL',
      'INTERNAL_SERVICE_AUTH_SECRET',
      'CATALOG_MAX_ATTEMPTS',
      'CATALOG_DATABASE_URL',
      'COMMON_S3_ENDPOINT',
      'COMMON_S3_REGION',
      'COMMON_S3_BUCKET',
      'COMMON_S3_ACCESS_KEY_ID',
      'COMMON_S3_SECRET_ACCESS_KEY',
      'METADATA_S3_ENDPOINT',
      'METADATA_S3_REGION',
      'METADATA_S3_BUCKET',
      'METADATA_S3_ACCESS_KEY_ID',
      'METADATA_S3_SECRET_ACCESS_KEY',
      'PROTECTED_S3_ENDPOINT',
      'PROTECTED_S3_REGION',
      'PROTECTED_S3_BUCKET',
      'PROTECTED_S3_ACCESS_KEY_ID',
      'PROTECTED_S3_SECRET_ACCESS_KEY',
    ]);

    const runtime = await loadSchedulerRuntimeEnv(COMPLETE_RAW_ENV, fetchSecrets);

    expect(fetchSecrets).toHaveBeenCalledTimes(1);
    expect(fetchSecrets).toHaveBeenCalledWith(COMPLETE_RAW_ENV);
    expect(runtime.catalogMaxAttempts).toBe(7);
    expect(runtime.catalogDatabaseUrl).toBe(FETCHED_SCHEDULER_SECRETS.CATALOG_DATABASE_URL);
    expect(runtime.publish).toEqual({
      convexApiSecret: FETCHED_SCHEDULER_SECRETS.CONVEX_API_SECRET,
      convexUrl: FETCHED_SCHEDULER_SECRETS.CONVEX_URL,
      internalServiceAuthSecret: FETCHED_SCHEDULER_SECRETS.INTERNAL_SERVICE_AUTH_SECRET,
      publishTimeoutMs: 15_000,
    });
    expect(runtime.common.endpoint).toBe(FETCHED_SCHEDULER_SECRETS.COMMON_S3_ENDPOINT);
    expect(runtime.common.accessKeyId).toBe(FETCHED_SCHEDULER_SECRETS.COMMON_S3_ACCESS_KEY_ID);
    expect(runtime.metadata.bucket).toBe(FETCHED_SCHEDULER_SECRETS.METADATA_S3_BUCKET);
    expect(runtime.protected.bucket).toBe(FETCHED_SCHEDULER_SECRETS.PROTECTED_S3_BUCKET);
  });

  it('does not use raw secret values when the required Infisical key is absent', async () => {
    const { CONVEX_API_SECRET: _missing, ...incompleteSecrets } = FETCHED_SCHEDULER_SECRETS;
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => incompleteSecrets);

    await expect(loadSchedulerRuntimeEnv(COMPLETE_RAW_ENV, fetchSecrets)).rejects.toThrow(
      'Missing required Infisical secrets: CONVEX_API_SECRET'
    );
  });

  it('rejects production startup without an Infisical bootstrap even when raw secrets exist', async () => {
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => FETCHED_SCHEDULER_SECRETS);
    const {
      INFISICAL_PROJECT_ID: _project,
      INFISICAL_CLIENT_ID: _client,
      INFISICAL_CLIENT_SECRET: _secret,
      ...rawOnly
    } = COMPLETE_RAW_ENV;

    await expect(loadSchedulerRuntimeEnv(rawOnly, fetchSecrets)).rejects.toThrow(
      'Missing required Infisical bootstrap environment variables'
    );
    expect(fetchSecrets).not.toHaveBeenCalled();
  });

  it('uses local storage with fetched publisher credentials in the disposable profile', async () => {
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => FETCHED_SCHEDULER_SECRETS);
    const localEnv = {
      ...COMPLETE_RAW_ENV,
      NODE_ENV: 'development',
      YUCP_STORAGE_PROFILE: 'disposable',
    } satisfies NodeJS.ProcessEnv;

    const runtime = await loadSchedulerRuntimeEnv(localEnv, fetchSecrets);

    expect(fetchSecrets).toHaveBeenCalledTimes(1);
    expect(runtime.catalogDatabaseUrl).toBe(COMPLETE_RAW_ENV.CATALOG_DATABASE_URL);
    expect(runtime.common.endpoint).toBe(COMPLETE_RAW_ENV.COMMON_S3_ENDPOINT);
    expect(runtime.common.accessKeyId).toBe(COMPLETE_RAW_ENV.COMMON_S3_ACCESS_KEY_ID);
    expect(runtime.metadata.endpoint).toBe(COMPLETE_RAW_ENV.METADATA_S3_ENDPOINT);
    expect(runtime.protected.endpoint).toBe(COMPLETE_RAW_ENV.PROTECTED_S3_ENDPOINT);
    expect(runtime.publish).toEqual({
      convexApiSecret: FETCHED_SCHEDULER_SECRETS.CONVEX_API_SECRET,
      convexUrl: FETCHED_SCHEDULER_SECRETS.CONVEX_URL,
      internalServiceAuthSecret: FETCHED_SCHEDULER_SECRETS.INTERNAL_SERVICE_AUTH_SECRET,
      publishTimeoutMs: 15_000,
    });
  });

  it('uses local storage with fetched publisher credentials in the interactive profile', async () => {
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => FETCHED_SCHEDULER_SECRETS);
    const localEnv = {
      ...COMPLETE_RAW_ENV,
      NODE_ENV: 'development',
      YUCP_STORAGE_PROFILE: 'interactive',
    } satisfies NodeJS.ProcessEnv;

    const runtime = await loadSchedulerRuntimeEnv(localEnv, fetchSecrets);

    expect(fetchSecrets).toHaveBeenCalledTimes(1);
    expect(runtime.catalogDatabaseUrl).toBe(COMPLETE_RAW_ENV.CATALOG_DATABASE_URL);
    expect(runtime.scratchRoot).toBe(COMPLETE_RAW_ENV.INGEST_SCRATCH_DIR);
    expect(runtime.common.endpoint).toBe(COMPLETE_RAW_ENV.COMMON_S3_ENDPOINT);
    expect(runtime.metadata.endpoint).toBe(COMPLETE_RAW_ENV.METADATA_S3_ENDPOINT);
    expect(runtime.protected.endpoint).toBe(COMPLETE_RAW_ENV.PROTECTED_S3_ENDPOINT);
    expect(runtime.publish).toEqual({
      convexApiSecret: FETCHED_SCHEDULER_SECRETS.CONVEX_API_SECRET,
      convexUrl: FETCHED_SCHEDULER_SECRETS.CONVEX_URL,
      internalServiceAuthSecret: FETCHED_SCHEDULER_SECRETS.INTERNAL_SERVICE_AUTH_SECRET,
      publishTimeoutMs: 15_000,
    });
  });
});
