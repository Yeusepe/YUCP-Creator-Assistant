import { describe, expect, it, mock } from 'bun:test';
import type { StorageGcCatalog, StorageGcDeletion } from '../catalog/storageGcCatalog';
import { ExactVersionDeletionBlockedError } from '../storage-core/exactVersionDeletion';
import { runExactVersionGarbageCollection } from './exactVersionGc';

describe('exact-version garbage collection', () => {
  it('deletes through a delete-only provider port without reading object retention', async () => {
    const now = new Date('2026-07-28T00:00:00.000Z');
    const deletion = {
      bucketName: 'yucp-common-prod',
      bytes: 42,
      fileIdentifier: 'file-id-1',
      generationId: 7,
      journalId: 'journal-1',
      objectKey: 'v2/common/chunks/aa/digest',
      objectVersionId: 'object-version-1',
      providerVersion: 'provider-version-1',
      storageRole: 'common',
    } satisfies StorageGcDeletion;
    const deleteExactVersion = mock(
      async (input: {
        fileIdentifier: string;
        objectKey: string;
        providerVersion: string;
        role: string;
      }) => {
        expect(input).toEqual({
          fileIdentifier: deletion.fileIdentifier,
          objectKey: deletion.objectKey,
          providerVersion: deletion.providerVersion,
          role: deletion.storageRole,
        });
      }
    );
    const failDeletion = mock(async () => undefined);
    const catalog = {
      async claimDeletionCandidate() {
        return null;
      },
      failDeletion,
      async listPendingDeletions() {
        return [deletion];
      },
      async observeGeneration() {
        return {
          candidatesObserved: 0,
          generation: {
            completedAt: now,
            id: deletion.generationId,
            previousCompletedGenerationId: deletion.generationId - 1,
            startedAt: now,
          },
        };
      },
      async withPendingDeletionFence(input: { handoff: () => Promise<unknown> }) {
        return {
          deletionAllowed: true as const,
          value: await input.handoff(),
        };
      },
    } as unknown as StorageGcCatalog;

    const result = await runExactVersionGarbageCollection({
      catalog,
      deletionStorage: { deleteExactVersion },
      now,
    });

    expect(result).toMatchObject({
      deletedBytes: deletion.bytes,
      deletedObjects: 1,
      failedObjects: 0,
      recoveredDeletions: 1,
    });
    expect(deleteExactVersion).toHaveBeenCalledTimes(1);
    expect(failDeletion).not.toHaveBeenCalled();
  });

  it('defers an Object Lock denial without failing the deletion journal', async () => {
    const now = new Date('2026-07-28T00:00:00.000Z');
    const deletion = {
      bucketName: 'yucp-protected-prod',
      bytes: 84,
      fileIdentifier: 'file-id-locked',
      generationId: 8,
      journalId: 'journal-locked',
      objectKey: 'v2/protected/creator/chunks/bb/digest',
      objectVersionId: 'object-version-locked',
      providerVersion: 'provider-version-locked',
      storageRole: 'protected',
    } satisfies StorageGcDeletion;
    const handoffs: unknown[] = [];
    const failDeletion = mock(async () => undefined);
    const catalog = {
      async claimDeletionCandidate() {
        return null;
      },
      failDeletion,
      async listPendingDeletions() {
        return [deletion];
      },
      async observeGeneration() {
        return {
          candidatesObserved: 0,
          generation: {
            completedAt: now,
            id: deletion.generationId,
            previousCompletedGenerationId: deletion.generationId - 1,
            startedAt: now,
          },
        };
      },
      async withPendingDeletionFence(input: { handoff: () => Promise<unknown> }) {
        const value = await input.handoff();
        handoffs.push(value);
        return { deletionAllowed: true as const, value };
      },
    } as unknown as StorageGcCatalog;

    const result = await runExactVersionGarbageCollection({
      catalog,
      deletionStorage: {
        async deleteExactVersion() {
          throw new ExactVersionDeletionBlockedError();
        },
      },
      now,
      objectLockRetryMs: 60_000,
    });

    expect(handoffs).toEqual([
      {
        retainUntil: new Date(now.getTime() + 60_000),
        state: 'RETENTION_BLOCKED',
      },
    ]);
    expect(result).toMatchObject({
      failedObjects: 0,
      retentionBlockedBytes: deletion.bytes,
      retentionBlockedObjects: 1,
    });
    expect(failDeletion).not.toHaveBeenCalled();
  });
});
