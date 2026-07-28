import { SpanKind, trace } from '@opentelemetry/api';
import { withObservedSpan } from '@yucp/shared/observability';
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
  onError: (error: unknown, context: IngestSchedulerErrorContext) => Promise<void> | void;
  onTickSucceeded?: () => Promise<void> | void;
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

export type IngestSchedulerErrorStage =
  | 'candidate-load'
  | 'catalog-reconcile'
  | 'health-signal'
  | 'legacy-migration'
  | 'promotion';

export interface IngestSchedulerErrorContext {
  stage: IngestSchedulerErrorStage;
  versionId?: string;
}

const MAX_SET_INTERVAL_DELAY_MS = 2_147_483_647;
const tracer = trace.getTracer('yucp-ingest-scheduler');

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
    onTickSucceeded,
    publish = createConvexCatalogPublish(loadConvexCatalogPublishConfig()),
    protectedStore,
    resolveCreatorId,
    scratchRoot,
    ...reconcileOptions
  } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  async function reportError(error: unknown, context: IngestSchedulerErrorContext): Promise<void> {
    try {
      await onError(error, context);
    } catch {
      // An error reporter must not turn a handled tick failure into an unhandled timer rejection.
    }
  }

  async function observeStage<T>(
    context: IngestSchedulerErrorContext,
    run: () => Promise<T>
  ): Promise<T> {
    return await withObservedSpan(
      tracer,
      `ingest_scheduler.${context.stage.replaceAll('-', '_')}`,
      {
        'catalog.version.id': context.versionId,
        'scheduler.stage': context.stage,
      },
      run
    );
  }

  async function executeTick(): Promise<boolean> {
    let succeeded = true;
    const reconcileContext = { stage: 'catalog-reconcile' } as const;
    try {
      await observeStage(reconcileContext, async () => {
        await reconcileCatalog(database, { ...reconcileOptions, batchLimit, publish });
      });
    } catch (error) {
      succeeded = false;
      await reportError(error, reconcileContext);
    }

    let candidates: { id: string; release_schema_version: 3 | 4; state: 'ASSEMBLED' | 'READY' }[];
    const candidateLoadContext = { stage: 'candidate-load' } as const;
    try {
      candidates = await observeStage(candidateLoadContext, async () => {
        return await database<
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
      });
    } catch (error) {
      await reportError(error, candidateLoadContext);
      return false;
    }

    for (const candidate of candidates) {
      const context: IngestSchedulerErrorContext = {
        stage:
          candidate.state === 'READY' && candidate.release_schema_version === 3
            ? 'legacy-migration'
            : 'promotion',
        versionId: candidate.id,
      };
      try {
        await observeStage(context, async () => {
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
            return;
          }
          await promoteVersion({
            catalog,
            commonStore,
            metadataStore,
            protectedStore,
            scratchRoot,
            versionId: candidate.id,
          });
        });
      } catch (error) {
        succeeded = false;
        await reportError(error, context);
      }
    }
    return succeeded;
  }

  async function runTick(): Promise<void> {
    const succeeded = await withObservedSpan(
      tracer,
      'ingest_scheduler.tick',
      { 'scheduler.batch.limit': batchLimit },
      executeTick,
      SpanKind.CONSUMER
    );
    if (!succeeded || !onTickSucceeded) {
      return;
    }
    try {
      await onTickSucceeded();
    } catch (error) {
      await reportError(error, { stage: 'health-signal' });
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
