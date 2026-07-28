import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DetailedError, type HttpRequest, type HttpResponse, Upload } from 'tus-js-client';
import {
  Catalog,
  type CatalogDatabase,
  ExactStorageCatalog,
  openCatalogDatabase,
  runCatalogMigrations,
} from '../catalog';
import { retrieveVersion } from '../ingest-pipeline';
import { loadCasConfig } from '../storage-core/config';
import { parseDeliveryManifest } from '../storage-core/deliveryManifest';
import {
  localCasStore,
  measureLocalStore,
  readCasIndexObject,
  type S3CasStore,
  s3CasStore,
  verifyDesyncCli,
} from '../storage-core/desyncCas';
import { DurableExactStorage } from '../storage-core/durableExactStorage';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import { DIRECT_FILE_CHUNK_LIMIT_BYTES } from '../storage-core/logicalFileCas';
import { normalizePackageArtifact } from '../storage-core/packageNormalizer';
import { createS3Bucket, listS3Objects } from '../storage-core/s3Control';
import { signUploadCapability } from '../storage-core/uploadSigning';
import { waitForMinioReady } from '../testing/minioReadiness';
import { waitForPostgres } from '../testing/postgresReadiness';
import { createUnityPackageRecordFixture } from '../testing/unityPackageFixture';
import {
  createIngestTusServer,
  INGEST_TUS_PATH,
  type IngestTusRequestListener,
  UPLOAD_CAPABILITY_HEADERS,
} from './ingestTusServer';
import { createS3QuarantineStorage, type QuarantineStoragePort } from './quarantine';

const postgresImage =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'; // postgres:17-alpine
const minioImage =
  'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e'; // minio/minio:RELEASE.2025-09-07T16-13-09Z
const databaseName = 'ingest_tus_test';
const databasePassword = 'ingest-tus-test-password';
const containerName = `yucp-ingest-tus-e2e-${randomUUID()}`;
const minioContainerName = `yucp-ingest-tus-minio-e2e-${randomUUID()}`;
const chunkSize = 256 * 1024;
const uploadHmacKey = 'trusted-ingest-tus-e2e-hmac-key-32';
const browserOrigin = 'https://app.example.test';

let sql: CatalogDatabase | undefined;
let catalog: Catalog | undefined;
let containerStarted = false;
let minioContainerStarted = false;
let scratchPath: string | undefined;
let fixturePath: string | undefined;
let corruptFixturePath: string | undefined;
let httpServer: HttpServer | undefined;
let serverOrigin: string | undefined;
let s3HttpServer: HttpServer | undefined;
let s3ServerOrigin: string | undefined;
let tusHandler: IngestTusRequestListener | undefined;
let s3TusHandler: IngestTusRequestListener | undefined;
let s3CommonStore: S3CasStore | undefined;
let s3MetadataStore: S3CasStore | undefined;
let s3ProtectedStore: S3CasStore | undefined;
let quarantineStorage: QuarantineStoragePort | undefined;
let maxBytes = 0;

