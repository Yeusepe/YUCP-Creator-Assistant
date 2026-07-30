import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DELIVERY_WORKER_BINDING_KEYS,
  getDeliveryWorkerBindingValues,
  getMaterializationSourceWorkerBindingValues,
  getRenditionWorkerBindingValues,
  getWebLocalEnvValues,
  MATERIALIZATION_SOURCE_WORKER_BINDING_KEYS,
  MATERIALIZATION_SOURCE_WORKER_SOURCE_KEYS,
  RENDITION_WORKER_BINDING_KEYS,
  RENDITION_WORKER_SOURCE_KEYS,
  resolveWebEnvValues,
  resolveWebLocalEnvPath,
} from './cloudflare-web-config';
import { DESYNC_STORAGE_FORMAT_VERSION } from './storage-core/deliveryManifest';

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
      'COMMON_CHUNK_PREFIX',
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

  test('documents every role-specific delivery Worker binding in the Infisical inventory', () => {
    const template = readFileSync(
      resolve(import.meta.dir, 'infisical', 'secrets.template.yaml'),
      'utf8'
    );
    const inventory = readFileSync(resolve(import.meta.dir, 'infisical', 'README.md'), 'utf8');

    for (const key of DELIVERY_WORKER_BINDING_KEYS) {
      expect(template).toContain(`${key}:`);
      expect(inventory).toContain(key);
    }
    expect(inventory).not.toContain('CAS_S3_READONLY_ACCESS_KEY_ID');
    expect(inventory).not.toContain('CAS_S3_READONLY_SECRET_ACCESS_KEY');
  });

  test('derives the materialization source Worker verifier from canonical Infisical values', async () => {
    const source = Object.fromEntries(
      MATERIALIZATION_SOURCE_WORKER_SOURCE_KEYS.map((key) => [
        key,
        `placeholder-${key.toLowerCase()}`,
      ])
    );
    source.MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY = Buffer.alloc(32, 0x29).toString('base64url');

    const bindings = await getMaterializationSourceWorkerBindingValues(source);

    expect(Object.keys(bindings)).toEqual([...MATERIALIZATION_SOURCE_WORKER_BINDING_KEYS]);
    expect(bindings).toMatchObject({
      COMMON_CHUNK_PREFIX: source.COMMON_CHUNK_PREFIX,
      DELIVERY_GRANT_ISSUER: source.MATERIALIZATION_SOURCE_GRANT_ISSUER,
      DELIVERY_GRANT_KEY_ID: source.MATERIALIZATION_SOURCE_GRANT_KEY_ID,
      MATERIALIZATION_SOURCE_AUDIENCE: source.MATERIALIZATION_SOURCE_GRANT_AUDIENCE,
      METADATA_INDEX_PREFIX: source.METADATA_INDEX_PREFIX,
      PROTECTED_CHUNK_PREFIX: source.PROTECTED_CHUNK_PREFIX,
    });
    expect(bindings.DELIVERY_GRANT_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bindings).not.toHaveProperty('MATERIALIZATION_SOURCE_GRANT_PRIVATE_KEY');
  });

  test('documents every materialization source Worker source value in Infisical', () => {
    const template = readFileSync(
      resolve(import.meta.dir, 'infisical', 'secrets.template.yaml'),
      'utf8'
    );
    const inventory = readFileSync(resolve(import.meta.dir, 'infisical', 'README.md'), 'utf8');

    for (const key of MATERIALIZATION_SOURCE_WORKER_SOURCE_KEYS) {
      expect(template).toContain(`${key}:`);
      expect(inventory).toContain(key);
    }
  });

  test('derives only the public rendition Worker bindings from Infisical', () => {
    const source = Object.fromEntries(
      RENDITION_WORKER_SOURCE_KEYS.map((key) => [key, `placeholder-${key.toLowerCase()}`])
    );
    source.MATERIALIZATION_RECEIPT_PRIVATE_KEY = Buffer.alloc(32, 0x31).toString('base64url');

    const bindings = getRenditionWorkerBindingValues(source);

    expect(Object.keys(bindings)).toEqual([...RENDITION_WORKER_BINDING_KEYS]);
    expect(bindings).toMatchObject({
      MATERIALIZER_ORIGIN_URL: source.MATERIALIZER_ORIGIN_URL,
      MATERIALIZER_RENDITION_SHARED_SECRET: source.MATERIALIZER_RENDITION_SHARED_SECRET,
      RENDITION_RECEIPT_KEY_ID: source.MATERIALIZATION_RECEIPT_KEY_ID,
    });
    expect(bindings.RENDITION_RECEIPT_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bindings).not.toHaveProperty('MATERIALIZATION_RECEIPT_PRIVATE_KEY');
  });

  test('routes only personalized rendition downloads ahead of the delivery custom domain', () => {
    const config = readFileSync(
      resolve(import.meta.dir, '..', 'services', 'rendition-worker', 'wrangler.jsonc'),
      'utf8'
    );

    expect(config).toContain('"pattern": "delivery.yucp.club/v2/renditions*"');
    expect(config).toContain('"zone_name": "yucp.club"');
  });

  test('keeps the Infisical storage format equal to the canonical manifest format', () => {
    const template = readFileSync(
      resolve(import.meta.dir, 'infisical', 'secrets.template.yaml'),
      'utf8'
    );
    const configuredFormats = Array.from(
      template.matchAll(/^\s+STORAGE_FORMAT_VERSION:\s+"([^"]+)"\s*$/gm),
      (match) => match[1]
    );

    expect(configuredFormats).toEqual([DESYNC_STORAGE_FORMAT_VERSION]);
  });
});
