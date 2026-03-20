import { describe, expect, it, mock } from 'bun:test';
import { startHeartbeat } from '../src/services/heartbeat';

describe('heartbeat service', () => {
  it('is disabled when no URL is provided', () => {
    const stop = startHeartbeat(undefined, 0.001);
    expect(stop).toBeUndefined();
  });

  it('sends pings and can be stopped', async () => {
    const calls: unknown[] = [];
    const fetchMock = mock(async (input: unknown, init?: unknown) => {
      calls.push({ input, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return 'ok';
        },
      } as unknown as Response;
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const stop = startHeartbeat('https://example.test/heartbeat', 0.001); // ~60ms interval

    // Wait enough time for at least one scheduled ping (immediate + interval)
    await new Promise((r) => setTimeout(r, 300));

    try {
      expect(calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      stop?.();
      globalThis.fetch = origFetch;
    }
  });

  it('stops concurrent heartbeats independently', async () => {
    const calls: unknown[] = [];
    const fetchMock = mock(async (input: unknown, init?: unknown) => {
      calls.push({ input, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return 'ok';
        },
      } as unknown as Response;
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const stopFirst = startHeartbeat('https://example.test/heartbeat-a', 0.017);
    const stopSecond = startHeartbeat('https://example.test/heartbeat-b', 0.017);

    try {
      await new Promise((r) => setTimeout(r, 1_150));

      stopFirst?.();
      stopSecond?.();

      await new Promise((r) => setTimeout(r, 150));
      const stoppedCount = calls.length;

      await new Promise((r) => setTimeout(r, 1_150));
      expect(calls.length).toBe(stoppedCount);
    } finally {
      stopFirst?.();
      stopSecond?.();
      globalThis.fetch = origFetch;
    }
  });
});
