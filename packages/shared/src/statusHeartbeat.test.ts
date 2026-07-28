import { describe, expect, mock, test } from 'bun:test';
import { createStatusHeartbeatReporter } from './statusHeartbeat';

describe('status heartbeat reporter', () => {
  test('sends an HTTPS GET without exposing the secret-bearing URL to diagnostics', async () => {
    const diagnostics: string[] = [];
    const request = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      return new Response(null, { status: 204 });
    });
    const reporter = createStatusHeartbeatReporter({
      fetch: request,
      logger: {
        debug: (message) => diagnostics.push(message),
        warn: (message) => diagnostics.push(message),
      },
      serviceName: 'scheduler',
      url: 'https://status.example.test/ext/heartbeat/scheduler/super-secret-value',
    });

    expect(reporter).toBeDefined();
    expect(await reporter?.signal()).toBeTrue();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://status.example.test/ext/heartbeat/scheduler/super-secret-value'
    );
    expect(diagnostics.join('\n')).not.toContain('super-secret-value');
    expect(diagnostics.join('\n')).not.toContain('/ext/heartbeat/');
  });

  test('treats non-success responses as delivery failures without reading or logging the body', async () => {
    const diagnostics: string[] = [];
    let bodyRead = false;
    const response = new Response('sensitive-upstream-body', { status: 503 });
    Object.defineProperty(response, 'text', {
      value: () => {
        bodyRead = true;
        return Promise.resolve('sensitive-upstream-body');
      },
    });
    const reporter = createStatusHeartbeatReporter({
      fetch: async () => response,
      logger: {
        debug: (message) => diagnostics.push(message),
        warn: (message) => diagnostics.push(message),
      },
      serviceName: 'storage-gc',
      url: 'https://status.example.test/ext/heartbeat/storage-gc/another-secret',
    });

    expect(await reporter?.signal()).toBeFalse();
    expect(bodyRead).toBeFalse();
    expect(diagnostics.join('\n')).not.toContain('another-secret');
    expect(diagnostics.join('\n')).not.toContain('sensitive-upstream-body');
    expect(diagnostics.join('\n')).toContain('"statusCode":503');
  });

  test('rejects plaintext and credential-bearing heartbeat URLs', () => {
    expect(() =>
      createStatusHeartbeatReporter({
        serviceName: 'scheduler',
        url: 'http://status.example.test/ext/heartbeat/scheduler/secret',
      })
    ).toThrow('Status heartbeat URL must use HTTPS');

    expect(() =>
      createStatusHeartbeatReporter({
        serviceName: 'scheduler',
        url: 'https://user:password@status.example.test/ext/heartbeat/scheduler/secret',
      })
    ).toThrow('Status heartbeat URL must not contain URL credentials');
  });

  test('disables reporting when no URL is configured', () => {
    expect(
      createStatusHeartbeatReporter({
        serviceName: 'scheduler',
        url: undefined,
      })
    ).toBeUndefined();
  });
});
