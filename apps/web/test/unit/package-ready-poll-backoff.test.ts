import { describe, expect, it } from 'vitest';
import { packageReadyPollDelayMs } from '@/components/dashboard/PackageRegistryPanel';

describe('package preparation poll backoff', () => {
  it('grows the interval and settles on a ceiling', () => {
    const delays = Array.from({ length: 12 }, (_, attempt) =>
      packageReadyPollDelayMs(attempt, 0.5)
    );

    expect(delays[0]).toBe(500);
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    expect(delays.at(-1)).toBe(10_000);
    expect(Math.max(...delays)).toBe(10_000);
  });

  it('spreads concurrent watchers around the interval', () => {
    expect(packageReadyPollDelayMs(20, 0)).toBe(8_000);
    expect(packageReadyPollDelayMs(20, 1)).toBe(12_000);
  });

  it('covers a long preparation in far fewer requests than a fixed tick', () => {
    let elapsed = 0;
    let requests = 0;
    while (elapsed < 10 * 60 * 1000) {
      elapsed += packageReadyPollDelayMs(requests, 0.5);
      requests += 1;
    }

    expect(requests).toBeLessThan(80);
  });
});
