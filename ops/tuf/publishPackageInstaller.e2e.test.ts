import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as ed25519 from '@noble/ed25519';
import {
  ExactStorageCatalog,
  openCatalogDatabase,
  StorageGcCatalog,
  TufRepositoryCatalog,
} from '../catalog';
import { runExactVersionGarbageCollection } from '../gc/exactVersionGc';
import { DurableExactStorage } from '../storage-core/durableExactStorage';
import { S3ExactStoragePort } from '../storage-core/exactStorage';
import { ExactTufRepositoryReader } from '../storage-core/tufRepositoryReader';
import {
  type DisposableStorageHarness,
  startDisposableStorageHarness,
} from '../testing/disposableStorageHarness';
import { publishPackageInstallerTuf } from './publishPackageInstaller';

const helperRoot = path.resolve('Verify', 'Native', 'transfer-helper');

let harness: DisposableStorageHarness | undefined;

class ExpiredRetentionStorage extends S3ExactStoragePort {
  override async getRetention(): Promise<{
    mode: 'GOVERNANCE';
    retainUntil: Date;
  }> {
    return {
      mode: 'GOVERNANCE',
      retainUntil: new Date('2000-01-01T00:00:00.000Z'),
    };
  }
}

beforeAll(async () => {
  harness = await startDisposableStorageHarness();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
  harness = undefined;
}, 300_000);

function requireHarness(): DisposableStorageHarness {
  if (!harness) {
    throw new Error('TUF publisher test harness was not initialized');
  }
  return harness;
}

function localTufSeed(role: 'snapshot' | 'targets' | 'timestamp'): string {
  return createHash('sha256')
    .update(`YUCP transfer-helper TUF test key: ${role}`)
    .digest('base64url');
}

function rootSeed(index: number): Buffer {
  return createHash('sha256').update(`YUCP TUF publisher E2E root key: ${index}`).digest();
}

async function publicKey(seed: Uint8Array): Promise<string> {
  return Buffer.from(await ed25519.getPublicKeyAsync(seed)).toString('base64url');
}

