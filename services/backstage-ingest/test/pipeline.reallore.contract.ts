import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runBackstageMaterialize } from '@yucp/shared';
import {
  type BackstageMaterializeClaims,
  type BackstageSourceKind,
  type BackstageUploadClaims,
  parseUploadResult,
  sign,
  verify,
} from '@yucp/shared/backstageIngest';
import {
  collectUnityPackageImportPaths,
  collectZipArchiveEntryPaths,
} from '@yucp/shared/backstageReleaseMaterialization';
import { sha256Hex } from '@yucp/shared/crypto';
import {
  getBackstageBytesFromLore,
  loreRepositoryIdForCreator,
  mintLorePresignedUrl,
  requireLoreBackstageConfig,
} from '@yucp/shared/loreBackstageClient';
import { Queue } from 'bullmq';
import { RedisClient } from 'bun';
import { gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
import { Redis as IORedis } from 'ioredis';
import { Upload } from 'tus-js-client';

const INGEST_SECRET = '11'.repeat(32);
const STARTUP_TIMEOUT_MS = 20_000;
const REDIS_STARTUP_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;
const AUTH_USER_ID = 'backstage-real-lore-pipeline-contract';

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Backstage real-Lore pipeline contract requires ${name}.`);
  }
  return value;
}

const LORE_API_BASE_URL = requireEnvironmentVariable('LORE_API_BASE_URL');
const LORE_PRESIGN_HMAC_KEY = requireEnvironmentVariable('LORE_PRESIGN_HMAC_KEY');
const LORE_REPO_NAMESPACE_SALT = requireEnvironmentVariable('LORE_REPO_NAMESPACE_SALT');
const LORE_ACCESS_CLIENT_ID = process.env.LORE_ACCESS_CLIENT_ID?.trim() || 'unused';
const LORE_ACCESS_CLIENT_SECRET = process.env.LORE_ACCESS_CLIENT_SECRET?.trim() || 'unused';

const loreConfig = requireLoreBackstageConfig({
  apiBaseUrl: LORE_API_BASE_URL,
  presignHmacKey: LORE_PRESIGN_HMAC_KEY,
  repoNamespaceSalt: LORE_REPO_NAMESPACE_SALT,
  accessClientId: LORE_ACCESS_CLIENT_ID,
  accessClientSecret: LORE_ACCESS_CLIENT_SECRET,
  timeoutMs: 20_000,
});

type TusUploadResult = {
  uploadUrl: string;
  pollToken?: string;
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
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
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
  endpoint: string;
  uploadToken: string;
}): Promise<TusUploadResult> {
  return await new Promise<TusUploadResult>((resolveUpload, rejectUpload) => {
    let pollToken: string | undefined;
    let settled = false;
    const sourceBuffer = Buffer.from(
      input.bytes.buffer,
      input.bytes.byteOffset,
      input.bytes.byteLength
    );
    const upload = new Upload(sourceBuffer, {
      endpoint: input.endpoint,
      metadata: { uploadToken: input.uploadToken },
      chunkSize: Math.min(5 * 1024 * 1024, input.bytes.byteLength),
      retryDelays: null,
      removeFingerprintOnSuccess: true,
      onAfterResponse: (_request, response) => {
        const responsePollToken = response.getHeader('X-Backstage-Ingest-Poll-Token')?.trim();
        if (responsePollToken) {
          pollToken = responsePollToken;
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
          resolveUpload({ uploadUrl: upload.url, pollToken });
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

async function pollUntilCompleted(input: {
  jobUrl: string;
  pollToken: string;
}): Promise<Extract<JobStatus, { state: 'completed' }>> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let previousState: JobStatus['state'] | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(input.jobUrl, {
      headers: { Authorization: `Bearer ${input.pollToken}` },
    });
    if (!response.ok) {
      throw new Error(`Job polling returned HTTP ${response.status}: ${await response.text()}`);
    }
    const status = (await response.json()) as JobStatus;
    if (status.state !== previousState) {
      process.stdout.write(`Job ${input.jobUrl} state: ${status.state}\n`);
      previousState = status.state;
    }
    if (status.state === 'completed') {
      return status;
    }
    if (status.state === 'failed') {
      throw new Error(`Job failed: ${status.reason}`);
    }
    await delay(500);
  }
  throw new Error(`Job did not complete within ${JOB_TIMEOUT_MS}ms.`);
}

function expectByteExact(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(actual).toEqual(expected);
}

function expectSafeRelativePath(path: string): void {
  expect(path).not.toBe('');
  expect(path.trim()).toBe(path);
  expect(path).not.toContain('\\');
  expect(path.startsWith('/')).toBe(false);
  expect(path).not.toMatch(/^[a-zA-Z]:/);
  for (const segment of path.split('/')) {
    expect(segment).not.toBe('');
    expect(segment).not.toBe('.');
    expect(segment).not.toBe('..');
  }
}

describe('Backstage ingest real-Lore pipeline contract', () => {
  test(
    'uploads and materializes unitypackage and zip through real Redis and Lore',
    async () => {
      const tempDirectory = await mkdtemp(join(tmpdir(), 'yucp-backstage-real-lore-pipeline-'));
      const sidecarPort = await getFreePort();
      const sidecarOrigin = `http://127.0.0.1:${sidecarPort}`;
      const queuePrefix = `{backstage-real-lore-pipeline-${crypto.randomUUID()}}`;
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
          BACKSTAGE_INGEST_SECRET: INGEST_SECRET,
          BACKSTAGE_INGEST_ALLOWED_ORIGINS: 'http://localhost:3000',
          LORE_API_BASE_URL,
          LORE_ACCESS_CLIENT_ID,
          LORE_ACCESS_CLIENT_SECRET,
          LORE_REPO_NAMESPACE_SALT,
          LORE_TIMEOUT_MS: '20000',
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

        const repositoryId = loreRepositoryIdForCreator(AUTH_USER_ID, LORE_REPO_NAMESPACE_SALT);
        const completedSourceKinds: BackstageSourceKind[] = [];

        async function runPipeline(input: {
          sourceKind: BackstageSourceKind;
          sourceBytes: Uint8Array;
          deliveryName: string;
          packageId: string;
          version: string;
        }): Promise<void> {
          const { sourceKind, sourceBytes, deliveryName, packageId, version } = input;
          const aliasId = `${packageId}-real-lore-alias`;
          const sourceSha256 = await sha256Hex(sourceBytes);
          const uploadClaims: BackstageUploadClaims = {
            typ: 'backstage-upload',
            authUserId: AUTH_USER_ID,
            packageId,
            version,
            repositoryId,
            deliveryName,
            sourceContentType:
              sourceKind === 'zip' ? 'application/zip' : 'application/octet-stream',
            declaredSha256: sourceSha256,
            byteSize: sourceBytes.byteLength,
            exp: Math.floor(Date.now() / 1000) + 3_600,
          };
          const uploadToken = await sign(INGEST_SECRET, uploadClaims);
          const upload = await uploadWithTus({
            bytes: sourceBytes,
            endpoint: `${sidecarOrigin}/files`,
            uploadToken,
          });
          if (!upload.pollToken) {
            throw new Error(`Expected a poll token for the ${sourceKind} upload job.`);
          }
          const uploadCompleted = await pollUntilCompleted({
            jobUrl: jobUrlFromUploadUrl(upload.uploadUrl),
            pollToken: upload.pollToken,
          });
          const uploadBundle = parseUploadResult(
            await verify(INGEST_SECRET, uploadCompleted.result)
          );
          expect(uploadBundle.rawSha256).toBe(sourceSha256);
          expect(uploadBundle.sourceKind).toBe(sourceKind);
          expect(uploadBundle.managedPaths.length).toBeGreaterThan(0);

          const rawPresigned = await mintLorePresignedUrl({
            config: loreConfig,
            repositoryId,
            address: uploadBundle.loreSource.address,
            contentType: uploadBundle.rawContentType,
          });
          const rawDownloadResponse = await fetch(rawPresigned.url);
          expect(rawDownloadResponse.status).toBe(200);
          const rawDownloadBytes = new Uint8Array(await rawDownloadResponse.arrayBuffer());
          expectByteExact(rawDownloadBytes, sourceBytes);
          expect(await sha256Hex(rawDownloadBytes)).toBe(uploadBundle.rawSha256);

          const accessDownloadBytes = new Uint8Array(
            await getBackstageBytesFromLore({
              config: loreConfig,
              repositoryId,
              address: uploadBundle.loreSource.address,
            })
          );
          expectByteExact(accessDownloadBytes, sourceBytes);

          const downloadedRawPaths =
            sourceKind === 'zip'
              ? collectZipArchiveEntryPaths(rawDownloadBytes)
              : collectUnityPackageImportPaths(rawDownloadBytes);
          const expectedManagedPaths =
            sourceKind === 'zip'
              ? downloadedRawPaths
              : Array.from(new Set([`Packages/${packageId}/package.json`, ...downloadedRawPaths]));
          expect(uploadBundle.managedPaths).toEqual(expectedManagedPaths);
          for (const managedPath of uploadBundle.managedPaths) {
            expectSafeRelativePath(managedPath);
          }

          const materializeClaims: BackstageMaterializeClaims = {
            typ: 'backstage-materialize',
            authUserId: AUTH_USER_ID,
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
              displayName: `Real Lore ${sourceKind} Pipeline`,
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
          const materializeBundle = await runBackstageMaterialize({
            ingestBaseUrl: sidecarOrigin,
            ingestSecret: INGEST_SECRET,
            claims: materializeClaims,
          });
          expect(materializeBundle.deliverableSha256).toMatch(/^[0-9a-f]{64}$/);
          expect(materializeBundle.loreDelivery.sha256).toBe(materializeBundle.deliverableSha256);
          expect(materializeBundle.loreDelivery.repositoryId).toBe(repositoryId);

          const deliverablePresigned = await mintLorePresignedUrl({
            config: loreConfig,
            repositoryId,
            address: materializeBundle.loreDelivery.address,
            contentType: materializeBundle.deliverableContentType,
          });
          const deliverableDownloadResponse = await fetch(deliverablePresigned.url);
          expect(deliverableDownloadResponse.status).toBe(200);
          const deliverableBytes = new Uint8Array(await deliverableDownloadResponse.arrayBuffer());
          expect(await sha256Hex(deliverableBytes)).toBe(materializeBundle.deliverableSha256);
          const accessDeliverableBytes = new Uint8Array(
            await getBackstageBytesFromLore({
              config: loreConfig,
              repositoryId,
              address: materializeBundle.loreDelivery.address,
            })
          );
          expectByteExact(accessDeliverableBytes, deliverableBytes);

          const deliverableArchive = unzipSync(deliverableBytes);
          expect(Object.keys(deliverableArchive)).toEqual(['package.json']);
          const packageJsonBytes = deliverableArchive['package.json'];
          if (!packageJsonBytes) {
            throw new Error('Materialized importer shim is missing package.json.');
          }
          const packageJson = JSON.parse(new TextDecoder().decode(packageJsonBytes)) as {
            name?: string;
            version?: string;
            yucp?: {
              kind?: string;
              installStrategy?: string;
              aliasId?: string;
              importerPackage?: string;
              installPlan?: {
                operation?: string;
                managedPaths?: string[];
              };
            };
          };
          expect(packageJson.name).toBe(packageId);
          expect(packageJson.version).toBe(version);
          expect(packageJson.yucp?.kind).toBe('alias-v1');
          expect(packageJson.yucp?.installStrategy).toBe('server-authorized');
          expect(packageJson.yucp?.aliasId).toBe(aliasId);
          expect(packageJson.yucp?.importerPackage).toBe('com.yucp.importer');
          expect(packageJson.yucp?.installPlan?.operation).toBe('install');
          expect(packageJson.yucp?.installPlan?.managedPaths).toEqual(uploadBundle.managedPaths);

          process.stdout.write(
            `[pipeline-reallore] ${sourceKind} rawSha=${uploadBundle.rawSha256} deliverableSha=${materializeBundle.deliverableSha256} managedPaths=${uploadBundle.managedPaths.length}\n`
          );
          completedSourceKinds.push(sourceKind);
        }

        await runPipeline({
          sourceKind: 'unitypackage',
          sourceBytes: buildUnitypackage([
            { path: 'first-guid/asset', content: strToU8('first real Lore asset') },
            { path: 'first-guid/asset.meta', content: strToU8('fileFormatVersion: 2\n') },
            {
              path: 'first-guid/pathname',
              content: strToU8('Assets/YUCP/RealLore/First.asset'),
            },
            { path: 'second-guid/asset', content: strToU8('second real Lore asset') },
            { path: 'second-guid/asset.meta', content: strToU8('fileFormatVersion: 2\n') },
            {
              path: 'second-guid/pathname',
              content: strToU8('Assets/YUCP/RealLore/Second.asset'),
            },
          ]),
          deliveryName: 'com.yucp.pipeline-reallore-unitypackage-1.0.0.unitypackage',
          packageId: 'com.yucp.pipeline-reallore-unitypackage',
          version: '1.0.0',
        });
        await runPipeline({
          sourceKind: 'zip',
          sourceBytes: zipSync({
            'package.json': strToU8(
              JSON.stringify({
                name: 'com.yucp.pipeline-reallore-zip',
                version: '2.0.0',
                displayName: 'Real Lore ZIP Pipeline',
              })
            ),
            'Assets/YUCP/RealLore/ZipFirst.asset': strToU8('first real Lore zip asset'),
            'Assets/YUCP/RealLore/ZipSecond.asset': strToU8('second real Lore zip asset'),
          }),
          deliveryName: 'com.yucp.pipeline-reallore-zip-2.0.0.zip',
          packageId: 'com.yucp.pipeline-reallore-zip',
          version: '2.0.0',
        });
        expect(completedSourceKinds).toEqual(['unitypackage', 'zip']);
      } catch (error) {
        process.stderr.write(`\nCaptured sidecar stderr:\n${stderr.join('')}\n`);
        throw error;
      } finally {
        await stopSidecar(sidecar);
        await Promise.all([stdoutCapture, stderrCapture]);
        await queue.obliterate({ force: true });
        await queue.close();
        await queueConnection.quit();
        await rm(tempDirectory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
