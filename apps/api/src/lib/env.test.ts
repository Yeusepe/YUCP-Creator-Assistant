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
  it('keeps delivery and VPM configuration optional when all values are unset', () => {
    delete process.env.PACKAGE_DELIVERY_AUDIENCE;
    delete process.env.PACKAGE_INSTALL_ISSUER;
    delete process.env.PACKAGE_INSTALL_SIGNING_KEY_ID;
    delete process.env.PACKAGE_INSTALL_SIGNING_PRIVATE_KEY;
    delete process.env.PACKAGE_OPERATION_AUTHORIZATION_DATABASE_URL;
    delete process.env.VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL;
    delete process.env.VPM_BASE_URL;
    delete process.env.VPM_PUBLIC_INDEX_URL;

    const env = loadEnv();

    expect(env).toHaveProperty('PACKAGE_DELIVERY_AUDIENCE', undefined);
    expect(env).toHaveProperty('PACKAGE_INSTALL_ISSUER', undefined);
    expect(env).toHaveProperty('PACKAGE_INSTALL_SIGNING_KEY_ID', undefined);
    expect(env).toHaveProperty('PACKAGE_INSTALL_SIGNING_PRIVATE_KEY', undefined);
    expect(env).toHaveProperty('PACKAGE_OPERATION_AUTHORIZATION_DATABASE_URL', undefined);
    expect(env).toHaveProperty('VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL', undefined);
    expect(env).toHaveProperty('VPM_BASE_URL', undefined);
    expect(env).toHaveProperty('VPM_PUBLIC_INDEX_URL', undefined);
    expect(env).not.toHaveProperty('VPM_TOKEN_KEY');
  });

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

  it('includes metadata storage fields required by bootstrap media delivery', () => {
    process.env.METADATA_S3_ACCESS_KEY_ID = 'metadata-access-key';
    process.env.METADATA_S3_SECRET_ACCESS_KEY = 'metadata-secret-key';
    process.env.METADATA_S3_BUCKET = 'metadata';
    process.env.METADATA_S3_ENDPOINT = 'http://127.0.0.1:9000';
    process.env.METADATA_S3_REGION = 'us-east-1';
    process.env.METADATA_S3_REQUEST_TIMEOUT_MS = '5000';
    process.env.METADATA_INDEX_PREFIX = 'indexes/';
    process.env.VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL =
      'postgres://publisher:secret@127.0.0.1:5432/catalog';

    expect(loadEnv()).toMatchObject({
      METADATA_S3_ACCESS_KEY_ID: 'metadata-access-key',
      METADATA_S3_SECRET_ACCESS_KEY: 'metadata-secret-key',
      METADATA_S3_BUCKET: 'metadata',
      METADATA_S3_ENDPOINT: 'http://127.0.0.1:9000',
      METADATA_S3_REGION: 'us-east-1',
      METADATA_S3_REQUEST_TIMEOUT_MS: '5000',
      METADATA_INDEX_PREFIX: 'indexes/',
      VPM_ALIAS_PUBLICATION_CATALOG_DATABASE_URL:
        'postgres://publisher:secret@127.0.0.1:5432/catalog',
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
});
