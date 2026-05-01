import { describe, expect, it } from 'bun:test';
import { buildApiAllowedCorsOrigins, buildApiCorsHeaders } from './cors';

describe('API CORS headers', () => {
  it('allows the Backstage signed source upload headers from approved browser origins', () => {
    const headers = buildApiCorsHeaders({
      allowedOrigins: new Set(['http://localhost:3000']),
      origin: 'http://localhost:3000',
    });

    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    expect(headers['Access-Control-Allow-Methods']).toContain('OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type');
    expect(headers['Access-Control-Allow-Headers']).toContain('X-YUCP-File-Name');
  });

  it('keeps localhost UI origins allowed in development when the public API URL is a tunnel', () => {
    const origins = buildApiAllowedCorsOrigins({
      frontendUrl: 'https://dsktp.tailc472f7.ts.net',
      nodeEnv: 'development',
      publicBaseUrl: 'https://dsktp.tailc472f7.ts.net',
      siteUrl: 'https://dsktp.tailc472f7.ts.net',
    });

    expect(origins.has('https://dsktp.tailc472f7.ts.net')).toBe(true);
    expect(origins.has('http://localhost:3000')).toBe(true);
  });

  it('does not add localhost UI origins to production tunnel CORS by default', () => {
    const origins = buildApiAllowedCorsOrigins({
      frontendUrl: 'https://creators.yucp.club',
      nodeEnv: 'production',
      publicBaseUrl: 'https://api.creators.yucp.club',
      siteUrl: 'https://api.creators.yucp.club',
    });

    expect(origins.has('https://api.creators.yucp.club')).toBe(true);
    expect(origins.has('https://creators.yucp.club')).toBe(true);
    expect(origins.has('http://localhost:3000')).toBe(false);
  });
});
