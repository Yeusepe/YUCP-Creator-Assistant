import { describe, expect, it } from 'bun:test';
import {
  readResponseErrorCode,
  resolveDiagnosticsSessionId,
  sanitizeApiRequestUrl,
} from './observability';

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

describe('API error code span annotation', () => {
  it('lifts a stable error code off a JSON error response without consuming it', async () => {
    const response = Response.json(
      {
        error: 'Operation authorization is invalid or expired',
        errorCode: 'OPERATION_AUTH_INVALID',
      },
      { status: 403 }
    );

    await expect(readResponseErrorCode(response)).resolves.toBe('OPERATION_AUTH_INVALID');
    // The response still has to be deliverable to the caller after the span reads it.
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'OPERATION_AUTH_INVALID' });
  });

  it('ignores bodies that carry no usable code', async () => {
    await expect(
      readResponseErrorCode(Response.json({ error: 'Method not allowed' }, { status: 405 }))
    ).resolves.toBeUndefined();
    await expect(
      readResponseErrorCode(new Response('not json', { status: 500 }))
    ).resolves.toBeUndefined();
    await expect(
      readResponseErrorCode(
        new Response('{"errorCode":', {
          headers: { 'Content-Type': 'application/json' },
          status: 400,
        })
      )
    ).resolves.toBeUndefined();
    // Free-form strings are caller-controlled in places; only stable codes become span attributes.
    await expect(
      readResponseErrorCode(Response.json({ errorCode: 'not a code' }, { status: 400 }))
    ).resolves.toBeUndefined();
  });
});