const summary: {
  byteExact?: boolean;
  dedupStoreDelta?: number;
  guardRejection?: boolean;
  healthz?: boolean;
  lifecycle?: string;
  resumeOffset?: number;
  s3ByteExact?: boolean;
  s3Chunks?: number;
} = {};

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CatalogRow {
  assembly_object_id: string | null;
  release_root: string | null;
  source_format: string | null;
  id: string;
  state: string;
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

async function removeMinioContainer(): Promise<void> {
  if (!minioContainerStarted) {
    return;
  }
  const result = await runDocker(['rm', '--force', minioContainerName]);
  minioContainerStarted = false;
  if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
    throw new Error(`Failed to remove MinIO test container: ${result.stderr || result.stdout}`);
  }
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

function requireS3ServerOrigin(): string {
  if (!s3ServerOrigin) {
    throw new Error('S3-backed tus ingest HTTP server was not initialized');
  }
  return s3ServerOrigin;
}

function requireS3Stores(): {
  common: S3CasStore;
  metadata: S3CasStore;
  protected: S3CasStore;
} {
  if (!s3CommonStore || !s3MetadataStore || !s3ProtectedStore) {
    throw new Error('Tus ingest MinIO role stores were not initialized');
  }
  return {
    common: s3CommonStore,
    metadata: s3MetadataStore,
    protected: s3ProtectedStore,
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
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

async function closeServer(activeServer: HttpServer | undefined): Promise<void> {
  if (!activeServer) {
    return;
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    activeServer.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function closeHttpServers(): Promise<void> {
  const activeLocalServer = httpServer;
  const activeS3Server = s3HttpServer;
  httpServer = undefined;
  s3HttpServer = undefined;
  serverOrigin = undefined;
  s3ServerOrigin = undefined;
  await Promise.all([closeServer(activeLocalServer), closeServer(activeS3Server)]);
}

async function listen(handler: RequestListener): Promise<{
  origin: string;
  server: HttpServer;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Tus ingest HTTP server did not bind a TCP port');
  }
  return { origin: `http://127.0.0.1:${(address as AddressInfo).port}`, server };
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
    SELECT id, state, source_format, release_root, assembly_object_id, error
    FROM package_versions
    WHERE package_id = ${packageId} AND version = ${version}
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Missing package version row for ${packageId}@${version}`);
  }
  return row;
}

function requireQuarantineStorage(): QuarantineStoragePort {
  if (!quarantineStorage) {
    throw new Error('Quarantine storage was not initialized');
  }
  return quarantineStorage;
}

async function expectLogicalTreeMatches(input: {
  expectedRoot: string;
  retrievedRoot: string;
}): Promise<void> {
  const expected = await normalizePackageArtifact({
    inputPath: input.expectedRoot,
    outputRoot: join(requireScratchPath(), `expected-logical-${randomUUID()}`),
    packageId: 'com.yucp.expected',
  });
  for (const file of expected.files) {
    const retrieved = join(input.retrievedRoot, ...file.normalizedPath.split('/'));
    expect(await sha256File(retrieved)).toBe(file.sha256);
    expect((await stat(retrieved)).size).toBe(file.bytes);
  }
}

function responseStatus(error: Error | DetailedError): number | undefined {
  return error instanceof DetailedError ? error.originalResponse?.getStatus() : undefined;
}

function responseBody(error: Error | DetailedError): string | undefined {
  return error instanceof DetailedError ? error.originalResponse?.getBody() : undefined;
}

function uploadMetadataHeader(input: {
  filename: string;
  packageId: string;
  version: string;
}): string {
  return Object.entries(input)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');
}

async function uploadCapabilityHeaders(input: {
  catalogProductId?: string;
  creatorId?: string;
  packageId: string;
  version: string;
  versionId?: string;
}): Promise<Record<string, string>> {
  const capability = await signUploadCapability({
    catalogProductId: input.catalogProductId,
    creatorId: input.creatorId ?? 'creator-ingest-e2e',
    expiresAt: Date.now() + 10 * 60_000,
    key: uploadHmacKey,
    packageId: input.packageId,
    protectionPolicyId: 'supported-visual-assets-v2',
    version: input.version,
    versionId: input.versionId ?? randomUUID(),
  });
  return {
    ...(capability.catalogProductId
      ? {
          [UPLOAD_CAPABILITY_HEADERS.catalogProductId]: encodeURIComponent(
            capability.catalogProductId
          ),
        }
      : {}),
    [UPLOAD_CAPABILITY_HEADERS.exp]: capability.exp,
    [UPLOAD_CAPABILITY_HEADERS.creatorId]: encodeURIComponent(capability.creatorId),
    [UPLOAD_CAPABILITY_HEADERS.editionId]: capability.editionId,
    [UPLOAD_CAPABILITY_HEADERS.packageId]: encodeURIComponent(capability.packageId),
    [UPLOAD_CAPABILITY_HEADERS.protectionPolicyId]: capability.protectionPolicyId,
    [UPLOAD_CAPABILITY_HEADERS.sig]: capability.sig,
    [UPLOAD_CAPABILITY_HEADERS.version]: encodeURIComponent(capability.version),
    [UPLOAD_CAPABILITY_HEADERS.versionId]: capability.versionId,
  };
}

async function createInterruptedUpload(input: {
  endpoint: string;
  filePath: string;
  packageId: string;
  version: string;
}): Promise<{
  completed: Promise<void>;
  interrupted: Promise<number>;
  resume: () => void;
  resumeOffset: () => number | undefined;
  uploadUrl: () => string | null;
}> {
  const headers = await uploadCapabilityHeaders(input);
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
    headers,
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

/**
 * A completed PATCH now only proves the bytes were accepted; assembly continues detached from the
 * request and reports through the catalog. Tests that assert on post-assembly state must drain the
 * handlers first, exactly like shutdown does.
 */
async function drainAssemblies(): Promise<void> {
  await tusHandler?.drainInFlightAssemblies();
  await s3TusHandler?.drainInFlightAssemblies();
}

async function uploadToCompletion(input: {
  endpoint: string;
  filePath: string;
  packageId: string;
  version: string;
}): Promise<void> {
  const headers = await uploadCapabilityHeaders(input);
  const source = createReadStream(input.filePath);
  try {
    await new Promise<void>((resolveUpload, rejectUpload) => {
      const upload = new Upload(source as never, {
        endpoint: input.endpoint,
        chunkSize,
        headers,
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
  await drainAssemblies();
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
  const headers = await uploadCapabilityHeaders(input);
  const source = createReadStream(input.filePath);
  let upload: Upload | undefined;
  try {
    return await new Promise<Error | DetailedError>((resolveError, rejectUnexpectedSuccess) => {
      upload = new Upload(source as never, {
        endpoint: input.endpoint,
        chunkSize,
        headers,
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
    await waitForPostgres({ containerName, databaseName, runDocker });

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

    const accessKeyId = `test-${randomUUID()}`;
    const secretAccessKey = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    const bucket = `ingest-tus-${randomUUID()}`;
    const minioResult = await runDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      minioContainerName,
      '--publish',
      '127.0.0.1::9000',
      '--env',
      `MINIO_ROOT_USER=${accessKeyId}`,
      '--env',
      `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      minioImage,
      'server',
      '/data',
      '--address',
      ':9000',
    ]);
    if (minioResult.exitCode !== 0) {
      throw new Error(
        `Failed to start MinIO test container: ${minioResult.stderr || minioResult.stdout}`
      );
    }
    minioContainerStarted = true;
    const minioPortOutput = await requireDocker(['port', minioContainerName, '9000/tcp']);
    const minioPortMatch = /127\.0\.0\.1:(\d+)$/.exec(minioPortOutput);
    if (!minioPortMatch?.[1]) {
      throw new Error(`Could not determine MinIO test port from: ${minioPortOutput}`);
    }
    const minioEndpoint = `http://127.0.0.1:${minioPortMatch[1]}`;
    await waitForMinioReady({ endpoint: minioEndpoint });
    const commonConfig = loadCasConfig({
      CAS_S3_ENDPOINT: minioEndpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: `${bucket}-common`,
      CAS_S3_ACCESS_KEY_ID: accessKeyId,
      CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
      CAS_CHUNK_PREFIX: 'chunks',
      CAS_INDEX_PREFIX: 'indexes',
    });
    const metadataConfig = loadCasConfig({
      CAS_S3_ENDPOINT: minioEndpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: `${bucket}-metadata`,
      CAS_S3_ACCESS_KEY_ID: accessKeyId,
      CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
      CAS_CHUNK_PREFIX: 'chunks',
      CAS_INDEX_PREFIX: 'indexes',
    });
    const protectedConfig = loadCasConfig({
      CAS_S3_ENDPOINT: minioEndpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: `${bucket}-protected`,
      CAS_S3_ACCESS_KEY_ID: accessKeyId,
      CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
      CAS_CHUNK_PREFIX: 'chunks',
      CAS_INDEX_PREFIX: 'indexes',
    });
    for (const config of [commonConfig, metadataConfig, protectedConfig]) {
      await createS3Bucket(config);
    }
    const durableStorage = new DurableExactStorage(
      new ExactStorageCatalog(requireSql()),
      new S3ExactStoragePort({
        common: commonConfig,
        metadata: metadataConfig,
        protected: protectedConfig,
      })
    );
    s3CommonStore = s3CasStore(commonConfig, {
      durableStorage,
      storageRole: 'common',
    });
    s3MetadataStore = s3CasStore(metadataConfig, {
      durableStorage,
      storageRole: 'metadata',
    });
    s3ProtectedStore = s3CasStore(protectedConfig, {
      durableStorage,
      storageRole: 'protected',
    });
    const quarantineConfig = loadCasConfig({
      CAS_S3_ENDPOINT: minioEndpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: `${bucket}-quarantine`,
      CAS_S3_ACCESS_KEY_ID: accessKeyId,
      CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
    });
    await createS3Bucket(quarantineConfig);
    quarantineStorage = createS3QuarantineStorage(quarantineConfig);

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-tus-e2e-'));
    fixturePath = join(scratchPath, 'fixture.unitypackage');
    await createUnityPackageRecordFixture({
      outputPath: fixturePath,
      timestamp: new Date('2025-01-01T00:00:00Z'),
      versionSeed: 'tus-resume-payload',
    });
    corruptFixturePath = join(scratchPath, 'corrupt.unitypackage');
    await writeFile(corruptFixturePath, 'not a gzip-compressed unitypackage');
    maxBytes = (await stat(fixturePath)).size + 1024;

    const handler = createIngestTusServer({
      allowedOrigin: browserOrigin,
      catalog,
      commonStore: localCasStore(join(scratchPath, 'common-store')),
      metadataStore: localCasStore(join(scratchPath, 'metadata-store')),
      protectedStore: localCasStore(join(scratchPath, 'protected-store')),
      quarantineStorage,
      scratchRoot: join(scratchPath, 'pipeline-scratch'),
      uploadDir: join(scratchPath, 'uploads'),
      uploadHmacKey,
      catalogControlSharedSecret: 'e2e-catalog-control-test-secret-32-bytes',
      maxBytes,
    });
    tusHandler = handler;
    const localListener = await listen(handler);
    httpServer = localListener.server;
    serverOrigin = localListener.origin;

    const s3Handler = createIngestTusServer({
      catalog,
      commonStore: requireS3Stores().common,
      metadataStore: requireS3Stores().metadata,
      protectedStore: requireS3Stores().protected,
      quarantineStorage,
      scratchRoot: join(scratchPath, 'pipeline-scratch'),
      uploadDir: join(scratchPath, 's3-uploads'),
      uploadHmacKey,
      catalogControlSharedSecret: 'e2e-catalog-control-test-secret-32-bytes',
      maxBytes,
    });
    s3TusHandler = s3Handler;
    const s3Listener = await listen(s3Handler);
    s3HttpServer = s3Listener.server;
    s3ServerOrigin = s3Listener.origin;
  } catch (error) {
    const activeSql = sql;
    sql = undefined;
    catalog = undefined;
    s3CommonStore = undefined;
    s3MetadataStore = undefined;
    s3ProtectedStore = undefined;
    quarantineStorage = undefined;
    try {
      await closeHttpServers();
      await activeSql?.end({ timeout: 1 });
    } finally {
      if (scratchPath) {
        assertScratchPath(scratchPath);
        await rm(scratchPath, { force: true, recursive: true });
        scratchPath = undefined;
      }
      await Promise.all([removePostgresContainer(), removeMinioContainer()]);
    }
    throw error;
  }
});

