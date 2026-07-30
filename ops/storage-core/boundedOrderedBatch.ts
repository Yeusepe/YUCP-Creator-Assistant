// The active CDC profile caps chunks at 1 MiB. The chunk I/O pool is process-wide: at most
// 32 chunk bodies are in flight at once (32 MiB) no matter how many files are being
// processed concurrently. Chunk transfers no longer hold PostgreSQL connections because
// catalog writes are batched per file, so the pool width is sized for provider throughput
// rather than the database pool.
export const LOGICAL_FILE_CHUNK_IO_CONCURRENCY = 32;
export const LOGICAL_FILE_CHUNK_MAX_BYTES = 1024 * 1024;
export const LOGICAL_FILE_CHUNK_IO_MAX_PAYLOAD_BYTES =
  LOGICAL_FILE_CHUNK_IO_CONCURRENCY * LOGICAL_FILE_CHUNK_MAX_BYTES;
// Files are ingested concurrently, but every chunk transfer still routes through the one
// shared chunk I/O pool above, so file concurrency adds no payload memory.
export const LOGICAL_FILE_INGEST_CONCURRENCY = 8;

let activeChunkIoPermits = 0;
const chunkIoWaiters: Array<() => void> = [];

/**
 * Runs one chunk-sized transfer inside the process-wide chunk I/O pool. A permit is held
 * for the lifetime of a single chunk body (read + write), which bounds in-flight payload
 * memory to LOGICAL_FILE_CHUNK_IO_MAX_PAYLOAD_BYTES across every concurrent file.
 *
 * Non-reentrant: never acquire a permit while already holding one.
 */
export async function withChunkIoPermit<T>(operation: () => Promise<T>): Promise<T> {
  if (activeChunkIoPermits < LOGICAL_FILE_CHUNK_IO_CONCURRENCY) {
    activeChunkIoPermits += 1;
  } else {
    await new Promise<void>((resolve) => chunkIoWaiters.push(resolve));
  }
  try {
    return await operation();
  } finally {
    const next = chunkIoWaiters.shift();
    if (next) {
      // The permit transfers directly to the next waiter; the active count is unchanged.
      next();
    } else {
      activeChunkIoPermits -= 1;
    }
  }
}

type OperationResult<R> =
  | { status: 'fulfilled'; value: R }
  | { reason: unknown; status: 'rejected' };

function startOperation<T, R>(
  values: readonly T[],
  index: number,
  operation: (value: T, index: number) => Promise<R>,
  failures: Map<number, unknown>
): Promise<OperationResult<R>> {
  return Promise.resolve()
    .then(() => operation(values[index] as T, index))
    .then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => {
        failures.set(index, reason);
        return { reason, status: 'rejected' as const };
      }
    );
}

async function waitForActive<R>(active: ReadonlyMap<number, Promise<OperationResult<R>>>) {
  await Promise.all(active.values());
}

function firstFailure(failures: ReadonlyMap<number, unknown>): unknown {
  return Array.from(failures).sort(([left], [right]) => left - right)[0]?.[1];
}

export async function mapBoundedOrdered<T, R>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<R>,
  concurrency: number = LOGICAL_FILE_CHUNK_IO_CONCURRENCY
): Promise<R[]> {
  const results: R[] = [];
  await forEachBoundedOrdered(
    values,
    operation,
    async (result) => {
      results.push(result);
    },
    concurrency
  );
  return results;
}

export async function forEachBoundedOrdered<T, R>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<R>,
  commit: (result: R, index: number) => Promise<void>,
  concurrency: number = LOGICAL_FILE_CHUNK_IO_CONCURRENCY
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Bounded ordered concurrency must be a positive integer');
  }
  const active = new Map<number, Promise<OperationResult<R>>>();
  const failures = new Map<number, unknown>();
  let nextToStart = 0;
  const fill = () => {
    while (active.size < concurrency && nextToStart < values.length) {
      active.set(nextToStart, startOperation(values, nextToStart, operation, failures));
      nextToStart += 1;
    }
  };
  fill();

  for (let index = 0; index < values.length; index += 1) {
    const current = active.get(index);
    if (!current) {
      throw new Error('Bounded ordered operation state is invalid');
    }
    const result = await current;
    active.delete(index);
    if (result.status === 'rejected' || failures.size > 0) {
      await waitForActive(active);
      throw firstFailure(failures);
    }
    try {
      await commit(result.value, index);
    } catch (error) {
      await waitForActive(active);
      throw error;
    }
    if (failures.size > 0) {
      await waitForActive(active);
      throw firstFailure(failures);
    }
    fill();
  }
}
