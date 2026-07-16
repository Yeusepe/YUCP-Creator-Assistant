import { describe, expect, it } from 'bun:test';
import { loadCasConfig, loadIngestRuntimeEnv } from './config';
import { buildDesyncS3StoreUrl, desyncS3ChildEnv } from './desyncCas';

const COMPLETE_CAS_ENV = {
  CAS_S3_ENDPOINT: 'http://127.0.0.1:9000',
  CAS_S3_REGION: 'us-east-1',
  CAS_S3_BUCKET: 'cas-test',
  CAS_S3_ACCESS_KEY_ID: 'test-access-key',
  CAS_S3_SECRET_ACCESS_KEY: 'test-secret-key',
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
    });
    expect(buildDesyncS3StoreUrl(config)).toBe('s3+http://127.0.0.1:9000/cas-test/chunks/');
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
      ...COMPLETE_CAS_ENV,
      CATALOG_DATABASE_URL: 'postgresql://local-test.invalid/catalog',
      INGEST_UPLOAD_DIR: 'C:/tmp/yucp-ingest-test',
      INGEST_MAX_BYTES: '1048576',
    } satisfies NodeJS.ProcessEnv;
    const originalEnv = { ...sourceEnv };
    const runtime = await loadIngestRuntimeEnv(sourceEnv);

    expect(runtime.catalogDatabaseUrl).toBe('postgresql://local-test.invalid/catalog');
    expect(runtime.ingestUploadDir).toBe('C:/tmp/yucp-ingest-test');
    expect(runtime.ingestMaxBytes).toBe(1_048_576);
    expect(runtime.cas.chunkPrefix).toBe('chunks/');
    expect(runtime.cas.indexPrefix).toBe('indexes/');
    expect(sourceEnv).toEqual(originalEnv);
  });
});
