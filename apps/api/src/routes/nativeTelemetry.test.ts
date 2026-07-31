import { describe, expect, test, vi } from 'bun:test';
import { handleNativeTelemetry } from './nativeTelemetry';

const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
const diagnosticsSession = '01234567-89ab-4cde-8123-456789abcdef';
const activeConsent = async (sessionId: string) => sessionId === diagnosticsSession;

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://api.example.test/api/telemetry/native', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      traceparent: traceparent,
      'x-yucp-diagnostics-session': diagnosticsSession,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('native telemetry ingestion', () => {
  test('requires W3C trace context and enforces consent for the diagnostics tier', async () => {
    // No diagnostics session is the anonymous operational tier, not a rejection:
    // authentication failures occur before any install session exists.
    const operational = await handleNativeTelemetry(
      request({ event: 'native.operation' }, { 'x-yucp-diagnostics-session': '' }),
      activeConsent
    );
    expect(operational.status).toBe(204);

    const missingTrace = await handleNativeTelemetry(
      request({ event: 'native.operation' }, { traceparent: '' }),
      activeConsent
    );
    expect(missingTrace.status).toBe(401);

    const withdrawn = await handleNativeTelemetry(
      request({ event: 'native.operation' }),
      async () => false
    );
    expect(withdrawn.status).toBe(403);
  });

  test('keeps the failure reason on the anonymous tier while redacting credentials', async () => {
    const logged: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
    const consentResolver = vi.fn(async () => true);
    const response = await handleNativeTelemetry(
      request(
        {
          event: 'native.lifecycle.failed',
          severity: 'error',
          errorCode: 'PACKAGE_API_UNAVAILABLE',
          operation: 'install',
          message: 'package broker API returned HTTP 503 authorization: Bearer abc.def',
        },
        { 'x-yucp-diagnostics-session': '' }
      ),
      consentResolver
    );
    expect(response.status).toBe(204);
    expect(consentResolver).not.toHaveBeenCalled();
    const serialized = JSON.stringify(logged);
    // A code with no cause is still an unexplained error, so the reason stays.
    expect(serialized).toContain('returned HTTP 503');
    expect(serialized).toContain('PACKAGE_API_UNAVAILABLE');
    expect(serialized).toContain('operational');
    // Credentials never survive, whatever the client sent.
    expect(serialized).not.toContain('abc.def');
    consoleError.mockRestore();
  });

  test('records the anonymous tier without consulting consent', async () => {
    const logged: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
    const consentResolver = vi.fn(async () => true);
    const response = await handleNativeTelemetry(
      request(
        {
          event: 'native.lifecycle.failed',
          severity: 'error',
          errorCode: 'AUTHENTICATION_REQUIRED',
          operation: 'preflight',
        },
        { 'x-yucp-diagnostics-session': '' }
      ),
      consentResolver
    );
    expect(response.status).toBe(204);
    // Consent is never consulted when no diagnostics session is presented.
    expect(consentResolver).not.toHaveBeenCalled();
    const serialized = JSON.stringify(logged);
    expect(serialized).toContain('AUTHENTICATION_REQUIRED');
    expect(serialized).toContain('operational');
    expect(serialized).not.toContain('diagnostics.session.id":"');
    consoleError.mockRestore();
  });

  test('accepts bounded operational metadata without exposing payloads as a response', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleNativeTelemetry(
      request({
        event: 'native.operation.failed',
        severity: 'error',
        service: 'yucp-native-package-broker',
        process: 'broker',
        operation: 'install',
        phase: 'downloading',
        errorCode: 'PACKAGE_API_INTERNAL_ERROR',
        status: 500,
        durationMs: 321,
        runId: 'run-install-1',
        releaseId: 'release-1',
        os: 'windows',
        arch: 'amd64',
        message: 'request failed with password=super-secret',
        requestBody: 'must never be logged',
      }),
      activeConsent
    );
    expect(response.status).toBe(204);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('super-secret');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('must never be logged');
    consoleError.mockRestore();
  });

  test('rejects oversized payloads', async () => {
    const response = await handleNativeTelemetry(
      request({ message: 'x'.repeat(13_000) }),
      activeConsent
    );
    expect(response.status).toBe(413);
  });

  test('rejects methods other than POST', async () => {
    const response = await handleNativeTelemetry(
      new Request('https://api.example.test/api/telemetry/native', {
        method: 'GET',
      }),
      activeConsent
    );
    expect(response.status).toBe(405);
  });
});
