import { describe, expect, it, mock } from 'bun:test';

mock.module('rate-limiter-flexible', () => ({
  RateLimiterMemory: class {},
  RateLimiterRedis: class {},
}));

const { buildPublicApiRateLimitKey, checkPublicApiRateLimit, InMemoryPublicApiRateLimitStore } =
  await import('./publicApiRateLimit');

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

  it('derives pre-auth public API key buckets from the public prefix and client fingerprint only', () => {
    const publicApiKey = `ypsk_01234567${'89abcdef'.repeat(5)}`;
    const collidingPrefixKey = `ypsk_01234567${'fedcba98'.repeat(5)}`;

    const key = buildPublicApiRateLimitKey({
      routeFamily: 'manual-licenses',
      clientAddress: '203.0.113.10',
      publicApiKey,
      userAgent: 'test-agent',
    });
    const collidingKey = buildPublicApiRateLimitKey({
      routeFamily: 'manual-licenses',
      clientAddress: '203.0.113.10',
      publicApiKey: collidingPrefixKey,
      userAgent: 'test-agent',
    });
    const differentClientKey = buildPublicApiRateLimitKey({
      routeFamily: 'manual-licenses',
      clientAddress: '203.0.113.11',
      publicApiKey,
      userAgent: 'test-agent',
    });

    expect(key).toStartWith('manual-licenses:auth:public-api-key:ypsk_01234567:');
    expect(collidingKey).toBe(key);
    expect(differentClientKey).not.toBe(key);
    expect(key).not.toContain(publicApiKey);
    expect(collidingKey).not.toContain(collidingPrefixKey);
    expect(key).not.toContain('203.0.113.10');
  });

  it('keeps client-controlled User-Agent changes in the same pre-auth bucket', () => {
    const publicApiKey = `ypsk_01234567${'89abcdef'.repeat(5)}`;
    const base = {
      routeFamily: 'manual-licenses',
      clientAddress: '203.0.113.10',
    };

    const anonymousKey = buildPublicApiRateLimitKey({
      ...base,
      userAgent: 'first-agent',
    });
    const anonymousRotatedAgentKey = buildPublicApiRateLimitKey({
      ...base,
      userAgent: 'second-agent',
    });
    const bearerKey = buildPublicApiRateLimitKey({
      ...base,
      bearerToken: 'oauth-token',
      userAgent: 'first-agent',
    });
    const bearerRotatedAgentKey = buildPublicApiRateLimitKey({
      ...base,
      bearerToken: 'oauth-token',
      userAgent: 'second-agent',
    });
    const publicApiKeyBucket = buildPublicApiRateLimitKey({
      ...base,
      publicApiKey,
      userAgent: 'first-agent',
    });
    const publicApiRotatedAgentKey = buildPublicApiRateLimitKey({
      ...base,
      publicApiKey,
      userAgent: 'second-agent',
    });

    expect(anonymousRotatedAgentKey).toBe(anonymousKey);
    expect(bearerRotatedAgentKey).toBe(bearerKey);
    expect(publicApiRotatedAgentKey).toBe(publicApiKeyBucket);
  });
});
