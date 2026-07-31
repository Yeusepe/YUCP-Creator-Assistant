import type { ProtectedPackageFile } from '../catalog';
import { mapBoundedOrdered } from '../storage-core/boundedOrderedBatch';
import {
  type CouplingLane,
  PNG_HEADER_BYTES,
  readPngCouplingMetadata,
  resolveCouplingLane,
} from '../storage-core/couplingLane';
import type { DeliveryManifest } from '../storage-core/deliveryManifest';

/**
 * `couplingLane` was added to the delivery manifest after packages were already
 * in the catalog, and `partitionCouplingLanes` reads an absent lane as
 * `container`. Every version published before it therefore materializes on a
 * container forever, even when every file it holds is worker-eligible. This
 * recomputes the lane from data already stored, so those versions can be
 * re-stamped without re-ingesting the artifact.
 */

export type BackfillManifestFile = {
  bytes: number;
  chunks: DeliveryManifest['files'][number]['chunks'];
  normalizedPath: string;
  sha256: string;
};

export type CouplingLaneBackfillInput = {
  concurrency?: number;
  manifestFiles: readonly BackfillManifestFile[];
  protectedFiles: readonly ProtectedPackageFile[];
  /** Reads at least PNG_HEADER_BYTES from the head of a stored file. */
  readHeader: (file: BackfillManifestFile) => Promise<Uint8Array>;
};

export type CouplingLaneBackfillResult = {
  changed: boolean;
  lanes: Record<CouplingLane, number>;
  protectedFiles: ProtectedPackageFile[];
};

const DEFAULT_CONCURRENCY = 16;

function laneOf(file: ProtectedPackageFile): CouplingLane | undefined {
  const lane = (file as { couplingLane?: unknown }).couplingLane;
  return lane === 'worker' || lane === 'container' ? lane : undefined;
}

export async function backfillCouplingLanes(
  input: CouplingLaneBackfillInput
): Promise<CouplingLaneBackfillResult> {
  const manifestByPath = new Map(input.manifestFiles.map((file) => [file.normalizedPath, file]));

  const resolved = await mapBoundedOrdered(
    input.protectedFiles,
    async (file): Promise<ProtectedPackageFile> => {
      const existing = laneOf(file);
      if (existing) {
        return file;
      }
      const manifestFile = manifestByPath.get(file.normalizedPath);
      if (!manifestFile) {
        // Nothing to recompute from: leaving the lane absent keeps the existing
        // container routing, which is correct but slow, rather than guessing.
        return file;
      }
      if (file.materializerType !== 'png') {
        return {
          ...file,
          couplingLane: resolveCouplingLane({
            bytes: manifestFile.bytes,
            materializerType: file.materializerType,
          }),
        };
      }
      let metadata: ReturnType<typeof readPngCouplingMetadata> = null;
      try {
        const header = await input.readHeader(manifestFile);
        metadata = readPngCouplingMetadata(header.subarray(0, PNG_HEADER_BYTES));
      } catch {
        metadata = null;
      }
      if (!metadata) {
        // An unreadable header cannot be proven worker-safe, so it stays on the
        // container lane instead of risking a lane violation at materialization.
        return { ...file, couplingLane: 'container' satisfies CouplingLane };
      }
      return {
        ...file,
        couplingLane: resolveCouplingLane({
          bytes: manifestFile.bytes,
          materializerType: 'png',
          pngHeight: metadata.height,
          pngStreamingSupported: metadata.streamingSupported,
          pngWidth: metadata.width,
        }),
      };
    },
    input.concurrency ?? DEFAULT_CONCURRENCY
  );

  const lanes: Record<CouplingLane, number> = { container: 0, worker: 0 };
  let changed = false;
  for (const [index, file] of resolved.entries()) {
    const lane = laneOf(file);
    if (lane) {
      lanes[lane] += 1;
    }
    if (lane !== laneOf(input.protectedFiles[index] as ProtectedPackageFile)) {
      changed = true;
    }
  }
  return { changed, lanes, protectedFiles: resolved };
}

/**
 * True when a version can skip container allocation entirely, matching the
 * dispatch predicate in materializationDispatch so the two cannot drift.
 */
export function isPureWorkerLane(protectedFiles: readonly ProtectedPackageFile[]): boolean {
  return protectedFiles.length > 0 && protectedFiles.every((file) => laneOf(file) === 'worker');
}
