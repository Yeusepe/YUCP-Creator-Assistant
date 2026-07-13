import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runBackstageMaterialize } from '@yucp/shared';
import {
  type BackstageMaterializeClaims,
  type BackstageUploadClaims,
  parseMaterializeClaims,
  parseMaterializePollClaims,
  parseUploadResult,
  sign,
  verify,
} from '@yucp/shared/backstageIngest';
import { collectZipArchiveEntryPaths } from '@yucp/shared/backstageReleaseMaterialization';
import { loreRepositoryIdForCreator } from '@yucp/shared/loreBackstageClient';
import { Queue } from 'bullmq';
import { RedisClient } from 'bun';
import { gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
import { Redis as IORedis } from 'ioredis';
import { Upload } from 'tus-js-client';

const INGEST_SECRET = '11'.repeat(32);
const WRONG_SECRET = '22'.repeat(32);
const REPOSITORY_SALT = 'test-salt';
const STARTUP_TIMEOUT_MS = 20_000;
const REDIS_STARTUP_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;
const ABANDONED_UPLOAD_TTL_MS = 250;
const MAX_MANAGED_PATHS_SERIALIZED_BYTES = 4 * 1024 * 1024;
const MAX_MATERIALIZE_BODY_BYTES = 8 * 1024 * 1024;
const MANAGED_PATHS_PAYLOAD_TOO_LARGE_REASON =
  'Backstage package has too many or too long managed asset paths.';
const MANAGED_PATHS_PARSE_FAILED_REASON = 'managed_paths_failed';
const OVER_LIMIT_ZIP_ENTRY_DECLARED_BYTES = 0xffff_fff0;

type ReceivedPut = {
  repositoryId: string;
  address: string;
  byteLength: number;
  bytes: Uint8Array;
  sha256: string;
};

type TusUploadResult = {
  uploadUrl: string;
  ingestResultHeader?: string;
};

type JobStatus =
  | { state: 'processing' }
  | { state: 'completed'; result: string }
  | { state: 'failed'; reason: string };

let redisUrl = '';
let redisContainerId: string | undefined;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolveSignal!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  return { promise, resolve: resolveSignal };
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeAscii(target, offset, length - 1, value.toString(8).padStart(length - 1, '0'));
  target[offset + length - 1] = 0;
}

function buildTarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 123);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeAscii(header, 257, 6, 'ustar');
  writeAscii(header, 263, 2, '00');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeAscii(header, 148, 6, checksum.toString(8).padStart(6, '0'));
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildUnitypackage(entries: Array<{ path: string; content: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    blocks.push(buildTarHeader(entry.path, entry.content.byteLength), entry.content);
    const remainder = entry.content.byteLength % 512;
    if (remainder !== 0) {
      blocks.push(new Uint8Array(512 - remainder));
    }
  }
  blocks.push(new Uint8Array(1024));

  const tarBytes = new Uint8Array(blocks.reduce((sum, block) => sum + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    tarBytes.set(block, offset);
    offset += block.byteLength;
  }
  return gzipSync(tarBytes, { level: 9, mtime: 123 });
}

function buildZipWithManagedPathsOverLimit(): Uint8Array {
  const archiveEntries: Record<string, Uint8Array> = {};
  let serializedSize = 2;
  let index = 0;
  while (serializedSize <= MAX_MANAGED_PATHS_SERIALIZED_BYTES) {
    const path = `Assets/YUCP/Oversized/${String(index).padStart(5, '0')}-${'x'.repeat(64)}.asset`;
    serializedSize += (index === 0 ? 0 : 1) + Buffer.byteLength(JSON.stringify(path));
    archiveEntries[path] = new Uint8Array();
    index += 1;
  }
  return zipSync(archiveEntries, { level: 0 });
}

function writeUint32LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function buildZipWithDeclaredDecompressedSizeOverLimit(): Uint8Array {
  const archive = zipSync({
    'package.json': new Uint8Array(),
    'Runtime/First.asset': new Uint8Array(),
    'Runtime/Second.asset': new Uint8Array(),
  });
  const centralDirectorySignature = [0x50, 0x4b, 0x01, 0x02] as const;
  let patchedEntries = 0;
  for (let offset = 0; offset + 46 <= archive.byteLength; offset += 1) {
    if (!centralDirectorySignature.every((value, index) => archive[offset + index] === value)) {
      continue;
    }
    writeUint32LittleEndian(archive, offset + 24, OVER_LIMIT_ZIP_ENTRY_DECLARED_BYTES);
    patchedEntries += 1;
  }
  if (patchedEntries !== 3) {
    throw new Error(`Expected to patch 3 ZIP central-directory entries, got ${patchedEntries}.`);
  }
  return archive;
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const ownedBytes = new Uint8Array(
    bytes instanceof ArrayBuffer
      ? bytes.slice(0)
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getFreePort(): Promise<number> {
  const reservation = Bun.serve({
    port: 0,
    fetch: () => new Response('reserved', { status: 503 }),
  });
  const port = reservation.port;
  await reservation.stop(true);
  return port;
}

async function runProcess(command: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const process = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function waitForRedis(url: string): Promise<void> {
  const deadline = Date.now() + REDIS_STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new RedisClient(url);
    try {
      const response = await Promise.race([
        client.send('PING', []),
        delay(1_000).then(() => {
          throw new Error('Redis PING timed out.');
        }),
      ]);
      if (response === 'PONG') {
        client.close();
        return;
      }
      lastError = new Error(`Redis PING returned ${String(response)}.`);
    } catch (error) {
      lastError = error;
    } finally {
      client.close();
    }
    await delay(200);
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Redis at ${url} did not answer within ${REDIS_STARTUP_TIMEOUT_MS}ms: ${detail}`);
}

beforeAll(async () => {
  const configuredRedisUrl = process.env.BACKSTAGE_INGEST_REDIS_URL?.trim();
  if (configuredRedisUrl) {
    redisUrl = configuredRedisUrl;
    await waitForRedis(redisUrl);
    process.stdout.write(`Using real Redis from BACKSTAGE_INGEST_REDIS_URL: ${redisUrl}\n`);
    return;
  }

  const dockerVersion = await runProcess(['docker', 'version', '--format', '{{.Server.Version}}']);
  if (dockerVersion.exitCode !== 0) {
    throw new Error(
      `BACKSTAGE_INGEST_REDIS_URL is unset and Docker is unavailable. A real Redis is required.\n${dockerVersion.stderr}`
    );
  }

  const redisPort = await getFreePort();
  const started = await runProcess([
    'docker',
    'run',
    '--rm',
    '-d',
    '-p',
    `${redisPort}:6379`,
    'redis:7-alpine',
  ]);
  if (started.exitCode !== 0) {
    throw new Error(`Failed to start redis:7-alpine.\n${started.stderr}`);
  }

  redisContainerId = started.stdout.trim();
  if (!redisContainerId) {
    throw new Error('Docker did not return a Redis container id.');
  }
  redisUrl = `redis://127.0.0.1:${redisPort}`;
  await waitForRedis(redisUrl);
  process.stdout.write(`Started real Redis container ${redisContainerId} at ${redisUrl}\n`);
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (!redisContainerId) {
    return;
  }
  const stopped = await runProcess(['docker', 'stop', redisContainerId]);
  if (stopped.exitCode !== 0) {
    throw new Error(`Failed to stop Redis container ${redisContainerId}.\n${stopped.stderr}`);
  }
}, TEST_TIMEOUT_MS);

function captureSidecarOutput(
  stream: ReadableStream<Uint8Array>,
  chunks: string[],
  write: (value: string) => void
): Promise<void> {
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const text = decoder.decode(chunk.value, { stream: true });
        chunks.push(text);
        write(text);
      }
      const remainder = decoder.decode();
      if (remainder) {
        chunks.push(remainder);
        write(remainder);
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

async function waitForSidecar(input: {
  origin: string;
  getExitCode: () => number | null;
  stderr: string[];
}): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const exitCode = input.getExitCode();
    if (exitCode !== null) {
      throw new Error(
        `Backstage ingest sidecar exited before becoming healthy with code ${exitCode}.\n${input.stderr.join('')}`
      );
    }

    try {
      const response = await fetch(`${input.origin}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Backstage ingest sidecar did not become healthy within ${STARTUP_TIMEOUT_MS}ms: ${detail}\n${input.stderr.join('')}`
  );
}

async function stopSidecar(process: Bun.Subprocess): Promise<void> {
  process.kill();
  const stopped = await Promise.race([
    process.exited.then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!stopped) {
    process.kill(9);
    await process.exited;
  }
}

async function uploadWithTus(input: {
  bytes: Uint8Array;
  chunkSize?: number;
  endpoint: string;
  uploadToken: string;
}): Promise<TusUploadResult> {
  return await new Promise<TusUploadResult>((resolveUpload, rejectUpload) => {
    let ingestResultHeader: string | undefined;
    let settled = false;
    const sourceBuffer = Buffer.from(
      input.bytes.buffer,
      input.bytes.byteOffset,
      input.bytes.byteLength
    );
    const upload = new Upload(sourceBuffer, {
      endpoint: input.endpoint,
      metadata: { uploadToken: input.uploadToken },
      chunkSize: Math.min(input.chunkSize ?? 5 * 1024 * 1024, input.bytes.byteLength),
      retryDelays: null,
      removeFingerprintOnSuccess: true,
      onAfterResponse: (_request, response) => {
        const header = response.getHeader('X-Backstage-Ingest-Result')?.trim();
        if (header) {
          ingestResultHeader = header;
        }
      },
      onError: (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          rejectUpload(error);
        }
      },
      onSuccess: () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (!upload.url) {
            rejectUpload(new Error('TUS upload completed without an upload URL.'));
            return;
          }
          resolveUpload({ uploadUrl: upload.url, ingestResultHeader });
        }
      },
    });
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        void upload.abort();
        rejectUpload(new Error(`TUS upload timed out after ${UPLOAD_TIMEOUT_MS}ms.`));
      }
    }, UPLOAD_TIMEOUT_MS);
    upload.start();
  });
}

