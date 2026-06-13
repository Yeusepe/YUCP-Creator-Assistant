import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, loadEnvAsync, resolveConvexSiteUrl, resolveSiteUrl } from './env';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveConvexSiteUrl', () => {
  it('prefers CONVEX_SITE_URL when provided', () => {
    expect(
      resolveConvexSiteUrl({
        CONVEX_SITE_URL: 'https://rare-squid-409.convex.site/',
        CONVEX_URL: 'https://ignored.convex.cloud',
      })
    ).toBe('https://rare-squid-409.convex.site');
  });

  it('derives the site host from CONVEX_URL', () => {
    expect(
      resolveConvexSiteUrl({
        CONVEX_URL: 'https://rare-squid-409.convex.cloud',
      })
    ).toBe('https://rare-squid-409.convex.site');
  });
});

describe('resolveSiteUrl', () => {
  it('prefers SITE_URL over legacy aliases', () => {
    expect(
      resolveSiteUrl({
        SITE_URL: 'https://creators.yucp.club/',
        FRONTEND_URL: 'https://legacy.example.com',
        BETTER_AUTH_URL: 'https://auth.example.com',
      })
    ).toBe('https://creators.yucp.club');
  });

  it('falls back to FRONTEND_URL and then legacy envs', () => {
    expect(
      resolveSiteUrl({
        FRONTEND_URL: 'https://frontend.example.com/',
      })
    ).toBe('https://frontend.example.com');

    expect(
      resolveSiteUrl({
        RENDER_EXTERNAL_URL: 'https://render.example.com/',
      })
    ).toBe('https://render.example.com');
  });
});

describe('loadEnv', () => {
  it('includes Polar billing fields when present', () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-access-token';
    process.env.POLAR_WEBHOOK_SECRET = 'polar-webhook-secret';
    process.env.POLAR_SERVER = 'sandbox';

    expect(loadEnv()).toMatchObject({
      POLAR_ACCESS_TOKEN: 'polar-access-token',
      POLAR_WEBHOOK_SECRET: 'polar-webhook-secret',
      POLAR_SERVER: 'sandbox',
    });
  });

  it('falls back to local .env.infisical values when process env is missing or blank', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yucp-api-env-'));
    await writeFile(
      path.join(tempDir, '.env.infisical'),
      [
        'YUCP_COUPLING_SERVICE_BASE_URL=http://127.0.0.1:8788',
        'YUCP_COUPLING_SERVICE_SHARED_SECRET=local-dev-secret',
      ].join('\n'),
      'utf8'
    );

    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      process.env.YUCP_COUPLING_SERVICE_BASE_URL = '';
      process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET = '';

      await loadEnvAsync();

      expect(loadEnv()).toMatchObject({
        YUCP_COUPLING_SERVICE_BASE_URL: 'http://127.0.0.1:8788',
        YUCP_COUPLING_SERVICE_SHARED_SECRET: 'local-dev-secret',
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('refuses production startup when Infisical secrets did not load', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yucp-api-env-no-infisical-'));
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      process.env = {
        NODE_ENV: 'production',
      };

      await expect(loadEnvAsync()).rejects.toThrow(
        'Infisical secrets did not load; environment is using process.env and local fallback files only. Refusing production startup.'
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('falls back to COUPLING_SERVICE_SECRET when the YUCP alias is absent', () => {
    process.env.COUPLING_SERVICE_SECRET = 'legacy-secret';

    expect(loadEnv()).toMatchObject({
      YUCP_COUPLING_SERVICE_SHARED_SECRET: 'legacy-secret',
    });
  });
});
