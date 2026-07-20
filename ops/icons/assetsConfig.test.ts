import { describe, expect, test } from 'bun:test';
import { loadAssetsConfig } from './assetsConfig';

const baseEnv: NodeJS.ProcessEnv = {
  ASSETS_S3_BUCKET: 'licensed-assets',
  ASSETS_S3_ENDPOINT: 's3.us-east-005.backblazeb2.com',
  ASSETS_S3_REGION: 'us-east-005',
  ASSETS_S3_ACCESS_KEY_ID: 'standard-access-key',
  ASSETS_S3_SECRET_ACCESS_KEY: 'standard-secret-key',
};

describe('assets icon configuration', () => {
  test('normalizes a bare endpoint to HTTPS', () => {
    expect(loadAssetsConfig(baseEnv).endpoint).toBe('https://s3.us-east-005.backblazeb2.com');
  });

  test('prefers the read-only credential pair', () => {
    const config = loadAssetsConfig({
      ...baseEnv,
      ASSETS_S3_READONLY_ACCESS_KEY_ID: 'readonly-access-key',
      ASSETS_S3_READONLY_SECRET_ACCESS_KEY: 'readonly-secret-key',
    });

    expect(config.accessKeyId).toBe('readonly-access-key');
    expect(config.secretAccessKey).toBe('readonly-secret-key');
  });

  test('falls back to the standard credential pair', () => {
    const config = loadAssetsConfig(baseEnv);

    expect(config.accessKeyId).toBe('standard-access-key');
    expect(config.secretAccessKey).toBe('standard-secret-key');
  });

  test('rejects an incomplete read-only credential pair', () => {
    expect(() =>
      loadAssetsConfig({
        ...baseEnv,
        ASSETS_S3_READONLY_ACCESS_KEY_ID: 'readonly-access-key',
      })
    ).toThrow('Incomplete read-only assets credential pair');
  });
});
