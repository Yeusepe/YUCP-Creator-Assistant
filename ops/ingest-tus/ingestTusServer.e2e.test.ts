import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { DetailedError, type HttpRequest, type HttpResponse, Upload } from 'tus-js-client';
import {
  Catalog,
  type CatalogDatabase,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../catalog';
import { retrieveVersion } from '../ingest-pipeline';
import { canonicalizeArtifact } from '../storage-core/canonicalizer';
import { measureLocalStore, verifyDesyncCli } from '../storage-core/desyncCas';
import { runCommand } from '../storage-core/process';
import { createIngestTusServer, INGEST_TUS_PATH } from './ingestTusServer';

const postgresImage = 'postgres:17-alpine';
const databaseName = 'ingest_tus_test';
const databasePassword = 'ingest-tus-test-password';
const containerName = `yucp-ingest-tus-e2e-${randomUUID()}`;
const chunkSize = 256 * 1024;

let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let containerStarted = false;
let scratchPath: string | undefined;
let fixturePath: string | undefined;
let corruptFixturePath: string | undefined;
let httpServer: HttpServer | undefined;
let serverOrigin: string | undefined;
let maxBytes = 0;

const summary: {
  byteExact?: boolean;
  dedupStoreDelta?: number;
  guardRejection?: boolean;
  healthz?: boolean;
  lifecycle?: string;
  resumeOffset?: number;
} = {};

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CatalogRow {
  id: string;
  state: string;
  format_tag: string | null;
  canonical_sha256: string | null;
  cas_index_id: string | null;
  error: string | null;
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

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastResult: CommandResult | undefined;

  while (Date.now() < deadline) {
    lastResult = await runDocker([
      'exec',
      containerName,
      'pg_isready',
      '--username',
      'postgres',
      '--dbname',
      databaseName,
    ]);
    if (lastResult.exitCode === 0) {
      return;
    }
    await Bun.sleep(250);
  }

  const logs = await runDocker(['logs', containerName]);
  throw new Error(
    `PostgreSQL did not become ready within 60 seconds.\n${lastResult?.stderr ?? ''}\n${logs.stderr}\n${logs.stdout}`
  );
}

function requireCatalog(): Catalog {
  if (!catalog) {
    throw new Error('Tus ingest end-to-end catalog was not initialized');
  }
  return catalog;
}

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('Tus ingest end-to-end database was not initialized');
  }
  return sql;
}

function requireScratchPath(): string {
  if (!scratchPath) {
    throw new Error('Tus ingest end-to-end scratch directory was not initialized');
  }
  return scratchPath;
}

function requireFixturePath(path: string | undefined, label: string): string {
  if (!path) {
    throw new Error(`${label} fixture was not initialized`);
  }
  return path;
}

function requireServerOrigin(): string {
  if (!serverOrigin) {
    throw new Error('Tus ingest HTTP server was not initialized');
  }
  return serverOrigin;
}

function deterministicBytes(seed: string, byteLength: number): Buffer {
  return createHash('shake256', { outputLength: byteLength }).update(seed).digest();
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function createUnityPackageFixture(rootPath: string, outputPath: string): Promise<void> {
  const timestamp = new Date('2025-01-01T00:00:00Z');
  const payloads = new Map<string, Buffer>([
    ['Assets/Package/manifest.json', Buffer.from('{"name":"com.yucp.tus-e2e"}\n')],
    ['Assets/Package/payload.bin', deterministicBytes('tus-resume-payload', 2 * 1024 * 1024)],
    ['Assets/Package/preview.bin', deterministicBytes('tus-resume-preview', 512 * 1024)],
  ]);
  for (const [assetPath, bytes] of payloads) {
    const filePath = join(rootPath, assetPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    await utimes(filePath, timestamp, timestamp);
  }
  for (const directory of ['Assets/Package', 'Assets', '.']) {
    await utimes(join(rootPath, directory), timestamp, timestamp);
  }

  const tarPath = `${outputPath}.tar`;
  await runCommand('tar', [
    '--force-local',
    '--create',
    '--file',
    tarPath,
    '--format=gnu',
    '--sort=name',
    '--directory',
    rootPath,
    '.',
  ]);
  await utimes(tarPath, timestamp, timestamp);
  await runCommand('gzip', ['--stdout', '--', tarPath], { stdoutPath: outputPath });
  await rm(tarPath, { force: true });
}

function assertScratchPath(path: string): void {
  const relativePath = relative(resolve(tmpdir()), resolve(path));
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`Refusing to clean scratch path outside the system temp directory: ${path}`);
  }
}

