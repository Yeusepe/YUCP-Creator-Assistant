import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { request as createHttpRequest, createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { canonicalizeArtifact } from '../storage-core/canonicalizer';
import { loadCasConfig } from '../storage-core/config';
import { signDeliveryUrl } from '../storage-core/deliverySigning';
import {
  inspectDesyncIndex,
  s3CasStore,
  storeArtifactToStore,
  verifyDesyncCli,
} from '../storage-core/desyncCas';
import { runCommand } from '../storage-core/process';
import { createS3Bucket } from '../storage-core/s3Control';
import { waitForMinioReady } from '../testing/minioReadiness';
import { importerCapabilityBinding, importVersion } from './importVersion';

const MINIO_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z';
const TEST_CONTAINER_LABEL = 'com.yucp.test=desync-importer';

type StoreGetCounts = {
  chunks: number;
  indexes: number;
  total: number;
};

let containerId: string | undefined;
let countingProxy: HttpServer | undefined;
let scratchPath: string | undefined;

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

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function startCountingProxy(input: {
  bucket: string;
  chunkPrefix: string;
  indexPrefix: string;
  upstream: URL;
}): Promise<{ counts: StoreGetCounts; endpoint: string; server: HttpServer }> {
  const counts: StoreGetCounts = { chunks: 0, indexes: 0, total: 0 };
  const chunkPathPrefix = `/${input.bucket}/${input.chunkPrefix}`;
  const indexPathPrefix = `/${input.bucket}/${input.indexPrefix}`;
  const server = createServer((request, response) => {
    const requestPath = request.url ?? '/';
    if (request.method === 'GET') {
      counts.total += 1;
      const pathname = new URL(requestPath, 'http://minio-proxy.invalid').pathname;
      if (pathname.startsWith(chunkPathPrefix)) {
        counts.chunks += 1;
      } else if (pathname.startsWith(indexPathPrefix)) {
        counts.indexes += 1;
      }
    }

    const upstreamRequest = createHttpRequest(
      {
        headers: request.headers,
        hostname: input.upstream.hostname,
        method: request.method,
        path: requestPath,
        port: input.upstream.port,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          upstreamResponse.headers
        );
        upstreamResponse.pipe(response);
      }
    );
    upstreamRequest.on('error', (error) => response.destroy(error));
    request.pipe(upstreamRequest);
  });

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
    throw new Error('Counting proxy did not bind a TCP port');
  }

  return {
    counts,
    endpoint: `http://127.0.0.1:${address.port}`,
    server,
  };
}