beforeEach(async () => {
  await requireSql()`TRUNCATE TABLE catalog_outbox, package_versions CASCADE`;
});

afterAll(async () => {
  const activeSql = sql;
  sql = undefined;
  catalog = undefined;
  try {
    await drainAssemblies();
    await closeHttpServers();
    await activeSql?.end({ timeout: 1 });
  } finally {
    if (scratchPath) {
      assertScratchPath(scratchPath);
      await rm(scratchPath, { force: true, recursive: true });
      scratchPath = undefined;
    }
    s3CommonStore = undefined;
    s3MetadataStore = undefined;
    s3ProtectedStore = undefined;
    quarantineStorage = undefined;
    await Promise.all([removePostgresContainer(), removeMinioContainer()]);
  }
});

describe.serial('tus ingest end to end', () => {
  it('interrupts, resumes from the server offset, assembles, retrieves, and deduplicates', async () => {
    const activeCatalog = requireCatalog();
    const scratch = requireScratchPath();
    const fixture = requireFixturePath(fixturePath, 'valid unitypackage');
    const endpoint = `${requireServerOrigin()}${INGEST_TUS_PATH}`;

    const resumable = await createInterruptedUpload({
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
    try {
      await resumable.completed;
    } catch (error) {
      const failed = await versionRow('com.yucp.tus-resume', '1.0.0');
      throw new Error(`Tus assembly failed: ${failed.error ?? 'unknown error'}`, {
        cause: error,
      });
    }
    await drainAssemblies();

    const completedUploadUrl = resumable.uploadUrl();
    if (!completedUploadUrl) {
      throw new Error('Completed tus upload did not retain its upload URL');
    }
    const completedUploadId = decodeURIComponent(
      new URL(completedUploadUrl).pathname.split('/').at(-1) ?? ''
    );
    await expect(stat(join(scratch, 'uploads', completedUploadId))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const resumeOffset = resumable.resumeOffset();
    expect(resumeOffset).toBe(interruptedAt);
    expect(resumeOffset).toBeGreaterThan(0);
    const assembledRow = await versionRow('com.yucp.tus-resume', '1.0.0');
    expect(assembledRow).toMatchObject({
      state: 'ASSEMBLED',
      source_format: 'unitypackage',
      error: null,
    });
    expect(assembledRow.release_root).toMatch(/^[0-9a-f]{64}$/);
    expect(assembledRow.assembly_object_id).toMatch(
      new RegExp(`^local:.*${assembledRow.id}\\.logical-tree-assembly-v4\\.json$`)
    );
    expect(await outboxEventTypes(assembledRow.id)).toEqual([
      'catalog.version.created',
      'catalog.version.uploading',
      'catalog.version.assembled',
    ]);
    const rawQuarantine = await activeCatalog.getQuarantineObject(assembledRow.id);
    expect(rawQuarantine).toMatchObject({
      bytes: (await stat(fixture)).size,
      sha256: await sha256File(fixture),
      state: 'COMMITTED',
    });
    if (!rawQuarantine?.providerVersion || !rawQuarantine.fileIdentifier) {
      throw new Error('Committed quarantine object has no exact provider version');
    }
    const exactRaw = await requireQuarantineStorage().headExactVersion(
      rawQuarantine.objectKey,
      rawQuarantine.providerVersion
    );
    expect(exactRaw).toMatchObject({
      contentLength: rawQuarantine.bytes,
      fileIdentifier: rawQuarantine.fileIdentifier,
      providerVersion: rawQuarantine.providerVersion,
    });

    const retrievedPath = await retrieveVersion({
      catalog: activeCatalog,
      commonStore: localCasStore(join(scratch, 'common-store')),
      metadataStore: localCasStore(join(scratch, 'metadata-store')),
      protectedStore: localCasStore(join(scratch, 'protected-store')),
      versionId: assembledRow.id,
      outputPath: join(scratch, 'retrieved-tree'),
    });
    await expectLogicalTreeMatches({
      expectedRoot: fixture,
      retrievedRoot: retrievedPath,
    });

    const storeBeforeDuplicate = await measureLocalStore(join(scratch, 'common-store'));
    await uploadToCompletion({
      endpoint,
      filePath: fixture,
      packageId: 'com.yucp.tus-resume',
      version: '1.0.1',
    });
    const storeAfterDuplicate = await measureLocalStore(join(scratch, 'common-store'));
    expect(storeAfterDuplicate).toEqual(storeBeforeDuplicate);

    summary.resumeOffset = resumeOffset;
    summary.lifecycle = 'CREATED->UPLOADING->ASSEMBLED';
    summary.byteExact = true;
    summary.dedupStoreDelta = storeAfterDuplicate.bytes - storeBeforeDuplicate.bytes;
  });

  it('resumes into the selected MinIO S3 store and reconstructs byte-exactly', async () => {
    const activeCatalog = requireCatalog();
    const stores = requireS3Stores();
    const scratch = requireScratchPath();
    const fixture = requireFixturePath(fixturePath, 'valid unitypackage');
    const resumable = await createInterruptedUpload({
      endpoint: `${requireS3ServerOrigin()}${INGEST_TUS_PATH}`,
      filePath: fixture,
      packageId: 'com.yucp.tus-s3',
      version: '1.0.0',
    });

    const interruptedAt = await resumable.interrupted;
    expect(interruptedAt).toBeGreaterThan(0);
    const uploadingRow = await versionRow('com.yucp.tus-s3', '1.0.0');
    expect(uploadingRow.state).toBe('UPLOADING');
    resumable.resume();
    try {
      await resumable.completed;
    } catch (error) {
      const failed = await versionRow('com.yucp.tus-s3', '1.0.0');
      throw new Error(`Tus S3 assembly failed: ${failed.error ?? 'unknown error'}`, {
        cause: error,
      });
    }
    await drainAssemblies();
    expect(resumable.resumeOffset()).toBe(interruptedAt);

    const assembledRow = await versionRow('com.yucp.tus-s3', '1.0.0');
    expect(assembledRow).toMatchObject({
      state: 'ASSEMBLED',
      source_format: 'unitypackage',
      error: null,
    });
    expect(assembledRow.release_root).toMatch(/^[0-9a-f]{64}$/);
    expect(assembledRow.assembly_object_id).toBe(
      `s3:${assembledRow.id}.logical-tree-assembly-v4.json`
    );
    expect(await outboxEventTypes(assembledRow.id)).toEqual([
      'catalog.version.created',
      'catalog.version.uploading',
      'catalog.version.assembled',
    ]);

    const manifest = parseDeliveryManifest(
      JSON.parse(
        await readCasIndexObject({
          indexId: `${assembledRow.id}.logical-tree-assembly-v4.json`,
          store: stores.metadata,
        })
      )
    );
    const chunks = new Set(manifest.files.flatMap((file) => file.chunks.map((chunk) => chunk.id)));
    const commonChunks = new Set(
      manifest.files
        .filter((file) => file.classification === 'common')
        .flatMap((file) => file.chunks.map((chunk) => chunk.id))
    );
    const protectedChunks = new Set(
      manifest.files
        .filter((file) => file.classification === 'protected')
        .flatMap((file) => file.chunks.map((chunk) => chunk.id))
    );
    expect(chunks.size).toBeGreaterThan(0);
    expect(commonChunks.size).toBeGreaterThan(0);
    expect(protectedChunks.size).toBeGreaterThan(0);
    expect(commonChunks.size + protectedChunks.size).toBe(chunks.size);
    for (const file of manifest.files) {
      if (file.bytes < DIRECT_FILE_CHUNK_LIMIT_BYTES) {
        expect(file.chunks).toEqual([
          {
            id: file.chunks[0]?.id,
            sha256: file.sha256,
            size: file.bytes,
          },
        ]);
      }
    }
    const commonObjects = await listS3Objects(stores.common.config);
    const metadataObjects = await listS3Objects(stores.metadata.config);
    const protectedObjects = await listS3Objects(stores.protected.config);
    const commonChunkObjects = commonObjects.filter((object) =>
      object.key.startsWith(stores.common.config.chunkPrefix)
    );
    const protectedChunkObjects = protectedObjects.filter((object) =>
      object.key.startsWith(stores.protected.config.chunkPrefix)
    );
    expect(commonChunkObjects).toHaveLength(commonChunks.size);
    expect(protectedChunkObjects).toHaveLength(protectedChunks.size);
    const metadataObjectKeys = new Set([
      `${stores.metadata.config.indexPrefix}${assembledRow.id}.logical-tree-assembly-v4.json`,
      ...(manifest.bootstrapMedia ?? []).map((media) => media.objectKey),
    ]);
    expect(new Set(metadataObjects.map((object) => object.key))).toEqual(metadataObjectKeys);
    expect(
      metadataObjects.some(
        (object) =>
          object.key ===
          `${stores.metadata.config.indexPrefix}${assembledRow.id}.logical-tree-assembly-v4.json`
      )
    ).toBeTrue();

    const exactVersions = await requireSql()<
      {
        bucket_name: string;
        id: string;
        object_key: string;
        provider_version: string;
        storage_role: 'common' | 'metadata' | 'protected';
      }[]
    >`
      SELECT
        object.bucket_name,
        object.id,
        object.object_key,
        object.provider_version,
        object.storage_role
      FROM storage_write_intents intent
      JOIN storage_object_versions object
        ON object.id = intent.object_version_id
      WHERE intent.owner_kind = 'package-version'
        AND intent.owner_id = ${assembledRow.id}
        AND intent.state = 'COMMITTED'
      ORDER BY object.storage_role, object.object_key
    `;
    expect(exactVersions.filter((object) => object.storage_role === 'common')).toHaveLength(
      commonChunks.size
    );
    expect(exactVersions.filter((object) => object.storage_role === 'metadata')).toHaveLength(
      metadataObjectKeys.size
    );
    expect(exactVersions.filter((object) => object.storage_role === 'protected')).toHaveLength(
      protectedChunks.size
    );
    const bucketByStorageRole = {
      common: stores.common.config.bucket,
      metadata: stores.metadata.config.bucket,
      protected: stores.protected.config.bucket,
    } as const;
    expect(
      exactVersions.every(
        (object) =>
          object.provider_version.length > 0 &&
          object.bucket_name === bucketByStorageRole[object.storage_role]
      )
    ).toBeTrue();
    const releaseClosure = await requireSql()<
      {
        logical_digest: string;
        logical_kind: 'bootstrap-media' | 'chunk' | 'manifest';
        object_version_id: string;
      }[]
    >`
      SELECT
        encode(logical_digest, 'hex') AS logical_digest,
        logical_kind,
        object_version_id
      FROM package_release_storage_objects
      WHERE package_version_id = ${assembledRow.id}
      ORDER BY logical_kind, logical_digest
    `;
    expect(releaseClosure.filter((object) => object.logical_kind === 'chunk')).toHaveLength(
      chunks.size
    );
    expect(releaseClosure.filter((object) => object.logical_kind === 'manifest')).toHaveLength(1);
    expect(
      releaseClosure.filter((object) => object.logical_kind === 'bootstrap-media')
    ).toHaveLength(manifest.bootstrapMedia?.length ?? 0);
    expect(
      releaseClosure.every((object) =>
        exactVersions.some((exactObject) => exactObject.id === object.object_version_id)
      )
    ).toBeTrue();

    const retrievedPath = await retrieveVersion({
      catalog: activeCatalog,
      commonStore: stores.common,
      metadataStore: stores.metadata,
      protectedStore: stores.protected,
      versionId: assembledRow.id,
      outputPath: join(scratch, 's3-retrieved-tree'),
    });
    await expectLogicalTreeMatches({
      expectedRoot: fixture,
      retrievedRoot: retrievedPath,
    });

    const commonVersionsBeforeDuplicate = await requireSql()<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM storage_object_versions
      WHERE storage_role = 'common'
        AND verification_state = 'VERIFIED'
    `;
    const protectedVersionsBeforeDuplicate = await requireSql()<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM storage_object_versions
      WHERE storage_role = 'protected'
        AND verification_state = 'VERIFIED'
    `;
    await uploadToCompletion({
      endpoint: `${requireS3ServerOrigin()}${INGEST_TUS_PATH}`,
      filePath: fixture,
      packageId: 'com.yucp.tus-s3',
      version: '1.0.1',
    });
    const duplicateRow = await versionRow('com.yucp.tus-s3', '1.0.1');
    const commonVersionsAfterDuplicate = await requireSql()<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM storage_object_versions
      WHERE storage_role = 'common'
        AND verification_state = 'VERIFIED'
    `;
    const protectedVersionsAfterDuplicate = await requireSql()<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM storage_object_versions
      WHERE storage_role = 'protected'
        AND verification_state = 'VERIFIED'
    `;
    expect(commonVersionsAfterDuplicate).toEqual(commonVersionsBeforeDuplicate);
    expect(protectedVersionsAfterDuplicate).toEqual(protectedVersionsBeforeDuplicate);
    expect(await listS3Objects(stores.common.config)).toEqual(commonObjects);
    expect(await listS3Objects(stores.protected.config)).toEqual(protectedObjects);
    const duplicateClosure = await requireSql()<
      {
        logical_digest: string;
        logical_kind: 'chunk' | 'manifest';
        object_version_id: string;
      }[]
    >`
      SELECT
        encode(logical_digest, 'hex') AS logical_digest,
        logical_kind,
        object_version_id
      FROM package_release_storage_objects
      WHERE package_version_id = ${duplicateRow.id}
      ORDER BY logical_kind, logical_digest
    `;
    expect(duplicateClosure).toHaveLength(releaseClosure.length);
    expect(
      duplicateClosure
        .filter((object) => object.logical_kind === 'chunk')
        .map((object) => object.object_version_id)
    ).toEqual(
      releaseClosure
        .filter((object) => object.logical_kind === 'chunk')
        .map((object) => object.object_version_id)
    );
    expect(
      duplicateClosure
        .filter((object) => object.logical_kind === 'manifest')
        .map((object) => object.object_version_id)
    ).not.toEqual(
      releaseClosure
        .filter((object) => object.logical_kind === 'manifest')
        .map((object) => object.object_version_id)
    );

    summary.s3Chunks = chunks.size;
    summary.s3ByteExact = true;
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

  it('requires an upload capability while leaving healthz open', async () => {
    const endpoint = `${requireServerOrigin()}${INGEST_TUS_PATH}`;
    const baseHeaders = {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': '1',
      'Upload-Metadata': uploadMetadataHeader({
        filename: 'authorized.zip',
        packageId: 'com.yucp.tus-auth',
        version: '1.0.0',
      }),
    };
    const missing = await fetch(endpoint, { method: 'POST', headers: baseHeaders });
    expect(missing.status).toBe(401);

    const invalid = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        ...(await uploadCapabilityHeaders({
          packageId: 'com.yucp.tus-auth',
          version: '1.0.0',
        })),
        [UPLOAD_CAPABILITY_HEADERS.sig]: '0'.repeat(64),
      },
    });
    expect(invalid.status).toBe(403);

    const validHeaders = await uploadCapabilityHeaders({
      packageId: 'com.yucp.tus-auth',
      version: '2.0.0',
    });
    const valid = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        ...validHeaders,
        'Upload-Metadata': uploadMetadataHeader({
          filename: 'authorized.zip',
          packageId: 'com.yucp.tus-auth',
          version: '2.0.0',
        }),
      },
    });
    expect(valid.status).toBe(201);
    const location = valid.headers.get('location');
    if (!location) {
      throw new Error('Authorized tus creation omitted its Location header');
    }
    const terminated = await fetch(new URL(location, endpoint), {
      method: 'DELETE',
      headers: { ...validHeaders, 'Tus-Resumable': '1.0.0' },
    });
    expect(terminated.status).toBe(204);

    const health = await fetch(`${requireServerOrigin()}/healthz`);
    expect(health.status).toBe(200);
  });

  it('allows browser preflight and an authorized cross-origin upload', async () => {
    const endpoint = `${requireServerOrigin()}${INGEST_TUS_PATH}`;
    const requestedHeaders = [
      'content-type',
      'tus-resumable',
      'upload-length',
      'upload-metadata',
      UPLOAD_CAPABILITY_HEADERS.exp,
      UPLOAD_CAPABILITY_HEADERS.packageId,
      UPLOAD_CAPABILITY_HEADERS.sig,
      UPLOAD_CAPABILITY_HEADERS.version,
      UPLOAD_CAPABILITY_HEADERS.versionId,
    ].join(',');
    const preflight = await fetch(endpoint, {
      method: 'OPTIONS',
      headers: {
        Origin: browserOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': requestedHeaders,
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(browserOrigin);
    expect(preflight.headers.get('access-control-allow-methods')).toBe(
      'POST,PATCH,HEAD,OPTIONS,GET'
    );
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      UPLOAD_CAPABILITY_HEADERS.sig
    );

    const capabilityHeaders = await uploadCapabilityHeaders({
      packageId: 'com.yucp.tus-browser-auth',
      version: '1.0.0',
    });
    const created = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Origin: browserOrigin,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1',
        'Upload-Metadata': uploadMetadataHeader({
          filename: 'browser-authorized.zip',
          packageId: 'com.yucp.tus-browser-auth',
          version: '1.0.0',
        }),
        ...capabilityHeaders,
      },
    });

    expect(created.status).toBe(201);
    expect(created.headers.get('access-control-allow-origin')).toBe(browserOrigin);
    const exposedHeaders = created.headers.get('access-control-expose-headers') ?? '';
    expect(exposedHeaders).toContain('Location');
    expect(exposedHeaders).toContain('Upload-Offset');
    expect(exposedHeaders).toContain('Upload-Length');
    const location = created.headers.get('location');
    if (!location) {
      throw new Error('Authorized browser tus creation omitted its Location header');
    }
    const terminated = await fetch(new URL(location, endpoint), {
      method: 'DELETE',
      headers: {
        Origin: browserOrigin,
        'Tus-Resumable': '1.0.0',
        ...capabilityHeaders,
      },
    });
    expect(terminated.status).toBe(204);
  });

  it('rejects packageId and version metadata longer than 256 characters', async () => {
    const fixture = requireFixturePath(fixturePath, 'valid unitypackage');
    const endpoint = `${requireServerOrigin()}${INGEST_TUS_PATH}`;
    const oversizedValue = 'x'.repeat(257);

    for (const input of [
      { field: 'packageId', packageId: oversizedValue, version: '1.0.0' },
      { field: 'version', packageId: 'com.yucp.tus-length-cap', version: oversizedValue },
    ]) {
      const error = await uploadExpectingRejection({
        endpoint,
        filePath: fixture,
        filename: 'length-cap.unitypackage',
        filetype: 'application/octet-stream',
        packageId: input.packageId,
        version: input.version,
      });
      expect(responseStatus(error)).toBe(400);
      expect(responseBody(error)).toBe(
        `Upload metadata ${input.field} must not exceed 256 characters.\n`
      );
    }

    const rows = await requireSql()<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM package_versions
      WHERE package_id = ${oversizedValue} OR version = ${oversizedValue}
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it('marks a version failed when detached assembly rejects the completed upload', async () => {
    // The transfer itself succeeds: the bytes reached quarantine, so the request has nothing left
    // to reject. Assembly fails afterwards and the catalog carries the verdict to status polls.
    const endpoint = `${requireServerOrigin()}${INGEST_TUS_PATH}`;
    await uploadToCompletion({
      endpoint,
      filePath: requireFixturePath(corruptFixturePath, 'corrupt unitypackage'),
      packageId: 'com.yucp.tus-corrupt',
      version: '1.0.0',
    });
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
      s3Chunks: expect.any(Number),
      s3ByteExact: true,
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
        `tus-to-s3-minio-chunks=${summary.s3Chunks}`,
        `s3-byte-exact-reconstruct=${summary.s3ByteExact ? 'yes' : 'no'}`,
      ].join('\n')
    );
  });
});