async function closeHttpServer(): Promise<void> {
  const activeServer = httpServer;
  httpServer = undefined;
  serverOrigin = undefined;
  if (!activeServer) {
    return;
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    activeServer.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function outboxEventTypes(versionId: string): Promise<string[]> {
  const rows = await requireSql()<
    {
      event_type: string;
    }[]
  >`
    SELECT event_type
    FROM catalog_outbox
    WHERE aggregate_id = ${versionId}
    ORDER BY created_at, id
  `;
  return rows.map((row) => row.event_type);
}

async function versionRow(packageId: string, version: string): Promise<CatalogRow> {
  const rows = await requireSql()<CatalogRow[]>`
    SELECT id, state, format_tag, canonical_sha256, cas_index_id, error
    FROM package_versions
    WHERE package_id = ${packageId} AND version = ${version}
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Missing package version row for ${packageId}@${version}`);
  }
  return row;
}

function responseStatus(error: Error | DetailedError): number | undefined {
  return error instanceof DetailedError ? error.originalResponse?.getStatus() : undefined;
}

function createInterruptedUpload(input: {
  endpoint: string;
  filePath: string;
  packageId: string;
  version: string;
}): {
  completed: Promise<void>;
  interrupted: Promise<number>;
  resume: () => void;
  resumeOffset: () => number | undefined;
  uploadUrl: () => string | null;
} {
  const source = createReadStream(input.filePath);
  let didInterrupt = false;
  let isResuming = false;
  let observedResumeOffset: number | undefined;
  let resolveInterrupted: (offset: number) => void = () => {};
  let rejectInterrupted: (error: Error | DetailedError) => void = () => {};
  const interrupted = new Promise<number>((resolvePromise, rejectPromise) => {
    resolveInterrupted = resolvePromise;
    rejectInterrupted = rejectPromise;
  });
  let resolveCompleted: () => void = () => {};
  let rejectCompleted: (error: Error | DetailedError) => void = () => {};
  const completed = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveCompleted = resolvePromise;
    rejectCompleted = rejectPromise;
  });

  const upload = new Upload(source as never, {
    endpoint: input.endpoint,
    chunkSize,
    metadata: {
      filename: `${input.packageId}-${input.version}.unitypackage`,
      filetype: 'application/octet-stream',
      packageId: input.packageId,
      version: input.version,
    },
    retryDelays: null,
    onAfterResponse(request: HttpRequest, response: HttpResponse) {
      if (isResuming && request.getMethod() === 'HEAD') {
        observedResumeOffset = Number(response.getHeader('Upload-Offset'));
      }
    },
    onChunkComplete(_acceptedChunkSize, bytesAccepted, bytesTotal) {
      if (!didInterrupt && bytesAccepted > 0 && bytesAccepted < bytesTotal) {
        didInterrupt = true;
        void upload.abort(false).then(
          () => resolveInterrupted(bytesAccepted),
          (error) => rejectInterrupted(error as Error)
        );
      }
    },
    onError(error) {
      if (!didInterrupt) {
        rejectInterrupted(error);
      }
      rejectCompleted(error);
      source.destroy();
    },
    onSuccess() {
      resolveCompleted();
    },
  });
  upload.start();

  return {
    completed,
    interrupted,
    resume() {
      isResuming = true;
      upload.start();
    },
    resumeOffset: () => observedResumeOffset,
    uploadUrl: () => upload.url,
  };
}

async function uploadToCompletion(input: {
  endpoint: string;
  filePath: string;
  packageId: string;
  version: string;
}): Promise<void> {
  const source = createReadStream(input.filePath);
  try {
    await new Promise<void>((resolveUpload, rejectUpload) => {
      const upload = new Upload(source as never, {
        endpoint: input.endpoint,
        chunkSize,
        metadata: {
          filename: `${input.packageId}-${input.version}.unitypackage`,
          filetype: 'application/octet-stream',
          packageId: input.packageId,
          version: input.version,
        },
        retryDelays: null,
        onError: rejectUpload,
        onSuccess() {
          resolveUpload();
        },
      });
      upload.start();
    });
  } finally {
    source.destroy();
  }
}

async function uploadExpectingRejection(input: {
  endpoint: string;
  filePath: string;
  filename: string;
  filetype: string;
  packageId: string;
  uploadSize?: number;
  version: string;
}): Promise<Error | DetailedError> {
  const source = createReadStream(input.filePath);
  let upload: Upload | undefined;
  try {
    return await new Promise<Error | DetailedError>((resolveError, rejectUnexpectedSuccess) => {
      upload = new Upload(source as never, {
        endpoint: input.endpoint,
        chunkSize,
        metadata: {
          filename: input.filename,
          filetype: input.filetype,
          packageId: input.packageId,
          version: input.version,
        },
        retryDelays: null,
        ...(input.uploadSize === undefined ? {} : { uploadSize: input.uploadSize }),
        onError: resolveError,
        onSuccess() {
          rejectUnexpectedSuccess(new Error('Expected the tus upload to be rejected'));
        },
      });
      upload.start();
    });
  } finally {
    await upload?.abort(false);
    source.destroy();
  }
}

