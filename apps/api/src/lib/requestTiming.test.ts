import { describe, expect, it } from 'bun:test';
import { buildTimedResponse, RouteTimingCollector } from './requestTiming';

describe('RouteTimingCollector', () => {
  it('formats a Server-Timing header with recorded phases and total', async () => {
    const timing = new RouteTimingCollector();
    await timing.measure(
      'auth/session',
      async () => {
        await Promise.resolve();
      },
      'resolve session'
    );
    timing.measureSync('serialize', () => undefined, 'serialize json response');

    const header = timing.toServerTimingHeader();

    expect(header).toContain('auth_session;dur=');
    expect(header).toContain('serialize;dur=');
    expect(header).toContain('total;dur=');
    expect(header).toContain('desc="resolve session"');
  });

  it('attaches Server-Timing headers to responses', async () => {
    const timing = new RouteTimingCollector();
    await timing.measure(
      'convex',
      async () => {
        await Promise.resolve();
      },
      'query convex'
    );

    const response = buildTimedResponse(
      timing,
      () => Response.json({ ok: true }),
      'serialize json response'
    );

    expect(response.headers.get('Server-Timing')).toMatch(
      /convex;dur=.*serialize;dur=.*total;dur=/
    );
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
