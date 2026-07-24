import { describe, expect, it } from 'bun:test';
import { Catalog, type CatalogState, withCatalogHeartbeat } from './catalog';
import { reconcileCatalog } from './reconciler';

type SqlTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<{ id: string }>>;

describe('catalog activity heartbeat', () => {
  it('keeps updated_at fresh while live work is still running', async () => {
    let heartbeatCount = 0;
    const sql = (async (strings: TemplateStringsArray) => {
      if (strings.join('?').includes('UPDATE package_versions')) {
        heartbeatCount += 1;
        return [{ id: 'version-live' }];
      }
      return [];
    }) as SqlTag;
    const catalog = new Catalog(sql as never);

    const result = await withCatalogHeartbeat({
      catalog,
      heartbeatIntervalMs: 5,
      operation: async () => {
        await Bun.sleep(24);
        return 'completed';
      },
      state: 'UPLOADING',
      versionId: 'version-live',
    });

    expect(result).toBe('completed');
    expect(heartbeatCount).toBeGreaterThanOrEqual(2);
  });

  it('does not start work after the catalog row left the expected live state', async () => {
    let operationStarted = false;
    const sql = (async () => []) as SqlTag;
    const catalog = new Catalog(sql as never);

    await expect(
      withCatalogHeartbeat({
        catalog,
        heartbeatIntervalMs: 5,
        operation: async () => {
          operationStarted = true;
        },
        state: 'PROMOTING',
        versionId: 'version-no-longer-promoting',
      })
    ).rejects.toThrow('is not in PROMOTING');
    expect(operationStarted).toBe(false);
  });

  it('aborts before the next side effect and failure cleanup after losing ownership', async () => {
    const ownershipLost = Promise.withResolvers<void>();
    let heartbeatCount = 0;
    let sideEffectCount = 0;
    let casDeleteCount = 0;
    const sql = (async (strings: TemplateStringsArray) => {
      if (!strings.join('?').includes('UPDATE package_versions')) {
        return [];
      }
      heartbeatCount += 1;
      if (heartbeatCount === 1) {
        return [{ id: 'version-ownership-lost' }];
      }
      ownershipLost.resolve();
      return [];
    }) as SqlTag;
    const catalog = new Catalog(sql as never);

    let operationError: unknown;
    try {
      await withCatalogHeartbeat({
        catalog,
        heartbeatIntervalMs: 5,
        operation: async (signal) => {
          try {
            await ownershipLost.promise;
            if (!signal.aborted) {
              await Promise.race([
                new Promise<void>((resolve) =>
                  signal.addEventListener('abort', () => resolve(), { once: true })
                ),
                Bun.sleep(50),
              ]);
            }
            signal.throwIfAborted();
            sideEffectCount += 1;
            throw new Error('operation continued after ownership loss');
          } catch (error) {
            if (!signal.aborted) {
              casDeleteCount += 1;
            }
            throw error;
          }
        },
        state: 'UPLOADING',
        versionId: 'version-ownership-lost',
      });
    } catch (error) {
      operationError = error;
    }

    expect(operationError).toBeInstanceOf(Error);
    expect((operationError as Error).name).toBe('AbortError');
    expect(sideEffectCount).toBe(0);
    expect(casDeleteCount).toBe(0);
  });

  it('shows the wall-clock-only failure mode for live work without activity heartbeats', async () => {
    const database = createReconcilerDatabase([
      catalogRow('upload-live-without-heartbeat', 'UPLOADING', STALE_UPDATED_AT),
      catalogRow('promotion-live-without-heartbeat', 'PROMOTING', STALE_UPDATED_AT),
    ]);

    const redriven: string[] = [];
    await reconcileCatalog(database.sql as never, {
      batchLimit: 2,
      publish: async () => {},
      redrive: async ({ version }) => {
        redriven.push(version.id);
      },
      stuckThresholdMs: STUCK_THRESHOLD_MS,
    });

    expect(redriven).toEqual(['promotion-live-without-heartbeat', 'upload-live-without-heartbeat']);
    expect(database.states()).toEqual({
      'promotion-live-without-heartbeat': 'FAILED',
      'upload-live-without-heartbeat': 'FAILED',
    });
  });

  it('keeps heartbeating uploads and promotions live while reclaiming abandoned work', async () => {
    const database = createReconcilerDatabase([
      catalogRow('upload-active', 'UPLOADING', STALE_UPDATED_AT),
      catalogRow('promotion-active', 'PROMOTING', STALE_UPDATED_AT),
      catalogRow('upload-abandoned', 'UPLOADING', STALE_UPDATED_AT),
      catalogRow('promotion-abandoned', 'PROMOTING', STALE_UPDATED_AT),
    ]);
    const activeWork = Promise.withResolvers<void>();
    const uploading = withCatalogHeartbeat({
      catalog: database.catalog,
      heartbeatIntervalMs: 5,
      operation: () => activeWork.promise,
      state: 'UPLOADING',
      versionId: 'upload-active',
    });
    const promoting = withCatalogHeartbeat({
      catalog: database.catalog,
      heartbeatIntervalMs: 5,
      operation: () => activeWork.promise,
      state: 'PROMOTING',
      versionId: 'promotion-active',
    });
    const redriven: string[] = [];
    try {
      await database.waitForFreshHeartbeats(['upload-active', 'promotion-active']);
      await reconcileCatalog(database.sql as never, {
        batchLimit: 4,
        publish: async () => {},
        redrive: async ({ version }) => {
          redriven.push(version.id);
        },
        stuckThresholdMs: STUCK_THRESHOLD_MS,
      });
    } finally {
      activeWork.resolve();
      await Promise.allSettled([uploading, promoting]);
    }
    await Promise.all([uploading, promoting]);

    expect(redriven).toEqual(['promotion-abandoned', 'upload-abandoned']);
    expect(database.states()).toEqual({
      'promotion-abandoned': 'FAILED',
      'promotion-active': 'PROMOTING',
      'upload-abandoned': 'FAILED',
      'upload-active': 'UPLOADING',
    });
  });
});

