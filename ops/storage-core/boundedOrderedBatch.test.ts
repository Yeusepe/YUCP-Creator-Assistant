import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  forEachBoundedOrdered,
  LOGICAL_FILE_CHUNK_IO_CONCURRENCY,
  mapBoundedOrdered,
  withChunkIoPermit,
} from './boundedOrderedBatch';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('bounded ordered batch', () => {
  test('runs operations concurrently without exceeding the fixed chunk I/O bound', async () => {
    let active = 0;
    let maximumActive = 0;
    const values = Array.from(
      { length: LOGICAL_FILE_CHUNK_IO_CONCURRENCY + 8 },
      (_, index) => index
    );

    const results = await mapBoundedOrdered(values, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await delay(10);
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual(values.map((value) => value * 2));
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBe(LOGICAL_FILE_CHUNK_IO_CONCURRENCY);
  });

  test('commits out-of-order work in exact input order', async () => {
    const chunks = Array.from({ length: 10 }, (_, index) =>
      Uint8Array.from({ length: 1024 }, () => index)
    );
    const expected = createHash('sha256');
    for (const chunk of chunks) {
      expected.update(chunk);
    }
    const actual = createHash('sha256');
    const committed: number[] = [];

    await forEachBoundedOrdered(
      chunks,
      async (chunk, index) => {
        await delay((LOGICAL_FILE_CHUNK_IO_CONCURRENCY - (index % 4)) * 3);
        return chunk;
      },
      async (chunk, index) => {
        committed.push(index);
        actual.update(chunk);
      }
    );

    expect(committed).toEqual(chunks.map((_, index) => index));
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
  });

  test('waits for every in-flight operation and starts no new batch after failure', async () => {
    let active = 0;
    let started = 0;
    let settled = 0;

    await expect(
      mapBoundedOrdered(
        Array.from({ length: LOGICAL_FILE_CHUNK_IO_CONCURRENCY + 8 }, (_, index) => index),
        async (value) => {
          active += 1;
          started += 1;
          try {
            await delay(value === 1 ? 2 : 20);
            if (value === 1) {
              throw new Error('expected chunk failure');
            }
            return value;
          } finally {
            active -= 1;
            settled += 1;
          }
        }
      )
    ).rejects.toThrow('expected chunk failure');

    expect(started).toBe(LOGICAL_FILE_CHUNK_IO_CONCURRENCY);
    expect(settled).toBe(started);
    expect(active).toBe(0);
  });

  test('shares one process-wide chunk I/O pool across concurrent callers', async () => {
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      Array.from({ length: LOGICAL_FILE_CHUNK_IO_CONCURRENCY * 2 }, () =>
        withChunkIoPermit(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await delay(10);
          active -= 1;
        })
      )
    );

    expect(active).toBe(0);
    expect(maximumActive).toBe(LOGICAL_FILE_CHUNK_IO_CONCURRENCY);
  });

  test('releases a chunk I/O permit when its operation fails', async () => {
    await expect(
      withChunkIoPermit(async () => {
        throw new Error('expected permit failure');
      })
    ).rejects.toThrow('expected permit failure');

    let ran = false;
    await Promise.all(
      Array.from({ length: LOGICAL_FILE_CHUNK_IO_CONCURRENCY }, () =>
        withChunkIoPermit(async () => {
          ran = true;
        })
      )
    );
    expect(ran).toBeTrue();
  });
});
