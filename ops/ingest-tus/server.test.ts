import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signUploadCapability, UPLOAD_CAPABILITY_HEADERS } from '../storage-core/uploadSigning';
import { buildIngestTusRuntime, INGEST_TUS_INFISICAL_KEYS } from './server';

const FETCHED_UPLOAD_HMAC_KEY = 'placeholder-fetched-upload-hmac-key';
const RAW_UPLOAD_HMAC_KEY = 'placeholder-raw-upload-hmac-key';

const openServers = new Set<ReturnType<typeof createServer>>();
const scratchPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  openServers.clear();
  await Promise.all([...scratchPaths].map((path) => rm(path, { force: true, recursive: true })));
  scratchPaths.clear();
});

describe('ingest-tus production runtime', () => {
  it('constructs capability verification with the Infisical UPLOAD_HMAC_KEY', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'yucp-ingest-tus-runtime-test-'));
    scratchPaths.add(uploadDir);
    const sourceEnv = {
      INFISICAL_PROJECT_ID: 'placeholder-project-id',
      INFISICAL_CLIENT_ID: 'placeholder-client-id',
      INFISICAL_CLIENT_SECRET: 'placeholder-client-secret',
      INGEST_UPLOAD_DIR: uploadDir,
      INGEST_MAX_BYTES: '1048576',
      UPLOAD_HMAC_KEY: RAW_UPLOAD_HMAC_KEY,
    } satisfies NodeJS.ProcessEnv;
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => ({
      UPLOAD_HMAC_KEY: FETCHED_UPLOAD_HMAC_KEY,
      CATALOG_DATABASE_URL: 'postgresql://placeholder.invalid/catalog',
      CAS_S3_ENDPOINT: 'https://s3.example.invalid',
      CAS_S3_REGION: 'placeholder-region',
      CAS_S3_BUCKET: 'placeholder-bucket',
      CAS_S3_ACCESS_KEY_ID: 'placeholder-write-key-id',
      CAS_S3_SECRET_ACCESS_KEY: 'placeholder-write-key-secret',
    }));

    expect(INGEST_TUS_INFISICAL_KEYS).toEqual([
      'UPLOAD_HMAC_KEY',
      'CATALOG_DATABASE_URL',
      'CAS_S3_ENDPOINT',
      'CAS_S3_REGION',
      'CAS_S3_BUCKET',
      'CAS_S3_ACCESS_KEY_ID',
      'CAS_S3_SECRET_ACCESS_KEY',
    ]);

    const runtime = await buildIngestTusRuntime(sourceEnv, fetchSecrets);
    expect(fetchSecrets).toHaveBeenCalledTimes(1);
    expect(fetchSecrets).toHaveBeenCalledWith(sourceEnv);

    const server = createServer(runtime.handler);
    openServers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const versionId = 'placeholder-version-id';

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    async function postWithKey(key: string): Promise<Response> {
      const capability = await signUploadCapability({
        expiresAt: Date.now() + 60_000,
        key,
        versionId,
      });
      return fetch(`http://127.0.0.1:${port}/files`, {
        method: 'POST',
        headers: {
          [UPLOAD_CAPABILITY_HEADERS.exp]: capability.exp,
          [UPLOAD_CAPABILITY_HEADERS.sig]: capability.sig,
          [UPLOAD_CAPABILITY_HEADERS.versionId]: capability.versionId,
        },
      });
    }

    expect((await postWithKey(RAW_UPLOAD_HMAC_KEY)).status).toBe(403);
    expect((await postWithKey(FETCHED_UPLOAD_HMAC_KEY)).status).not.toBe(403);
    await runtime.database.end({ timeout: 0 });
  });

  it('does not let a raw UPLOAD_HMAC_KEY mask a missing Infisical declaration', async () => {
    const sourceEnv = {
      INFISICAL_PROJECT_ID: 'placeholder-project-id',
      INFISICAL_CLIENT_ID: 'placeholder-client-id',
      INFISICAL_CLIENT_SECRET: 'placeholder-client-secret',
      UPLOAD_HMAC_KEY: RAW_UPLOAD_HMAC_KEY,
    } satisfies NodeJS.ProcessEnv;
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => ({
      CATALOG_DATABASE_URL: 'postgresql://placeholder.invalid/catalog',
      CAS_S3_ENDPOINT: 'https://s3.example.invalid',
      CAS_S3_REGION: 'placeholder-region',
      CAS_S3_BUCKET: 'placeholder-bucket',
      CAS_S3_ACCESS_KEY_ID: 'placeholder-write-key-id',
      CAS_S3_SECRET_ACCESS_KEY: 'placeholder-write-key-secret',
    }));

    await expect(buildIngestTusRuntime(sourceEnv, fetchSecrets)).rejects.toThrow(
      'Missing required Infisical secrets: UPLOAD_HMAC_KEY'
    );
  });
});
