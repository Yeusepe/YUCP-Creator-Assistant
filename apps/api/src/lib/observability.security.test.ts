import { describe, expect, it } from 'bun:test';
import { sanitizeApiRequestUrl } from './observability';

describe('API observability URL sanitization', () => {
  it('redacts creator-managed VCC link identifiers from URL telemetry', () => {
    const sanitized = sanitizeApiRequestUrl(
      `https://api.test/api/vpm/access/${'A'.repeat(43)}/index.json`
    );

    expect(sanitized.pathname).toBe('/api/vpm/access/[REDACTED]/index.json');
  });
});
