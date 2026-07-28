import type { CatalogDatabase } from '../catalog';
import type { CasConfig } from '../storage-core/config';
import {
  deleteS3ObjectVersion,
  listS3Objects,
  listS3ObjectVersions,
} from '../storage-core/s3Control';

export type QuarantineGarbageCollectionResult = {
  deletedObjects: number;
  deletedOrphans: number;
  failedObjects: number;
  releasedRows: number;
};

const QUARANTINE_KEY_PATTERN =
  /^raw\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}\.(?:unitypackage|zip|spp)$/i;

export async function runQuarantineGarbageCollection(input: {
  config: CasConfig;
  deletionLimit?: number;
  sql: CatalogDatabase;
}): Promise<QuarantineGarbageCollectionResult> {
  const deletionLimit = input.deletionLimit ?? 100;
  if (!Number.isSafeInteger(deletionLimit) || deletionLimit < 1 || deletionLimit > 1000) {
    throw new Error('Quarantine GC deletion limit is invalid');
  }
  const result: QuarantineGarbageCollectionResult = {
    deletedObjects: 0,
    deletedOrphans: 0,
    failedObjects: 0,
    releasedRows: 0,
  };

  const releasable = await input.sql<
    { object_key: string; provider_version: string | null; version_id: string }[]
  >`
    SELECT quarantine.object_key, quarantine.provider_version, quarantine.version_id
    FROM package_quarantine_objects quarantine
    JOIN package_versions version ON version.id = quarantine.version_id
    WHERE version.state IN ('READY', 'DELETED')
    LIMIT ${deletionLimit}
  `;
  for (const row of releasable) {
    try {
      if (row.provider_version) {
        await deleteS3ObjectVersion(input.config, row.object_key, row.provider_version);
      }
      await input.sql`
        DELETE FROM package_quarantine_objects WHERE version_id = ${row.version_id}
      `;
      result.deletedObjects += row.provider_version ? 1 : 0;
      result.releasedRows += 1;
    } catch {
      result.failedObjects += 1;
    }
  }

  const objects = await listS3Objects(input.config, 'raw/');
  const knownKeys = new Set(
    (
      await input.sql<{ object_key: string }[]>`
        SELECT object_key FROM package_quarantine_objects
      `
    ).map((row) => row.object_key)
  );
  for (const object of objects) {
    if (result.deletedOrphans >= deletionLimit) {
      break;
    }
    if (!QUARANTINE_KEY_PATTERN.test(object.key) || knownKeys.has(object.key)) {
      continue;
    }
    try {
      for (const version of await listS3ObjectVersions(input.config, object.key)) {
        if (version.key === object.key) {
          await deleteS3ObjectVersion(input.config, object.key, version.versionId);
        }
      }
      result.deletedOrphans += 1;
    } catch {
      result.failedObjects += 1;
    }
  }
  return result;
}
