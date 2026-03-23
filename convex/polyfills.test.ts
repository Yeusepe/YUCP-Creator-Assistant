import { describe, expect, it } from 'bun:test';
import { ensureConvexPolyfills } from './polyfills';

describe('ensureConvexPolyfills', () => {
  it('restores Buffer for runtimes that do not expose it globally', () => {
    const globalWithBuffer = globalThis as typeof globalThis & {
      Buffer?: typeof Buffer;
    };
    const originalBuffer = globalWithBuffer.Buffer;

    try {
      globalWithBuffer.Buffer = undefined;
      ensureConvexPolyfills();
      expect(globalWithBuffer.Buffer).toBeDefined();
    } finally {
      globalWithBuffer.Buffer = originalBuffer;
    }
  });
});
