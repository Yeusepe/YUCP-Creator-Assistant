import { describe, expect, it, mock } from 'bun:test';
import { loadCasConfig, loadIngestRuntimeEnv } from './config';
import { buildDesyncS3StoreUrl, desyncS3ChildEnv } from './desyncCas';

const COMPLETE_CAS_ENV = {
  CAS_S3_ENDPOINT: 'http://127.0.0.1:9000',
  CAS_S3_REGION: 'us-east-1',
  CAS_S3_BUCKET: 'cas-test',
  CAS_S3_ACCESS_KEY_ID: 'test-access-key',
  CAS_S3_SECRET_ACCESS_KEY: 'test-secret-key',
} satisfies NodeJS.ProcessEnv;

const COMPLETE_STORAGE_ROLE_ENV = {
  COMMON_S3_ACCESS_KEY_ID: 'common-access-key',
  COMMON_S3_BUCKET: 'common-test',
  COMMON_S3_ENDPOINT: 'http://127.0.0.1:9000',
  COMMON_S3_REGION: 'us-east-1',
  COMMON_S3_SECRET_ACCESS_KEY: 'common-secret-key',
  METADATA_S3_ACCESS_KEY_ID: 'metadata-access-key',
  METADATA_S3_BUCKET: 'metadata-test',
  METADATA_S3_ENDPOINT: 'http://127.0.0.1:9000',
  METADATA_S3_REGION: 'us-east-1',
  METADATA_S3_SECRET_ACCESS_KEY: 'metadata-secret-key',
  PROTECTED_S3_ACCESS_KEY_ID: 'protected-access-key',
  PROTECTED_S3_BUCKET: 'protected-test',
  PROTECTED_S3_ENDPOINT: 'http://127.0.0.1:9000',
  PROTECTED_S3_REGION: 'us-east-1',
  PROTECTED_S3_SECRET_ACCESS_KEY: 'protected-secret-key',
  QUARANTINE_S3_ACCESS_KEY_ID: 'quarantine-access-key',
  QUARANTINE_S3_BUCKET: 'quarantine-test',
  QUARANTINE_S3_ENDPOINT: 'http://127.0.0.1:9000',
  QUARANTINE_S3_REGION: 'us-east-1',
  QUARANTINE_S3_SECRET_ACCESS_KEY: 'quarantine-secret-key',
} satisfies NodeJS.ProcessEnv;

describe('loadCasConfig', () => {
  it('rejects missing required keys by name without exposing present values', () => {
    const presentValue = 'must-not-appear-in-the-error';

    expect(() =>
      loadCasConfig({
        CAS_S3_ENDPOINT: presentValue,
      })
    ).toThrow(
      'Missing required CAS environment variables: CAS_S3_REGION, CAS_S3_BUCKET, CAS_S3_ACCESS_KEY_ID, CAS_S3_SECRET_ACCESS_KEY'
    );

    try {
      loadCasConfig({ CAS_S3_ENDPOINT: presentValue });
      throw new Error('Expected loadCasConfig to reject incomplete configuration');
    } catch (error) {
      expect(String(error)).not.toContain(presentValue);
    }
  });

  it('applies the chunk and index prefix defaults', () => {
    const config = loadCasConfig(COMPLETE_CAS_ENV);
    expect(config).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'cas-test',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      chunkPrefix: 'chunks/',
      indexPrefix: 'indexes/',
      requestTimeoutMs: 30_000,
    });
    expect(buildDesyncS3StoreUrl(config)).toBe('s3+http://127.0.0.1:9000/cas-test/chunks/');
  });

  it('validates the optional S3 request timeout', () => {
    expect(
      loadCasConfig({ ...COMPLETE_CAS_ENV, CAS_S3_REQUEST_TIMEOUT_MS: '1250' }).requestTimeoutMs
    ).toBe(1_250);
    expect(() => loadCasConfig({ ...COMPLETE_CAS_ENV, CAS_S3_REQUEST_TIMEOUT_MS: '0' })).toThrow(
      'Invalid CAS environment variable: CAS_S3_REQUEST_TIMEOUT_MS'
    );
  });

  it('builds a child-only desync credential environment', () => {
    const config = loadCasConfig(COMPLETE_CAS_ENV);
    const originalAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const originalCasSecret = process.env.CAS_S3_SECRET_ACCESS_KEY;
    process.env.CAS_S3_SECRET_ACCESS_KEY = 'desync-child-must-not-receive-this';
    try {
      const childEnv = desyncS3ChildEnv(config);

      expect(childEnv.AWS_ACCESS_KEY_ID).toBe('test-access-key');
      expect(childEnv.AWS_SECRET_ACCESS_KEY).toBe('test-secret-key');
      expect(childEnv.AWS_REGION).toBe('us-east-1');
      expect(childEnv.AWS_DEFAULT_REGION).toBe('us-east-1');
      expect(childEnv.S3_REGION).toBe('us-east-1');
      expect(childEnv.S3_ACCESS_KEY).toBeUndefined();
      expect(childEnv.S3_SECRET_KEY).toBeUndefined();
      expect(childEnv.CAS_S3_SECRET_ACCESS_KEY).toBeUndefined();
      expect(process.env.AWS_ACCESS_KEY_ID).toBe(originalAccessKey);
    } finally {
      if (originalCasSecret === undefined) {
        delete process.env.CAS_S3_SECRET_ACCESS_KEY;
      } else {
        process.env.CAS_S3_SECRET_ACCESS_KEY = originalCasSecret;
      }
    }
  });
});

