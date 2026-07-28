import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchedulerRuntime } from '../scheduler/server';
import { signUploadCapability, UPLOAD_CAPABILITY_HEADERS } from '../storage-core/uploadSigning';
import { waitForPostgres } from '../testing/postgresReadiness';
import { buildIngestTusRuntime, INGEST_TUS_INFISICAL_KEYS } from './server';

const FETCHED_UPLOAD_HMAC_KEY = 'placeholder-fetched-upload-hmac-key';
const FETCHED_CATALOG_CONTROL_SECRET = 'placeholder-fetched-catalog-control-secret-32-bytes';
const RAW_UPLOAD_HMAC_KEY = 'placeholder-raw-upload-hmac-key-32';
const FETCHED_ALLOWED_ORIGIN = 'https://fetched-app.example.test';
const RAW_ALLOWED_ORIGIN = 'https://raw-app.example.test';
const postgresImage =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'; // postgres:17-alpine
const databaseName = 'ingest_tus_runtime_test';
const schedulerDatabaseName = 'scheduler_runtime_test';
const databasePassword = 'ingest-tus-runtime-test-password';
const containerName = `yucp-ingest-tus-runtime-${randomUUID()}`;
const storageRolePrefixes = ['COMMON', 'METADATA', 'PROTECTED', 'QUARANTINE'] as const;

function storageRoleSecrets(): Record<string, string> {
  return Object.fromEntries(
    storageRolePrefixes.flatMap((prefix) => [
      [`${prefix}_S3_ENDPOINT`, 'https://s3.example.invalid'],
      [`${prefix}_S3_REGION`, 'placeholder-region'],
      [`${prefix}_S3_BUCKET`, `placeholder-${prefix.toLowerCase()}-bucket`],
      [`${prefix}_S3_ACCESS_KEY_ID`, 'placeholder-write-key-id'],
      [`${prefix}_S3_SECRET_ACCESS_KEY`, 'placeholder-write-key-secret'],
    ])
  );
}

const openServers = new Set<ReturnType<typeof createServer>>();
const scratchPaths = new Set<string>();
let catalogDatabaseUrl: string | undefined;
let schedulerCatalogDatabaseUrl: string | undefined;
let containerStarted = false;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runDocker(args: string[]): Promise<CommandResult> {
  const process = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function requireDocker(args: string[]): Promise<string> {
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed with exit code ${result.exitCode}\n${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

async function removePostgresContainer(): Promise<void> {
  if (!containerStarted) {
    return;
  }
  const result = await runDocker(['rm', '--force', containerName]);
  containerStarted = false;
  if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
    throw new Error(
      `Failed to remove PostgreSQL test container: ${result.stderr || result.stdout}`
    );
  }
}

function requireCatalogDatabaseUrl(): string {
  if (!catalogDatabaseUrl) {
    throw new Error('Ingest-tus runtime test database was not initialized');
  }
  return catalogDatabaseUrl;
}

function requireSchedulerCatalogDatabaseUrl(): string {
  if (!schedulerCatalogDatabaseUrl) {
    throw new Error('Scheduler runtime test database was not initialized');
  }
  return schedulerCatalogDatabaseUrl;
}

beforeAll(async () => {
  try {
    await requireDocker(['version']);
    await requireDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--env',
      `POSTGRES_PASSWORD=${databasePassword}`,
      '--env',
      `POSTGRES_DB=${databaseName}`,
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data',
      postgresImage,
    ]);
    containerStarted = true;
    await waitForPostgres({ containerName, databaseName, runDocker });

    const portOutput = await requireDocker(['port', containerName, '5432/tcp']);
    const portMatch = /127\.0\.0\.1:(\d+)$/.exec(portOutput);
    if (!portMatch?.[1]) {
      throw new Error(`Could not determine PostgreSQL test port from: ${portOutput}`);
    }
    await requireDocker([
      'exec',
      containerName,
      'psql',
      '--username',
      'postgres',
      '--dbname',
      databaseName,
      '--command',
      `CREATE DATABASE ${schedulerDatabaseName}`,
    ]);
    catalogDatabaseUrl = `postgres://postgres:${databasePassword}@127.0.0.1:${portMatch[1]}/${databaseName}`;
    schedulerCatalogDatabaseUrl = `postgres://postgres:${databasePassword}@127.0.0.1:${portMatch[1]}/${schedulerDatabaseName}`;
  } catch (error) {
    await removePostgresContainer();
    throw error;
  }
});

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

afterAll(async () => {
  catalogDatabaseUrl = undefined;
  schedulerCatalogDatabaseUrl = undefined;
  await removePostgresContainer();
});

