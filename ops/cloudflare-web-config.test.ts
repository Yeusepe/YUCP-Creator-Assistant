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
      'CAS_S3_ENDPOINT',
      'CAS_S3_REGION',
      'CAS_S3_BUCKET',
      'CAS_S3_READONLY_ACCESS_KEY_ID',
      'CAS_S3_READONLY_SECRET_ACCESS_KEY',
      'CAS_INDEX_PREFIX',
      'CAS_CHUNK_PREFIX',
      'DELIVERY_HMAC_KEY',
      'STORAGE_FORMAT_VERSION',
    ]);
    const source = Object.fromEntries(
      DELIVERY_WORKER_BINDING_KEYS.map((key) => [key, `placeholder-${key.toLowerCase()}`])
    );
    source.CAS_S3_ACCESS_KEY_ID = 'placeholder-write-key-must-not-sync';
    source.CAS_S3_SECRET_ACCESS_KEY = 'placeholder-write-secret-must-not-sync';
    source.DELIVERY_BASE_URL = 'https://delivery.example.invalid';

    expect(getDeliveryWorkerBindingValues(source)).toEqual(
      Object.fromEntries(
        DELIVERY_WORKER_BINDING_KEYS.map((key) => [key, `placeholder-${key.toLowerCase()}`])
      )
    );
  });
});