describe('loadIngestRuntimeEnv', () => {
  it('validates the complete local ingest contract without Infisical bootstrap credentials', async () => {
    const sourceEnv = {
      ...COMPLETE_STORAGE_ROLE_ENV,
      CATALOG_DATABASE_URL: 'postgresql://local-test.invalid/catalog',
      INGEST_SCRATCH_DIR: 'C:/tmp/yucp-ingest-scratch-test',
      INGEST_UPLOAD_DIR: 'C:/tmp/yucp-ingest-test',
      INGEST_MAX_BYTES: '1048576',
      PACKAGE_CATALOG_CONTROL_SHARED_SECRET: 'placeholder-local-catalog-control-secret',
      UPLOAD_HMAC_KEY: 'placeholder-local-upload-hmac-key',
    } satisfies NodeJS.ProcessEnv;
    const originalEnv = { ...sourceEnv };
    const runtime = await loadIngestRuntimeEnv(sourceEnv);

    expect(runtime.catalogDatabaseUrl).toBe('postgresql://local-test.invalid/catalog');
    expect(runtime.catalogMaxAttempts).toBe(5);
    expect(runtime.uploadHmacKey).toBe('placeholder-local-upload-hmac-key');
    expect(runtime.catalogControlSharedSecret).toBe('placeholder-local-catalog-control-secret');
    expect(runtime.ingestScratchDir).toBe('C:/tmp/yucp-ingest-scratch-test');
    expect(runtime.ingestUploadDir).toBe('C:/tmp/yucp-ingest-test');
    expect(runtime.ingestMaxBytes).toBe(1_048_576);
    expect(runtime.common.chunkPrefix).toBe('chunks/');
    expect(runtime.metadata.indexPrefix).toBe('indexes/');
    expect(runtime.protected.chunkPrefix).toBe('chunks/');
    expect(runtime.quarantine.bucket).toBe('quarantine-test');
    expect(sourceEnv).toEqual(originalEnv);
  });

  it('validates the catalog retry cap used to classify recoverable versions', async () => {
    await expect(
      loadIngestRuntimeEnv({
        ...COMPLETE_STORAGE_ROLE_ENV,
        CATALOG_DATABASE_URL: 'postgresql://local-test.invalid/catalog',
        CATALOG_MAX_ATTEMPTS: '0',
        INGEST_SCRATCH_DIR: 'C:/tmp/yucp-ingest-scratch-test',
        INGEST_UPLOAD_DIR: 'C:/tmp/yucp-ingest-test',
        INGEST_MAX_BYTES: '1048576',
        PACKAGE_CATALOG_CONTROL_SHARED_SECRET: 'placeholder-local-catalog-control-secret',
        UPLOAD_HMAC_KEY: 'placeholder-local-upload-hmac-key',
      })
    ).rejects.toThrow('Invalid ingest environment variable: CATALOG_MAX_ATTEMPTS');
  });

  it('keeps disposable storage values local when Infisical bootstrap values exist', async () => {
    const sourceEnv = {
      ...COMPLETE_STORAGE_ROLE_ENV,
      CATALOG_DATABASE_URL: 'postgresql://local-test.invalid/catalog',
      INFISICAL_CLIENT_ID: 'placeholder-client-id',
      INFISICAL_CLIENT_SECRET: 'placeholder-client-secret',
      INFISICAL_PROJECT_ID: 'placeholder-project-id',
      INGEST_SCRATCH_DIR: 'C:/tmp/yucp-ingest-scratch-test',
      INGEST_MAX_BYTES: '1048576',
      INGEST_UPLOAD_DIR: 'C:/tmp/yucp-ingest-test',
      NODE_ENV: 'development',
      PACKAGE_CATALOG_CONTROL_SHARED_SECRET: 'placeholder-local-catalog-control-secret',
      UPLOAD_HMAC_KEY: 'placeholder-local-upload-hmac-key',
      YUCP_STORAGE_PROFILE: 'disposable',
    } satisfies NodeJS.ProcessEnv;
    const fetchSecrets = mock(async () => ({
      ...COMPLETE_STORAGE_ROLE_ENV,
      CATALOG_DATABASE_URL: 'postgresql://remote.invalid/catalog',
      PACKAGE_CATALOG_CONTROL_SHARED_SECRET: 'placeholder-remote-catalog-control-secret',
      UPLOAD_HMAC_KEY: 'placeholder-remote-upload-hmac-key',
    }));

    const runtime = await loadIngestRuntimeEnv(sourceEnv, fetchSecrets);

    expect(fetchSecrets).not.toHaveBeenCalled();
    expect(runtime.catalogDatabaseUrl).toBe('postgresql://local-test.invalid/catalog');
    expect(runtime.uploadHmacKey).toBe('placeholder-local-upload-hmac-key');
    expect(runtime.common.endpoint).toBe(COMPLETE_STORAGE_ROLE_ENV.COMMON_S3_ENDPOINT);
    expect(runtime.metadata.endpoint).toBe(COMPLETE_STORAGE_ROLE_ENV.METADATA_S3_ENDPOINT);
    expect(runtime.protected.endpoint).toBe(COMPLETE_STORAGE_ROLE_ENV.PROTECTED_S3_ENDPOINT);
    expect(runtime.quarantine.endpoint).toBe(COMPLETE_STORAGE_ROLE_ENV.QUARANTINE_S3_ENDPOINT);
  });

  it('keeps interactive storage values local when Infisical bootstrap values exist', async () => {
    const sourceEnv = {
      ...COMPLETE_STORAGE_ROLE_ENV,
      CATALOG_DATABASE_URL: 'postgresql://local-test.invalid/catalog',
      INFISICAL_CLIENT_ID: 'placeholder-client-id',
      INFISICAL_CLIENT_SECRET: 'placeholder-client-secret',
      INFISICAL_PROJECT_ID: 'placeholder-project-id',
      INGEST_SCRATCH_DIR: 'C:/tmp/yucp-ingest-scratch-test',
      INGEST_MAX_BYTES: '1048576',
      INGEST_UPLOAD_DIR: 'C:/tmp/yucp-ingest-test',
      NODE_ENV: 'development',
      PACKAGE_CATALOG_CONTROL_SHARED_SECRET: 'placeholder-local-catalog-control-secret',
      UPLOAD_HMAC_KEY: 'placeholder-local-upload-hmac-key',
      YUCP_STORAGE_PROFILE: 'interactive',
    } satisfies NodeJS.ProcessEnv;
    const fetchSecrets = mock(async () => ({
      ...COMPLETE_STORAGE_ROLE_ENV,
      CATALOG_DATABASE_URL: 'postgresql://remote.invalid/catalog',
      PACKAGE_CATALOG_CONTROL_SHARED_SECRET: 'placeholder-remote-catalog-control-secret',
      UPLOAD_HMAC_KEY: 'placeholder-remote-upload-hmac-key',
    }));

    const runtime = await loadIngestRuntimeEnv(sourceEnv, fetchSecrets);

    expect(fetchSecrets).not.toHaveBeenCalled();
    expect(runtime.catalogDatabaseUrl).toBe('postgresql://local-test.invalid/catalog');
    expect(runtime.uploadHmacKey).toBe('placeholder-local-upload-hmac-key');
    expect(runtime.common.endpoint).toBe(COMPLETE_STORAGE_ROLE_ENV.COMMON_S3_ENDPOINT);
    expect(runtime.metadata.endpoint).toBe(COMPLETE_STORAGE_ROLE_ENV.METADATA_S3_ENDPOINT);
    expect(runtime.protected.endpoint).toBe(COMPLETE_STORAGE_ROLE_ENV.PROTECTED_S3_ENDPOINT);
    expect(runtime.quarantine.endpoint).toBe(COMPLETE_STORAGE_ROLE_ENV.QUARANTINE_S3_ENDPOINT);
  });

  it('rejects local storage profiles in production', async () => {
    await expect(
      loadIngestRuntimeEnv({
        ...COMPLETE_STORAGE_ROLE_ENV,
        CATALOG_DATABASE_URL: 'postgresql://local-test.invalid/catalog',
        INGEST_SCRATCH_DIR: 'C:/tmp/yucp-ingest-scratch-test',
        INGEST_MAX_BYTES: '1048576',
        INGEST_UPLOAD_DIR: 'C:/tmp/yucp-ingest-test',
        NODE_ENV: 'production',
        PACKAGE_CATALOG_CONTROL_SHARED_SECRET: 'placeholder-local-catalog-control-secret',
        UPLOAD_HMAC_KEY: 'placeholder-local-upload-hmac-key',
        YUCP_STORAGE_PROFILE: 'disposable',
      })
    ).rejects.toThrow('A local storage profile cannot run in production');

    await expect(
      loadIngestRuntimeEnv({
        ...COMPLETE_STORAGE_ROLE_ENV,
        CATALOG_DATABASE_URL: 'postgresql://local-test.invalid/catalog',
        INGEST_SCRATCH_DIR: 'C:/tmp/yucp-ingest-scratch-test',
        INGEST_MAX_BYTES: '1048576',
        INGEST_UPLOAD_DIR: 'C:/tmp/yucp-ingest-test',
        NODE_ENV: 'production',
        PACKAGE_CATALOG_CONTROL_SHARED_SECRET: 'placeholder-local-catalog-control-secret',
        UPLOAD_HMAC_KEY: 'placeholder-local-upload-hmac-key',
        YUCP_STORAGE_PROFILE: 'interactive',
      })
    ).rejects.toThrow('A local storage profile cannot run in production');
  });
});
