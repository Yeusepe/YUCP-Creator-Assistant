import type { Catalog, CatalogDatabase, PackageVersion, ReconcileCatalogOptions } from '../catalog';
import {
  createConvexCatalogPublish,
  loadConvexCatalogPublishConfig,
  reconcileCatalog,
} from '../catalog';
import { migrateLegacyReadyVersion, promoteVersion } from '../ingest-pipeline';
import type { CasStore } from '../storage-core/desyncCas';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';

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
  commonStore: CasStore;
  metadataStore: CasStore;
  protectedStore: CasStore;
  resolveCreatorId: (version: PackageVersion) => Promise<string>;
  scratchRoot: string;
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
    commonStore,
    database,
    intervalMs,
    metadataStore,
    onError,
    publish = createConvexCatalogPublish(loadConvexCatalogPublishConfig()),
    protectedStore,
    resolveCreatorId,
    scratchRoot,
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

    let candidates: { id: string; release_schema_version: 3 | 4; state: 'ASSEMBLED' | 'READY' }[];
    try {
      candidates = await database<
        { id: string; release_schema_version: 3 | 4; state: 'ASSEMBLED' | 'READY' }[]
      >`
        SELECT id, release_schema_version, state
        FROM package_versions
        WHERE state = 'ASSEMBLED'
          OR (state = 'READY' AND release_schema_version = 3)
        ORDER BY
          CASE WHEN state = 'READY' AND release_schema_version = 3 THEN 0 ELSE 1 END,
          updated_at,
          id
        LIMIT ${batchLimit}
      `;
    } catch (error) {
      await reportError(error);
      return;
    }

    for (const candidate of candidates) {
      try {
        if (candidate.state === 'READY' && candidate.release_schema_version === 3) {
          const version = await catalog.getVersion(candidate.id);
          if (!version) {
            throw new Error(`Legacy package version ${candidate.id} no longer exists`);
          }
          const creatorId = (await resolveCreatorId(version)).trim();
          if (!creatorId) {
            throw new Error(`Legacy package version ${candidate.id} has no creator identity`);
          }
          await migrateLegacyReadyVersion({
            catalog,
            commonStore,
            creatorId,
            metadataStore,
            protectedStore,
            protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
            scratchRoot,
            versionId: candidate.id,
          });
          continue;
        }
        await promoteVersion({
          catalog,
          commonStore,
          metadataStore,
          protectedStore,
          scratchRoot,
          versionId: candidate.id,
        });
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
