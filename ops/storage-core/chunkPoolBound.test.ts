// Cost-blowout bound: no matter how many ingest workloads run at once, chunk
// bodies in flight against the storage provider never exceed the process-wide
// pool width. Two concurrent multi-file ingest-shaped workloads share the one
// global permit pool, so provider concurrency (and payload memory) stays at
// LOGICAL_FILE_CHUNK_IO_CONCURRENCY, not workloads x files x chunks.
import { describe, expect, test } from 'bun:test';
import {
  LOGICAL_FILE_CHUNK_IO_CONCURRENCY,
  LOGICAL_FILE_INGEST_CONCURRENCY,
  mapBoundedOrdered,
  withChunkIoPermit,
} from './boundedOrderedBatch';

// Fake storage port that gauges concurrent chunk puts across every caller.
class GaugedStoragePort {
  active = 0;
  peak = 0;
  puts = 0;

  async putChunk(): Promise<void> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    this.puts += 1;
    // A real timer tick so transfers genuinely overlap across workloads.
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.active -= 1;
  }
}

describe('global chunk I/O pool bound', () => {
  test('two concurrent multi-file ingests never exceed the 32-wide pool and all complete', async () => {
    const storage = new GaugedStoragePort();
    const filesPerWorkload = 8;
    const chunksPerFile = 12;

    // Mirrors the ingest shape: files fan out at the ingest concurrency, and
    // every chunk transfer routes through the shared chunk I/O permit.
    const ingestWorkload = () =>
      mapBoundedOrdered(
        Array.from({ length: filesPerWorkload }, (_, file) => file),
        () =>
          mapBoundedOrdered(
            Array.from({ length: chunksPerFile }, (_, chunk) => chunk),
            () => withChunkIoPermit(() => storage.putChunk()),
            chunksPerFile
          ),
        LOGICAL_FILE_INGEST_CONCURRENCY
      );

    await Promise.all([ingestWorkload(), ingestWorkload()]);

    // No starvation: every chunk of both workloads completed.
    expect(storage.puts).toBe(2 * filesPerWorkload * chunksPerFile);
    // The candidate concurrency (2 workloads x 8 files x 12 chunks = 192) far
    // exceeds the pool, so the bound must both hold and actually saturate -
    // proving the permits, not the workload shape, are the limiter.
    expect(storage.peak).toBeLessThanOrEqual(LOGICAL_FILE_CHUNK_IO_CONCURRENCY);
    expect(storage.peak).toBe(LOGICAL_FILE_CHUNK_IO_CONCURRENCY);
    // The pool fully drains: a follow-up full-width burst acquires every permit.
    expect(storage.active).toBe(0);
    const drainCheck = new GaugedStoragePort();
    await Promise.all(
      Array.from({ length: LOGICAL_FILE_CHUNK_IO_CONCURRENCY }, () =>
        withChunkIoPermit(() => drainCheck.putChunk())
      )
    );
    expect(drainCheck.peak).toBe(LOGICAL_FILE_CHUNK_IO_CONCURRENCY);
  });
});
