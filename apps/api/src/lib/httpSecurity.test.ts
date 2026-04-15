import { describe, expect, it } from 'bun:test';
import { applyResponseSecurityHeaders } from './httpSecurity';

describe('applyResponseSecurityHeaders', () => {
  it('marks +json responses as no-store when cache headers are absent', async () => {
    const response = new Response(JSON.stringify({ error: 'bad request' }), {
      headers: {
        'content-type': 'application/problem+json; charset=utf-8',
      },
    });

    const securedResponse = applyResponseSecurityHeaders(response);

    expect(securedResponse.headers.get('Cache-Control')).toBe('no-store');
  });
});
