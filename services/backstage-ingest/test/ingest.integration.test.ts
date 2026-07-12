import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type BackstageUploadClaims,
  parseIngestResult,
  sign,
  verify,
} from '@yucp/shared/backstageIngest';
import { loreRepositoryIdForCreator } from '@yucp/shared/loreBackstageClient';
import { strToU8, zipSync } from 'fflate';
import { Upload } from 'tus-js-client';

const INGEST_SECRET = '11'.repeat(32);
const WRONG_SECRET = '22'.repeat(32);
const REPOSITORY_SALT = 'test-salt';
const STARTUP_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 180_000;

type ReceivedPut = {
  repositoryId: string;
  byteLength: number;
  sha256: string;
};

type TusUploadResult = {
  ingestResultHeader?: string;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
      chunkSize: Math.min(5 * 1024 * 1024, input.bytes.byteLength),
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
          resolveUpload({ ingestResultHeader });
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

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('originalResponse' in error)) {
    return undefined;
  }
  const response = (error as { originalResponse?: { getStatus?: () => number } }).originalResponse;
  return response?.getStatus?.();
}

describe('backstage ingest resumable upload integration', () => {
  test(
    'uploads, materializes, stores, and signs a release while enforcing upload authentication',
    async () => {
      const receivedPuts: ReceivedPut[] = [];
      const fakeLore = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const match = /^\/v1\/repository\/([0-9a-f]{32})\/content$/.exec(url.pathname);
          if (request.method !== 'PUT' || !match) {
            return new Response('Not found', { status: 404 });
          }

          const body = await request.arrayBuffer();
          const sha256 = await sha256Hex(body);
          receivedPuts.push({
            repositoryId: match[1],
            byteLength: body.byteLength,
            sha256,
          });
          return Response.json({
            data: { address: `${sha256}-${'0'.repeat(32)}` },
          });
        },
      });

      const tempDirectory = await mkdtemp(join(tmpdir(), 'yucp-backstage-ingest-'));
      const sidecarPort = await getFreePort();
      const sidecarOrigin = `http://127.0.0.1:${sidecarPort}`;
      const entrypoint = resolve(import.meta.dir, '../src/index.ts');
      const stdout: string[] = [];
      const stderr: string[] = [];
      const sidecar = Bun.spawn(['bun', 'run', entrypoint], {
        cwd: resolve(import.meta.dir, '../../..'),
        env: {
          ...process.env,
          PORT: String(sidecarPort),
          BACKSTAGE_INGEST_TUS_DIR: tempDirectory,
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
        await waitForSidecar({
          origin: sidecarOrigin,
          getExitCode: () => exitCode,
          stderr,
        });

        const packageId = 'com.yucp.ingest-integration';
        const version = '1.2.3';
        const authUserId = 'auth-user-ingest-integration';
        const repositoryId = loreRepositoryIdForCreator(authUserId, REPOSITORY_SALT);
        const archiveMtime = new Date('2024-01-01T00:00:00.000Z');
        const sourceBytes = zipSync(
          {
            'package.json': [
              strToU8(JSON.stringify({ name: packageId, version })),
              { mtime: archiveMtime },
            ],
            'Assets/integration.txt': [strToU8('real resumable ingest'), { mtime: archiveMtime }],
          },
          { level: 9 }
        );
        const sourceSha256 = await sha256Hex(sourceBytes);
        const claims: BackstageUploadClaims = {
          typ: 'backstage-upload',
          authUserId,
          packageId,
          version,
          repositoryId,
          deliveryName: `${packageId}-${version}.zip`,
          sourceContentType: 'application/zip',
          declaredSha256: sourceSha256,
          byteSize: sourceBytes.byteLength,
          exp: Math.floor(Date.now() / 1000) + 3_600,
        };

        const uploadToken = await sign(INGEST_SECRET, claims);
        const uploadResult = await uploadWithTus({
          bytes: sourceBytes,
          endpoint: `${sidecarOrigin}/files`,
          uploadToken,
        });
        expect(uploadResult.ingestResultHeader).toBeTruthy();

        const signedResult = uploadResult.ingestResultHeader as string;
        const bundle = parseIngestResult(await verify(INGEST_SECRET, signedResult));
        expect(bundle.typ).toBe('backstage-ingest-result');
        expect(bundle.authUserId).toBe(authUserId);
        expect(bundle.packageId).toBe(packageId);
        expect(bundle.version).toBe(version);
        expect(bundle.loreSource.sha256).toBe(sourceSha256);
        expect(bundle.loreSource.repositoryId).toBe(repositoryId);
        expect(bundle.loreDelivery.sha256).not.toBe(bundle.loreSource.sha256);
        expect(bundle.loreSource.tenantId).toBe(authUserId);
        expect(bundle.loreDelivery.tenantId).toBe(authUserId);

        expect(receivedPuts).toHaveLength(2);
        expect(receivedPuts.map((put) => put.repositoryId)).toEqual([repositoryId, repositoryId]);
        expect(receivedPuts[0]).toEqual({
          repositoryId,
          byteLength: sourceBytes.byteLength,
          sha256: sourceSha256,
        });
        expect(receivedPuts[1].sha256).toBe(bundle.loreDelivery.sha256);
        expect(receivedPuts[1].byteLength).toBe(bundle.loreDelivery.byteSize);

        const firstCharacter = signedResult.at(0);
        const tamperedHeader = `${firstCharacter === 'A' ? 'B' : 'A'}${signedResult.slice(1)}`;
        await expect(verify(INGEST_SECRET, tamperedHeader)).rejects.toThrow();
        await expect(verify(WRONG_SECRET, signedResult)).rejects.toThrow();

        const invalidArchiveBytes = strToU8('not a zip archive');
        const invalidArchiveToken = await sign(INGEST_SECRET, {
          ...claims,
          declaredSha256: await sha256Hex(invalidArchiveBytes),
          byteSize: invalidArchiveBytes.byteLength,
        });
        let invalidArchiveUploadSucceeded = false;
        let invalidArchiveUploadError: unknown;
        try {
          await uploadWithTus({
            bytes: invalidArchiveBytes,
            endpoint: `${sidecarOrigin}/files`,
            uploadToken: invalidArchiveToken,
          });
          invalidArchiveUploadSucceeded = true;
        } catch (error) {
          invalidArchiveUploadError = error;
        }
        expect(invalidArchiveUploadSucceeded).toBe(false);
        expect(invalidArchiveUploadError).toBeInstanceOf(Error);
        expect(responseStatus(invalidArchiveUploadError)).toBe(422);
        expect(receivedPuts).toHaveLength(2);
        expect(await readdir(tempDirectory)).toEqual([]);
        expect(stdout.join('')).not.toContain(repositoryId);
        expect(stderr.join('')).not.toContain(repositoryId);
        expect(stderr.join('')).not.toContain('invalid zip data');
        expect(stderr.join('')).toContain('"reason":"materialization_failed"');

        const wrongToken = await sign(WRONG_SECRET, claims);
        let wrongSecretUploadSucceeded = false;
        let wrongSecretUploadError: unknown;
        try {
          await uploadWithTus({
            bytes: sourceBytes,
            endpoint: `${sidecarOrigin}/files`,
            uploadToken: wrongToken,
          });
          wrongSecretUploadSucceeded = true;
        } catch (error) {
          wrongSecretUploadError = error;
        }
        expect(wrongSecretUploadSucceeded).toBe(false);
        expect(wrongSecretUploadError).toBeInstanceOf(Error);
        expect(responseStatus(wrongSecretUploadError)).toBe(401);
        expect(receivedPuts).toHaveLength(2);

        const wrongShaToken = await sign(INGEST_SECRET, {
          ...claims,
          declaredSha256: 'f'.repeat(64),
        });
        let wrongShaUploadSucceeded = false;
        let wrongShaUploadError: unknown;
        try {
          await uploadWithTus({
            bytes: sourceBytes,
            endpoint: `${sidecarOrigin}/files`,
            uploadToken: wrongShaToken,
          });
          wrongShaUploadSucceeded = true;
        } catch (error) {
          wrongShaUploadError = error;
        }
        expect(wrongShaUploadSucceeded).toBe(false);
        expect(wrongShaUploadError).toBeInstanceOf(Error);
        expect(responseStatus(wrongShaUploadError)).toBe(422);
        expect(receivedPuts).toHaveLength(2);
        expect(await readdir(tempDirectory)).toEqual([]);
      } catch (error) {
        process.stderr.write(`\nCaptured sidecar stderr:\n${stderr.join('')}\n`);
        throw error;
      } finally {
        await stopSidecar(sidecar);
        await Promise.all([stdoutCapture, stderrCapture]);
        await fakeLore.stop(true);
        await rm(tempDirectory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});
