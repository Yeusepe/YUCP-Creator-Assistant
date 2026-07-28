import { describe, expect, mock, test } from 'bun:test';
import type { Catalog, StorageGcCatalog } from '../catalog';
import type { ExactStoragePort } from '../storage-core/exactStorage';
import {
  createStorageGcJanitor,
  loadStorageGcRuntimeEnv,
  STORAGE_GC_INFISICAL_KEYS,
} from './server';

function storageRoleSecrets(): Record<string, string> {
  return Object.fromEntries(
    ['COMMON', 'METADATA', 'PROTECTED', 'QUARANTINE'].flatMap((prefix) => [
      [`${prefix}_S3_ENDPOINT`, 'http://127.0.0.1:9000'],
      [`${prefix}_S3_REGION`, 'us-east-1'],
      [`${prefix}_S3_BUCKET`, `local-${prefix.toLowerCase()}`],
      [`${prefix}_S3_ACCESS_KEY_ID`, `${prefix.toLowerCase()}-key`],
      [`${prefix}_S3_SECRET_ACCESS_KEY`, `${prefix.toLowerCase()}-secret`],
    ])
  );
}

function idleCatalog(
  observeGeneration: () => Promise<{
    candidatesObserved: number;
    generation: {
      completedAt: Date;
      id: number;
      previousCompletedGenerationId: number | null;
      startedAt: Date;
    };
  }>,
  listPendingDeletions = mock(async (_limit: number) => [])
): StorageGcCatalog {
  return {
    claimDeletionCandidate: mock(async () => null),
    listPendingDeletions,
    observeGeneration,
  } as unknown as StorageGcCatalog;
}

function idleLifecycleCatalog(): Pick<Catalog, 'expireTerminalFailedVersions'> {
  return {
    expireTerminalFailedVersions: mock(async () => []),
  };
}

const unusedStorage = {} as ExactStoragePort;