describe('ingest-tus production runtime', () => {
  it('constructs the ingest runtime from Infisical storage configuration', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'yucp-ingest-tus-runtime-test-'));
    const scratchDir = await mkdtemp(join(tmpdir(), 'yucp-ingest-tus-scratch-test-'));
    scratchPaths.add(uploadDir);
    scratchPaths.add(scratchDir);
    const sourceEnv = {
      INFISICAL_PROJECT_ID: 'placeholder-project-id',
      INFISICAL_CLIENT_ID: 'placeholder-client-id',
      INFISICAL_CLIENT_SECRET: 'placeholder-client-secret',
      INGEST_SCRATCH_DIR: scratchDir,
      INGEST_UPLOAD_DIR: uploadDir,
      INGEST_MAX_BYTES: '1048576',
      INGEST_ALLOWED_ORIGIN: RAW_ALLOWED_ORIGIN,
      UPLOAD_HMAC_KEY: RAW_UPLOAD_HMAC_KEY,
    } satisfies NodeJS.ProcessEnv;
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => ({
      CATALOG_MAX_ATTEMPTS: '7',
      UPLOAD_HMAC_KEY: FETCHED_UPLOAD_HMAC_KEY,
      PACKAGE_CATALOG_CONTROL_SHARED_SECRET: FETCHED_CATALOG_CONTROL_SECRET,
      CATALOG_DATABASE_URL: requireCatalogDatabaseUrl(),
      ...storageRoleSecrets(),
      INGEST_ALLOWED_ORIGIN: FETCHED_ALLOWED_ORIGIN,
    }));

    expect(INGEST_TUS_INFISICAL_KEYS).toEqual([
      'UPLOAD_HMAC_KEY',
      'PACKAGE_CATALOG_CONTROL_SHARED_SECRET',
      'CATALOG_DATABASE_URL',
      ...storageRolePrefixes.flatMap((prefix) => [
        `${prefix}_S3_ENDPOINT`,
        `${prefix}_S3_REGION`,
        `${prefix}_S3_BUCKET`,
        `${prefix}_S3_ACCESS_KEY_ID`,
        `${prefix}_S3_SECRET_ACCESS_KEY`,
      ]),
      'CATALOG_MAX_ATTEMPTS',
      'INGEST_ALLOWED_ORIGIN',
    ]);

    const runtime = await buildIngestTusRuntime(sourceEnv, fetchSecrets);
    expect(fetchSecrets).toHaveBeenCalledTimes(1);
    expect(fetchSecrets).toHaveBeenCalledWith(sourceEnv);
    const catalogTables = await runtime.database<
      {
        migrations: string | null;
        outbox: string | null;
        versions: string | null;
      }[]
    >`
      SELECT
        to_regclass('public.catalog_schema_migrations')::text AS migrations,
        to_regclass('public.catalog_outbox')::text AS outbox,
        to_regclass('public.package_versions')::text AS versions
    `;
    expect(catalogTables[0]).toEqual({
      migrations: 'catalog_schema_migrations',
      outbox: 'catalog_outbox',
      versions: 'package_versions',
    });

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

    const preflight = await fetch(`http://127.0.0.1:${port}/files`, {
      method: 'OPTIONS',
      headers: {
        Origin: FETCHED_ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(FETCHED_ALLOWED_ORIGIN);

    async function postWithKey(key: string): Promise<Response> {
      const capability = await signUploadCapability({
        creatorId: 'creator-runtime-test',
        expiresAt: Date.now() + 60_000,
        key,
        packageId: 'com.yucp.runtime-test',
        protectionPolicyId: 'supported-visual-assets-v2',
        version: '1.0.0',
        versionId,
      });
      return fetch(`http://127.0.0.1:${port}/files`, {
        method: 'POST',
        headers: {
          [UPLOAD_CAPABILITY_HEADERS.creatorId]: capability.creatorId,
          [UPLOAD_CAPABILITY_HEADERS.editionId]: capability.editionId,
          [UPLOAD_CAPABILITY_HEADERS.exp]: capability.exp,
          [UPLOAD_CAPABILITY_HEADERS.packageId]: encodeURIComponent(capability.packageId),
          [UPLOAD_CAPABILITY_HEADERS.protectionPolicyId]: capability.protectionPolicyId,
          [UPLOAD_CAPABILITY_HEADERS.sig]: capability.sig,
          [UPLOAD_CAPABILITY_HEADERS.version]: encodeURIComponent(capability.version),
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
      PACKAGE_CATALOG_CONTROL_SHARED_SECRET: FETCHED_CATALOG_CONTROL_SECRET,
      ...storageRoleSecrets(),
    }));

    await expect(buildIngestTusRuntime(sourceEnv, fetchSecrets)).rejects.toThrow(
      'Missing required Infisical secrets: UPLOAD_HMAC_KEY'
    );
  });

  it('migrates a fresh catalog before constructing the scheduler runtime', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'yucp-scheduler-scratch-test-'));
    scratchPaths.add(scratchDir);
    const sourceEnv = {
      INFISICAL_PROJECT_ID: 'placeholder-project-id',
      INFISICAL_CLIENT_ID: 'placeholder-client-id',
      INFISICAL_CLIENT_SECRET: 'placeholder-client-secret',
      INGEST_SCRATCH_DIR: scratchDir,
    } satisfies NodeJS.ProcessEnv;
    const fetchSecrets = mock(async (_env: NodeJS.ProcessEnv) => ({
      CATALOG_MAX_ATTEMPTS: '5',
      CONVEX_API_SECRET: 'placeholder-convex-api-secret',
      CONVEX_URL: 'https://placeholder-convex.invalid',
      INTERNAL_SERVICE_AUTH_SECRET: 'placeholder-internal-service-auth-secret',
      CATALOG_DATABASE_URL: requireSchedulerCatalogDatabaseUrl(),
      ...storageRoleSecrets(),
    }));

    const runtime = await buildSchedulerRuntime(sourceEnv, fetchSecrets);
    expect(fetchSecrets).toHaveBeenCalledTimes(1);
    expect(fetchSecrets).toHaveBeenCalledWith(sourceEnv);
    const catalogTables = await runtime.database<
      {
        migrations: string | null;
        outbox: string | null;
        versions: string | null;
      }[]
    >`
      SELECT
        to_regclass('public.catalog_schema_migrations')::text AS migrations,
        to_regclass('public.catalog_outbox')::text AS outbox,
        to_regclass('public.package_versions')::text AS versions
    `;
    expect(catalogTables[0]).toEqual({
      migrations: 'catalog_schema_migrations',
      outbox: 'catalog_outbox',
      versions: 'package_versions',
    });
    await runtime.database.end({ timeout: 0 });
  });
});
