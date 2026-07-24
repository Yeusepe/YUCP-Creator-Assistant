import { describe, expect, test } from 'bun:test';
import {
  DELIVERY_WORKER_BINDING_KEYS,
  getDeliveryWorkerBindingValues,
  getWebLocalEnvValues,
  resolveWebEnvValues,
  resolveWebLocalEnvPath,
} from './cloudflare-web-config';

describe('cloudflare-web-config', () => {
  test('defaults local worker NODE_ENV to development without ambient shell leakage', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      expect(resolveWebEnvValues({}, { prod: false }).NODE_ENV).toBe('development');
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  test('sets production NODE_ENV when prod is true', () => {
    expect(resolveWebEnvValues({}, { prod: true }).NODE_ENV).toBe('production');
  });

  test('carries public feature flags into the local Worker runtime env file', () => {
    expect(
      getWebLocalEnvValues({
        YUCP_ENABLE_AUTOMATIC_SETUP: 'true',
        YUCP_ENABLE_PRIVATE_VPM: 'true',
      })
    ).toEqual({
      YUCP_ENABLE_AUTOMATIC_SETUP: 'true',
      YUCP_ENABLE_PRIVATE_VPM: 'true',
    });
  });

  test('allows tests to redirect the generated local Worker env file', () => {
    expect(resolveWebLocalEnvPath({ WEB_LOCAL_ENV_PATH: 'E:\\tmp\\web-worker-test.vars' })).toBe(
      'E:\\tmp\\web-worker-test.vars'
    );
  });

  test('selects only the delivery Worker bindings from the Infisical export', () => {
    expect(DELIVERY_WORKER_BINDING_KEYS).toEqual([
      'COMMON_S3_ENDPOINT',
      'COMMON_S3_REGION',
      'COMMON_S3_BUCKET',
      'COMMON_S3_READONLY_ACCESS_KEY_ID',
      'COMMON_S3_READONLY_SECRET_ACCESS_KEY',
      'COMMON_CHUNK_PREFIX',
      'METADATA_S3_ENDPOINT',
      'METADATA_S3_REGION',
      'METADATA_S3_BUCKET',
      'METADATA_S3_READONLY_ACCESS_KEY_ID',
      'METADATA_S3_READONLY_SECRET_ACCESS_KEY',
      'METADATA_INDEX_PREFIX',
      'PACKAGE_DELIVERY_AUDIENCE',
      'PACKAGE_INSTALL_ISSUER',
      'PACKAGE_INSTALL_SIGNING_KEY_ID',
      'PACKAGE_INSTALL_SIGNING_PUBLIC_KEY',
      'STORAGE_FORMAT_VERSION',
    ]);
    const source = Object.fromEntries(
      DELIVERY_WORKER_BINDING_KEYS.map((key) => [key, `placeholder-${key.toLowerCase()}`])
    );
    source.COMMON_S3_ACCESS_KEY_ID = 'placeholder-write-key-must-not-sync';
    source.COMMON_S3_SECRET_ACCESS_KEY = 'placeholder-write-secret-must-not-sync';
    source.METADATA_S3_ACCESS_KEY_ID = 'placeholder-write-key-must-not-sync';
    source.METADATA_S3_SECRET_ACCESS_KEY = 'placeholder-write-secret-must-not-sync';
    source.PACKAGE_INSTALL_SIGNING_PRIVATE_KEY = 'private-key-must-not-sync';

    expect(getDeliveryWorkerBindingValues(source)).toEqual(
      Object.fromEntries(
        DELIVERY_WORKER_BINDING_KEYS.map((key) => [key, `placeholder-${key.toLowerCase()}`])
      )
    );
  });
});
