import { describe, expect, it } from 'vitest';
import { getWebApiBaseUrl, isWebProductionRuntime } from '@/lib/server/runtimeEnv';

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
});
