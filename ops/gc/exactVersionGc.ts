import type { StorageGcCatalog, StorageGcDeletion } from '../catalog/storageGcCatalog';
import type { ExactStoragePort } from '../storage-core/exactStorage';

const DEFAULT_DELETION_LIMIT = 100;

export type ExactVersionGarbageCollectionResult = {
  candidatesObserved: number;
  deletedBytes: number;
  deletedObjects: number;
  failedObjects: number;
  generationId: number;
  recoveredDeletions: number;
  retentionBlockedBytes: number;
  retentionBlockedObjects: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error).trim() || 'Unknown exact-version deletion failure';
}

async function exactVersionStillExists(
  deletion: StorageGcDeletion,
  storage: ExactStoragePort
): Promise<boolean> {
  const versions = await storage.listExactVersions({
    objectKey: deletion.objectKey,
    role: deletion.storageRole,
  });
  return versions.some((version) => version.providerVersion === deletion.providerVersion);
}

async function processDeletion(input: {
  catalog: StorageGcCatalog;
  deletion: StorageGcDeletion;
  now: Date;
  result: ExactVersionGarbageCollectionResult;
  storage: ExactStoragePort;
}): Promise<void> {
  try {
    const fenced = await input.catalog.withPendingDeletionFence({
      handoff: async () => {
        if (!(await exactVersionStillExists(input.deletion, input.storage))) {
          return { state: 'DELETED' as const };
        }
        const retention = await input.storage.getRetention({
          objectKey: input.deletion.objectKey,
          providerVersion: input.deletion.providerVersion,
          role: input.deletion.storageRole,
        });
        if (retention.retainUntil.getTime() > input.now.getTime()) {
          return {
            retainUntil: retention.retainUntil,
            state: 'RETENTION_BLOCKED' as const,
          };
        }
        await input.storage.deleteExactVersion({
          objectKey: input.deletion.objectKey,
          providerVersion: input.deletion.providerVersion,
          role: input.deletion.storageRole,
        });
        if (await exactVersionStillExists(input.deletion, input.storage)) {
          throw new Error('Exact provider version still exists after deletion');
        }
        return { state: 'DELETED' as const };
      },
      journalId: input.deletion.journalId,
      now: input.now,
      objectVersionId: input.deletion.objectVersionId,
    });
    if (!fenced.deletionAllowed) {
      input.result.failedObjects += 1;
      return;
    }
    if (fenced.value.state === 'RETENTION_BLOCKED') {
      input.result.retentionBlockedBytes += input.deletion.bytes;
      input.result.retentionBlockedObjects += 1;
      return;
    }
    input.result.deletedBytes += input.deletion.bytes;
    input.result.deletedObjects += 1;
  } catch (error) {
    await input.catalog.failDeletion({
      error: errorMessage(error),
      journalId: input.deletion.journalId,
      objectVersionId: input.deletion.objectVersionId,
    });
    input.result.failedObjects += 1;
  }
}

export async function runExactVersionGarbageCollection(input: {
  catalog: StorageGcCatalog;
  deletionLimit?: number;
  now?: Date;
  storage: ExactStoragePort;
}): Promise<ExactVersionGarbageCollectionResult> {
  const deletionLimit = input.deletionLimit ?? DEFAULT_DELETION_LIMIT;
  if (!Number.isSafeInteger(deletionLimit) || deletionLimit < 1 || deletionLimit > 1000) {
    throw new Error('Exact-version GC deletion limit is invalid');
  }
  if (input.now !== undefined && !Number.isFinite(input.now.getTime())) {
    throw new Error('Exact-version GC time is invalid');
  }
  const observed = await input.catalog.observeGeneration(input.now);
  const now = input.now ?? observed.generation.completedAt;
  const result: ExactVersionGarbageCollectionResult = {
    candidatesObserved: observed.candidatesObserved,
    deletedBytes: 0,
    deletedObjects: 0,
    failedObjects: 0,
    generationId: observed.generation.id,
    recoveredDeletions: 0,
    retentionBlockedBytes: 0,
    retentionBlockedObjects: 0,
  };

  const pending = await input.catalog.listPendingDeletions(deletionLimit);
  for (const deletion of pending) {
    await processDeletion({
      catalog: input.catalog,
      deletion,
      now,
      result,
      storage: input.storage,
    });
    result.recoveredDeletions += 1;
  }

  let processed = pending.length;
  while (processed < deletionLimit) {
    const deletion = await input.catalog.claimDeletionCandidate({
      generationId: observed.generation.id,
      now,
    });
    if (!deletion) {
      break;
    }
    await processDeletion({
      catalog: input.catalog,
      deletion,
      now,
      result,
      storage: input.storage,
    });
    processed += 1;
  }
  return result;
}