async function runExecutable(
  executable: string,
  args: string[],
  env?: Record<string, string>
): Promise<void> {
  const process = Bun.spawn([executable, ...args], {
    env,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${path.basename(executable)} failed: ${stderr.trim()}`);
  }
}

describe.serial('package installer TUF production publisher', () => {
  test('publishes one exact recoverable repository and reuses its idempotent reservation', async () => {
    const activeHarness = requireHarness();
    const executable = path.join(
      activeHarness.uploadDir,
      process.platform === 'win32' ? 'yucp-tuf-online-repository.exe' : 'yucp-tuf-online-repository'
    );
    const rootExecutable = path.join(
      activeHarness.uploadDir,
      process.platform === 'win32' ? 'yucp-tuf-root.exe' : 'yucp-tuf-root'
    );
    const helper = path.join(activeHarness.uploadDir, 'yucp-transfer-helper.exe');
    await writeFile(helper, Buffer.from('MZ production publisher integration helper'));
    const goExecutable =
      process.env.YUCP_GO_EXECUTABLE ??
      (process.platform === 'win32' ? 'E:\\YUCPTools\\go-1.26.5\\go\\bin\\go.exe' : 'go');
    for (const [output, command] of [
      [executable, './cmd/yucp-tuf-online-repository'],
      [rootExecutable, './cmd/yucp-tuf-root'],
    ]) {
      const build = Bun.spawn([goExecutable, 'build', '-trimpath', '-o', output, command], {
        cwd: helperRoot,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      });
      const [buildExit, buildError] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      if (buildExit !== 0) {
        throw new Error(`TUF command build failed: ${buildError.trim()}`);
      }
    }
    const rootSeeds = [rootSeed(1), rootSeed(2), rootSeed(3)];
    const onlineSeeds = {
      snapshot: Buffer.from(localTufSeed('snapshot'), 'base64url'),
      targets: Buffer.from(localTufSeed('targets'), 'base64url'),
      timestamp: Buffer.from(localTufSeed('timestamp'), 'base64url'),
    };
    const rootManifest = path.join(activeHarness.uploadDir, 'root-manifest.json');
    const unsignedRoot = path.join(activeHarness.uploadDir, '1.root.unsigned.json');
    const firstSignedRoot = path.join(activeHarness.uploadDir, '1.root.signed-1.json');
    const productionRoot = path.join(activeHarness.uploadDir, '1.root.json');
    await writeFile(
      rootManifest,
      JSON.stringify({
        expires: '2037-01-01T00:00:00Z',
        rootPublicKeys: await Promise.all(rootSeeds.map(publicKey)),
        rootThreshold: 2,
        schemaVersion: 1,
        snapshotPublicKey: await publicKey(onlineSeeds.snapshot),
        targetsPublicKey: await publicKey(onlineSeeds.targets),
        timestampPublicKey: await publicKey(onlineSeeds.timestamp),
        version: 1,
      })
    );
    await runExecutable(rootExecutable, [
      'create',
      '--manifest',
      rootManifest,
      '--output',
      unsignedRoot,
    ]);
    await runExecutable(
      rootExecutable,
      ['sign', '--root', unsignedRoot, '--output', firstSignedRoot],
      { YUCP_TUF_ROOT_PRIVATE_KEY: rootSeeds[0]?.toString('base64url') ?? '' }
    );
    await runExecutable(
      rootExecutable,
      ['sign', '--root', firstSignedRoot, '--output', productionRoot],
      { YUCP_TUF_ROOT_PRIVATE_KEY: rootSeeds[1]?.toString('base64url') ?? '' }
    );
    await runExecutable(rootExecutable, ['verify', '--root', productionRoot]);
    const rootSha256 = createHash('sha256')
      .update(await readFile(productionRoot))
      .digest('hex');
    const installPrivate = randomBytes(32);
    const receiptPrivate = randomBytes(32);
    const metadata = activeHarness.buckets.metadata;
    const env: NodeJS.ProcessEnv = {
      CATALOG_DATABASE_URL: activeHarness.postgres.url,
      MATERIALIZATION_RECEIPT_KEY_ID: 'receipt-integration',
      MATERIALIZATION_RECEIPT_PUBLIC_KEY: Buffer.from(
        await ed25519.getPublicKeyAsync(receiptPrivate)
      ).toString('base64url'),
      METADATA_S3_ACCESS_KEY_ID: metadata.accessKeyId,
      METADATA_S3_BUCKET: metadata.bucket,
      METADATA_S3_ENDPOINT: metadata.endpoint,
      METADATA_S3_REGION: metadata.region,
      METADATA_S3_SECRET_ACCESS_KEY: metadata.secretAccessKey,
      NODE_ENV: 'test',
      PACKAGE_INSTALLER_TUF_HELPER_WINDOWS_AMD64_PATH: helper,
      PACKAGE_INSTALLER_TUF_PUBLISHER_EXECUTABLE: executable,
      PACKAGE_INSTALLER_TUF_REPOSITORY_ID: 'package-installer',
      PACKAGE_INSTALLER_TUF_ROOT_PATH: productionRoot,
      PACKAGE_INSTALLER_TUF_ROOT_SHA256: rootSha256,
      PACKAGE_INSTALL_SIGNING_KEY_ID: 'install-integration',
      PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: Buffer.from(
        await ed25519.getPublicKeyAsync(installPrivate)
      ).toString('base64url'),
      YUCP_TUF_SNAPSHOT_PRIVATE_KEY: localTufSeed('snapshot'),
      YUCP_TUF_TARGETS_PRIVATE_KEY: localTufSeed('targets'),
      YUCP_TUF_TIMESTAMP_PRIVATE_KEY: localTufSeed('timestamp'),
    };

    const first = await publishPackageInstallerTuf(env);
    const second = await publishPackageInstallerTuf(env);
    expect(second).toEqual(first);

    const database = openCatalogDatabase(activeHarness.postgres.url);
    try {
      const rows = await database<
        {
          object_count: number;
          publication_count: number;
        }[]
      >`
          SELECT
            (
              SELECT count(*)::int
              FROM tuf_publications
              WHERE state = 'PUBLISHED'
            ) AS publication_count,
            (
              SELECT count(*)::int
              FROM tuf_publication_objects
              WHERE publication_id = ${first.publicationId}
            ) AS object_count
        `;
      expect(rows[0]).toEqual({
        object_count: 6,
        publication_count: 1,
      });
      const publishedPaths = await database<{ repository_path: string }[]>`
        SELECT repository_path
        FROM tuf_publication_objects
        WHERE publication_id = ${first.publicationId}
        ORDER BY repository_path
      `;
      const storage = new ExpiredRetentionStorage({ metadata });
      const reader = new ExactTufRepositoryReader({
        catalog: new TufRepositoryCatalog(database),
        repositoryId: 'package-installer',
        storage,
      });
      const timestamp = await reader.read('metadata', 'timestamp.json');
      expect(timestamp?.body.byteLength).toBeGreaterThan(0);
      expect(timestamp?.contentType).toBe('application/json');
      expect(
        await storage.listExactVersions({
          objectKey: 'v2/metadata/tuf/package-installer/metadata/timestamp.json',
          role: 'metadata',
        })
      ).toHaveLength(1);

      const orphanBody = Buffer.from('unreferenced TUF GC control object');
      const orphanDigest = createHash('sha256').update(orphanBody).digest('hex');
      const orphan = await new DurableExactStorage(
        new ExactStorageCatalog(database),
        storage
      ).putImmutable({
        body: orphanBody,
        contentType: 'application/octet-stream',
        idempotencyKey: `tuf-gc-control:${first.publicationId}`,
        objectKey: `v2/metadata/tuf-gc-control/${orphanDigest}`,
        ownerId: `tuf-gc-control:${first.publicationId}`,
        ownerKind: 'maintenance',
        storageRole: 'metadata',
      });
      const gcCatalog = new StorageGcCatalog(database);
      const firstGeneration = await runExactVersionGarbageCollection({
        catalog: gcCatalog,
        storage,
      });
      const secondGeneration = await runExactVersionGarbageCollection({
        catalog: gcCatalog,
        storage,
      });
      expect(firstGeneration.deletedObjects).toBe(0);
      expect(secondGeneration.deletedObjects).toBe(1);
      expect(
        await storage.listExactVersions({
          objectKey: orphan.objectKey,
          role: 'metadata',
        })
      ).toEqual([]);

      for (const { repository_path: repositoryPath } of publishedPaths) {
        const [kind, ...nameParts] = repositoryPath.split('/');
        const repositoryObject = await reader.read(
          kind as 'metadata' | 'targets',
          nameParts.join('/')
        );
        expect(repositoryObject?.body.byteLength).toBeGreaterThan(0);
      }
    } finally {
      await database.end({ timeout: 5 });
    }
  }, 300_000);
});
