// The active CDC profile caps chunks at 1 MiB. Four operations reserve 4 MiB of payload memory.
// Four also leaves six connections in the default PostgreSQL pool for leases and maintenance work.
export const LOGICAL_FILE_CHUNK_IO_CONCURRENCY = 4;
export const LOGICAL_FILE_CHUNK_MAX_BYTES = 1024 * 1024;
export const LOGICAL_FILE_CHUNK_IO_MAX_PAYLOAD_BYTES =
  LOGICAL_FILE_CHUNK_IO_CONCURRENCY * LOGICAL_FILE_CHUNK_MAX_BYTES;

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
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  await forEachBoundedOrdered(values, operation, async (result) => {
    results.push(result);
  });
  return results;
}

export async function forEachBoundedOrdered<T, R>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<R>,
  commit: (result: R, index: number) => Promise<void>
): Promise<void> {
  const active = new Map<number, Promise<OperationResult<R>>>();
  const failures = new Map<number, unknown>();
  let nextToStart = 0;
  const fill = () => {
    while (active.size < LOGICAL_FILE_CHUNK_IO_CONCURRENCY && nextToStart < values.length) {
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
