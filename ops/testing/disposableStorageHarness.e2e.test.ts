import { describe, expect, it } from 'bun:test';
import { openCatalogDatabase } from '../catalog';
import { getS3Object, listS3Objects, putS3Object } from '../storage-core/s3Control';
import {
  type DisposableStorageHarness,
  STORAGE_ROLES,
  startDisposableStorageHarness,
} from './disposableStorageHarness';

async function dockerContainerExists(containerName: string): Promise<boolean> {
  const child = Bun.spawn(['docker', 'container', 'inspect', containerName], {
    stderr: 'ignore',
    stdin: 'ignore',
    stdout: 'ignore',
  });
  return (await child.exited) === 0;
}

async function stopAll(harnesses: DisposableStorageHarness[]): Promise<void> {
  const results = await Promise.allSettled(harnesses.map((harness) => harness.stop()));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Disposable storage harness cleanup failed');
  }
}

describe.serial('disposable storage harness', () => {
  it('isolates parallel resources, storage credentials, and restarted data', async () => {
    const activeHarnesses: DisposableStorageHarness[] = [];
    let firstContainerNames: string[] = [];
    try {
      const [first, second] = await Promise.all([
        startDisposableStorageHarness(),
        startDisposableStorageHarness(),
      ]);
      activeHarnesses.push(first, second);
      firstContainerNames = [
        first.postgres.containerName,
        first.minio.containerName,
        second.postgres.containerName,
        second.minio.containerName,
      ];

      expect(first.runId).not.toBe(second.runId);
      expect(first.postgres.databaseName).not.toBe(second.postgres.databaseName);
      expect(first.postgres.url).not.toBe(second.postgres.url);
      expect(first.minio.endpoint).not.toBe(second.minio.endpoint);
      expect(
        new Set([
          ...STORAGE_ROLES.map((role) => first.buckets[role].bucket),
          ...STORAGE_ROLES.map((role) => second.buckets[role].bucket),
        ]).size
      ).toBe(STORAGE_ROLES.length * 2);

      for (const harness of [first, second]) {
        const sql = openCatalogDatabase(harness.postgres.url);
        try {
          const rows = await sql<{ database_name: string }[]>`
              SELECT current_database() AS database_name
            `;
          expect(rows[0]?.database_name).toBe(harness.postgres.databaseName);
        } finally {
          await sql.end({ timeout: 1 });
        }

        for (const role of STORAGE_ROLES) {
          const config = harness.buckets[role];
          await putS3Object({
            body: `${harness.runId}:${role}`,
            config,
            contentType: 'text/plain',
            key: 'probe.txt',
          });
          expect(await (await getS3Object(config, 'probe.txt')).text()).toBe(
            `${harness.runId}:${role}`
          );
        }
      }

      const unrelatedProtectedConfig = {
        ...first.buckets.common,
        bucket: first.buckets.protected.bucket,
      };
      await expect(
        putS3Object({
          body: 'cross-role-write',
          config: unrelatedProtectedConfig,
          contentType: 'text/plain',
          key: 'forbidden.txt',
        })
      ).rejects.toThrow('HTTP status 403');
      await expect(getS3Object(unrelatedProtectedConfig, 'probe.txt')).rejects.toThrow(
        'HTTP status 403'
      );

      await stopAll(activeHarnesses.splice(0));
      for (const containerName of firstContainerNames) {
        expect(await dockerContainerExists(containerName)).toBe(false);
      }

      const restarted = await startDisposableStorageHarness();
      activeHarnesses.push(restarted);
      for (const role of STORAGE_ROLES) {
        expect(await listS3Objects(restarted.buckets[role])).toEqual([]);
      }
    } finally {
      await stopAll(activeHarnesses);
    }
  }, 300_000);
});