beforeAll(async () => {
  try {
    await verifyDesyncCli();
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
    await waitForPostgres();

    const portOutput = await requireDocker(['port', containerName, '5432/tcp']);
    const portMatch = /127\.0\.0\.1:(\d+)$/.exec(portOutput);
    if (!portMatch?.[1]) {
      throw new Error(`Could not determine PostgreSQL test port from: ${portOutput}`);
    }
    sql = openCatalogDatabase(
      `postgres://postgres:${databasePassword}@127.0.0.1:${portMatch[1]}/${databaseName}`
    );
    await runCatalogMigrations(sql);
    catalog = new Catalog(sql);

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-tus-e2e-'));
    const fixtureTree = join(scratchPath, 'fixture-tree');
    await mkdir(fixtureTree);
    fixturePath = join(scratchPath, 'fixture.unitypackage');
    await createUnityPackageFixture(fixtureTree, fixturePath);
    corruptFixturePath = join(scratchPath, 'corrupt.unitypackage');
    await writeFile(corruptFixturePath, 'not a gzip-compressed unitypackage');
    maxBytes = (await stat(fixturePath)).size + 1024;

    const handler = createIngestTusServer({
      catalog,
      storePath: join(scratchPath, 'cas-store'),
      indexDir: join(scratchPath, 'cas-indexes'),
      uploadDir: join(scratchPath, 'uploads'),
      maxBytes,
    });
    httpServer = createServer(handler);
    await new Promise<void>((resolveListen, rejectListen) => {
      httpServer?.once('error', rejectListen);
      httpServer?.listen(0, '127.0.0.1', () => {
        httpServer?.off('error', rejectListen);
        resolveListen();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Tus ingest HTTP server did not bind a TCP port');
    }
    serverOrigin = `http://127.0.0.1:${(address as AddressInfo).port}`;
  } catch (error) {
    const activeSql = sql;
    sql = undefined;
    catalog = undefined;
    try {
      await closeHttpServer();
      await activeSql?.end({ timeout: 1 });
    } finally {
      if (scratchPath) {
        assertScratchPath(scratchPath);
        await rm(scratchPath, { force: true, recursive: true });
        scratchPath = undefined;
      }
      await removePostgresContainer();
    }
    throw error;
  }
});

beforeEach(async () => {
  await requireSql()`TRUNCATE TABLE catalog_outbox, package_versions`;
});

afterAll(async () => {
  const activeSql = sql;
  sql = undefined;
  catalog = undefined;
  try {
    await closeHttpServer();
    await activeSql?.end({ timeout: 1 });
  } finally {
    if (scratchPath) {
      assertScratchPath(scratchPath);
      await rm(scratchPath, { force: true, recursive: true });
      scratchPath = undefined;
    }
    await removePostgresContainer();
  }
});

describe.serial('tus ingest end to end', () => {
  it('interrupts, resumes from the server offset, assembles, retrieves, and deduplicates', async () => {
    const activeCatalog = requireCatalog();
    const scratch = requireScratchPath();
    const fixture = requireFixturePath(fixturePath, 'valid unitypackage');
    const endpoint = `${requireServerOrigin()}${INGEST_TUS_PATH}`;
    const expectedCanonical = await canonicalizeArtifact({
      inputPath: fixture,
      outputPath: join(scratch, 'expected.canonical'),
    });
    const expectedSha256 = await sha256File(expectedCanonical.path);

    const resumable = createInterruptedUpload({
      endpoint,
      filePath: fixture,
      packageId: 'com.yucp.tus-resume',
      version: '1.0.0',
    });
    const interruptedAt = await resumable.interrupted;
    expect(interruptedAt).toBeGreaterThan(0);
    expect(interruptedAt).toBeLessThan((await stat(fixture)).size);
    expect(resumable.uploadUrl()).toBeTruthy();

    const uploadingRow = await versionRow('com.yucp.tus-resume', '1.0.0');
    expect(uploadingRow.state).toBe('UPLOADING');
    resumable.resume();
    await resumable.completed;

    const resumeOffset = resumable.resumeOffset();
    expect(resumeOffset).toBe(interruptedAt);
    expect(resumeOffset).toBeGreaterThan(0);
    const assembledRow = await versionRow('com.yucp.tus-resume', '1.0.0');
    expect(assembledRow).toMatchObject({
      state: 'ASSEMBLED',
      format_tag: 'CANONICAL_TARGZ_V1',
      canonical_sha256: expectedSha256,
      error: null,
    });
    expect(assembledRow.format_tag).not.toBeNull();
    expect(assembledRow.canonical_sha256).not.toBeNull();
    expect(assembledRow.cas_index_id).not.toBeNull();
    expect(await outboxEventTypes(assembledRow.id)).toEqual([
      'catalog.version.created',
      'catalog.version.uploading',
      'catalog.version.assembled',
    ]);

    const retrievedPath = await retrieveVersion({
      catalog: activeCatalog,
      storePath: join(scratch, 'cas-store'),
      versionId: assembledRow.id,
      outputPath: join(scratch, 'retrieved.unitypackage'),
    });
    expect(await sha256File(retrievedPath)).toBe(expectedSha256);
    expect((await stat(retrievedPath)).size).toBe((await stat(expectedCanonical.path)).size);

    const storeBeforeDuplicate = await measureLocalStore(join(scratch, 'cas-store'));
    await uploadToCompletion({
      endpoint,
      filePath: fixture,
      packageId: 'com.yucp.tus-resume',
      version: '1.0.1',
    });
    const storeAfterDuplicate = await measureLocalStore(join(scratch, 'cas-store'));
    expect(storeAfterDuplicate).toEqual(storeBeforeDuplicate);

    summary.resumeOffset = resumeOffset;
    summary.lifecycle = 'CREATED->UPLOADING->ASSEMBLED';
    summary.byteExact = true;
    summary.dedupStoreDelta = storeAfterDuplicate.bytes - storeBeforeDuplicate.bytes;
  });

  it('rejects oversize and disallowed creations without catalog rows', async () => {
    const fixture = requireFixturePath(fixturePath, 'valid unitypackage');
    const endpoint = `${requireServerOrigin()}${INGEST_TUS_PATH}`;
    const oversizeError = await uploadExpectingRejection({
      endpoint,
      filePath: fixture,
      filename: 'oversize.unitypackage',
      filetype: 'application/octet-stream',
      packageId: 'com.yucp.tus-oversize',
      uploadSize: maxBytes + 1,
      version: '1.0.0',
    });
    expect(responseStatus(oversizeError)).toBe(413);

    const disallowedError = await uploadExpectingRejection({
      endpoint,
      filePath: fixture,
      filename: 'malware.exe',
      filetype: 'application/x-msdownload',
      packageId: 'com.yucp.tus-disallowed',
      version: '1.0.0',
    });
    expect(responseStatus(disallowedError)).toBe(415);
    const rows = await requireSql()<
      {
        count: number;
      }[]
    >`
      SELECT count(*)::int AS count
      FROM package_versions
      WHERE package_id IN ('com.yucp.tus-oversize', 'com.yucp.tus-disallowed')
    `;
    expect(rows[0]?.count).toBe(0);
    summary.guardRejection = true;
  });

  it('marks a version failed when inline assembly rejects the completed upload', async () => {
    const endpoint = `${requireServerOrigin()}${INGEST_TUS_PATH}`;
    const assemblyError = await uploadExpectingRejection({
      endpoint,
      filePath: requireFixturePath(corruptFixturePath, 'corrupt unitypackage'),
      filename: 'corrupt.unitypackage',
      filetype: 'application/octet-stream',
      packageId: 'com.yucp.tus-corrupt',
      version: '1.0.0',
    });
    expect(responseStatus(assemblyError)).toBe(500);
    const failedRow = await versionRow('com.yucp.tus-corrupt', '1.0.0');
    expect(failedRow.state).toBe('FAILED');
    expect(failedRow.error?.trim().length).toBeGreaterThan(0);
    expect(await outboxEventTypes(failedRow.id)).toEqual([
      'catalog.version.created',
      'catalog.version.uploading',
      'catalog.version.failed',
    ]);
  });

  it('serves healthz and reports the e2e proof', async () => {
    const response = await fetch(`${requireServerOrigin()}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    summary.healthz = true;
    expect(summary).toEqual({
      resumeOffset: expect.any(Number),
      lifecycle: 'CREATED->UPLOADING->ASSEMBLED',
      byteExact: true,
      dedupStoreDelta: 0,
      guardRejection: true,
      healthz: true,
    });
    console.log(
      [
        'INGEST_TUS_E2E_RESULT',
        `resume-offset=${summary.resumeOffset}`,
        `lifecycle=${summary.lifecycle}`,
        `byte-exact-retrieve=${summary.byteExact ? 'yes' : 'no'}`,
        `dedup-store-delta=${summary.dedupStoreDelta}`,
        `guard-rejection=${summary.guardRejection ? 'yes' : 'no'}`,
        `healthz=${summary.healthz ? 'yes' : 'no'}`,
      ].join('\n')
    );
  });
});