async function createAbandonedTusUpload(input: {
  endpoint: string;
  uploadToken: string;
  byteSize: number;
}): Promise<string> {
  const encodedUploadToken = Buffer.from(input.uploadToken, 'utf8').toString('base64');
  const response = await fetch(input.endpoint, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(input.byteSize),
      'Upload-Metadata': `uploadToken ${encodedUploadToken}`,
    },
  });
  expect(response.status).toBe(201);

  const location = response.headers.get('Location');
  expect(location).toBeTruthy();
  const uploadPath = new URL(location as string, input.endpoint).pathname;
  const uploadId = uploadPath.split('/').filter(Boolean).at(-1);
  if (!uploadId) {
    throw new Error('TUS create response did not identify the abandoned upload.');
  }
  return decodeURIComponent(uploadId);
}

function jobUrlFromUploadUrl(uploadUrl: string): string {
  const url = new URL(uploadUrl);
  const jobPath = url.pathname.replace('/files/', '/jobs/');
  if (jobPath === url.pathname) {
    throw new Error(`TUS upload URL does not contain /files/: ${uploadUrl}`);
  }
  url.pathname = jobPath;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function getJobStatus(jobUrl: string, uploadToken: string): Promise<Response> {
  return await fetch(jobUrl, {
    headers: { Authorization: `Bearer ${uploadToken}` },
  });
}

async function waitForJobState(input: {
  jobUrl: string;
  uploadToken: string;
  terminalState: 'completed' | 'failed';
}): Promise<JobStatus> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let previousState: string | undefined;
  while (Date.now() < deadline) {
    const response = await getJobStatus(input.jobUrl, input.uploadToken);
    if (!response.ok) {
      throw new Error(`Job polling returned HTTP ${response.status}: ${await response.text()}`);
    }
    const status = (await response.json()) as JobStatus;
    if (status.state !== previousState) {
      process.stdout.write(`Job ${input.jobUrl} state: ${status.state}\n`);
      previousState = status.state;
    }
    if (status.state === input.terminalState) {
      return status;
    }
    if (status.state === 'completed' || status.state === 'failed') {
      throw new Error(`Job reached ${status.state}, expected ${input.terminalState}.`);
    }
    await delay(500);
  }
  throw new Error(`Job did not reach ${input.terminalState} within ${JOB_TIMEOUT_MS}ms.`);
}

async function waitForDirectoryEmpty(directory: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let entries = await readdir(directory);
  while (entries.length > 0 && Date.now() < deadline) {
    await delay(50);
    entries = await readdir(directory);
  }
  expect(entries).toEqual([]);
  process.stdout.write('Staged tus file cleanup assertion passed.\n');
}

async function waitForAbandonedUploadSweep(
  directory: string,
  uploadId: string,
  sidecarStdout: string[]
): Promise<void> {
  const stagedNames = [uploadId, `${uploadId}.json`];
  const initialEntries = await readdir(directory);
  expect(initialEntries).toEqual(expect.arrayContaining(stagedNames));

  const deadline = Date.now() + 5_000;
  let entries = initialEntries;
  while (stagedNames.some((name) => entries.includes(name)) && Date.now() < deadline) {
    await delay(50);
    entries = await readdir(directory);
  }

  for (const stagedName of stagedNames) {
    expect(entries).not.toContain(stagedName);
  }
  expect(sidecarStdout.join('')).toContain(
    '"event":"backstage_ingest.abandoned_upload_swept","count":1'
  );
  process.stdout.write('Abandoned tus upload sweep assertion passed.\n');
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('originalResponse' in error)) {
    return undefined;
  }
  const response = (error as { originalResponse?: { getStatus?: () => number } }).originalResponse;
  return response?.getStatus?.();
}

