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
      frontendUrl: 'https://dev-tunnel.test',
      nodeEnv: 'development',
      publicBaseUrl: 'https://dev-tunnel.test',
      siteUrl: 'https://dev-tunnel.test',
    });

    expect(origins.has('https://dev-tunnel.test')).toBe(true);
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

  it('does not trust loopback origins in production even when a URL is misconfigured locally', () => {
    const origins = buildApiAllowedCorsOrigins({
      frontendUrl: 'http://localhost:3000',
      nodeEnv: 'production',
      publicBaseUrl: 'https://api.creators.yucp.club',
      siteUrl: 'https://api.creators.yucp.club',
    });

    expect(origins.has('https://api.creators.yucp.club')).toBe(true);
    expect(origins.has('http://localhost:3000')).toBe(false);
  });
});
