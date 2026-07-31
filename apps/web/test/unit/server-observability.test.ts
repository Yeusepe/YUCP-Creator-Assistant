import { describe, expect, it } from 'vitest';
import { buildIncomingTraceCarrier } from '@/lib/server/observability';

describe('web server observability', () => {
  it('keeps trace headers from incoming server function requests', () => {
    const carrier = buildIncomingTraceCarrier(
      new Headers({
        traceparent: '00-8109a1b16b114f960bcfe458d6f59aa1-392a189c995ccc0d-01',
        baggage: 'userId=123',
        cookie: 'session=abc',
      })
    );

    expect(carrier).toEqual({
      traceparent: '00-8109a1b16b114f960bcfe458d6f59aa1-392a189c995ccc0d-01',
    });
  });
});
