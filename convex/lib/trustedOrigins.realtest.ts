import { describe, expect, it } from 'vitest';
import { buildTrustedBrowserOrigins, normalizeOrigin } from './trustedOrigins';

describe('normalizeOrigin', () => {
  it('extracts origin from a full URL', () => {
    expect(normalizeOrigin('https://example.com/path?query=1')).toBe('https://example.com');
  });

  it('extracts origin with port', () => {
    expect(normalizeOrigin('http://localhost:3000/api/auth')).toBe('http://localhost:3000');
  });

  it('returns null for empty string', () => {
    expect(normalizeOrigin('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(normalizeOrigin(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(normalizeOrigin(undefined)).toBeNull();
  });

  it('returns null for invalid URL', () => {
    expect(normalizeOrigin('not-a-url')).toBeNull();
  });

  it('strips trailing path from origin', () => {
    expect(normalizeOrigin('https://verify.creators.yucp.club/dashboard')).toBe(
      'https://verify.creators.yucp.club'
    );
  });
});

describe('buildTrustedBrowserOrigins', () => {
  it('includes explicit loopback origins when no origins are configured', () => {
    const origins = buildTrustedBrowserOrigins({});
    expect(origins).toContain('http://localhost:3000');
    expect(origins).toContain('http://localhost:3001');
    expect(origins).toContain('http://127.0.0.1:3000');
    expect(origins).not.toContain('http://localhost:*');
    expect(origins).not.toContain('https://localhost:*');
  });

  it('includes explicit loopback origins when siteUrl is localhost', () => {
    const origins = buildTrustedBrowserOrigins({ siteUrl: 'http://localhost:3000' });
    expect(origins).toContain('http://localhost:3000');
    expect(origins).toContain('http://127.0.0.1:3001');
    expect(origins).not.toContain('http://localhost:*');
  });

  it('does NOT include local loopback origins for production origins', () => {
    const origins = buildTrustedBrowserOrigins({
      siteUrl: 'https://verify.creators.yucp.club',
      frontendUrl: 'https://verify.creators.yucp.club',
    });
    expect(origins).not.toContain('http://localhost:3000');
    expect(origins).not.toContain('http://127.0.0.1:3000');
    expect(origins).toContain('https://verify.creators.yucp.club');
  });

  it('deduplicates identical origins', () => {
    const origins = buildTrustedBrowserOrigins({
      siteUrl: 'https://example.com',
      frontendUrl: 'https://example.com',
    });
    const exampleCount = origins.filter((o) => o === 'https://example.com').length;
    expect(exampleCount).toBe(1);
  });

  it('includes both siteUrl and frontendUrl when different', () => {
    const origins = buildTrustedBrowserOrigins({
      siteUrl: 'https://app.example.com',
      frontendUrl: 'https://www.example.com',
    });
    expect(origins).toContain('https://app.example.com');
    expect(origins).toContain('https://www.example.com');
    expect(origins).not.toContain('http://localhost:3000');
  });

  it('filters out null and invalid URLs from additionalOrigins', () => {
    const origins = buildTrustedBrowserOrigins({
      siteUrl: 'https://example.com',
      additionalOrigins: [null, undefined, 'invalid', 'https://extra.com'],
    });
    expect(origins).toContain('https://example.com');
    expect(origins).toContain('https://extra.com');
    expect(origins).toHaveLength(2);
  });

  it('treats 127.0.0.1 as local', () => {
    const origins = buildTrustedBrowserOrigins({ siteUrl: 'http://127.0.0.1:8080' });
    expect(origins).toContain('http://127.0.0.1:8080');
    expect(origins).toContain('http://localhost:3000');
    expect(origins).not.toContain('http://localhost:*');
  });

  it('marks mixed local+production as local (security: be explicit)', () => {
    const origins = buildTrustedBrowserOrigins({
      siteUrl: 'http://localhost:3000',
      frontendUrl: 'https://prod.example.com',
    });
    expect(origins).toContain('http://localhost:3000');
    expect(origins).toContain('http://127.0.0.1:3001');
    expect(origins).not.toContain('http://localhost:*');
    expect(origins).toContain('https://prod.example.com');
  });
});
