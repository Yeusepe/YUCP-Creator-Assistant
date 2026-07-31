import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { handleBrowserTelemetry } from './browserTelemetry';
import { handleConvexTelemetry } from './convexTelemetry';

describe('browser operational telemetry', () => {
  it('rejects malformed payloads', async () => {
    const response = await handleBrowserTelemetry(
      new Request('https://api.example.test/api/telemetry/browser-error', {
        method: 'POST',
        body: '{not-json',
      })
    );

    expect(response.status).toBe(400);
  });

  it('rejects oversized payloads before logging them', async () => {
    const response = await handleBrowserTelemetry(
      new Request('https://api.example.test/api/telemetry/browser-error', {
        method: 'POST',
        body: JSON.stringify({ error: { message: 'x'.repeat(20_000) } }),
      })
    );

    expect(response.status).toBe(413);
  });
});

describe('Convex log-stream telemetry', () => {
  const originalSecret = process.env.CONVEX_LOG_STREAM_SECRET;

  beforeEach(() => {
    process.env.CONVEX_LOG_STREAM_SECRET = 'convex-log-stream-test-secret';
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CONVEX_LOG_STREAM_SECRET;
    } else {
      process.env.CONVEX_LOG_STREAM_SECRET = originalSecret;
    }
    vi.restoreAllMocks();
  });

  it('requires the configured webhook secret', async () => {
    const response = await handleConvexTelemetry(
      new Request('https://api.example.test/api/telemetry/convex', {
        method: 'POST',
        body: JSON.stringify({ functionName: 'users.list' }),
      })
    );

    expect(response.status).toBe(401);
  });

  it('accepts authorized redacted log-stream events', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];

    const response = await handleConvexTelemetry(
      new Request('https://api.example.test/api/telemetry/convex', {
        method: 'POST',
        headers: {
          'x-convex-log-stream-secret': 'convex-log-stream-test-secret',
        },
        body: JSON.stringify({
          functionName: 'users.list',
          metadata: { token: 'secret-value' },
        }),
      })
    );

    expect(response.status).toBe(204);
    expect(JSON.stringify(consoleSpies.map((spy) => spy.mock.calls))).not.toContain('secret-value');
  });
});
