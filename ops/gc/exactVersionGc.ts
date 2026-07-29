import type { StorageGcCatalog, StorageGcDeletion } from '../catalog/storageGcCatalog';
import {
  ExactVersionDeletionBlockedError,
  type ExactVersionDeletionPort,
} from '../storage-core/exactVersionDeletion';

const DEFAULT_DELETION_LIMIT = 100;
const DEFAULT_OBJECT_LOCK_RETRY_MS = 24 * 60 * 60 * 1_000;

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

async function processDeletion(input: {
  catalog: StorageGcCatalog;
  deletionStorage: ExactVersionDeletionPort;
  deletion: StorageGcDeletion;
  now: Date;
  objectLockRetryMs: number;
  result: ExactVersionGarbageCollectionResult;
}): Promise<void> {
  try {
    const fenced = await input.catalog.withPendingDeletionFence({
      handoff: async () => {
        try {
          await input.deletionStorage.deleteExactVersion({
            fileIdentifier: input.deletion.fileIdentifier,
            objectKey: input.deletion.objectKey,
            providerVersion: input.deletion.providerVersion,
            role: input.deletion.storageRole,
          });
        } catch (error) {
          if (error instanceof ExactVersionDeletionBlockedError) {
            return {
              retainUntil: new Date(input.now.getTime() + input.objectLockRetryMs),
              state: 'RETENTION_BLOCKED' as const,
            };
          }
          throw error;
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
  deletionStorage: ExactVersionDeletionPort;
  deletionLimit?: number;
  now?: Date;
  objectLockRetryMs?: number;
}): Promise<ExactVersionGarbageCollectionResult> {
  const deletionLimit = input.deletionLimit ?? DEFAULT_DELETION_LIMIT;
  const objectLockRetryMs = input.objectLockRetryMs ?? DEFAULT_OBJECT_LOCK_RETRY_MS;
  if (!Number.isSafeInteger(deletionLimit) || deletionLimit < 1 || deletionLimit > 1000) {
    throw new Error('Exact-version GC deletion limit is invalid');
  }
  if (input.now !== undefined && !Number.isFinite(input.now.getTime())) {
    throw new Error('Exact-version GC time is invalid');
  }
  if (!Number.isSafeInteger(objectLockRetryMs) || objectLockRetryMs < 1) {
    throw new Error('Exact-version GC Object Lock retry interval is invalid');
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
      deletionStorage: input.deletionStorage,
      deletion,
      now,
      objectLockRetryMs,
      result,
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
      deletionStorage: input.deletionStorage,
      deletion,
      now,
      objectLockRetryMs,
      result,
    });
    processed += 1;
  }
  return result;
}
