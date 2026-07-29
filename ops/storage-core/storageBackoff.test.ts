import { describe, expect, it } from 'bun:test';
import { fetchWithSlowDownBackoff } from './storageBackoff';

const FAST_DELAYS = [2, 2, 2];

describe('fetchWithSlowDownBackoff', () => {
  it('returns a successful response without retrying', async () => {
    let attempts = 0;
    const response = await fetchWithSlowDownBackoff(async () => {
      attempts += 1;
      return new Response('ok');
    }, FAST_DELAYS);

    expect(response.status).toBe(200);
    expect(attempts).toBe(1);
  });

  it('retries 503 SlowDown until storage recovers', async () => {
    let attempts = 0;
    const response = await fetchWithSlowDownBackoff(async () => {
      attempts += 1;
      return attempts < 3 ? new Response('slow down', { status: 503 }) : new Response('ok');
    }, FAST_DELAYS);

    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it('retries 429 and honors a small Retry-After header', async () => {
    let attempts = 0;
    const response = await fetchWithSlowDownBackoff(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('slow down', { headers: { 'retry-after': '0' }, status: 429 })
        : new Response('ok');
    }, FAST_DELAYS);

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it('waits a real backoff delay when Retry-After is absent', async () => {
    let attempts = 0;
    const startedAt = Date.now();
    const response = await fetchWithSlowDownBackoff(async () => {
      attempts += 1;
      return attempts === 1 ? new Response('slow down', { status: 503 }) : new Response('ok');
    }, [80]);

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    // Equal jitter guarantees at least half the scheduled delay.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it('retries thrown network failures before giving up', async () => {
    let attempts = 0;
    const response = await fetchWithSlowDownBackoff(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('connection reset');
      }
      return new Response('ok');
    }, FAST_DELAYS);

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it('rethrows a persistent network failure after the schedule is exhausted', async () => {
    let attempts = 0;
    await expect(
      fetchWithSlowDownBackoff(async () => {
        attempts += 1;
        throw new TypeError('connection reset');
      }, FAST_DELAYS)
    ).rejects.toBeInstanceOf(TypeError);
    expect(attempts).toBe(4);
  });

  it('gives up after exhausting the retry schedule', async () => {
    let attempts = 0;
    const response = await fetchWithSlowDownBackoff(async () => {
      attempts += 1;
      return new Response('slow down', { status: 503 });
    }, FAST_DELAYS);

    expect(response.status).toBe(503);
    expect(attempts).toBe(4);
  });

  it('does not retry non-rate-limit failures', async () => {
    let attempts = 0;
    const response = await fetchWithSlowDownBackoff(async () => {
      attempts += 1;
      return new Response('missing', { status: 404 });
    }, FAST_DELAYS);

    expect(response.status).toBe(404);
    expect(attempts).toBe(1);
  });
});
