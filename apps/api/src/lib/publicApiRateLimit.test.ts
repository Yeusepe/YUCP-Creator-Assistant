import { describe, expect, it } from 'bun:test';
import { checkPublicApiRateLimit, InMemoryPublicApiRateLimitStore } from './publicApiRateLimit';

describe('checkPublicApiRateLimit', () => {
  it('allows requests inside the configured budget and emits standard rate limit headers', async () => {
    const store = new InMemoryPublicApiRateLimitStore();
    const now = 1_000;

    const result = await checkPublicApiRateLimit({
      store,
      key: 'public:client:key_123',
      limit: 2,
      windowMs: 60_000,
      now,
    });

    expect(result.allowed).toBe(true);
    expect(result.headers['RateLimit-Limit']).toBe('2');
    expect(result.headers['RateLimit-Remaining']).toBe('1');
    expect(result.headers['RateLimit-Reset']).toBe('61');
  });

  it('blocks over-budget requests and includes retry guidance', async () => {
    const store = new InMemoryPublicApiRateLimitStore();
    const args = {
      store,
      key: 'public:ip:203.0.113.10',
      limit: 1,
      windowMs: 60_000,
      now: 1_000,
    };

    await checkPublicApiRateLimit(args);
    const blocked = await checkPublicApiRateLimit({ ...args, now: 2_000 });

    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['RateLimit-Remaining']).toBe('0');
    expect(blocked.headers['Retry-After']).toBe('59');
  });
});