describe('storage GC production runtime', () => {
  test('loads fixed-capacity settings and exact storage roles through Infisical', async () => {
    const sourceEnv = {
      INFISICAL_PROJECT_ID: 'placeholder-project',
      INFISICAL_CLIENT_ID: 'placeholder-client',
      INFISICAL_CLIENT_SECRET: 'placeholder-secret',
      STORAGE_GC_DELETION_LIMIT: '37',
      STORAGE_GC_INTERVAL_MS: '45000',
    } satisfies NodeJS.ProcessEnv;
    const fetchSecrets = mock(async () => ({
      CATALOG_FAILED_RETENTION_MS: '604800000',
      CATALOG_MAX_ATTEMPTS: '7',
      CATALOG_DATABASE_URL: 'postgresql://postgres:secret@127.0.0.1:5432/catalog',
      ...storageRoleSecrets(),
    }));

    const runtime = await loadStorageGcRuntimeEnv(sourceEnv, fetchSecrets);

    expect(STORAGE_GC_INFISICAL_KEYS).toContain('CATALOG_DATABASE_URL');
    expect(STORAGE_GC_INFISICAL_KEYS).toContain('CATALOG_FAILED_RETENTION_MS');
    expect(STORAGE_GC_INFISICAL_KEYS).toContain('CATALOG_MAX_ATTEMPTS');
    expect(fetchSecrets).toHaveBeenCalledWith(sourceEnv);
    expect(runtime).toMatchObject({
      catalogMaxAttempts: 7,
      catalogDatabaseUrl: 'postgresql://postgres:secret@127.0.0.1:5432/catalog',
      common: { bucket: 'local-common' },
      deletionLimit: 37,
      failedRetentionMs: 604_800_000,
      intervalMs: 45_000,
      metadata: { bucket: 'local-metadata' },
      protected: { bucket: 'local-protected' },
    });
  });

  test('rejects a deletion batch above the collector safety bound', async () => {
    await expect(
      loadStorageGcRuntimeEnv({
        CATALOG_FAILED_RETENTION_MS: '604800000',
        CATALOG_MAX_ATTEMPTS: '5',
        CATALOG_DATABASE_URL: 'postgresql://postgres:secret@127.0.0.1:5432/catalog',
        STORAGE_GC_DELETION_LIMIT: '1001',
        YUCP_STORAGE_PROFILE: 'interactive',
        ...storageRoleSecrets(),
      })
    ).rejects.toThrow('STORAGE_GC_DELETION_LIMIT must be a positive safe integer at most 1000');
  });

  test('rejects an interval that can create unbounded database pressure', async () => {
    await expect(
      loadStorageGcRuntimeEnv({
        CATALOG_FAILED_RETENTION_MS: '604800000',
        CATALOG_MAX_ATTEMPTS: '5',
        CATALOG_DATABASE_URL: 'postgresql://postgres:secret@127.0.0.1:5432/catalog',
        STORAGE_GC_INTERVAL_MS: '999',
        YUCP_STORAGE_PROFILE: 'interactive',
        ...storageRoleSecrets(),
      })
    ).rejects.toThrow('STORAGE_GC_INTERVAL_MS must be between 1000 and 86400000 milliseconds');
  });

  test('passes the configured batch bound to PostgreSQL workflow truth', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const lifecycleCalls: string[] = [];
    const expireTerminalFailedVersions = mock(async () => {
      lifecycleCalls.push('expire');
      return [];
    });
    const listPendingDeletions = mock(async (_limit: number) => []);
    const janitor = createStorageGcJanitor({
      catalog: idleCatalog(async () => {
        lifecycleCalls.push('observe');
        return {
          candidatesObserved: 0,
          generation: {
            completedAt: now,
            id: 41,
            previousCompletedGenerationId: 40,
            startedAt: now,
          },
        };
      }, listPendingDeletions),
      deletionLimit: 23,
      failedRetentionMs: 604_800_000,
      intervalMs: 60_000,
      lifecycleCatalog: {
        expireTerminalFailedVersions,
      },
      logger: { error: mock(() => undefined), info: mock(() => undefined) },
      storage: unusedStorage,
    });

    const result = await janitor.runOnce(now);

    expect(expireTerminalFailedVersions).toHaveBeenCalledWith({
      limit: 23,
      now,
      retentionMs: 604_800_000,
    });
    expect(lifecycleCalls).toEqual(['expire', 'observe']);
    expect(listPendingDeletions).toHaveBeenCalledWith(23);
    expect(result.generationId).toBe(41);
  });

  test('uses the PostgreSQL observation time when no explicit test clock is supplied', async () => {
    const databaseNow = new Date('2026-07-27T12:00:00.000Z');
    const observeGeneration = mock(async (_now?: Date) => ({
      candidatesObserved: 0,
      generation: {
        completedAt: databaseNow,
        id: 45,
        previousCompletedGenerationId: 44,
        startedAt: databaseNow,
      },
    }));
    const claimDeletionCandidate = mock(
      async (_input: { generationId: number; now?: Date }) => null
    );
    const janitor = createStorageGcJanitor({
      catalog: {
        claimDeletionCandidate,
        listPendingDeletions: mock(async () => []),
        observeGeneration,
      } as unknown as StorageGcCatalog,
      deletionLimit: 23,
      failedRetentionMs: 604_800_000,
      intervalMs: 60_000,
      lifecycleCatalog: idleLifecycleCatalog(),
      logger: { error: mock(() => undefined), info: mock(() => undefined) },
      storage: unusedStorage,
    });

    await janitor.runOnce();

    expect(observeGeneration).toHaveBeenCalledWith(undefined);
    expect(claimDeletionCandidate).toHaveBeenCalledWith({
      generationId: 45,
      now: databaseNow,
    });
  });

  test('runs no overlapping batches and finishes the active batch during shutdown', async () => {
    const batchStarted = Promise.withResolvers<void>();
    const releaseBatch = Promise.withResolvers<void>();
    const observeGeneration = mock(async () => {
      batchStarted.resolve();
      await releaseBatch.promise;
      const now = new Date();
      return {
        candidatesObserved: 0,
        generation: {
          completedAt: now,
          id: 52,
          previousCompletedGenerationId: 51,
          startedAt: now,
        },
      };
    });
    const janitor = createStorageGcJanitor({
      catalog: idleCatalog(observeGeneration),
      deletionLimit: 10,
      failedRetentionMs: 604_800_000,
      intervalMs: 1,
      lifecycleCatalog: idleLifecycleCatalog(),
      logger: { error: mock(() => undefined), info: mock(() => undefined) },
      storage: unusedStorage,
    });

    janitor.start();
    janitor.start();
    await batchStarted.promise;
    let stopped = false;
    const stopping = janitor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBeFalse();
    expect(observeGeneration).toHaveBeenCalledTimes(1);

    releaseBatch.resolve();
    await stopping;
    expect(observeGeneration).toHaveBeenCalledTimes(1);
  });
});