async function writeFixtureTree(rootPath: string, versionSeed: string): Promise<void> {
  const files = new Map<string, Buffer>([
    ['Assets/000-version.asset', deterministicBytes(versionSeed, 256 * 1024)],
    ['Assets/Audio/preview.ogg', deterministicBytes('shared-preview-ogg', 2 * 1024 * 1024)],
    ['Assets/Models/avatar.fbx', deterministicBytes('shared-avatar-fbx', 4 * 1024 * 1024)],
    [
      'Assets/Settings/package.asset',
      Buffer.from('Material:\n  shader: Standard\n  renderQueue: 2000\n'.repeat(16_000)),
    ],
    ['Assets/Textures/albedo.png', deterministicBytes('shared-albedo-png', 4 * 1024 * 1024)],
  ]);

  for (const [relativePath, bytes] of files) {
    const filePath = join(rootPath, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }
}

async function createRawUnityPackage(sourcePath: string, outputPath: string): Promise<void> {
  const tarPath = `${outputPath}.tar`;
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  await runCommand('tar', [
    '--force-local',
    '--create',
    '--file',
    tarPath,
    '--format=gnu',
    '--sort=name',
    '--directory',
    sourcePath,
    '.',
  ]);
  await utimes(tarPath, timestamp, timestamp);
  await runCommand('gzip', ['--stdout', '--', tarPath], { stdoutPath: outputPath });
  await rm(tarPath, { force: true });
}

beforeAll(async () => {
  await runCommand('docker', ['version', '--format', '{{.Server.Version}}']);
  await verifyDesyncCli();
});

afterAll(async () => {
  if (countingProxy) {
    await closeServer(countingProxy);
  }
  if (containerId) {
    try {
      await runCommand('docker', ['rm', '--force', containerId]);
    } catch {
      // Docker --rm may already have removed a stopped throwaway container.
    }
  }
  if (scratchPath) {
    assertScratchPath(scratchPath);
    await rm(scratchPath, { force: true, recursive: true });
  }
});

describe('first-party desync importer against throwaway MinIO', () => {
  it('imports byte-exact, fetches only delta chunks with a seed, and authorizes before storage', async () => {
    const accessKeyId = `test-${randomBytes(12).toString('hex')}`;
    const secretAccessKey = randomBytes(32).toString('hex');
    const bucket = `importer-test-${randomBytes(8).toString('hex')}`;
    const containerName = `yucp-desync-importer-${randomBytes(6).toString('hex')}`;
    const started = await runCommand('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--label',
      TEST_CONTAINER_LABEL,
      '--publish',
      '127.0.0.1::9000',
      '--env',
      `MINIO_ROOT_USER=${accessKeyId}`,
      '--env',
      `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      MINIO_IMAGE,
      'server',
      '/data',
      '--address',
      ':9000',
    ]);
    containerId = started.stdout.trim();
    if (!containerId) {
      throw new Error('Docker did not return the throwaway MinIO container ID');
    }

    const publishedPort = (
      await runCommand('docker', ['port', containerId, '9000/tcp'])
    ).stdout.trim();
    const portMatch = publishedPort.match(/127\.0\.0\.1:(\d+)$/m);
    if (!portMatch?.[1]) {
      throw new Error('Docker did not publish the throwaway MinIO API on a random local port');
    }
    const minioEndpoint = `http://127.0.0.1:${portMatch[1]}`;
    await waitForMinioReady({ endpoint: minioEndpoint });

    const proxy = await startCountingProxy({
      bucket,
      chunkPrefix: 'chunks/',
      indexPrefix: 'indexes/',
      upstream: new URL(minioEndpoint),
    });
    countingProxy = proxy.server;
    const config = loadCasConfig({
      CAS_S3_ENDPOINT: proxy.endpoint,
      CAS_S3_REGION: 'us-east-1',
      CAS_S3_BUCKET: bucket,
      CAS_S3_ACCESS_KEY_ID: accessKeyId,
      CAS_S3_SECRET_ACCESS_KEY: secretAccessKey,
    });
    await createS3Bucket(config);
    const store = s3CasStore(config);

    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-importer-e2e-'));
    const v1TreePath = join(scratchPath, 'v1-tree');
    const v2TreePath = join(scratchPath, 'v2-tree');
    await mkdir(v1TreePath);
    await mkdir(v2TreePath);
    await writeFixtureTree(v1TreePath, 'version-one');
    await writeFixtureTree(v2TreePath, 'version-two');

    const rawV1Path = join(scratchPath, 'fixture-v1.unitypackage');
    const rawV2Path = join(scratchPath, 'fixture-v2.unitypackage');
    await createRawUnityPackage(v1TreePath, rawV1Path);
    await createRawUnityPackage(v2TreePath, rawV2Path);
    const canonicalV1 = await canonicalizeArtifact({
      inputPath: rawV1Path,
      outputPath: join(scratchPath, 'canonical-v1.unitypackage'),
    });
    const canonicalV2 = await canonicalizeArtifact({
      inputPath: rawV2Path,
      outputPath: join(scratchPath, 'canonical-v2.unitypackage'),
    });
    const v1Sha256 = await sha256File(canonicalV1.path);
    const v2Sha256 = await sha256File(canonicalV2.path);

    await storeArtifactToStore({ artifactPath: canonicalV1.path, indexId: 'v1.caibx', store });
    await storeArtifactToStore({ artifactPath: canonicalV2.path, indexId: 'v2.caibx', store });
    const v1Chunks = await inspectDesyncIndex({ indexId: 'v1.caibx', store });
    const v2Chunks = await inspectDesyncIndex({ indexId: 'v2.caibx', store });
    const v1ChunkIds = new Set(v1Chunks.map((chunk) => chunk.id));
    const v2ChunkIds = new Set(v2Chunks.map((chunk) => chunk.id));
    const newV2ChunkIds = new Set(
      Array.from(v2ChunkIds).filter((chunkId) => !v1ChunkIds.has(chunkId))
    );
    expect(newV2ChunkIds.size).toBeGreaterThan(0);
    expect(newV2ChunkIds.size).toBeLessThan(v2ChunkIds.size / 3);

    const hmacKey = randomBytes(32).toString('hex');
    const v1VersionId = 'importer-fixture-v1';
    const v1Signed = await signDeliveryUrl({
      binding: importerCapabilityBinding('v1.caibx', v1Sha256),
      expiresAt: Date.now() + 10 * 60_000,
      key: hmacKey,
      versionId: v1VersionId,
    });
    const importedV1Path = join(scratchPath, 'imported-v1.unitypackage');
    const importedV1 = await importVersion(
      {
        capability: { ...v1Signed, versionId: v1VersionId },
        expectedSha256: v1Sha256,
        indexId: 'v1.caibx',
        outputPath: importedV1Path,
        store,
      },
      { hmacKey }
    );
    expect(importedV1).toBe(resolve(importedV1Path));
    expect(await sha256File(importedV1)).toBe(v1Sha256);
    expect(await readFile(importedV1)).toEqual(await readFile(canonicalV1.path));

    const replacementPath = join(scratchPath, 'imported-replacement.unitypackage');
    const preexistingArtifact = Buffer.from('pre-existing artifact must survive failed import');
    await writeFile(replacementPath, preexistingArtifact);
    const wrongV1Sha256 = `${v1Sha256[0] === '0' ? '1' : '0'}${v1Sha256.slice(1)}`;
    const wrongV1Signed = await signDeliveryUrl({
      binding: importerCapabilityBinding('v1.caibx', wrongV1Sha256),
      expiresAt: Date.now() + 10 * 60_000,
      key: hmacKey,
      versionId: v1VersionId,
    });
    await expect(
      importVersion(
        {
          capability: { ...wrongV1Signed, versionId: v1VersionId },
          expectedSha256: wrongV1Sha256,
          indexId: 'v1.caibx',
          outputPath: replacementPath,
          store,
        },
        { hmacKey }
      )
    ).rejects.toThrow('Imported artifact SHA-256 mismatch');
    expect(await readFile(replacementPath)).toEqual(preexistingArtifact);

    await importVersion(
      {
        capability: { ...v1Signed, versionId: v1VersionId },
        expectedSha256: v1Sha256,
        indexId: 'v1.caibx',
        outputPath: replacementPath,
        store,
      },
      { hmacKey }
    );
    expect(await readFile(replacementPath)).toEqual(await readFile(canonicalV1.path));

    const v2VersionId = 'importer-fixture-v2';
    const v2Signed = await signDeliveryUrl({
      binding: importerCapabilityBinding('v2.caibx', v2Sha256),
      expiresAt: Date.now() + 10 * 60_000,
      key: hmacKey,
      versionId: v2VersionId,
    });
    const fullChunksBefore = proxy.counts.chunks;
    const importedFullV2 = await importVersion(
      {
        capability: { ...v2Signed, versionId: v2VersionId },
        expectedSha256: v2Sha256,
        indexId: 'v2.caibx',
        outputPath: join(scratchPath, 'imported-v2-full.unitypackage'),
        store,
      },
      { hmacKey }
    );
    const fullV2StoreGets = proxy.counts.chunks - fullChunksBefore;
    expect(fullV2StoreGets).toBe(v2ChunkIds.size);
    expect(await sha256File(importedFullV2)).toBe(v2Sha256);

    const deltaChunksBefore = proxy.counts.chunks;
    const importedDeltaV2 = await importVersion(
      {
        capability: { ...v2Signed, versionId: v2VersionId },
        expectedSha256: v2Sha256,
        indexId: 'v2.caibx',
        outputPath: join(scratchPath, 'imported-v2-delta.unitypackage'),
        seed: { artifactPath: importedV1, indexId: 'v1.caibx' },
        store,
      },
      { hmacKey }
    );
    const deltaV2StoreGets = proxy.counts.chunks - deltaChunksBefore;
    expect(deltaV2StoreGets).toBe(newV2ChunkIds.size);
    expect(deltaV2StoreGets).toBeLessThan(fullV2StoreGets / 3);
    expect(await sha256File(importedDeltaV2)).toBe(v2Sha256);
    expect(await readFile(importedDeltaV2)).toEqual(await readFile(canonicalV2.path));

    const authFailureFetchesBefore = proxy.counts.total;
    const badSignature = `${v2Signed.sig[0] === '0' ? '1' : '0'}${v2Signed.sig.slice(1)}`;
    await expect(
      importVersion(
        {
          capability: {
            ...v2Signed,
            sig: badSignature,
            versionId: v2VersionId,
          },
          expectedSha256: v2Sha256,
          indexId: 'v2.caibx',
          outputPath: join(scratchPath, 'invalid-capability.unitypackage'),
          store,
        },
        { hmacKey }
      )
    ).rejects.toThrow('Invalid or expired importer capability');
    const expired = await signDeliveryUrl({
      binding: importerCapabilityBinding('v2.caibx', v2Sha256),
      expiresAt: Date.now() - 60_000,
      key: hmacKey,
      versionId: v2VersionId,
    });
    await expect(
      importVersion(
        {
          capability: { ...expired, versionId: v2VersionId },
          expectedSha256: v2Sha256,
          indexId: 'v2.caibx',
          outputPath: join(scratchPath, 'expired-capability.unitypackage'),
          store,
        },
        { hmacKey }
      )
    ).rejects.toThrow('Invalid or expired importer capability');
    const invalidCapabilityStoreFetches = proxy.counts.total - authFailureFetchesBefore;
    expect(invalidCapabilityStoreFetches).toBe(0);

    console.log(
      `IMPORTER_E2E_RESULT v1-byte-exact=yes delta-v2-store-gets=${deltaV2StoreGets} full=${fullV2StoreGets} invalid-capability-store-fetches=${invalidCapabilityStoreFetches} minio=yes`
    );
    console.log(
      'IMPORTER_TARGET_REPLACEMENT_RESULT failed-import-preserved=yes successful-import-replaced-byte-exact=yes'
    );
  });
});