describe('backstage ingest resumable upload integration', () => {
  test(
    'stores raw at upload and materializes resolved metadata in a publish-time job',
    async () => {
      const receivedPuts: ReceivedPut[] = [];
      const storedObjects = new Map<string, Uint8Array>();
      const receivedGets: string[] = [];
      const firstLorePutStarted = createSignal();
      const releaseFirstLorePut = createSignal();
      const fakeLore = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const putMatch = /^\/v1\/repository\/([0-9a-f]{32})\/content$/.exec(url.pathname);
          if (request.method === 'PUT' && putMatch) {
            expect(request.headers.get('CF-Access-Client-Id')).toBe('test-id');
            expect(request.headers.get('CF-Access-Client-Secret')).toBe('test-secret');
            const body = new Uint8Array(await request.arrayBuffer());
            const sha256 = await sha256Hex(body);
            const address = `${sha256}-${'0'.repeat(32)}`;
            receivedPuts.push({
              repositoryId: putMatch[1],
              address,
              byteLength: body.byteLength,
              bytes: body,
              sha256,
            });
            storedObjects.set(`${putMatch[1]}/${address}`, body);
            process.stdout.write(
              `Fake Lore PUT #${receivedPuts.length}: ${sha256} (${body.byteLength} bytes)\n`
            );
            if (receivedPuts.length === 1) {
              firstLorePutStarted.resolve();
              await releaseFirstLorePut.promise;
            }
            return Response.json({ data: { address } });
          }

          const getMatch =
            /^\/v1\/repository\/([0-9a-f]{32})\/content\/([0-9a-f]{64}-[0-9a-f]{32})$/.exec(
              url.pathname
            );
          if (request.method === 'GET' && getMatch) {
            expect(request.headers.get('CF-Access-Client-Id')).toBe('test-id');
            expect(request.headers.get('CF-Access-Client-Secret')).toBe('test-secret');
            const key = `${getMatch[1]}/${getMatch[2]}`;
            receivedGets.push(url.pathname);
            const bytes = storedObjects.get(key);
            return bytes ? new Response(bytes) : new Response('Not found', { status: 404 });
          }
          return new Response('Not found', { status: 404 });
        },
      });

      const tempDirectory = await mkdtemp(join(tmpdir(), 'yucp-backstage-ingest-'));
      const sidecarPort = await getFreePort();
      const sidecarOrigin = `http://127.0.0.1:${sidecarPort}`;
      const queuePrefix = `{backstage-ingest-integration-${crypto.randomUUID()}}`;
      const queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      const queue = new Queue('backstage-ingest', {
        connection: queueConnection,
        prefix: queuePrefix,
      });
      const entrypoint = resolve(import.meta.dir, '../src/index.ts');
      const stdout: string[] = [];
      const stderr: string[] = [];
      const sidecar = Bun.spawn(['bun', 'run', entrypoint], {
        cwd: resolve(import.meta.dir, '../../..'),
        env: {
          ...process.env,
          PORT: String(sidecarPort),
          BACKSTAGE_INGEST_REDIS_URL: redisUrl,
          BACKSTAGE_INGEST_QUEUE_PREFIX: queuePrefix,
          BACKSTAGE_INGEST_CONCURRENCY: '2',
          BACKSTAGE_INGEST_TUS_DIR: tempDirectory,
          BACKSTAGE_INGEST_UPLOAD_TTL_MS: String(ABANDONED_UPLOAD_TTL_MS),
          BACKSTAGE_INGEST_SECRET: INGEST_SECRET,
          BACKSTAGE_INGEST_ALLOWED_ORIGINS: 'http://localhost:3000',
          LORE_API_BASE_URL: `http://127.0.0.1:${fakeLore.port}`,
          LORE_ACCESS_CLIENT_ID: 'test-id',
          LORE_ACCESS_CLIENT_SECRET: 'test-secret',
          LORE_REPO_NAMESPACE_SALT: REPOSITORY_SALT,
          LORE_TIMEOUT_MS: '15000',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let exitCode: number | null = null;
      void sidecar.exited.then((code) => {
        exitCode = code;
      });
      const stdoutCapture = captureSidecarOutput(sidecar.stdout, stdout, (value) =>
        process.stdout.write(value)
      );
      const stderrCapture = captureSidecarOutput(sidecar.stderr, stderr, (value) =>
        process.stderr.write(value)
      );

      try {
        await waitForSidecar({ origin: sidecarOrigin, getExitCode: () => exitCode, stderr });

        const packageId = 'com.yucp.ingest-integration';
        const version = '1.2.3';
        const aliasId = 'resolved-alias-id';
        const authUserId = 'auth-user-ingest-integration';
        const repositoryId = loreRepositoryIdForCreator(authUserId, REPOSITORY_SALT);
        const sourceBytes = buildUnitypackage([
          { path: 'asset-guid/asset', content: strToU8('real resumable ingest') },
          { path: 'asset-guid/asset.meta', content: strToU8('fileFormatVersion: 2\n') },
          { path: 'asset-guid/pathname', content: strToU8('Assets/YUCP/Integration.txt') },
        ]);
        const sourceSha256 = await sha256Hex(sourceBytes);
        const claims: BackstageUploadClaims = {
          typ: 'backstage-upload',
          authUserId,
          packageId,
          version,
          repositoryId,
          deliveryName: `${packageId}-${version}.unitypackage`,
          sourceContentType: 'application/octet-stream',
          declaredSha256: sourceSha256,
          byteSize: sourceBytes.byteLength,
          exp: Math.floor(Date.now() / 1000) + 3_600,
        };

        const uploadToken = await sign(INGEST_SECRET, claims);
        const tusUpload = await uploadWithTus({
          bytes: sourceBytes,
          endpoint: `${sidecarOrigin}/files`,
          uploadToken,
        });
        expect(tusUpload.ingestResultHeader).toBeUndefined();
        const uploadJobUrl = jobUrlFromUploadUrl(tusUpload.uploadUrl);

        await firstLorePutStarted.promise;
        await delay(ABANDONED_UPLOAD_TTL_MS * 3);
        const processingUploadId = new URL(tusUpload.uploadUrl).pathname
          .split('/')
          .filter(Boolean)
          .at(-1);
        expect(processingUploadId).toBeTruthy();
        expect(await readdir(tempDirectory)).toEqual(
          expect.arrayContaining([processingUploadId as string, `${processingUploadId}.json`])
        );
        process.stdout.write('In-flight worker staged file retention assertion passed.\n');
        releaseFirstLorePut.resolve();

        const preflight = await fetch(uploadJobUrl, {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:3000',
            'Access-Control-Request-Headers': 'authorization',
            'Access-Control-Request-Method': 'GET',
          },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
        expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');

        const missingJobUrl = new URL(uploadJobUrl);
        missingJobUrl.pathname = '/jobs/not-found';
        expect((await getJobStatus(missingJobUrl.toString(), uploadToken)).status).toBe(404);
        const uploadOwnershipToken = await sign(INGEST_SECRET, {
          ...claims,
          packageId: 'com.yucp.other-package',
        });
        expect((await getJobStatus(uploadJobUrl, uploadOwnershipToken)).status).toBe(403);
        const tamperedUploadToken = `${uploadToken.at(0) === 'A' ? 'B' : 'A'}${uploadToken.slice(1)}`;
        expect((await getJobStatus(uploadJobUrl, tamperedUploadToken)).status).toBe(401);

        const uploadCompleted = await waitForJobState({
          jobUrl: uploadJobUrl,
          uploadToken,
          terminalState: 'completed',
        });
        if (uploadCompleted.state !== 'completed') {
          throw new Error('Expected a completed upload job result.');
        }
        const uploadBundle = parseUploadResult(await verify(INGEST_SECRET, uploadCompleted.result));
        expect(uploadBundle).toMatchObject({
          typ: 'backstage-upload-result',
          authUserId,
          packageId,
          version,
          rawSha256: sourceSha256,
          sourceKind: 'unitypackage',
        });
        expect(uploadBundle.loreSource.repositoryId).toBe(repositoryId);
        expect(uploadBundle.managedPaths).toEqual([
          `Packages/${packageId}/package.json`,
          'Assets/YUCP/Integration.txt',
          'Assets/YUCP/Integration.txt.meta',
        ]);
        expect(receivedPuts).toHaveLength(1);
        expect(receivedPuts[0]).toMatchObject({
          repositoryId,
          byteLength: sourceBytes.byteLength,
          sha256: sourceSha256,
        });
        expect(receivedGets).toHaveLength(0);
        process.stdout.write(
          `Upload result managedPaths: ${JSON.stringify(uploadBundle.managedPaths)}; Lore PUTs: ${receivedPuts.length} raw only\n`
        );
        await waitForDirectoryEmpty(tempDirectory);

        const expiredUploadPollToken = await sign(INGEST_SECRET, {
          ...claims,
          exp: Math.floor(Date.now() / 1000) - 1,
        });
        expect((await getJobStatus(uploadJobUrl, expiredUploadPollToken)).status).toBe(200);
        const wrongSignatureExpiredPollToken = await sign(WRONG_SECRET, {
          ...claims,
          exp: Math.floor(Date.now() / 1000) - 1,
        });
        expect((await getJobStatus(uploadJobUrl, wrongSignatureExpiredPollToken)).status).toBe(401);

        const materializeClaims: BackstageMaterializeClaims = {
          typ: 'backstage-materialize',
          authUserId,
          packageId,
          version,
          repositoryId,
          loreSourceAddress: uploadBundle.loreSource.address,
          loreSourceSha256: uploadBundle.rawSha256,
          deliveryName: uploadBundle.rawDeliveryName,
          sourceContentType: uploadBundle.rawContentType,
          sourceKind: uploadBundle.sourceKind,
          managedPaths: uploadBundle.managedPaths,
          materializeMetadata: {
            displayName: 'Ingest Integration',
            metadata: {
              yucp: {
                kind: 'alias-v1',
                installStrategy: 'server-authorized',
                aliasId,
                importerPackage: 'com.yucp.importer',
              },
            },
          },
          exp: Math.floor(Date.now() / 1000) + 3_600,
        };

        const materializePreflight = await fetch(`${sidecarOrigin}/materialize`, {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:3000' },
        });
        expect(materializePreflight.status).toBe(204);
        expect(materializePreflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');

        const jobCountsBeforeOversizedRequest = await queue.getJobCounts();
        const oversizedMaterializeBody = JSON.stringify({
          token: 'x'.repeat(MAX_MATERIALIZE_BODY_BYTES),
        });
        const oversizedMaterializeResponse = await fetch(`${sidecarOrigin}/materialize`, {
          method: 'POST',
          headers: {
            'Content-Length': String(Buffer.byteLength(oversizedMaterializeBody)),
            'Content-Type': 'application/json',
          },
          body: oversizedMaterializeBody,
        });
        expect(oversizedMaterializeResponse.status).toBe(413);
        expect(await queue.getJobCounts()).toEqual(jobCountsBeforeOversizedRequest);
        process.stdout.write(
          `Oversized materialize body (${Buffer.byteLength(oversizedMaterializeBody)} bytes) rejected with HTTP ${oversizedMaterializeResponse.status}; no job enqueued.\n`
        );

        const mismatchedRepositoryToken = await sign(INGEST_SECRET, {
          ...materializeClaims,
          repositoryId: 'f'.repeat(32),
        });
        expect(
          (
            await fetch(`${sidecarOrigin}/materialize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: mismatchedRepositoryToken }),
            })
          ).status
        ).toBe(403);
        const wrongMaterializeToken = await sign(WRONG_SECRET, materializeClaims);
        expect(
          (
            await fetch(`${sidecarOrigin}/materialize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: wrongMaterializeToken }),
            })
          ).status
        ).toBe(401);

        const loreGetsBeforeMaterialize = receivedGets.length;
        let materializePostObserved = false;
        let materializePollObserved = false;
        const materializeBundle = await runBackstageMaterialize({
          ingestBaseUrl: sidecarOrigin,
          ingestSecret: INGEST_SECRET,
          claims: materializeClaims,
          fetchImpl: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/materialize') {
              materializePostObserved = true;
              expect(new Headers(init?.headers).get('Authorization')).toBeNull();
              expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
              if (typeof init?.body !== 'string') {
                throw new Error('Expected JSON text for the materialize request body.');
              }
              const body = JSON.parse(init.body) as { token?: unknown };
              expect(body).toEqual({ token: expect.any(String) });
              expect(
                parseMaterializeClaims(await verify(INGEST_SECRET, body.token as string))
              ).toEqual(materializeClaims);
            } else if (url.pathname.startsWith('/jobs/')) {
              materializePollObserved = true;
              const authorization = new Headers(init?.headers).get('Authorization');
              expect(authorization).toMatch(/^Bearer \S+$/);
              const pollClaims = parseMaterializePollClaims(
                await verify(INGEST_SECRET, authorization?.slice('Bearer '.length) ?? '')
              );
              expect(pollClaims).toEqual({
                typ: 'backstage-materialize-poll',
                authUserId,
                packageId,
                version,
                jobId: url.pathname.slice('/jobs/'.length),
                exp: materializeClaims.exp,
              });
              expect(pollClaims).not.toHaveProperty('managedPaths');
              expect(pollClaims).not.toHaveProperty('materializeMetadata');
            }
            return await fetch(input, init);
          },
        });
        expect(materializePostObserved).toBe(true);
        expect(materializePollObserved).toBe(true);
        expect(materializeBundle).toMatchObject({
          typ: 'backstage-materialize-result',
          authUserId,
          packageId,
          version,
        });
        expect(materializeBundle.loreDelivery).toMatchObject({
          repositoryId,
          tenantId: authUserId,
        });
        expect(receivedPuts).toHaveLength(2);
        const unitypackageMaterializeGets = receivedGets.slice(loreGetsBeforeMaterialize);
        expect(unitypackageMaterializeGets).toEqual([]);
        expect(receivedPuts[1].sha256).toBe(materializeBundle.deliverableSha256);

        const deliverablePath = `/v1/repository/${materializeBundle.loreDelivery.repositoryId}/content/${materializeBundle.loreDelivery.address}`;
        const deliverableResponse = await fetch(
          `http://127.0.0.1:${fakeLore.port}${deliverablePath}`,
          {
            headers: {
              'CF-Access-Client-Id': 'test-id',
              'CF-Access-Client-Secret': 'test-secret',
            },
          }
        );
        expect(deliverableResponse.status).toBe(200);
        const deliverableBytes = new Uint8Array(await deliverableResponse.arrayBuffer());
        expect(await sha256Hex(deliverableBytes)).toBe(materializeBundle.deliverableSha256);
        const deliverableArchive = unzipSync(deliverableBytes);
        const packageJson = JSON.parse(
          new TextDecoder().decode(deliverableArchive['package.json'])
        ) as { yucp?: { aliasId?: string; installPlan?: { managedPaths?: string[] } } };
        expect(packageJson.yucp?.aliasId).toBe(aliasId);
        expect(packageJson.yucp?.installPlan?.managedPaths).toEqual(uploadBundle.managedPaths);
        expect(receivedGets).toEqual([deliverablePath]);
        process.stdout.write(
          `Unitypackage materialize raw Lore GETs: ${unitypackageMaterializeGets.length}; yucp.aliasId=${packageJson.yucp?.aliasId}; managedPaths=${JSON.stringify(packageJson.yucp?.installPlan?.managedPaths)}\n`
        );

        const oversizedVersion = '1.2.4';
        const oversizedSourceBytes = buildZipWithManagedPathsOverLimit();
        const oversizedManagedPaths = collectZipArchiveEntryPaths(oversizedSourceBytes);
        const oversizedManagedPathsSerializedBytes = Buffer.byteLength(
          JSON.stringify(oversizedManagedPaths)
        );
        expect(oversizedManagedPathsSerializedBytes).toBeGreaterThan(
          MAX_MANAGED_PATHS_SERIALIZED_BYTES
        );
        const oversizedUploadClaims: BackstageUploadClaims = {
          ...claims,
          version: oversizedVersion,
          deliveryName: `${packageId}-${oversizedVersion}.zip`,
          sourceContentType: 'application/zip',
          declaredSha256: await sha256Hex(oversizedSourceBytes),
          byteSize: oversizedSourceBytes.byteLength,
        };
        const oversizedUploadToken = await sign(INGEST_SECRET, oversizedUploadClaims);
        const lorePutsBeforeOversizedUpload = receivedPuts.length;
        const oversizedTusUpload = await uploadWithTus({
          bytes: oversizedSourceBytes,
          chunkSize: 1024 * 1024,
          endpoint: `${sidecarOrigin}/files`,
          uploadToken: oversizedUploadToken,
        });
        const oversizedUploadStatus = await waitForJobState({
          jobUrl: jobUrlFromUploadUrl(oversizedTusUpload.uploadUrl),
          uploadToken: oversizedUploadToken,
          terminalState: 'failed',
        });
        expect(oversizedUploadStatus).toEqual({
          state: 'failed',
          reason: MANAGED_PATHS_PAYLOAD_TOO_LARGE_REASON,
        });
        expect(oversizedUploadStatus).not.toHaveProperty('result');
        expect(receivedPuts).toHaveLength(lorePutsBeforeOversizedUpload);
        const oversizedVersionJobNames = (await queue.getJobs())
          .filter((job) => job.data?.claims?.version === oversizedVersion)
          .map((job) => job.name);
        expect(oversizedVersionJobNames).toEqual(['ingest-upload']);
        await waitForDirectoryEmpty(tempDirectory);
        process.stdout.write(
          `Oversized managed paths (${oversizedManagedPathsSerializedBytes} serialized bytes) rejected during upload; no upload result, Lore PUT, or materialize attempt.\n`
        );

        const zipBombVersion = '1.2.5';
        const zipBombSourceBytes = buildZipWithDeclaredDecompressedSizeOverLimit();
        const zipBombUploadClaims: BackstageUploadClaims = {
          ...claims,
          version: zipBombVersion,
          deliveryName: `${packageId}-${zipBombVersion}.zip`,
          sourceContentType: 'application/zip',
          declaredSha256: await sha256Hex(zipBombSourceBytes),
          byteSize: zipBombSourceBytes.byteLength,
        };
        const zipBombUploadToken = await sign(INGEST_SECRET, zipBombUploadClaims);
        const lorePutsBeforeZipBombUpload = receivedPuts.length;
        const zipBombTusUpload = await uploadWithTus({
          bytes: zipBombSourceBytes,
          endpoint: `${sidecarOrigin}/files`,
          uploadToken: zipBombUploadToken,
        });
        const zipBombUploadId = new URL(zipBombTusUpload.uploadUrl).pathname
          .split('/')
          .filter(Boolean)
          .at(-1);
        expect(zipBombUploadId).toBeTruthy();
        expect(
          await waitForJobState({
            jobUrl: jobUrlFromUploadUrl(zipBombTusUpload.uploadUrl),
            uploadToken: zipBombUploadToken,
            terminalState: 'failed',
          })
        ).toEqual({ state: 'failed', reason: 'ingest_failed' });
        const zipBombJob = await queue.getJob(zipBombUploadId as string);
        expect(zipBombJob?.failedReason).toBe(MANAGED_PATHS_PARSE_FAILED_REASON);
        expect(zipBombJob?.attemptsMade).toBe(1);
        expect(receivedPuts).toHaveLength(lorePutsBeforeZipBombUpload);
        const zipBombVersionJobNames = (await queue.getJobs())
          .filter((job) => job.data?.claims?.version === zipBombVersion)
          .map((job) => job.name);
        expect(zipBombVersionJobNames).toEqual(['ingest-upload']);
        await waitForDirectoryEmpty(tempDirectory);
        process.stdout.write(
          `Over-cap declared ZIP rejected as unrecoverable during upload after ${zipBombJob?.attemptsMade} attempt; no Lore PUT or materialize attempt.\n`
        );

        const zipVersion = '1.2.6';
        const zipSourceBytes = zipSync({
          'package.json': strToU8(
            JSON.stringify({ name: packageId, version: zipVersion, displayName: 'Zip Integration' })
          ),
        });
        const zipSourceSha256 = await sha256Hex(zipSourceBytes);
        const zipUploadClaims: BackstageUploadClaims = {
          ...claims,
          version: zipVersion,
          deliveryName: `${packageId}-${zipVersion}.zip`,
          sourceContentType: 'application/zip',
          declaredSha256: zipSourceSha256,
          byteSize: zipSourceBytes.byteLength,
        };
        const zipUploadToken = await sign(INGEST_SECRET, zipUploadClaims);
        const zipTusUpload = await uploadWithTus({
          bytes: zipSourceBytes,
          endpoint: `${sidecarOrigin}/files`,
          uploadToken: zipUploadToken,
        });
        const zipUploadCompleted = await waitForJobState({
          jobUrl: jobUrlFromUploadUrl(zipTusUpload.uploadUrl),
          uploadToken: zipUploadToken,
          terminalState: 'completed',
        });
        if (zipUploadCompleted.state !== 'completed') {
          throw new Error('Expected a completed zip upload job result.');
        }
        const zipUploadBundle = parseUploadResult(
          await verify(INGEST_SECRET, zipUploadCompleted.result)
        );
        expect(zipUploadBundle.sourceKind).toBe('zip');
        expect(receivedPuts).toHaveLength(3);

        const zipMaterializeClaims: BackstageMaterializeClaims = {
          typ: 'backstage-materialize',
          authUserId,
          packageId,
          version: zipVersion,
          repositoryId,
          loreSourceAddress: zipUploadBundle.loreSource.address,
          loreSourceSha256: zipUploadBundle.rawSha256,
          deliveryName: zipUploadBundle.rawDeliveryName,
          sourceContentType: zipUploadBundle.rawContentType,
          sourceKind: zipUploadBundle.sourceKind,
          managedPaths: zipUploadBundle.managedPaths,
          exp: Math.floor(Date.now() / 1000) + 3_600,
        };
        const zipMaterializeBundle = await runBackstageMaterialize({
          ingestBaseUrl: sidecarOrigin,
          ingestSecret: INGEST_SECRET,
          claims: zipMaterializeClaims,
        });
        expect(zipMaterializeBundle).toMatchObject({
          typ: 'backstage-materialize-result',
          authUserId,
          packageId,
          version: zipVersion,
        });
        expect(receivedPuts).toHaveLength(4);
        expect(Object.keys(unzipSync(receivedPuts[3]?.bytes ?? new Uint8Array()))).toEqual([
          'package.json',
        ]);
        process.stdout.write(
          `Normal ZIP uploaded and materialized; Lore PUTs: ${receivedPuts.length}.\n`
        );

        const zipGetsBeforeMaterialize = receivedGets.length;
        const zipMismatchClaims: BackstageMaterializeClaims = {
          ...zipMaterializeClaims,
          loreSourceSha256: 'f'.repeat(64),
        };
        await expect(
          runBackstageMaterialize({
            ingestBaseUrl: sidecarOrigin,
            ingestSecret: INGEST_SECRET,
            claims: zipMismatchClaims,
          })
        ).rejects.toThrow('Backstage materialize job failed: ingest_failed');
        const zipMaterializeGets = receivedGets.slice(zipGetsBeforeMaterialize);
        expect(zipMaterializeGets.length).toBeGreaterThan(0);
        expect(new Set(zipMaterializeGets)).toEqual(
          new Set([`/v1/repository/${repositoryId}/content/${zipUploadBundle.loreSource.address}`])
        );
        expect(receivedPuts).toHaveLength(4);
        process.stdout.write(
          `Zip materialize raw Lore GETs: ${zipMaterializeGets.length}; SHA mismatch rejected.\n`
        );

        const invalidArchiveBytes = strToU8('not a unitypackage archive');
        const invalidArchiveClaims = {
          ...claims,
          declaredSha256: await sha256Hex(invalidArchiveBytes),
          byteSize: invalidArchiveBytes.byteLength,
        };
        const invalidArchiveToken = await sign(INGEST_SECRET, invalidArchiveClaims);
        const invalidArchiveUpload = await uploadWithTus({
          bytes: invalidArchiveBytes,
          endpoint: `${sidecarOrigin}/files`,
          uploadToken: invalidArchiveToken,
        });
        expect(
          await waitForJobState({
            jobUrl: jobUrlFromUploadUrl(invalidArchiveUpload.uploadUrl),
            uploadToken: invalidArchiveToken,
            terminalState: 'failed',
          })
        ).toEqual({ state: 'failed', reason: 'ingest_failed' });
        expect(receivedPuts).toHaveLength(4);
        await waitForDirectoryEmpty(tempDirectory);

        const abandonedUploadId = await createAbandonedTusUpload({
          endpoint: `${sidecarOrigin}/files`,
          uploadToken,
          byteSize: sourceBytes.byteLength,
        });
        await waitForAbandonedUploadSweep(tempDirectory, abandonedUploadId, stdout);

        const wrongUploadToken = await sign(WRONG_SECRET, claims);
        let wrongSecretUploadError: unknown;
        try {
          await uploadWithTus({
            bytes: sourceBytes,
            endpoint: `${sidecarOrigin}/files`,
            uploadToken: wrongUploadToken,
          });
        } catch (error) {
          wrongSecretUploadError = error;
        }
        expect(wrongSecretUploadError).toBeInstanceOf(Error);
        expect(responseStatus(wrongSecretUploadError)).toBe(401);

        const wrongShaToken = await sign(INGEST_SECRET, {
          ...claims,
          declaredSha256: 'f'.repeat(64),
        });
        let wrongShaUploadError: unknown;
        try {
          await uploadWithTus({
            bytes: sourceBytes,
            endpoint: `${sidecarOrigin}/files`,
            uploadToken: wrongShaToken,
          });
        } catch (error) {
          wrongShaUploadError = error;
        }
        expect(wrongShaUploadError).toBeInstanceOf(Error);
        expect(responseStatus(wrongShaUploadError)).toBe(422);
        expect(receivedPuts).toHaveLength(4);
        expect(await readdir(tempDirectory)).toEqual([]);
        process.stdout.write('SHA mismatch immediate staged upload cleanup assertion passed.\n');

        expect(stdout.join('')).not.toContain(repositoryId);
        expect(stderr.join('')).not.toContain(repositoryId);
        expect(stderr.join('')).not.toContain('invalid gzip data');
      } catch (error) {
        process.stderr.write(`\nCaptured sidecar stderr:\n${stderr.join('')}\n`);
        throw error;
      } finally {
        releaseFirstLorePut.resolve();
        await stopSidecar(sidecar);
        await Promise.all([stdoutCapture, stderrCapture]);
        await queue.obliterate({ force: true });
        await queue.close();
        await queueConnection.quit();
        await fakeLore.stop(true);
        await rm(tempDirectory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
