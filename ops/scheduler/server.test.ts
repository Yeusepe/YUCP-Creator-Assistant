import { describe, expect, it, mock } from 'bun:test';
import { loadSchedulerRuntimeEnv, SCHEDULER_INFISICAL_KEYS } from './server';

const COMPLETE_RAW_ENV = {
  INFISICAL_PROJECT_ID: 'placeholder-project-id',
  INFISICAL_CLIENT_ID: 'placeholder-client-id',
  INFISICAL_CLIENT_SECRET: 'placeholder-client-secret',
  CONVEX_API_SECRET: 'placeholder-raw-convex-api-secret',
  CONVEX_URL: 'https://raw-convex.invalid',
  INTERNAL_SERVICE_AUTH_SECRET: 'placeholder-raw-internal-auth-secret',
  CATALOG_DATABASE_URL: 'postgresql://raw.invalid/catalog',
  CAS_S3_ENDPOINT: 'https://raw-s3.invalid',
  CAS_S3_REGION: 'raw-region',
  CAS_S3_BUCKET: 'raw-bucket',
  CAS_S3_ACCESS_KEY_ID: 'placeholder-raw-write-key-id',
  CAS_S3_SECRET_ACCESS_KEY: 'placeholder-raw-write-key-secret',
} satisfies NodeJS.ProcessEnv;

const FETCHED_SCHEDULER_SECRETS = {
  CONVEX_API_SECRET: 'placeholder-fetched-convex-api-secret',
  CONVEX_URL: 'https://fetched-convex.invalid',
  INTERNAL_SERVICE_AUTH_SECRET: 'placeholder-fetched-internal-auth-secret',
  CATALOG_DATABASE_URL: 'postgresql://fetched.invalid/catalog',
  CAS_S3_ENDPOINT: 'https://fetched-s3.invalid',
  CAS_S3_REGION: 'fetched-region',
  CAS_S3_BUCKET: 'fetched-bucket',
  CAS_S3_ACCESS_KEY_ID: 'placeholder-fetched-write-key-id',
  CAS_S3_SECRET_ACCESS_KEY: 'placeholder-fetched-write-key-secret',
} as const;

describe('scheduler production runtime environment', () => {
  it('hydrates the catalog publisher and storage config before reading them', async () => {
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => FETCHED_SCHEDULER_SECRETS);

    expect(SCHEDULER_INFISICAL_KEYS).toEqual([
      'CONVEX_API_SECRET',
      'CONVEX_URL',
      'INTERNAL_SERVICE_AUTH_SECRET',
      'CATALOG_DATABASE_URL',
      'CAS_S3_ENDPOINT',
      'CAS_S3_REGION',
      'CAS_S3_BUCKET',
      'CAS_S3_ACCESS_KEY_ID',
      'CAS_S3_SECRET_ACCESS_KEY',
    ]);

    const runtime = await loadSchedulerRuntimeEnv(COMPLETE_RAW_ENV, fetchSecrets);

    expect(fetchSecrets).toHaveBeenCalledTimes(1);
    expect(fetchSecrets).toHaveBeenCalledWith(COMPLETE_RAW_ENV);
    expect(runtime.catalogDatabaseUrl).toBe(FETCHED_SCHEDULER_SECRETS.CATALOG_DATABASE_URL);
    expect(runtime.publish).toEqual({
      convexApiSecret: FETCHED_SCHEDULER_SECRETS.CONVEX_API_SECRET,
      convexUrl: FETCHED_SCHEDULER_SECRETS.CONVEX_URL,
      internalServiceAuthSecret: FETCHED_SCHEDULER_SECRETS.INTERNAL_SERVICE_AUTH_SECRET,
      publishTimeoutMs: 15_000,
    });
    expect(runtime.cas.endpoint).toBe(FETCHED_SCHEDULER_SECRETS.CAS_S3_ENDPOINT);
    expect(runtime.cas.accessKeyId).toBe(FETCHED_SCHEDULER_SECRETS.CAS_S3_ACCESS_KEY_ID);
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
    expect(runtime.cas.endpoint).toBe(COMPLETE_RAW_ENV.CAS_S3_ENDPOINT);
    expect(runtime.cas.accessKeyId).toBe(COMPLETE_RAW_ENV.CAS_S3_ACCESS_KEY_ID);
    expect(runtime.publish).toEqual({
      convexApiSecret: FETCHED_SCHEDULER_SECRETS.CONVEX_API_SECRET,
      convexUrl: FETCHED_SCHEDULER_SECRETS.CONVEX_URL,
      internalServiceAuthSecret: FETCHED_SCHEDULER_SECRETS.INTERNAL_SERVICE_AUTH_SECRET,
      publishTimeoutMs: 15_000,
    });
  });
});
