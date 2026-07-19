import type { Catalog, CatalogDatabase, ReconcileCatalogOptions } from '../catalog';
import {
  createConvexCatalogPublish,
  loadConvexCatalogPublishConfig,
  reconcileCatalog,
} from '../catalog';
import { promoteVersion } from '../ingest-pipeline';
import type { CasStore } from '../storage-core/desyncCas';

export type CreateIngestSchedulerOptions = Omit<
  ReconcileCatalogOptions,
  'batchLimit' | 'publish'
> & {
  batchLimit: number;
  catalog: Catalog;
  database: CatalogDatabase;
  intervalMs: number;
  onError: (error: unknown) => Promise<void> | void;
  publish?: ReconcileCatalogOptions['publish'];
  store: CasStore;
};

export interface IngestScheduler {
  start(): void;
  stop(): Promise<void>;
}

const MAX_SET_INTERVAL_DELAY_MS = 2_147_483_647;

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function createIngestScheduler(options: CreateIngestSchedulerOptions): IngestScheduler {
  requirePositiveSafeInteger(options.intervalMs, 'intervalMs');
  if (options.intervalMs > MAX_SET_INTERVAL_DELAY_MS) {
    throw new RangeError(`intervalMs must not exceed ${MAX_SET_INTERVAL_DELAY_MS}`);
  }
  requirePositiveSafeInteger(options.batchLimit, 'batchLimit');

  const {
    batchLimit,
    catalog,
    database,
    intervalMs,
    onError,
    publish = createConvexCatalogPublish(loadConvexCatalogPublishConfig()),
    store,
    ...reconcileOptions
  } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  async function reportError(error: unknown): Promise<void> {
    try {
      await onError(error);
    } catch {
      // An error reporter must not turn a handled tick failure into an unhandled timer rejection.
    }
  }

  async function runTick(): Promise<void> {
    try {
      await reconcileCatalog(database, { ...reconcileOptions, batchLimit, publish });
    } catch (error) {
      await reportError(error);
    }

    let candidates: { id: string }[];
    try {
      candidates = await database<{ id: string }[]>`
        SELECT id
        FROM package_versions
        WHERE state = 'ASSEMBLED'
        ORDER BY updated_at, id
        LIMIT ${batchLimit}
      `;
    } catch (error) {
      await reportError(error);
      return;
    }

    for (const candidate of candidates) {
      try {
        await promoteVersion({ catalog, store, versionId: candidate.id });
      } catch (error) {
        await reportError(error);
      }
    }
  }

  function beginTick(): void {
    if (inFlight) {
      return;
    }
    const tick = runTick();
    inFlight = tick;
    void tick.finally(() => {
      if (inFlight === tick) {
        inFlight = undefined;
      }
    });
  }

  return {
    start(): void {
      if (timer) {
        return;
      }
      if (stopping) {
        throw new Error('Cannot start the ingest scheduler while it is stopping');
      }
      // ponytail: A durable queue can replace this process-local timer when ownership moves out.
      timer = setInterval(beginTick, intervalMs);
      beginTick();
    },

    async stop(): Promise<void> {
      if (stopping) {
        await stopping;
        return;
      }
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }

      const activeTick = inFlight;
      const currentStop = (async () => {
        await activeTick;
      })();
      stopping = currentStop;
      try {
        await currentStop;
      } finally {
        if (stopping === currentStop) {
          stopping = undefined;
        }
      }
    },
  };
}
