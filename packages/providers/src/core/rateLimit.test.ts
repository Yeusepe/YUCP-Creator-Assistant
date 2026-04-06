import { describe, expect, it } from 'bun:test';
import {
  detectProviderRateLimitError,
  ProviderRateLimitError,
  parseRetryAfterMs,
  withProviderRateLimitRetries,
} from './rateLimit';

describe('rate limit helpers', () => {
  it('parses Retry-After seconds into milliseconds', () => {
    expect(parseRetryAfterMs('12', 5_000)).toBe(12_000);
    expect(parseRetryAfterMs('invalid', 5_000)).toBe(5_000);
    expect(parseRetryAfterMs(null, 5_000)).toBe(5_000);
  });

  it('retries retryable provider operations until they succeed', async () => {
    let attempts = 0;
    const waits: number[] = [];

    const result = await withProviderRateLimitRetries({
      providerName: 'TestProvider',
      operation: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ProviderRateLimitError('TestProvider', 250);
        }
        return 'ok';
      },
      getRateLimitError: (error) => (error instanceof ProviderRateLimitError ? error : null),
      sleep: async (waitMs) => {
        waits.push(waitMs);
      },
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 250]);
  });

  it('detects message-based 429 errors', () => {
    const detected = detectProviderRateLimitError(new Error('429 too many requests'), {
      providerName: 'Jinxxy',
      fallbackWaitMs: 60_000,
    });

    expect(detected).toBeInstanceOf(ProviderRateLimitError);
    expect(detected?.providerName).toBe('Jinxxy');
    expect(detected?.waitMs).toBe(60_000);
  });
});
