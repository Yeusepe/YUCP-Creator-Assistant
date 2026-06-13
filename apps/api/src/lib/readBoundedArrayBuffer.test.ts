import { describe, expect, it } from 'bun:test';
import { readBoundedArrayBuffer } from './readBoundedArrayBuffer';

describe('readBoundedArrayBuffer', () => {
  it('copies streamed chunks before reading the next chunk', async () => {
    const bytes = new TextEncoder().encode('icon-bytes');
    const streamedChunk = bytes.slice();
    let readCount = 0;

    const body = {
      getReader: () => ({
        cancel: async () => undefined,
        read: async () => {
          readCount += 1;
          if (readCount === 1) {
            return { done: false as const, value: streamedChunk };
          }
          streamedChunk.fill('x'.charCodeAt(0));
          return { done: true as const, value: undefined };
        },
        releaseLock: () => undefined,
      }),
    } as unknown as ReadableStream<Uint8Array>;

    const buffer = await readBoundedArrayBuffer(
      {
        arrayBuffer: async () => {
          throw new Error('streaming source should use the body reader');
        },
        body,
        headers: new Headers({ 'content-length': String(bytes.byteLength) }),
      },
      1024
    );

    expect(readCount).toBe(2);
    expect(new Uint8Array(buffer)).toEqual(bytes);
  });
});
