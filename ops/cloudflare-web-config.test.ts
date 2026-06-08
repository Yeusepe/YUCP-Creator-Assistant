import { describe, expect, test } from 'bun:test';
import { getWebLocalEnvValues, resolveWebEnvValues } from './cloudflare-web-config';

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
});
