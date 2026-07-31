import { describe, expect, it } from 'bun:test';
import { resolveDiagnosticsSessionId, sanitizeApiRequestUrl } from './observability';

describe('API observability URL sanitization', () => {
  it('redacts creator-managed VCC link identifiers from URL telemetry', () => {
    const sanitized = sanitizeApiRequestUrl(
      `https://api.test/api/vpm/access/${'A'.repeat(43)}/index.json`
    );

    expect(sanitized.pathname).toBe('/api/vpm/access/[REDACTED]/index.json');
  });

  it('only returns diagnostics sessions with active consent', async () => {
    const request = new Request('https://api.test/api/items', {
      headers: {
        'x-yucp-diagnostics-session': '01234567-89ab-4cde-8123-456789abcdef',
      },
    });

    await expect(resolveDiagnosticsSessionId(request, async () => true)).resolves.toBe(
      '01234567-89ab-4cde-8123-456789abcdef'
    );
    await expect(resolveDiagnosticsSessionId(request, async () => false)).resolves.toBeUndefined();
  });
});
