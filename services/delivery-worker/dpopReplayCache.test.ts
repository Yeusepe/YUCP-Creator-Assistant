import { describe, expect, it } from 'bun:test';
import { BoundedDpopReplayCache } from './src/dpopReplayCache';

describe('bounded DPoP replay cache', () => {
  it('rejects live proof reuse and evicts the oldest entry at its memory bound', () => {
    const cache = new BoundedDpopReplayCache({ maxEntries: 2, sweepLimit: 1 });

    expect(cache.reserve({ expiresAtMs: 10_000, key: 'proof-a', nowMs: 1_000 })).toBe(true);
    expect(cache.reserve({ expiresAtMs: 10_000, key: 'proof-a', nowMs: 1_001 })).toBe(false);
    expect(cache.reserve({ expiresAtMs: 10_000, key: 'proof-b', nowMs: 1_002 })).toBe(true);
    expect(cache.reserve({ expiresAtMs: 10_000, key: 'proof-c', nowMs: 1_003 })).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.reserve({ expiresAtMs: 10_000, key: 'proof-a', nowMs: 1_004 })).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('removes an expired proof before accepting the identifier again', () => {
    const cache = new BoundedDpopReplayCache({ maxEntries: 2, sweepLimit: 2 });

    expect(cache.reserve({ expiresAtMs: 2_000, key: 'proof-a', nowMs: 1_000 })).toBe(true);
    expect(cache.reserve({ expiresAtMs: 3_000, key: 'proof-a', nowMs: 2_000 })).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('keeps replay observations local to one Worker isolate', () => {
    const firstIsolate = new BoundedDpopReplayCache({ maxEntries: 2, sweepLimit: 2 });
    const secondIsolate = new BoundedDpopReplayCache({ maxEntries: 2, sweepLimit: 2 });
    const proof = { expiresAtMs: 10_000, key: 'proof-a', nowMs: 1_000 };

    expect(firstIsolate.reserve(proof)).toBe(true);
    expect(firstIsolate.reserve(proof)).toBe(false);
    expect(secondIsolate.reserve(proof)).toBe(true);
  });
});
