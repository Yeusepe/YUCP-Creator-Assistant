import { describe, expect, it } from 'bun:test';
import { sanitizeApiRequestUrl } from './observability';

describe('API observability URL sanitization', () => {
  it('redacts VPM bearer tokens and strips signed query data from URL telemetry', () => {
    const sanitized = sanitizeApiRequestUrl(
      'https://api.test/api/vpm/encoded-buyer-token.signature/index.json?sig=secret&exp=123#fragment'
    );

    expect(sanitized.pathname).toBe('/api/vpm/[REDACTED]/index.json');
    expect(sanitized.toString()).toBe('https://api.test/api/vpm/[REDACTED]/index.json');
  });

  it('preserves paths that do not contain credentials', () => {
    const sanitized = sanitizeApiRequestUrl('https://api.test/api/vpm/repo-token');

    expect(sanitized.toString()).toBe('https://api.test/api/vpm/repo-token');
  });
});