const NOW = new Date('2026-07-18T12:00:00.000Z');
const STALE_UPDATED_AT = new Date(NOW.getTime() - 2 * 60_000);
const STUCK_THRESHOLD_MS = 60_000;

interface ReconcilerRow {
  attempts: number;
  release_root: string | null;
  assembly_object_id: string | null;
  catalog_product_id: string | null;
  created_at: Date;
  error: string | null;
  source_format: string | null;
  id: string;
  next_attempt_at: Date | null;
  package_id: string;
  state: CatalogState;
  updated_at: Date;
  version: string;
}

function catalogRow(id: string, state: CatalogState, updatedAt: Date): ReconcilerRow {
  return {
    attempts: 0,
    release_root: null,
    assembly_object_id: null,
    catalog_product_id: null,
    created_at: updatedAt,
    error: null,
    source_format: null,
    id,
    next_attempt_at: null,
    package_id: 'heartbeat-test-package',
    state,
    updated_at: updatedAt,
    version: '1.0.0',
  };
}

function createReconcilerDatabase(initialRows: ReconcilerRow[]) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  const isCandidate = (row: ReconcilerRow, thresholdMs: number) =>
    row.attempts < 5 &&
    (!row.next_attempt_at || row.next_attempt_at <= NOW) &&
    (row.state === 'FAILED' ||
      (['UPLOADING', 'ASSEMBLED', 'PROMOTING'].includes(row.state) &&
        row.updated_at.getTime() <= NOW.getTime() - thresholdMs));

  type TestSqlTag = {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    (values: readonly unknown[]): readonly unknown[];
    begin<T>(callback: (transaction: TestSqlTag) => Promise<T>): Promise<T>;
    json(value: unknown): unknown;
  };

  const sql = ((
    stringsOrValues: TemplateStringsArray | readonly unknown[],
    ...values: unknown[]
  ) => {
    if (!('raw' in stringsOrValues)) {
      return stringsOrValues;
    }
    const statement = stringsOrValues.join('?');

    if (
      statement.includes('SET updated_at = clock_timestamp()') &&
      !statement.includes('error =')
    ) {
      const row = rows.get(String(values[0]));
      if (!row || row.state !== values[1]) {
        return Promise.resolve([]);
      }
      row.updated_at = NOW;
      return Promise.resolve([{ id: row.id }]);
    }

    if (statement.includes('SELECT id') && statement.includes('FROM package_versions')) {
      const thresholdMs = Number(values.find((value) => value === STUCK_THRESHOLD_MS));
      return Promise.resolve(
        [...rows.values()]
          .filter((row) => isCandidate(row, thresholdMs))
          .sort((left, right) =>
            left.updated_at.getTime() === right.updated_at.getTime()
              ? left.id.localeCompare(right.id)
              : left.updated_at.getTime() - right.updated_at.getTime()
          )
          .map(({ id }) => ({ id }))
      );
    }

    if (statement.includes('SELECT *') && statement.includes('FROM package_versions')) {
      const row = rows.get(String(values[0]));
      const thresholdMs = Number(values.find((value) => value === STUCK_THRESHOLD_MS));
      return Promise.resolve(row && isCandidate(row, thresholdMs) ? [{ ...row }] : []);
    }

    if (statement.includes("state = 'FAILED'") && statement.includes('UPDATE package_versions')) {
      const row = rows.get(String(values.at(-1)));
      if (!row) {
        return Promise.resolve([]);
      }
      row.state = 'FAILED';
      row.error = String(values[0]);
      row.attempts = Number(values[1]);
      row.next_attempt_at = new Date(NOW.getTime() + Number(values[2]));
      row.updated_at = NOW;
      return Promise.resolve([{ ...row }]);
    }

    return Promise.resolve([]);
  }) as TestSqlTag;
  sql.begin = async <T>(callback: (transaction: TestSqlTag) => Promise<T>) => callback(sql);
  sql.json = (value: unknown) => value;

  return {
    catalog: new Catalog(sql as never),
    sql,
    states: () =>
      Object.fromEntries(
        [...rows.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((row) => [row.id, row.state])
      ),
    waitForFreshHeartbeats: async (versionIds: string[]) => {
      for (let attempts = 0; attempts < 20; attempts += 1) {
        if (versionIds.every((versionId) => rows.get(versionId)?.updated_at === NOW)) {
          return;
        }
        await Bun.sleep(1);
      }
      throw new Error('Timed out waiting for catalog activity heartbeats');
    },
  };
}
