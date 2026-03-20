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
    // @ts-expect-error - override global fetch for test
    globalThis.fetch = fetchMock as any;

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
});
