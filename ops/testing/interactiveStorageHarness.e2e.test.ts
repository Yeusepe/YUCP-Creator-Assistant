import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalogDatabase } from '../catalog';
import { getS3ObjectVersion, putS3ObjectVersioned } from '../storage-core/s3Control';
import {
  resetInteractiveStorageHarness,
  startInteractiveStorageHarness,
} from './interactiveStorageHarness';

describe.serial('interactive storage harness', () => {
  it('preserves PostgreSQL state and exact MinIO versions across ordinary restarts', async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), 'yucp-interactive-storage-test-'));
    let active = await startInteractiveStorageHarness({ profileRoot });
    const epoch = active.runId;
    const bucket = active.buckets.metadata.bucket;
    const accessKeyId = active.buckets.metadata.accessKeyId;
    const secretAccessKey = active.buckets.metadata.secretAccessKey;
    const databaseName = active.postgres.databaseName;
    const runtimeSecrets = active.runtimeSecrets;
    let versionId = '';

    try {
      const sql = openCatalogDatabase(active.postgres.url);
      try {
        await sql`
          CREATE TABLE interactive_restart_probe (
            storage_epoch text PRIMARY KEY,
            object_key text NOT NULL,
            object_version text NOT NULL
          )
        `;
        const version = await putS3ObjectVersioned({
          body: 'persistent metadata',
          config: active.buckets.metadata,
          contentType: 'application/octet-stream',
          key: 'restart-probe/metadata.cbor',
        });
        versionId = version.versionId;
        await sql`
          INSERT INTO interactive_restart_probe (
            storage_epoch,
            object_key,
            object_version
          )
          VALUES (
            ${epoch},
            ${'restart-probe/metadata.cbor'},
            ${versionId}
          )
        `;
      } finally {
        await sql.end({ timeout: 1 });
      }

      await active.stop();
      active = await startInteractiveStorageHarness({ profileRoot });

      expect(active.runId).toBe(epoch);
      expect(active.buckets.metadata.bucket).toBe(bucket);
      expect(active.buckets.metadata.accessKeyId).toBe(accessKeyId);
      expect(active.buckets.metadata.secretAccessKey).toBe(secretAccessKey);
      expect(active.postgres.databaseName).toBe(databaseName);
      expect(active.runtimeSecrets).toEqual(runtimeSecrets);

      const restartedSql = openCatalogDatabase(active.postgres.url);
      try {
        const rows = await restartedSql<
          {
            object_key: string;
            object_version: string;
            storage_epoch: string;
          }[]
        >`
          SELECT storage_epoch, object_key, object_version
          FROM interactive_restart_probe
        `;
        expect(
          rows.map(({ object_key, object_version, storage_epoch }) => ({
            object_key,
            object_version,
            storage_epoch,
          }))
        ).toEqual([
          {
            object_key: 'restart-probe/metadata.cbor',
            object_version: versionId,
            storage_epoch: epoch,
          },
        ]);
      } finally {
        await restartedSql.end({ timeout: 1 });
      }

      const exactObject = await getS3ObjectVersion(
        active.buckets.metadata,
        'restart-probe/metadata.cbor',
        versionId
      );
      expect(await exactObject.text()).toBe('persistent metadata');
      expect(exactObject.headers.get('etag')).toBe(`"${versionId}"`);
      await expect(
        resetInteractiveStorageHarness({
          expectedEpoch: '000000000000',
          profileRoot,
        })
      ).rejects.toThrow('epoch confirmation does not match');
    } finally {
      await active.stop();
      await resetInteractiveStorageHarness({
        expectedEpoch: epoch,
        profileRoot,
      });
    }
  }, 300_000);
});
