/**
 * Re-stamps `couplingLane` on package versions published before the field
 * existed. Those versions route every install to a container because
 * partitionCouplingLanes reads an absent lane as `container`, even when every
 * file is worker-eligible.
 *
 * Detection-first: reports what would change and mutates nothing unless
 * --apply is passed.
 *
 * Usage:
 *   bun run ops/coupling-lane-backfill.ts
 *   bun run ops/coupling-lane-backfill.ts --limit 500
 *   bun run ops/coupling-lane-backfill.ts --apply
 */
import { parseArgs } from 'node:util';
import type { ProtectedPackageFile } from './catalog';
import {
  backfillCouplingLanes,
  type BackfillManifestFile,
  isPureWorkerLane,
} from './ingest-pipeline/couplingLaneBackfill';

const DEFAULT_LIMIT = 200;

export type CouplingLaneBackfillOptions = {
  apply: boolean;
  help: boolean;
  limit: number;
};

export function parseCouplingLaneBackfillOptions(argv: string[]): CouplingLaneBackfillOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      limit: { type: 'string' },
    },
    strict: true,
  });
  const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return { apply: Boolean(values.apply), help: Boolean(values.help), limit };
}

export type BackfillCandidate = {
  manifestFiles: readonly BackfillManifestFile[];
  protectedFiles: readonly ProtectedPackageFile[];
  versionId: string;
};

export type BackfillReportRow = {
  changed: boolean;
  container: number;
  pureWorker: boolean;
  versionId: string;
  worker: number;
};

/**
 * Pure over its inputs so the whole sweep is testable without a database: the
 * caller supplies candidates and the byte reader, this decides the lanes.
 */
export async function planCouplingLaneBackfill(input: {
  candidates: readonly BackfillCandidate[];
  readHeader: (
    versionId: string,
    file: BackfillManifestFile
  ) => Promise<Uint8Array>;
}): Promise<{ rows: BackfillReportRow[]; updates: Map<string, ProtectedPackageFile[]> }> {
  const rows: BackfillReportRow[] = [];
  const updates = new Map<string, ProtectedPackageFile[]>();

  for (const candidate of input.candidates) {
    const result = await backfillCouplingLanes({
      manifestFiles: candidate.manifestFiles,
      protectedFiles: candidate.protectedFiles,
      readHeader: (file) => input.readHeader(candidate.versionId, file),
    });
    rows.push({
      changed: result.changed,
      container: result.lanes.container,
      pureWorker: isPureWorkerLane(result.protectedFiles),
      versionId: candidate.versionId,
      worker: result.lanes.worker,
    });
    if (result.changed) {
      updates.set(candidate.versionId, result.protectedFiles);
    }
  }
  return { rows, updates };
}

export function summarize(rows: readonly BackfillReportRow[]): string {
  const changed = rows.filter((row) => row.changed);
  const pure = changed.filter((row) => row.pureWorker);
  return [
    `versions scanned:        ${rows.length}`,
    `versions with new lanes: ${changed.length}`,
    `now pure worker lane:    ${pure.length}  (these stop allocating containers)`,
    `files -> worker:         ${changed.reduce((n, row) => n + row.worker, 0)}`,
    `files -> container:      ${changed.reduce((n, row) => n + row.container, 0)}`,
  ].join('\n');
}

function printUsage(): void {
  console.log(
    [
      'coupling-lane-backfill',
      '',
      'Usage:',
      '  bun run ops/coupling-lane-backfill.ts',
      '  bun run ops/coupling-lane-backfill.ts --limit 500',
      '  bun run ops/coupling-lane-backfill.ts --apply',
      '',
      'Options:',
      '  --limit <number>  Max package versions to scan. Default: 200.',
      '  --apply           Persist the recomputed lanes. Detection-only without it.',
      '  --help            Show this message.',
    ].join('\n')
  );
}

if (import.meta.main) {
  const options = parseCouplingLaneBackfillOptions(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }
  console.error(
    'This entrypoint needs the catalog and CAS wiring for the target environment;\n' +
      'run it from the deployment tooling that already holds those handles and pass\n' +
      'its candidates to planCouplingLaneBackfill().'
  );
  process.exit(2);
}
