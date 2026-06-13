import { describe, expect, it } from 'vitest';
import {
  getWebApiBaseUrl,
  isWebProductionRuntime,
  resolveDefaultWebRuntimeEnv,
} from '@/lib/server/runtimeEnv';

describe('runtimeEnv', () => {
  it('treats isProduction as a production override', () => {
    expect(
      isWebProductionRuntime({
        NODE_ENV: 'development',
        isProduction: true,
      })
    ).toBe(true);
  });

  it('throws for missing API_BASE_URL when isProduction override is set', () => {
    expect(() =>
      getWebApiBaseUrl({
        NODE_ENV: 'development',
        isProduction: true,
      })
    ).toThrow('API_BASE_URL is required');
  });

  it('fills missing local Worker bindings from the fallback environment', () => {
    const env = resolveDefaultWebRuntimeEnv({
      runtimeCloudflareEnv: {
        CONVEX_URL: 'https://convex.example',
      },
      fallbackEnv: {
        API_BASE_URL: 'http://localhost:3001',
        INTERNAL_RPC_SHARED_SECRET: 'test-secret',
      },
    });

    expect(env.CONVEX_URL).toBe('https://convex.example');
    expect(env.API_BASE_URL).toBe('http://localhost:3001');
    expect(env.INTERNAL_RPC_SHARED_SECRET).toBe('test-secret');
  });
});
