import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Catalog, PackageVersion } from '../catalog';
import { parseDeliveryManifest } from '../storage-core/deliveryManifest';
import { localCasStore, verifyDesyncCli } from '../storage-core/desyncCas';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import { createUnityPackageRecordFixture } from '../testing/unityPackageFixture';
import { assembleVersion, resolvePipelineCasIndexId } from './ingestPipeline';

const scratchPaths: string[] = [];

async function createScratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'yucp-ingest-manifest-order-'));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe('ingest pipeline manifest determinism', () => {
  test('concurrent file storage produces the sequential manifest files[] order', async () => {
    await verifyDesyncCli();
    const root = await createScratch();
    const artifactPath = join(root, 'fixture.unitypackage');
    const hashes = await createUnityPackageRecordFixture({
      outputPath: artifactPath,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      versionSeed: 'manifest-order-fixture',
    });
    const version = {
      id: '018f8c03-3880-7d40-a8d5-b190a64141cc',
      packageId: 'com.yucp.fixture',
      releaseRoot: null,
      state: 'UPLOADING',
      version: '1.0.0',
    } as unknown as PackageVersion;
    const metadataStore = localCasStore(join(root, 'metadata'));

    const assembleOnce = async (runRoot: string): Promise<string> => {
      let assemblyObjectId: string | undefined;
      const catalog = {
        async getVersion() {
          return version;
        },
        async markFailed() {
          return version;
        },
        async transition(
          _id: string,
          _target: string,
          options: { fields: { assemblyObjectId: string } }
        ) {
          assemblyObjectId = options.fields.assemblyObjectId;
          return version;
        },
      } as unknown as Catalog;
      await assembleVersion({
        catalog,
        commonStore: localCasStore(join(root, 'common')),
        creatorId: 'creator-manifest-order',
        inputPath: artifactPath,
        metadataStore,
        protectedStore: localCasStore(join(root, 'protected')),
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        scratchRoot: runRoot,
        versionId: version.id,
      });
      if (!assemblyObjectId) {
        throw new Error('Assembly transition did not record its object id');
      }
      return readFile(resolvePipelineCasIndexId(metadataStore, assemblyObjectId), 'utf8');
    };

    const firstBody = await assembleOnce(join(root, 'run-one'));
    const manifest = parseDeliveryManifest(JSON.parse(firstBody));

    const expectedPaths = Array.from(hashes.keys()).sort();
    expect(manifest.files.map((file) => file.normalizedPath)).toEqual(expectedPaths);
    for (const file of manifest.files) {
      expect(file.sha256).toBe(hashes.get(file.normalizedPath) as string);
    }

    expect(await assembleOnce(join(root, 'run-two'))).toBe(firstBody);
  }, 120_000);
});
